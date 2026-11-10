// Checks the step 4 adapters (Instagram, Threads, Facebook Page, YouTube) and the R2 image host against a
// fake `fetch` that answers as the documents of each network say, and records each request. The clock is
// fixed. Nothing leaves this process: the global `fetch` throws, and the check fails if anything calls it.
//
// Run: bunx tsx scripts/content-adapters-e2e.ts
// Writes .openbot-build/content-adapters-e2e/report.json and exits non-zero on a failure.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import type {
  ContentAdapter,
  ContentAdapterError,
  ContentFetch,
  ContentPublishMedia,
  ContentPublishResult,
} from "../src/main/content/content-adapter";
import {
  contentHostedKey,
  isContentHostedKey,
  R2MediaHost,
  signS3Request,
} from "../src/main/content/content-media-host";
import {
  FACEBOOK_SCOPES,
  FacebookPageAdapter,
  InstagramAdapter,
  META_GRAPH_VERSION,
  metaError,
  ThreadsAdapter,
} from "../src/main/content/meta-adapters";
import { YOUTUBE_SCOPES, YouTubeAdapter } from "../src/main/content/youtube-adapter";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".openbot-build", "content-adapters-e2e");

interface Step {
  name: string;
  passed: boolean;
  detail?: unknown;
  error?: string;
}
const report: { passed: boolean; steps: Step[] } = { passed: false, steps: [] };

async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  process.stdout.write(`- ${name}\n`);
  try {
    const value = await run();
    report.steps.push({ name, passed: true, detail: value });
    return value;
  } catch (error) {
    report.steps.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

let globalFetchCalls = 0;
globalThis.fetch = Object.assign(
  async (): Promise<Response> => {
    globalFetchCalls += 1;
    throw new Error("The E2E called the global fetch.");
  },
  { preconnect: () => {} },
);

const SECRETS = {
  appSecret: "meta-app-secret-0123456789",
  code: "auth-code-0123456789",
  shortToken: "short-lived-token-0123456789",
  longToken: "long-lived-token-0123456789",
  renewedToken: "renewed-token-0123456789",
  userToken: "fb-user-token-0123456789",
  pageToken: "fb-page-token-0123456789",
  googleAccess: "google-access-token-0123456789",
  googleRefresh: "google-refresh-token-0123456789",
  r2Secret: "test-secret-access-key-0123456789",
};

interface RecordedRequest {
  method: string;
  url: URL;
  route: string;
  headers: Record<string, string>;
  body: string;
  bytes: number;
}
const requests: RecordedRequest[] = [];
type Handler = (request: RecordedRequest) => Response | Promise<Response>;
/** The answers of the fake network, by `METHOD host/path`. A test replaces one for one case. */
const routes = new Map<string, Handler>();

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function bodyText(body: RequestInit["body"]): { text: string; bytes: number } {
  if (typeof body === "string") return { text: body, bytes: Buffer.byteLength(body) };
  if (body instanceof FormData)
    return {
      text: [...body.entries()]
        .map(([key, value]: [string, FormDataEntryValue]) =>
          typeof value === "string" ? `${key}=${value}` : `${key}=<file ${value.size} ${value.type}>`,
        )
        .join("&"),
      bytes: 0,
    };
  if (body instanceof Uint8Array) return { text: `<bytes ${body.byteLength}>`, bytes: body.byteLength };
  return { text: "", bytes: 0 };
}

const fakeFetch: ContentFetch = async (url, init) => {
  const parsed = new URL(url);
  const { text, bytes } = bodyText(init.body);
  const recorded: RecordedRequest = {
    method: init.method ?? "GET",
    url: parsed,
    route: `${init.method ?? "GET"} ${parsed.host}${parsed.pathname}`,
    headers: Object.fromEntries(new Headers(init.headers).entries()),
    body: text,
    bytes,
  };
  requests.push(recorded);
  const handler = routes.get(recorded.route);
  if (!handler) return json(404, { error: { message: `No fake route ${recorded.route}`, code: 803 } });
  return handler(recorded);
};

let clock = new Date("2030-03-01T09:00:00.000Z");
const options = { fetch: fakeFetch, now: () => clock, sleep: async () => {} };
const REDIRECT = "http://127.0.0.1:28418/content-auth";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
// A few KB of fake video bytes: the adapters never look inside.
const VIDEO = new Uint8Array(4096).map((_, index) => index % 251);
const jpeg: ContentPublishMedia = { kind: "image", mimeType: "image/jpeg", bytes: JPEG, name: "photo.jpg" };
const png: ContentPublishMedia = { kind: "image", mimeType: "image/png", bytes: PNG, name: "photo.png" };
const video: ContentPublishMedia = { kind: "video", mimeType: "video/mp4", bytes: VIDEO, name: "clip.mp4" };

const run = <A>(effect: Effect.Effect<A, ContentAdapterError>) => Effect.runPromise(effect);
const flip = <A>(effect: Effect.Effect<A, ContentAdapterError>) => Effect.runPromise(Effect.flip(effect));
const during = async <A>(work: () => Promise<A>) => {
  const before = requests.length;
  const value = await work();
  return { value, sent: requests.slice(before) };
};
const routesOf = (sent: RecordedRequest[]) => sent.map((request) => request.route);
const pendingOf = (result: ContentPublishResult) => {
  assert.equal(result.kind, "pending");
  assert.ok(result.kind === "pending");
  assert.equal(result.reason, "processing");
  return result;
};
const authorizeChecks = (adapter: ContentAdapter, origin: string, scope: string) => {
  const start = adapter.generateAuthUrl({ clientId: "client-1", redirectUri: REDIRECT });
  const url = new URL(start.url);
  assert.equal(url.origin + url.pathname, origin);
  assert.equal(url.searchParams.get("client_id"), "client-1");
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), scope);
  assert.equal(url.searchParams.get("state"), start.state);
  assert.ok(start.state.length >= 20);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    url.searchParams.get("code_challenge"),
    createHash("sha256").update(start.codeVerifier).digest("base64url"),
  );
  return { start, url };
};

/** The fake R2 bucket: objects by key, and the public base URL answers from it. */
const bucket = new Map<string, Buffer>();
let failDeletes = 0;
const R2_HOST = "fake-account.r2.example.test";
const R2_PUBLIC = "pub-fake.r2.example.test";

function r2Route(request: RecordedRequest): Response {
  const key = decodeURIComponent(request.url.pathname.replace(/^\/content-bucket\//u, ""));
  if (request.method === "PUT") {
    bucket.set(key, Buffer.from(lastBody));
    return new Response(null, { status: 200 });
  }
  if (failDeletes > 0) {
    failDeletes -= 1;
    return new Response("<Error/>", { status: 503 });
  }
  bucket.delete(key);
  return new Response(null, { status: 204 });
}
let lastBody: Uint8Array = new Uint8Array();
const r2Fetch: ContentFetch = async (url, init) => {
  if (init.body instanceof Uint8Array) lastBody = init.body;
  const parsed = new URL(url);
  if (parsed.host === R2_HOST && parsed.pathname.startsWith("/content-bucket/t/")) {
    const recorded: RecordedRequest = {
      method: init.method ?? "GET",
      url: parsed,
      route: `${init.method ?? "GET"} ${parsed.host}/content-bucket/<key>`,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: bodyText(init.body).text,
      bytes: bodyText(init.body).bytes,
    };
    requests.push(recorded);
    return r2Route(recorded);
  }
  if (parsed.host === R2_PUBLIC) {
    requests.push({
      method: "GET",
      url: parsed,
      route: `GET ${parsed.host}/<key>`,
      headers: {},
      body: "",
      bytes: 0,
    });
    const object = bucket.get(parsed.pathname.slice(1));
    return object ? new Response(new Uint8Array(object), { status: 200 }) : new Response(null, { status: 404 });
  }
  return fakeFetch(url, init);
};
const hostSettings = {
  endpoint: `https://${R2_HOST}`,
  bucket: "content-bucket",
  publicBaseUrl: `https://${R2_PUBLIC}`,
  accessKeyId: "test-access-key",
  secretAccessKey: SECRETS.r2Secret,
};
const host = new R2MediaHost({ fetch: r2Fetch, now: () => clock, settings: hostSettings });
const hostImage = (media: ContentPublishMedia) => {
  const key = contentHostedKey(media.mimeType);
  assert.ok(key);
  return host.put(media, key);
};

try {
  await step("1. SigV4: the AWS documented GET Object example gives its documented signature", async () => {
    // The public example of the AWS SigV4 documents (S3 "GET Object" with a Range header). These are the
    // documented example keys, not credentials.
    const headers = signS3Request({
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/test.txt",
      headers: { range: "bytes=0-9" },
      payloadHash: createHash("sha256").update("").digest("hex"),
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      now: new Date("2013-05-24T00:00:00.000Z"),
    });
    assert.equal(
      headers.authorization,
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    assert.equal(headers["x-amz-date"], "20130524T000000Z");
    return { signature: headers.authorization?.slice(-64) };
  });

  await step("2. R2 host: signed PUT with the body hash, public URL, one exact DELETE, key pattern guard", async () => {
    const key = contentHostedKey("image/jpeg");
    assert.ok(key && /^t\/[0-9a-f]{32}\.jpg$/u.test(key));
    assert.equal(contentHostedKey("image/heic"), null);
    const { value, sent } = await during(() => run(host.put(jpeg, key)));
    assert.equal(value.url, `https://${R2_PUBLIC}/${key}`);
    const [put] = sent;
    assert.ok(put);
    assert.equal(put.url.toString(), `https://${R2_HOST}/content-bucket/${key}`, "Path-style address.");
    assert.equal(put.headers["x-amz-content-sha256"], createHash("sha256").update(JPEG).digest("hex"));
    assert.equal(put.headers["content-type"], "image/jpeg");
    assert.equal(put.headers["x-amz-acl"], undefined, "R2 has no ACL header.");
    assert.match(put.headers.authorization ?? "", /Credential=test-access-key\/20300301\/auto\/s3\/aws4_request/u);
    assert.match(put.headers.authorization ?? "", /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date,/u);
    assert.ok(bucket.has(key));
    const removed = await during(() => run(host.remove(key)));
    assert.deepEqual(routesOf(removed.sent), [`DELETE ${R2_HOST}/content-bucket/<key>`]);
    assert.equal(bucket.has(key), false);
    for (const bad of ["photo.jpg", "t/", "t/*", "user-assets/logo.png", `t/${"a".repeat(32)}.jpg/../x`, "t/ABC.jpg"]) {
      assert.equal(isContentHostedKey(bad), false);
      const refused = await during(() => flip(host.remove(bad)));
      assert.equal(refused.sent.length, 0, `No DELETE for ${bad}.`);
      assert.equal(refused.value.code, "rejected");
    }
    return { key };
  });

  await step("3. R2 probe: passes and removes its file; upload refused, not public and other bytes fail", async () => {
    const ok = await during(() => Effect.runPromise(host.probe()));
    assert.deepEqual(routesOf(ok.sent), [
      `PUT ${R2_HOST}/content-bucket/<key>`,
      `GET ${R2_PUBLIC}/<key>`,
      `DELETE ${R2_HOST}/content-bucket/<key>`,
    ]);
    assert.match(ok.sent[0]?.url.pathname ?? "", /^\/content-bucket\/t\/probe-[0-9a-f]{32}\.txt$/u);
    assert.equal(bucket.size, 0, "The probe file is removed.");
    const wrongPublic = new R2MediaHost({
      fetch: r2Fetch,
      now: () => clock,
      settings: { ...hostSettings, publicBaseUrl: `https://${R2_PUBLIC}/elsewhere` },
    });
    const notPublic = await Effect.runPromise(Effect.flip(wrongPublic.probe()));
    assert.equal(notPublic.reason, "public");
    assert.match(notPublic.message, /Public Development URL/u);
    assert.equal(bucket.size, 0, "Removed on a failure too.");
    const wrongBucket = new R2MediaHost({
      fetch: async (url, init) =>
        new URL(url).host === R2_HOST && init.method === "PUT"
          ? new Response(null, { status: 403 })
          : r2Fetch(url, init),
      now: () => clock,
      settings: hostSettings,
    });
    assert.equal((await Effect.runPromise(Effect.flip(wrongBucket.probe()))).reason, "upload");
    const otherBytes = new R2MediaHost({
      fetch: async (url, init) =>
        new URL(url).host === R2_PUBLIC ? new Response("something else", { status: 200 }) : r2Fetch(url, init),
      now: () => clock,
      settings: hostSettings,
    });
    assert.equal((await Effect.runPromise(Effect.flip(otherBytes.probe()))).reason, "bytes");
    assert.equal(bucket.size, 0);
    return { reasons: ["public", "upload", "bytes"] };
  });

  const instagram = new InstagramAdapter(options);
  await step(
    "4. Instagram sign-in: URL, form with client_secret, `#_` stripped, long-lived exchange, profile",
    async () => {
      const { start } = authorizeChecks(
        instagram,
        "https://www.instagram.com/oauth/authorize",
        "instagram_business_basic,instagram_business_content_publish",
      );
      routes.set("POST api.instagram.com/oauth/access_token", () =>
        json(200, { data: [{ access_token: SECRETS.shortToken, user_id: "17841400000", permissions: "a,b" }] }),
      );
      routes.set("GET graph.instagram.com/access_token", () =>
        json(200, { access_token: SECRETS.longToken, token_type: "bearer", expires_in: 5_184_000 }),
      );
      routes.set(`GET graph.instagram.com/${META_GRAPH_VERSION}/me`, () =>
        json(200, { user_id: "17841400000", username: "openbot_ig", id: "app-scoped-1" }),
      );
      const { value, sent } = await during(() =>
        run(
          instagram.authenticate({
            clientId: "client-1",
            clientSecret: SECRETS.appSecret,
            redirectUri: REDIRECT,
            code: `${SECRETS.code}#_`,
            codeVerifier: start.codeVerifier,
          }),
        ),
      );
      const [token, exchange, me] = sent;
      assert.ok(token && exchange && me);
      const form = new URLSearchParams(token.body);
      assert.equal(form.get("client_secret"), SECRETS.appSecret);
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(form.get("redirect_uri"), REDIRECT);
      assert.equal(form.get("code"), SECRETS.code);
      assert.equal(exchange.url.searchParams.get("grant_type"), "ig_exchange_token");
      assert.equal(exchange.url.searchParams.get("client_secret"), SECRETS.appSecret);
      assert.equal(exchange.url.searchParams.get("access_token"), SECRETS.shortToken);
      assert.equal(me.url.searchParams.get("access_token"), SECRETS.longToken);
      assert.equal(value.profile.externalAccountId, "17841400000");
      assert.equal(value.profile.handle, "openbot_ig");
      assert.equal(value.tokens.accessToken, SECRETS.longToken);
      assert.equal(value.tokens.refreshToken, SECRETS.longToken, "The long-lived token is the refresh token too.");
      assert.equal(value.tokens.expiresAt, "2030-04-30T09:00:00.000Z");
      const noSecret = await flip(
        instagram.authenticate({
          clientId: "c",
          clientSecret: null,
          redirectUri: REDIRECT,
          code: "c",
          codeVerifier: "v",
        }),
      );
      assert.equal(noSecret.message, "Instagram needs the client secret of the app.");
      return { handle: value.profile.handle };
    },
  );

  await step("5. Instagram refresh renews the token; a refused refresh signs out", async () => {
    routes.set("GET graph.instagram.com/refresh_access_token", () =>
      json(200, { access_token: SECRETS.renewedToken, token_type: "bearer", expires_in: 5_184_000 }),
    );
    const { value, sent } = await during(() =>
      run(
        instagram.refreshToken({
          clientId: "client-1",
          clientSecret: SECRETS.appSecret,
          refreshToken: SECRETS.longToken,
        }),
      ),
    );
    assert.equal(sent[0]?.url.searchParams.get("grant_type"), "ig_refresh_token");
    assert.equal(sent[0]?.url.searchParams.get("access_token"), SECRETS.longToken);
    assert.equal(value.accessToken, SECRETS.renewedToken);
    assert.equal(value.refreshToken, SECRETS.renewedToken);
    routes.set("GET graph.instagram.com/refresh_access_token", () =>
      json(400, { error: { message: `Bad token ${SECRETS.longToken}`, type: "OAuthException", code: 190 } }),
    );
    const error = await flip(
      instagram.refreshToken({
        clientId: "client-1",
        clientSecret: SECRETS.appSecret,
        refreshToken: SECRETS.longToken,
      }),
    );
    assert.equal(error.code, "signed-out");
    assert.equal(error.message, "Sign in to Instagram again.");
    return { renewed: true };
  });

  await step("6. Instagram publish: host put -> container -> pending -> FINISHED -> publish -> permalink", async () => {
    let statusAnswers = ["IN_PROGRESS", "FINISHED"];
    routes.set(`POST graph.instagram.com/${META_GRAPH_VERSION}/17841400000/media`, () =>
      json(200, { id: "container-1" }),
    );
    routes.set(`GET graph.instagram.com/${META_GRAPH_VERSION}/container-1`, () =>
      json(200, { status_code: statusAnswers.shift() ?? "FINISHED", id: "container-1" }),
    );
    routes.set(`POST graph.instagram.com/${META_GRAPH_VERSION}/17841400000/media_publish`, () =>
      json(200, { id: "media-9" }),
    );
    routes.set(`GET graph.instagram.com/${META_GRAPH_VERSION}/media-9`, () =>
      json(200, { permalink: "https://www.instagram.com/p/abc/", id: "media-9" }),
    );
    const publish = await during(() =>
      run(
        instagram.publish({
          accessToken: SECRETS.longToken,
          profile: { externalAccountId: "17841400000" },
          body: "Caption #launch",
          title: null,
          media: jpeg,
          hostImage,
        }),
      ),
    );
    assert.deepEqual(routesOf(publish.sent), [
      `PUT ${R2_HOST}/content-bucket/<key>`,
      `POST graph.instagram.com/${META_GRAPH_VERSION}/17841400000/media`,
    ]);
    const form = new URLSearchParams(publish.sent[1]?.body);
    assert.match(form.get("image_url") ?? "", new RegExp(`^https://${R2_PUBLIC}/t/[0-9a-f]{32}\\.jpg$`, "u"));
    assert.equal(form.get("caption"), "Caption #launch");
    const pending = pendingOf(publish.value);
    assert.equal(pending.checkAfterMs, 60_000);
    const again = pendingOf(
      await run(instagram.checkPostStatus({ accessToken: SECRETS.longToken, pendingData: pending.pendingData })),
    );
    assert.equal(again.pendingData, pending.pendingData);
    const done = await during(() =>
      run(instagram.checkPostStatus({ accessToken: SECRETS.longToken, pendingData: pending.pendingData })),
    );
    assert.deepEqual(done.value, {
      kind: "published",
      externalPostId: "media-9",
      url: "https://www.instagram.com/p/abc/",
    });
    assert.equal(new URLSearchParams(done.sent[1]?.body).get("creation_id"), "container-1");
    // A failed permalink read does not fail the post.
    statusAnswers = ["FINISHED"];
    routes.set(`GET graph.instagram.com/${META_GRAPH_VERSION}/media-9`, () => json(500, {}));
    const noLink = await run(
      instagram.checkPostStatus({ accessToken: SECRETS.longToken, pendingData: pending.pendingData }),
    );
    assert.deepEqual(noLink, { kind: "published", externalPostId: "media-9", url: null });
    return { container: "container-1" };
  });

  await step("7. Instagram refuses PNG, no host, and no image as invalid with no request", async () => {
    const input = {
      accessToken: SECRETS.longToken,
      profile: { externalAccountId: "17841400000" },
      body: "x",
      title: null,
    };
    const notJpeg = await during(() => flip(instagram.publish({ ...input, media: png, hostImage })));
    assert.equal(notJpeg.sent.length, 0);
    assert.equal(notJpeg.value.code, "invalid");
    assert.equal(
      notJpeg.value.message,
      "Instagram takes only JPEG images up to 8 MB. Use another image for Instagram.",
    );
    const noHost = await during(() => flip(instagram.publish({ ...input, media: jpeg })));
    assert.equal(noHost.sent.length, 0);
    assert.equal(noHost.value.code, "invalid");
    const big = { ...jpeg, bytes: new Uint8Array(8 * 1024 * 1024 + 1) };
    assert.equal((await flip(instagram.publish({ ...input, media: big, hostImage }))).code, "invalid");
    return { refused: 3 };
  });

  await step("8. Instagram and Threads container ERROR, EXPIRED and the 24 h give-up", async () => {
    const pendingData = JSON.stringify({
      containerId: "container-1",
      userId: "17841400000",
      startedAt: clock.toISOString(),
    });
    routes.set(`GET graph.instagram.com/${META_GRAPH_VERSION}/container-1`, () =>
      json(200, { status_code: "ERROR", status: "Error: image could not be fetched" }),
    );
    const error = await flip(instagram.checkPostStatus({ accessToken: SECRETS.longToken, pendingData }));
    assert.equal(error.code, "rejected");
    assert.equal(error.message, "Instagram refused the post: Error: image could not be fetched");
    routes.set(`GET graph.instagram.com/${META_GRAPH_VERSION}/container-1`, () =>
      json(200, { status_code: "EXPIRED" }),
    );
    assert.equal(
      (await flip(instagram.checkPostStatus({ accessToken: SECRETS.longToken, pendingData }))).code,
      "unknown-result",
    );
    routes.set(`GET graph.instagram.com/${META_GRAPH_VERSION}/container-1`, () =>
      json(200, { status_code: "IN_PROGRESS" }),
    );
    const start = clock;
    clock = new Date(start.getTime() + 24 * 60 * 60_000 + 1);
    const late = await flip(instagram.checkPostStatus({ accessToken: SECRETS.longToken, pendingData }));
    clock = start;
    assert.equal(late.code, "unknown-result");
    assert.equal(late.message, "Instagram did not finish the post in 24 hours. Check Instagram before you retry.");
    return { codes: ["rejected", "unknown-result", "unknown-result"] };
  });

  const threads = new ThreadsAdapter(options);
  await step("9. Threads sign-in, refresh, text post and image post", async () => {
    const { start } = authorizeChecks(
      threads,
      "https://threads.com/oauth/authorize",
      "threads_basic,threads_content_publish",
    );
    routes.set("POST graph.threads.com/oauth/access_token", () =>
      json(200, { access_token: SECRETS.shortToken, user_id: 990011 }),
    );
    routes.set("GET graph.threads.com/access_token", () =>
      json(200, { access_token: SECRETS.longToken, token_type: "bearer", expires_in: 5_184_000 }),
    );
    routes.set("GET graph.threads.com/v1.0/me", () => json(200, { id: "990011", username: "openbot_threads" }));
    const signIn = await during(() =>
      run(
        threads.authenticate({
          clientId: "client-1",
          clientSecret: SECRETS.appSecret,
          redirectUri: REDIRECT,
          code: SECRETS.code,
          codeVerifier: start.codeVerifier,
        }),
      ),
    );
    assert.equal(new URLSearchParams(signIn.sent[0]?.body).get("client_secret"), SECRETS.appSecret);
    assert.equal(signIn.sent[1]?.url.searchParams.get("grant_type"), "th_exchange_token");
    assert.equal(signIn.value.profile.externalAccountId, "990011");
    assert.equal(signIn.value.profile.handle, "openbot_threads");
    assert.equal(signIn.value.tokens.refreshToken, SECRETS.longToken);
    routes.set("GET graph.threads.com/refresh_access_token", () =>
      json(200, { access_token: SECRETS.renewedToken, expires_in: 5_184_000 }),
    );
    const refresh = await during(() =>
      run(
        threads.refreshToken({
          clientId: "client-1",
          clientSecret: SECRETS.appSecret,
          refreshToken: SECRETS.longToken,
        }),
      ),
    );
    assert.equal(refresh.sent[0]?.url.searchParams.get("grant_type"), "th_refresh_token");
    assert.equal(refresh.value.accessToken, SECRETS.renewedToken);

    routes.set("POST graph.threads.com/v1.0/990011/threads", () => json(200, { id: "th-container-1" }));
    routes.set("GET graph.threads.com/v1.0/th-container-1", () => json(200, { status: "FINISHED" }));
    routes.set("POST graph.threads.com/v1.0/990011/threads_publish", () => json(200, { id: "th-media-1" }));
    routes.set("GET graph.threads.com/v1.0/th-media-1", () =>
      json(200, { permalink: "https://www.threads.com/@x/post/1" }),
    );
    const base = { accessToken: SECRETS.longToken, profile: { externalAccountId: "990011" }, title: null };
    const text = await during(() => run(threads.publish({ ...base, body: "Hello Threads", media: null })));
    const textForm = new URLSearchParams(text.sent[0]?.body);
    assert.equal(textForm.get("media_type"), "TEXT");
    assert.equal(textForm.get("text"), "Hello Threads");
    assert.equal(textForm.get("image_url"), null);
    const textPending = pendingOf(text.value);
    assert.equal(textPending.checkAfterMs, 30_000);
    assert.deepEqual(
      await run(threads.checkPostStatus({ accessToken: SECRETS.longToken, pendingData: textPending.pendingData })),
      {
        kind: "published",
        externalPostId: "th-media-1",
        url: "https://www.threads.com/@x/post/1",
      },
    );
    const image = await during(() => run(threads.publish({ ...base, body: "With image", media: png, hostImage })));
    assert.deepEqual(routesOf(image.sent), [
      `PUT ${R2_HOST}/content-bucket/<key>`,
      "POST graph.threads.com/v1.0/990011/threads",
    ]);
    const imageForm = new URLSearchParams(image.sent[1]?.body);
    assert.equal(imageForm.get("media_type"), "IMAGE");
    assert.match(imageForm.get("image_url") ?? "", /\.png$/u);
    const noHost = await during(() => flip(threads.publish({ ...base, body: "x", media: png })));
    assert.equal(noHost.sent.length, 0);
    assert.equal(noHost.value.code, "invalid");
    return { text: "published", image: "pending" };
  });

  const facebook = new FacebookPageAdapter(options);
  await step("10. Facebook sign-in: PKCE, code exchange, long-lived user token, exactly one Page", async () => {
    const { start } = authorizeChecks(
      facebook,
      `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`,
      FACEBOOK_SCOPES,
    );
    routes.set(`GET graph.facebook.com/${META_GRAPH_VERSION}/oauth/access_token`, (request) =>
      json(200, {
        access_token:
          request.url.searchParams.get("grant_type") === "fb_exchange_token" ? SECRETS.userToken : SECRETS.shortToken,
        token_type: "bearer",
        expires_in: 5_183_944,
      }),
    );
    let pages: unknown[] = [{ id: "page-1", name: "OpenBot Page", access_token: SECRETS.pageToken }];
    routes.set(`GET graph.facebook.com/${META_GRAPH_VERSION}/me/accounts`, () => json(200, { data: pages }));
    const input = {
      clientId: "client-1",
      clientSecret: SECRETS.appSecret,
      redirectUri: REDIRECT,
      code: SECRETS.code,
      codeVerifier: start.codeVerifier,
    };
    const { value, sent } = await during(() => run(facebook.authenticate(input)));
    const [code, exchange, accounts] = sent;
    assert.ok(code && exchange && accounts);
    assert.equal(code.url.searchParams.get("client_secret"), SECRETS.appSecret);
    assert.equal(code.url.searchParams.get("code_verifier"), start.codeVerifier);
    assert.equal(code.url.searchParams.get("redirect_uri"), REDIRECT);
    assert.equal(exchange.url.searchParams.get("grant_type"), "fb_exchange_token");
    assert.equal(exchange.url.searchParams.get("fb_exchange_token"), SECRETS.shortToken);
    assert.equal(accounts.url.searchParams.get("access_token"), SECRETS.userToken);
    assert.deepEqual(value.profile, {
      externalAccountId: "page-1",
      handle: "OpenBot Page",
      displayName: "OpenBot Page",
    });
    assert.equal(value.tokens.accessToken, SECRETS.pageToken);
    assert.equal(value.tokens.refreshToken, null);
    assert.equal(value.tokens.expiresAt, null);
    pages = [];
    assert.equal((await flip(facebook.authenticate(input))).message, "No Facebook Page.");
    pages = [
      { id: "page-1", name: "A", access_token: SECRETS.pageToken },
      { id: "page-2", name: "B", access_token: SECRETS.pageToken },
    ];
    assert.equal((await flip(facebook.authenticate(input))).message, "More than one Facebook Page.");
    const refresh = await flip(facebook.refreshToken());
    assert.equal(refresh.code, "signed-out");
    assert.equal(refresh.message, "Sign in to Facebook again.");
    return { page: value.profile.externalAccountId };
  });

  await step("11. Facebook publish: text to /feed, image as multipart `source` to /photos", async () => {
    routes.set(`POST graph.facebook.com/${META_GRAPH_VERSION}/page-1/feed`, () => json(200, { id: "page-1_111" }));
    routes.set(`POST graph.facebook.com/${META_GRAPH_VERSION}/page-1/photos`, () =>
      json(200, { id: "photo-5", post_id: "page-1_222" }),
    );
    const base = { accessToken: SECRETS.pageToken, profile: { externalAccountId: "page-1" }, title: null };
    const text = await during(() => run(facebook.publish({ ...base, body: "Page text", media: null })));
    assert.equal(new URLSearchParams(text.sent[0]?.body).get("message"), "Page text");
    assert.deepEqual(text.value, {
      kind: "published",
      externalPostId: "page-1_111",
      url: "https://www.facebook.com/page-1_111",
    });
    const photo = await during(() => run(facebook.publish({ ...base, body: "Page photo", media: png })));
    assert.equal(photo.sent.length, 1, "No image host: the bytes go to Facebook.");
    assert.match(photo.sent[0]?.body ?? "", /source=<file 16 image\/png>/u);
    assert.match(photo.sent[0]?.body ?? "", /message=Page photo/u);
    assert.match(photo.sent[0]?.body ?? "", /published=true/u);
    assert.deepEqual(photo.value, {
      kind: "published",
      externalPostId: "page-1_222",
      url: "https://www.facebook.com/page-1_222",
    });
    return { text: "page-1_111", photo: "page-1_222" };
  });

  await step(
    "12. Meta error classes: 190 signed-out, 4/17/32/613/80002 rate-limited, 10/200 rejected, 5xx server",
    async () => {
      const classify = async (status: number, code: number | null) =>
        await Effect.runPromise(
          Effect.flip(
            metaError(
              new Response(null, { status }),
              {
                error: {
                  message: `Detail with ${SECRETS.pageToken}`,
                  type: "OAuthException",
                  ...(code === null ? {} : { code }),
                },
              },
              "Facebook",
              "error.content.signInAgainFacebook",
            ),
          ),
        );
      assert.equal((await classify(400, 190)).code, "signed-out");
      for (const code of [4, 17, 32, 613, 80002]) assert.equal((await classify(400, code)).code, "rate-limited");
      const permission = await classify(403, 200);
      assert.equal(permission.code, "rejected");
      assert.match(permission.message, /may not have the permission/u);
      assert.equal((await classify(400, 10)).code, "rejected");
      assert.equal((await classify(503, null)).code, "server");
      assert.equal((await classify(400, 100)).code, "rejected");
      return { classes: 5 };
    },
  );

  const youtube = new YouTubeAdapter(options);
  await step(
    "13. YouTube sign-in: PKCE, offline consent, secret optional, channel profile; refresh and invalid_grant",
    async () => {
      const { start, url } = authorizeChecks(youtube, "https://accounts.google.com/o/oauth2/v2/auth", YOUTUBE_SCOPES);
      assert.equal(url.searchParams.get("access_type"), "offline");
      assert.equal(url.searchParams.get("prompt"), "consent");
      routes.set("POST oauth2.googleapis.com/token", (request) => {
        const form = new URLSearchParams(request.body);
        if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") === "ended")
          return json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
        return json(200, {
          access_token: SECRETS.googleAccess,
          expires_in: 3599,
          ...(form.get("grant_type") === "authorization_code" ? { refresh_token: SECRETS.googleRefresh } : {}),
          scope: YOUTUBE_SCOPES,
          token_type: "Bearer",
        });
      });
      routes.set("GET www.googleapis.com/youtube/v3/channels", () =>
        json(200, { items: [{ id: "UC123", snippet: { title: "OpenBot Channel", customUrl: "@openbot" } }] }),
      );
      const { value, sent } = await during(() =>
        run(
          youtube.authenticate({
            clientId: "client-1",
            clientSecret: null,
            redirectUri: REDIRECT,
            code: SECRETS.code,
            codeVerifier: start.codeVerifier,
          }),
        ),
      );
      const form = new URLSearchParams(sent[0]?.body);
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(form.get("code_verifier"), start.codeVerifier);
      assert.equal(form.get("client_secret"), null, "A Desktop client with no secret sends none.");
      assert.equal(sent[1]?.headers.authorization, `Bearer ${SECRETS.googleAccess}`);
      assert.deepEqual(value.profile, {
        externalAccountId: "UC123",
        handle: "@openbot",
        displayName: "OpenBot Channel",
      });
      assert.equal(value.tokens.refreshToken, SECRETS.googleRefresh);
      const refresh = await during(() =>
        run(
          youtube.refreshToken({
            clientId: "client-1",
            clientSecret: "desktop-secret-123456",
            refreshToken: SECRETS.googleRefresh,
          }),
        ),
      );
      const refreshForm = new URLSearchParams(refresh.sent[0]?.body);
      assert.equal(refreshForm.get("grant_type"), "refresh_token");
      assert.equal(refreshForm.get("client_secret"), "desktop-secret-123456", "A given secret goes.");
      assert.equal(refresh.value.refreshToken, null, "Google keeps the old refresh token.");
      const ended = await flip(
        youtube.refreshToken({ clientId: "client-1", clientSecret: null, refreshToken: "ended" }),
      );
      assert.equal(ended.code, "signed-out");
      assert.equal(ended.message, "Sign in to YouTube again.");
      return { channel: value.profile.externalAccountId };
    },
  );

  const uploadInput = {
    accessToken: SECRETS.googleAccess,
    profile: { externalAccountId: "UC123" },
    body: "Description",
    title: "Launch video",
    media: video,
  };
  const SESSION = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=session-1";
  await step(
    "14. YouTube resumable upload: start -> Location -> PUT -> 201 -> pending processing -> succeeded",
    async () => {
      routes.set(
        "POST www.googleapis.com/upload/youtube/v3/videos",
        () => new Response(null, { status: 200, headers: { location: SESSION } }),
      );
      routes.set("PUT www.googleapis.com/upload/youtube/v3/videos", () =>
        json(201, { id: "vid-1", kind: "youtube#video" }),
      );
      const { value, sent } = await during(() => run(youtube.publish(uploadInput)));
      const [startUpload, put] = sent;
      assert.ok(startUpload && put);
      assert.equal(startUpload.url.searchParams.get("uploadType"), "resumable");
      assert.equal(startUpload.url.searchParams.get("part"), "snippet,status");
      assert.equal(startUpload.headers["x-upload-content-length"], String(VIDEO.byteLength));
      assert.equal(startUpload.headers["x-upload-content-type"], "video/mp4");
      assert.deepEqual(JSON.parse(startUpload.body), {
        snippet: { title: "Launch video", description: "Description", categoryId: "22" },
        status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
      });
      assert.equal(put.url.toString(), SESSION);
      assert.equal(put.bytes, VIDEO.byteLength);
      const pending = pendingOf(value);
      assert.equal(pending.checkAfterMs, 60_000);
      let processing = "processing";
      routes.set("GET www.googleapis.com/youtube/v3/videos", () =>
        json(200, {
          items: [
            { id: "vid-1", status: { uploadStatus: "uploaded" }, processingDetails: { processingStatus: processing } },
          ],
        }),
      );
      const again = await during(() =>
        run(youtube.checkPostStatus({ accessToken: SECRETS.googleAccess, pendingData: pending.pendingData })),
      );
      assert.equal(again.sent[0]?.url.searchParams.get("part"), "status,processingDetails");
      assert.equal(again.sent[0]?.url.searchParams.get("id"), "vid-1");
      assert.equal(pendingOf(again.value).pendingData, pending.pendingData);
      processing = "succeeded";
      assert.deepEqual(
        await run(youtube.checkPostStatus({ accessToken: SECRETS.googleAccess, pendingData: pending.pendingData })),
        {
          kind: "published",
          externalPostId: "vid-1",
          url: "https://www.youtube.com/watch?v=vid-1",
        },
      );
      processing = "failed";
      const failed = await flip(
        youtube.checkPostStatus({ accessToken: SECRETS.googleAccess, pendingData: pending.pendingData }),
      );
      assert.equal(failed.code, "rejected");
      routes.set("GET www.googleapis.com/youtube/v3/videos", () =>
        json(200, {
          items: [
            { id: "vid-1", status: { uploadStatus: "rejected", rejectionReason: "duplicate" }, processingDetails: {} },
          ],
        }),
      );
      const rejected = await flip(
        youtube.checkPostStatus({ accessToken: SECRETS.googleAccess, pendingData: pending.pendingData }),
      );
      assert.equal(rejected.message, "YouTube refused the post: duplicate");
      routes.set("GET www.googleapis.com/youtube/v3/videos", () =>
        json(200, {
          items: [
            {
              id: "vid-1",
              status: { uploadStatus: "uploaded" },
              processingDetails: { processingStatus: "processing" },
            },
          ],
        }),
      );
      const start = clock;
      clock = new Date(start.getTime() + 24 * 60 * 60_000 + 1);
      const late = await flip(
        youtube.checkPostStatus({ accessToken: SECRETS.googleAccess, pendingData: pending.pendingData }),
      );
      clock = start;
      assert.equal(late.code, "unknown-result");
      return { video: "vid-1" };
    },
  );

  await step(
    "15. YouTube resume: 503 on the PUT -> status PUT -> 308 Range -> rest of the bytes; 404 restarts",
    async () => {
      let puts = 0;
      routes.set("PUT www.googleapis.com/upload/youtube/v3/videos", (request) => {
        puts += 1;
        if (request.headers["content-range"] === `bytes */${VIDEO.byteLength}`)
          return new Response(null, { status: 308, headers: { range: "bytes=0-1023" } });
        if (puts === 1) return json(503, { error: { code: 503, message: "Backend Error" } });
        return json(200, { id: "vid-2" });
      });
      const resumed = await during(() => run(youtube.publish(uploadInput)));
      assert.deepEqual(
        resumed.sent.map((request) => [request.method, request.headers["content-range"] ?? null, request.bytes]),
        [
          ["POST", null, Buffer.byteLength(resumed.sent[0]?.body ?? "")],
          ["PUT", null, 4096],
          ["PUT", "bytes */4096", 0],
          ["PUT", "bytes 1024-4095/4096", 3072],
        ],
      );
      assert.equal(pendingOf(resumed.value).kind, "pending");

      puts = 0;
      let starts = 0;
      routes.set("POST www.googleapis.com/upload/youtube/v3/videos", () => {
        starts += 1;
        return new Response(null, { status: 200, headers: { location: `${SESSION}-${starts}` } });
      });
      routes.set("PUT www.googleapis.com/upload/youtube/v3/videos", (request) => {
        puts += 1;
        if (request.headers["content-range"]) return new Response(null, { status: 404 });
        if (puts === 1) return json(500, {});
        return json(201, { id: "vid-3" });
      });
      const restarted = await during(() => run(youtube.publish(uploadInput)));
      assert.equal(starts, 2, "A 404 session starts a new upload.");
      assert.deepEqual(routesOf(restarted.sent), [
        "POST www.googleapis.com/upload/youtube/v3/videos",
        "PUT www.googleapis.com/upload/youtube/v3/videos",
        "PUT www.googleapis.com/upload/youtube/v3/videos",
        "POST www.googleapis.com/upload/youtube/v3/videos",
        "PUT www.googleapis.com/upload/youtube/v3/videos",
      ]);
      assert.equal(restarted.sent[4]?.url.searchParams.get("upload_id"), "session-1-2");
      return { resumedFrom: 1024, restarts: starts - 1 };
    },
  );

  await step(
    "16. YouTube errors: 401 signed-out, quotaExceeded and uploadLimitExceeded rate-limited, 400 rejected, 5xx server",
    async () => {
      const answer = (status: number, reason: string | null) => {
        routes.set("POST www.googleapis.com/upload/youtube/v3/videos", () =>
          json(status, {
            error: { code: status, message: `Detail ${SECRETS.googleAccess}`, errors: reason ? [{ reason }] : [] },
          }),
        );
        return flip(youtube.publish(uploadInput));
      };
      assert.equal((await answer(401, "authError")).code, "signed-out");
      assert.equal((await answer(403, "quotaExceeded")).code, "rate-limited");
      assert.equal((await answer(403, "uploadLimitExceeded")).code, "rate-limited");
      assert.equal((await answer(403, "forbidden")).code, "rejected");
      assert.equal((await answer(400, "invalidTitle")).code, "rejected");
      assert.equal((await answer(503, null)).code, "server");
      const noVideo = await during(() => flip(youtube.publish({ ...uploadInput, media: null })));
      assert.equal(noVideo.sent.length, 0);
      assert.equal(noVideo.value.code, "invalid");
      return { classes: 4 };
    },
  );

  await step(
    "17. No secret is in an error message; only fake hosts got requests; the global fetch was never called",
    async () => {
      // Each error path above put a token in the provider text; the redaction must hide it.
      const { registerSecretValue } = await import("@openbot/logging");
      for (const value of Object.values(SECRETS)) registerSecretValue(value);
      const messages: string[] = [];
      routes.set("GET graph.instagram.com/refresh_access_token", () =>
        json(400, { error: { message: `Bad ${SECRETS.longToken}`, code: 100 } }),
      );
      messages.push(
        (await flip(instagram.refreshToken({ clientId: "c", clientSecret: null, refreshToken: SECRETS.longToken })))
          .message,
      );
      messages.push(
        (
          await Effect.runPromise(
            Effect.flip(
              metaError(
                new Response(null, { status: 400 }),
                { error: { message: `Detail ${SECRETS.pageToken} ${SECRETS.appSecret}`, code: 100 } },
                "Facebook",
                "error.content.signInAgainFacebook",
              ),
            ),
          )
        ).message,
      );
      routes.set("POST www.googleapis.com/upload/youtube/v3/videos", () =>
        json(400, { error: { code: 400, message: `Detail ${SECRETS.googleAccess}` } }),
      );
      messages.push((await flip(youtube.publish(uploadInput))).message);
      for (const message of messages)
        for (const value of Object.values(SECRETS)) assert.ok(!message.includes(value), `A secret is in: ${message}`);
      const hosts = [...new Set(requests.map((request) => request.url.host))].sort();
      const allowed = new Set([
        R2_HOST,
        R2_PUBLIC,
        "api.instagram.com",
        "graph.instagram.com",
        "graph.threads.com",
        "graph.facebook.com",
        "oauth2.googleapis.com",
        "www.googleapis.com",
      ]);
      assert.deepEqual(
        hosts.filter((name) => !allowed.has(name)),
        [],
        "Only the fake hosts got requests.",
      );
      assert.equal(globalFetchCalls, 0);
      return { hosts, requests: requests.length, messages };
    },
  );

  report.passed = true;
} finally {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${report.passed ? "passed" : "FAILED"}: ${join(OUT, "report.json")}\n`);
}

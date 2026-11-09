// Checks the content publisher of step 2 on a real temporary profile: the real SQLite database with
// migration 60, the real agent store, the real X and LinkedIn adapters, the real account sign-in and
// the real due source of the routine timer. The networks are a fake `fetch` that answers as X and
// LinkedIn do and records each request; the cipher is a fake that marks its ciphertext; the clock is
// fixed. No port is bound and nothing leaves this process: the global `fetch` throws, and the check
// fails if anything calls it.
//
// Run: bunx tsx scripts/content-publish-e2e.ts
// (bun cannot load `node:sqlite`, so this runs on Node through tsx.)
// Writes .openbot-build/content-publish-e2e/report.json and exits non-zero on a failure.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CONTENT_PLATFORM_KEYS,
  type ContentMedia,
  type ContentPlatform,
  contentPostStatus,
} from "@openbot/contracts/ipc-content";
import { teeLogLines } from "@openbot/logging";
import { Effect } from "effect";
import { AgentStore } from "../src/backend/agent-store";
import { type ContentPostInput, ContentStateError, ContentStore } from "../src/backend/content/content-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { CONTENT_REDIRECT_URI, ContentAccounts } from "../src/main/content/content-accounts";
import type { ContentFetch } from "../src/main/content/content-adapter";
import { ContentPublisher } from "../src/main/content/content-publisher";
import { escapeLinkedInCommentary, LINKEDIN_API_VERSION, LinkedInAdapter } from "../src/main/content/linkedin-adapter";
import { X_SCOPES, XAdapter } from "../src/main/content/x-adapter";
import type { CallbackAnswer } from "../src/main/loopback-callback-server";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".openbot-build", "content-publish-e2e");

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

// Nothing may reach the real network.
let globalFetchCalls = 0;
const blockedFetch = async (): Promise<Response> => {
  globalFetchCalls += 1;
  throw new Error("The E2E called the global fetch.");
};
globalThis.fetch = Object.assign(blockedFetch, { preconnect: () => {} });

/** Every value that must never be stored or logged in plain text. */
const SECRETS = {
  xClientSecret: "x-client-secret-0123456789",
  xCode: "x-auth-code-0123456789",
  xAccess: "x-access-token-first-0123456789",
  xRefresh: "x-refresh-token-first-0123456789",
  xAccess2: "x-access-token-second-0123456789",
  xRefresh2: "x-refresh-token-second-0123456789",
  xRefreshRenewed: "x-refresh-token-renewed-0123456789",
  liClientSecret: "li-client-secret-0123456789",
  liCode: "li-auth-code-0123456789",
  liAccess: "li-access-token-0123456789",
};
const verifiers: string[] = [];

interface RecordedRequest {
  method: string;
  url: string;
  host: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

const requests: RecordedRequest[] = [];
/** What the fake X answers to a new post, and the state of the fake LinkedIn image. */
interface FakeState {
  tweetStatus: number;
  tweetBody: { title?: string; detail?: string; status?: number } | null;
  tweetHeaders: Record<string, string>;
  tweetId: number;
  linkedInImagePolls: number;
  rejectTokenOnce: string | null;
}
const fake: FakeState = {
  tweetStatus: 201,
  tweetBody: null,
  tweetHeaders: {},
  tweetId: 1000,
  linkedInImagePolls: 0,
  rejectTokenOnce: null,
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function bodyText(body: RequestInit["body"]): string {
  if (typeof body === "string") return body;
  if (body instanceof FormData)
    return [...body.entries()]
      .map(([key, value]: [string, FormDataEntryValue]) =>
        typeof value === "string" ? `${key}=${value}` : `${key}=<file ${value.size}>`,
      )
      .join("&");
  if (body instanceof Uint8Array) return `<bytes ${body.byteLength}>`;
  return "";
}

const fakeFetch: ContentFetch = async (url, init) => {
  const parsed = new URL(url);
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  const recorded: RecordedRequest = {
    method: init.method ?? "GET",
    url,
    host: parsed.host,
    path: parsed.pathname,
    headers,
    body: bodyText(init.body),
  };
  requests.push(recorded);
  const route = `${recorded.method} ${parsed.host}${parsed.pathname}`;
  const form = new URLSearchParams(recorded.body);
  switch (route) {
    case "POST api.x.com/2/oauth2/token":
      if (form.get("grant_type") === "authorization_code") {
        verifiers.push(form.get("code_verifier") ?? "");
        return json(200, {
          access_token: SECRETS.xAccess,
          refresh_token: SECRETS.xRefresh,
          expires_in: 7200,
          scope: X_SCOPES,
          token_type: "bearer",
        });
      }
      return json(200, {
        access_token: SECRETS.xAccess2,
        refresh_token: SECRETS.xRefresh2,
        expires_in: 7200,
        scope: X_SCOPES,
      });
    case "GET api.x.com/2/users/me":
      return json(200, { data: { id: "x-user-42", username: "openbot_test", name: "OpenBot Test" } });
    case "POST api.x.com/2/media/upload":
      return json(200, { data: { id: "x-media-7", media_key: "3_x-media-7" } });
    case "POST api.x.com/2/tweets": {
      // A token that X ended early: the first request with it gets 401 once.
      if (fake.rejectTokenOnce && headers.authorization === `Bearer ${fake.rejectTokenOnce}`) {
        fake.rejectTokenOnce = null;
        return json(401, { title: "Unauthorized", status: 401 });
      }
      if (fake.tweetStatus !== 201) return json(fake.tweetStatus, fake.tweetBody, fake.tweetHeaders);
      fake.tweetId += 1;
      return json(201, { data: { id: String(fake.tweetId), text: "ok" } });
    }
    case "POST www.linkedin.com/oauth/v2/accessToken":
      verifiers.push(form.get("code_verifier") ?? "");
      // An ordinary LinkedIn app gets no refresh token.
      return json(200, {
        access_token: SECRETS.liAccess,
        expires_in: 5_184_000,
        scope: "openid,profile,w_member_social",
      });
    case "GET api.linkedin.com/v2/userinfo":
      return json(200, { sub: "li-member-777", name: "Ada Lovelace" });
    case "POST api.linkedin.com/rest/images":
      return json(200, {
        value: { uploadUrl: "https://api.linkedin.com/mediaUpload/abc/upload", image: "urn:li:image:C4E10AQ" },
      });
    case "PUT api.linkedin.com/mediaUpload/abc/upload":
      return new Response(null, { status: 201 });
    case "GET api.linkedin.com/rest/images/urn%3Ali%3Aimage%3AC4E10AQ":
      fake.linkedInImagePolls += 1;
      return json(200, {
        id: "urn:li:image:C4E10AQ",
        status: fake.linkedInImagePolls === 1 ? "WAITING_UPLOAD" : "AVAILABLE",
      });
    case "POST api.linkedin.com/rest/posts":
      return new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:7001" } });
  }
  return json(404, { message: `The fake network has no route ${route}.` });
};

/** A reversible cipher whose output is marked, so a stored plaintext cannot pass for a ciphertext. */
const cipher = {
  persist: true,
  canPersist() {
    return this.persist;
  },
  encrypt: (value: string) => Buffer.from(`fake-cipher:${Buffer.from(value).reverse().toString("hex")}`),
  decrypt: (value: Buffer) => {
    const text = value.toString();
    assert.ok(text.startsWith("fake-cipher:"), "Only fake ciphertext is decrypted.");
    return Buffer.from(text.slice("fake-cipher:".length), "hex").reverse().toString();
  },
};

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const logs: string[] = [];
const stopLogs = teeLogLines(["content-publisher"], (line) => logs.push(line));

const root = await mkdtemp(join(tmpdir(), "openbot-content-publish-"));
const database = new OpenBotDatabase(join(root, "state"));
const agents = new AgentStore(join(root, "state"), join(root, "home"), database);

try {
  await runCauseEffect(agents.initialize());
  const agent = await runCauseEffect(
    agents.createAgent({ name: "Herald", description: "Writes posts", avatarSeed: "herald", avatarHue: null }),
  );
  let clock = new Date("2030-03-01T09:00:00.000Z");
  const now = () => clock;
  let arms = 0;
  const content = new ContentStore(database, () => {
    arms += 1;
  });
  const sleeps: number[] = [];
  const adapterOptions = {
    fetch: fakeFetch,
    now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
  let receive: ((url: URL) => CallbackAnswer) | null = null;
  let listens = 0;
  let closes = 0;
  let openedUrl: URL | null = null;
  const callbackAnswers: Array<{ name: string; answer: CallbackAnswer }> = [];
  /** What the browser does after OpenBot opens the sign-in page. */
  let browser: (page: URL) => void = () => {};
  const accounts = new ContentAccounts({
    store: content,
    cipher,
    appsPath: join(root, "state", "openbot-content-apps-v1.json"),
    adapters: [new XAdapter(adapterOptions), new LinkedInAdapter(adapterOptions)],
    openExternal: async (url) => {
      openedUrl = new URL(url);
      const page = openedUrl;
      setImmediate(() => browser(page));
    },
    listen: async (handler) => {
      listens += 1;
      receive = handler;
      return {
        close: async () => {
          closes += 1;
        },
      };
    },
    now,
  });
  const publisher = new ContentPublisher({ store: content, accounts, now });
  const callback = (name: string, query: Record<string, string>) => {
    assert.ok(receive, "A sign-in listens.");
    const answer = receive(new URL(`${CONTENT_REDIRECT_URI}?${new URLSearchParams(query)}`));
    callbackAnswers.push({ name, answer });
    return answer;
  };
  const pass = () => Effect.runPromise(publisher.processDue(clock, () => true));
  const requestsDuring = async (run: () => Promise<unknown>) => {
    const before = requests.length;
    await run();
    return requests.slice(before);
  };
  const variantOf = (postId: string, platform: ContentPlatform) => {
    const variant = content.readPost(postId)?.variants.find((candidate) => candidate.platform === platform);
    assert.ok(variant, `The post has a ${platform} variant.`);
    return variant;
  };
  const statuses = (postId: string) =>
    Object.fromEntries((content.readPost(postId)?.variants ?? []).map((variant) => [variant.platform, variant.status]));

  await mkdir(content.mediaRoot, { recursive: true });
  await writeFile(join(content.mediaRoot, "launch-image.png"), PNG);
  const image: ContentMedia = {
    id: "media-1",
    kind: "image",
    mimeType: "image/png",
    bytes: PNG.length,
    name: "launch.png",
    file: "launch-image.png",
  };
  const skip = { body: null, title: null, media: null, status: "skipped" as const };
  /** A post that needs no approval, queued for one hour later. */
  const queuedPost = (input: Partial<ContentPostInput>) => {
    const post = content.createPost(
      {
        body: "A post",
        media: null,
        approvalState: "none",
        scheduledFor: null,
        timezone: "UTC",
        authorAgentId: null,
        variants: {},
        ...input,
      },
      clock,
    );
    const time = new Date(clock.getTime() + 60 * 60_000);
    content.schedulePost(post.id, time.toISOString(), clock);
    return { id: post.id, time };
  };

  await step(
    "1. X connect: PKCE S256, state and redirect; a forged state is refused; tokens are ciphertext",
    async () => {
      await Effect.runPromise(accounts.setApp("x", { clientId: "x-client-id", clientSecret: null }));
      browser = (page) => {
        const forged = callback("forged state", { state: "forged-state-value", code: "forged-code-value" });
        assert.equal(forged.status, 400);
        callback("real state", { state: page.searchParams.get("state") ?? "", code: SECRETS.xCode });
      };
      const before = requests.length;
      const account = await Effect.runPromise(accounts.connect("x"));
      const page = openedUrl;
      assert.ok(page);
      assert.equal(page.origin + page.pathname, "https://x.com/i/oauth2/authorize");
      assert.equal(page.searchParams.get("response_type"), "code");
      assert.equal(page.searchParams.get("client_id"), "x-client-id");
      assert.equal(page.searchParams.get("redirect_uri"), "http://127.0.0.1:28418/content-auth");
      assert.equal(page.searchParams.get("scope"), "tweet.read tweet.write users.read media.write offline.access");
      assert.equal(page.searchParams.get("code_challenge_method"), "S256");
      const state = page.searchParams.get("state") ?? "";
      assert.ok(state.length >= 20);
      const [token, me] = requests.slice(before);
      assert.ok(token && me);
      const form = new URLSearchParams(token.body);
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(form.get("code"), SECRETS.xCode);
      assert.equal(form.get("redirect_uri"), CONTENT_REDIRECT_URI);
      assert.equal(form.get("client_id"), "x-client-id", "A public client sends its id in the body.");
      assert.equal(token.headers.authorization, undefined, "A public client sends no Basic header.");
      const verifier = form.get("code_verifier") ?? "";
      assert.equal(
        createHash("sha256").update(verifier).digest("base64url"),
        page.searchParams.get("code_challenge"),
        "The challenge is the S256 of the verifier.",
      );
      assert.equal(me.headers.authorization, `Bearer ${SECRETS.xAccess}`);
      // The same state a second time finds no sign-in.
      assert.equal(callback("replayed state", { state, code: SECRETS.xCode }).status, 400);
      assert.equal(listens, 1);
      assert.equal(closes, 1, "The listener closes after the sign-in.");

      assert.equal(account.platform, "x");
      assert.equal(account.handle, "openbot_test");
      assert.equal(account.status, "connected");
      assert.notEqual(account.tokenCiphertext, SECRETS.xAccess);
      assert.ok(Buffer.from(account.tokenCiphertext, "base64").toString().startsWith("fake-cipher:"));
      assert.equal(cipher.decrypt(Buffer.from(account.tokenCiphertext, "base64")), SECRETS.xAccess);
      assert.equal(cipher.decrypt(Buffer.from(account.refreshCiphertext ?? "", "base64")), SECRETS.xRefresh);
      assert.equal(account.expiresAt, new Date(clock.getTime() + 7200 * 1000).toISOString());

      // A confidential client uses Basic and sends no client id in the body.
      const confidential = await requestsDuring(() =>
        Effect.runPromise(
          new XAdapter(adapterOptions).authenticate({
            clientId: "x-client-id",
            clientSecret: SECRETS.xClientSecret,
            redirectUri: CONTENT_REDIRECT_URI,
            code: SECRETS.xCode,
            codeVerifier: verifier,
          }),
        ),
      );
      const basic = confidential[0];
      assert.ok(basic);
      assert.equal(
        basic.headers.authorization,
        `Basic ${Buffer.from(`x-client-id:${SECRETS.xClientSecret}`).toString("base64")}`,
      );
      assert.equal(new URLSearchParams(basic.body).get("client_id"), null);

      // The later steps check the refresh on their own, so this token does not end during them.
      content.updateAccountTokens(account.id, {
        tokenCiphertext: account.tokenCiphertext,
        refreshCiphertext: account.refreshCiphertext,
        scopes: account.scopes,
        expiresAt: "2031-01-01T00:00:00.000Z",
      });

      // A second X account is refused while one is connected.
      const second = await Effect.runPromise(Effect.flip(accounts.connect("x")));
      assert.match(second.message, /already has a connected account \(openbot_test\)/);
      return { state: "checked", account: account.id };
    },
  );

  await step("2. LinkedIn connect: client secret in the body, person id from userinfo, no refresh token", async () => {
    await Effect.runPromise(
      accounts.setApp("linkedin", { clientId: "li-client-id", clientSecret: SECRETS.liClientSecret }),
    );
    cipher.persist = false;
    const unavailable = await Effect.runPromise(Effect.flip(accounts.connect("linkedin")));
    assert.equal(unavailable.message, "System secret storage is unavailable.");
    cipher.persist = true;
    browser = (page) => callback("linkedin", { state: page.searchParams.get("state") ?? "", code: SECRETS.liCode });
    const before = requests.length;
    const account = await Effect.runPromise(accounts.connect("linkedin"));
    const page = openedUrl;
    assert.ok(page);
    assert.equal(page.origin + page.pathname, "https://www.linkedin.com/oauth/v2/authorization");
    assert.equal(page.searchParams.get("scope"), "openid profile w_member_social");
    assert.equal(page.searchParams.get("code_challenge_method"), "S256");
    const [token, userinfo] = requests.slice(before);
    assert.ok(token && userinfo);
    const form = new URLSearchParams(token.body);
    assert.equal(form.get("client_id"), "li-client-id");
    assert.equal(form.get("client_secret"), SECRETS.liClientSecret);
    assert.equal(form.get("code"), SECRETS.liCode);
    assert.equal(form.get("redirect_uri"), CONTENT_REDIRECT_URI);
    assert.equal(userinfo.url, "https://api.linkedin.com/v2/userinfo");
    assert.equal(account.externalAccountId, "li-member-777");
    assert.equal(account.handle, "Ada Lovelace");
    assert.equal(account.refreshCiphertext, null, "LinkedIn sent no refresh token.");
    const app = await Effect.runPromise(accounts.app("linkedin"));
    assert.equal(app?.clientSecret, SECRETS.liClientSecret);
    return { account: account.id };
  });

  const commentary = "Launch (v2) is live #ship @team_a [notes] *now* <3 {ok} | ~_~ \\o/";
  let launchPostId = "";

  await step("3. An approved post publishes on X and LinkedIn at its time; the four others stay queued", async () => {
    const time = new Date(clock.getTime() + 2 * 60 * 60_000);
    const post = content.createPost(
      {
        body: commentary,
        media: image,
        approvalState: "pending",
        scheduledFor: time.toISOString(),
        timezone: "Europe/Warsaw",
        authorAgentId: agent.id,
        variants: {},
      },
      clock,
    );
    launchPostId = post.id;
    assert.equal(publisher.nextDueAt(), null, "A pending post is never due.");
    const armsBefore = arms;
    content.approvePost(post.id, clock);
    assert.ok(arms > armsBefore, "The approve plans the timer again.");
    assert.deepEqual(new Set(Object.values(statuses(post.id))), new Set(["queued"]));
    assert.equal(publisher.nextDueAt(), time.toISOString());

    // Before the time nothing happens.
    assert.equal((await requestsDuring(pass)).length, 0);
    clock = time;
    const sent = await requestsDuring(pass);
    // The two networks are due at the same time, in any order. Each network keeps its own order.
    const xSent = sent.filter((request) => request.host === "api.x.com");
    const linkedInSent = sent.filter((request) => request.host === "api.linkedin.com");
    assert.equal(sent.length, xSent.length + linkedInSent.length);
    assert.deepEqual(
      xSent.map((request) => `${request.method} ${request.host}${request.path}`),
      ["POST api.x.com/2/media/upload", "POST api.x.com/2/tweets"],
    );
    assert.deepEqual(
      linkedInSent.map((request) => `${request.method} ${request.host}${request.path}`),
      [
        "POST api.linkedin.com/rest/images",
        "PUT api.linkedin.com/mediaUpload/abc/upload",
        "GET api.linkedin.com/rest/images/urn%3Ali%3Aimage%3AC4E10AQ",
        "GET api.linkedin.com/rest/images/urn%3Ali%3Aimage%3AC4E10AQ",
        "POST api.linkedin.com/rest/posts",
      ],
    );
    const [upload, tweet] = xSent;
    const [init, put, , , linkedInPost] = linkedInSent;
    assert.ok(upload && tweet && init && put && linkedInPost);
    assert.match(upload.body, /media=<file 16>/);
    assert.match(upload.body, /media_category=tweet_image/);
    assert.deepEqual(JSON.parse(tweet.body), { text: commentary, media: { media_ids: ["x-media-7"] } });
    assert.equal(tweet.headers.authorization, `Bearer ${SECRETS.xAccess}`);
    assert.deepEqual(JSON.parse(init.body), { initializeUploadRequest: { owner: "urn:li:person:li-member-777" } });
    assert.equal(init.headers["linkedin-version"], LINKEDIN_API_VERSION);
    assert.equal(init.headers["x-restli-protocol-version"], "2.0.0");
    assert.equal(put.body, "<bytes 16>");
    assert.equal(put.headers.authorization, `Bearer ${SECRETS.liAccess}`);
    assert.deepEqual(sleeps, [1000], "LinkedIn waits about 1 s between two image reads.");
    const posted = JSON.parse(linkedInPost.body);
    assert.equal(posted.author, "urn:li:person:li-member-777");
    assert.equal(posted.commentary, escapeLinkedInCommentary(commentary));
    assert.equal(
      posted.commentary,
      "Launch \\(v2\\) is live \\#ship \\@team\\_a \\[notes\\] \\*now\\* \\<3 \\{ok\\} \\| \\~\\_\\~ \\\\o/",
    );
    assert.deepEqual(posted.content, { media: { id: "urn:li:image:C4E10AQ" } });
    assert.equal(posted.visibility, "PUBLIC");
    assert.equal(posted.lifecycleState, "PUBLISHED");

    const x = variantOf(post.id, "x");
    const linkedin = variantOf(post.id, "linkedin");
    assert.equal(x.status, "published");
    assert.equal(x.externalPostId, "1001");
    assert.equal(x.attempt, 1);
    assert.ok(x.accountId);
    assert.equal(linkedin.status, "published");
    assert.equal(linkedin.externalPostId, "urn:li:share:7001");
    for (const platform of ["instagram", "threads", "facebook_page", "youtube"] as const) {
      const variant = variantOf(post.id, platform);
      assert.equal(variant.status, "queued");
      assert.equal(variant.error, null);
      assert.equal(variant.attempt, 0);
    }
    // The timer does not spin: the four networks with no adapter are not due.
    assert.equal(publisher.nextDueAt(), null);
    assert.equal((await requestsDuring(pass)).length, 0, "A second pass sends nothing.");
    assert.equal(content.nextDueAt([...CONTENT_PLATFORM_KEYS]), time.toISOString(), "The four are still queued.");
    return { requests: sent.length, statuses: statuses(post.id) };
  });

  await step("4. The post status is queued while the four networks with no adapter wait (step 2 reality)", async () => {
    const post = content.readPost(launchPostId);
    assert.ok(post);
    assert.equal(contentPostStatus(post.variants), "queued");
    return { status: contentPostStatus(post.variants) };
  });

  await step(
    "5. X 500 fails as server, waits for a manual retry, then publishes; 429 and 403 fail clearly",
    async () => {
      const post = queuedPost({ body: "Retry check", variants: { linkedin: skip } });
      fake.tweetStatus = 500;
      fake.tweetBody = { title: "Internal Error" };
      clock = post.time;
      await pass();
      let x = variantOf(post.id, "x");
      assert.equal(x.status, "failed");
      assert.equal(x.errorCode, "server");
      assert.equal(x.error, "X had a server error (500).");
      fake.tweetStatus = 201;
      clock = new Date(clock.getTime() + 60 * 60_000);
      assert.equal((await requestsDuring(pass)).length, 0, "No automatic retry.");
      assert.equal(variantOf(post.id, "x").status, "failed");
      const armsBefore = arms;
      content.retryVariant(post.id, "x", clock);
      assert.ok(arms > armsBefore);
      assert.equal(variantOf(post.id, "x").status, "queued");
      assert.equal(publisher.nextDueAt(), post.time.toISOString(), "The kept time makes it due at once.");
      await pass();
      x = variantOf(post.id, "x");
      assert.equal(x.status, "published");
      assert.equal(x.attempt, 2);

      const limited = queuedPost({ body: "Rate limit check", variants: { linkedin: skip } });
      fake.tweetStatus = 429;
      fake.tweetBody = { title: "Too Many Requests" };
      fake.tweetHeaders = { "x-rate-limit-reset": String(Date.parse("2030-03-01T15:00:00Z") / 1000) };
      clock = limited.time;
      await pass();
      const rateLimited = variantOf(limited.id, "x");
      assert.equal(rateLimited.errorCode, "rate-limited");
      assert.equal(rateLimited.error, "X limits the posts now. Try again after 2030-03-01T15:00:00.000Z.");

      const refused = queuedPost({ body: "Refusal check", variants: { linkedin: skip } });
      fake.tweetStatus = 403;
      // The network repeats the token in its error text. The stored text must not hold it.
      fake.tweetBody = {
        detail: `You are not permitted to create a duplicate post (${SECRETS.xAccess}).`,
        status: 403,
      };
      fake.tweetHeaders = {};
      clock = refused.time;
      await pass();
      const rejected = variantOf(refused.id, "x");
      assert.equal(rejected.errorCode, "rejected");
      assert.match(rejected.error ?? "", /^X refused the post: You are not permitted to create a duplicate post/);
      assert.ok(!rejected.error?.includes(SECRETS.xAccess), "The token in the provider text is masked.");
      fake.tweetStatus = 201;
      return { server: "retried", rateLimited: rateLimited.error, rejected: rejected.error };
    },
  );

  await step("6a. An X token near its end is refreshed once, stored encrypted, then used", async () => {
    const xAccount = content.connectedAccount("x");
    assert.ok(xAccount);
    content.updateAccountTokens(xAccount.id, {
      tokenCiphertext: xAccount.tokenCiphertext,
      refreshCiphertext: xAccount.refreshCiphertext,
      scopes: xAccount.scopes,
      expiresAt: new Date(clock.getTime() + 60 * 60_000 + 30_000).toISOString(),
    });
    const post = queuedPost({ body: "Refresh check", variants: { linkedin: skip } });
    clock = post.time;
    const sent = await requestsDuring(pass);
    assert.deepEqual(
      sent.map((request) => `${request.method} ${request.host}${request.path}`),
      ["POST api.x.com/2/oauth2/token", "POST api.x.com/2/tweets"],
    );
    const [refresh, tweet] = sent;
    assert.ok(refresh && tweet);
    const form = new URLSearchParams(refresh.body);
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.equal(form.get("refresh_token"), SECRETS.xRefresh);
    assert.equal(form.get("client_id"), "x-client-id");
    assert.equal(tweet.headers.authorization, `Bearer ${SECRETS.xAccess2}`);
    const after = content.readAccount(xAccount.id);
    assert.ok(after);
    assert.equal(cipher.decrypt(Buffer.from(after.tokenCiphertext, "base64")), SECRETS.xAccess2);
    assert.equal(cipher.decrypt(Buffer.from(after.refreshCiphertext ?? "", "base64")), SECRETS.xRefresh2);
    assert.ok(!after.tokenCiphertext.includes(SECRETS.xAccess2));
    assert.equal(variantOf(post.id, "x").status, "published");
    return { refreshes: 1 };
  });

  await step("6c. A refresh sends the refresh token that is stored at that time, not an older one", async () => {
    const xAccount = content.connectedAccount("x");
    assert.ok(xAccount);
    // A publish that needs no refresh.
    content.updateAccountTokens(xAccount.id, {
      tokenCiphertext: xAccount.tokenCiphertext,
      refreshCiphertext: xAccount.refreshCiphertext,
      scopes: xAccount.scopes,
      expiresAt: "2031-01-01T00:00:00.000Z",
    });
    const first = queuedPost({ body: "No refresh needed", variants: { linkedin: skip } });
    clock = first.time;
    assert.deepEqual(
      (await requestsDuring(pass)).map((request) => `${request.method} ${request.host}${request.path}`),
      ["POST api.x.com/2/tweets"],
    );
    // The stored refresh token changes, as a new sign-in changes it. Then the token is near its end.
    content.updateAccountTokens(xAccount.id, {
      tokenCiphertext: xAccount.tokenCiphertext,
      refreshCiphertext: cipher.encrypt(SECRETS.xRefreshRenewed).toString("base64"),
      scopes: xAccount.scopes,
      expiresAt: new Date(clock.getTime() + 60 * 60_000 + 30_000).toISOString(),
    });
    const second = queuedPost({ body: "Refresh after a new sign-in", variants: { linkedin: skip } });
    clock = second.time;
    const refresh = (await requestsDuring(pass)).find((request) => request.path === "/2/oauth2/token");
    assert.ok(refresh, "The token near its end is refreshed.");
    assert.equal(new URLSearchParams(refresh.body).get("refresh_token"), SECRETS.xRefreshRenewed);
    assert.equal(variantOf(second.id, "x").status, "published");
    return { refreshToken: "current" };
  });

  await step("6d. A 401 on a token that should still work refreshes once and posts once more", async () => {
    const xAccount = content.connectedAccount("x");
    assert.ok(xAccount);
    content.updateAccountTokens(xAccount.id, {
      tokenCiphertext: xAccount.tokenCiphertext,
      refreshCiphertext: xAccount.refreshCiphertext,
      scopes: xAccount.scopes,
      expiresAt: "2031-01-01T00:00:00.000Z",
    });
    fake.rejectTokenOnce = cipher.decrypt(Buffer.from(xAccount.tokenCiphertext, "base64"));
    const post = queuedPost({ body: "Token ended early", variants: { linkedin: skip } });
    clock = post.time;
    const sent = await requestsDuring(pass);
    assert.deepEqual(
      sent.map((request) => `${request.method} ${request.host}${request.path}`),
      ["POST api.x.com/2/tweets", "POST api.x.com/2/oauth2/token", "POST api.x.com/2/tweets"],
    );
    const x = variantOf(post.id, "x");
    assert.equal(x.status, "published");
    assert.equal(x.attempt, 1, "The second request is part of one attempt.");
    assert.equal(fake.rejectTokenOnce, null);
    return { requests: sent.length };
  });

  await step(
    "7. Decision B: a disconnected X keeps its variant queued, then fails signed-out at the time",
    async () => {
      const post = queuedPost({ body: "Disconnect check" });
      const xAccount = content.connectedAccount("x");
      assert.ok(xAccount);
      accounts.disconnect(xAccount.id);
      const revoked = content.readAccount(xAccount.id);
      assert.equal(revoked?.status, "revoked");
      assert.equal(revoked?.tokenCiphertext, "");
      assert.equal(revoked?.refreshCiphertext, null);
      assert.equal(variantOf(post.id, "x").status, "queued", "No auto-skip and no move to draft.");
      clock = post.time;
      fake.linkedInImagePolls = 0;
      const sent = await requestsDuring(pass);
      assert.ok(
        sent.every((request) => !request.host.endsWith("x.com")),
        "X gets no request.",
      );
      const x = variantOf(post.id, "x");
      assert.equal(x.status, "failed");
      assert.equal(x.errorCode, "signed-out");
      assert.equal(x.error, "Sign in to X again.");
      assert.equal(variantOf(post.id, "linkedin").status, "published", "LinkedIn is not affected.");
      for (const platform of ["instagram", "threads", "facebook_page", "youtube"] as const)
        assert.equal(variantOf(post.id, platform).status, "queued");
      return { statuses: statuses(post.id) };
    },
  );

  await step(
    "6b. An expired LinkedIn token with no refresh token fails signed-out and marks the account expired",
    async () => {
      const linkedIn = content.connectedAccount("linkedin");
      assert.ok(linkedIn);
      content.updateAccountTokens(linkedIn.id, {
        tokenCiphertext: linkedIn.tokenCiphertext,
        refreshCiphertext: null,
        scopes: linkedIn.scopes,
        expiresAt: new Date(clock.getTime() - 1000).toISOString(),
      });
      const post = queuedPost({ body: "Expired check", variants: { x: skip } });
      clock = post.time;
      assert.equal((await requestsDuring(pass)).length, 0);
      const variant = variantOf(post.id, "linkedin");
      assert.equal(variant.status, "failed");
      assert.equal(variant.errorCode, "signed-out");
      assert.equal(variant.error, "Sign in to LinkedIn again.");
      assert.equal(content.readAccount(linkedIn.id)?.status, "expired");
      return { account: "expired" };
    },
  );

  let interruptedPostId = "";

  // Decision A as updated in step 3a: unschedule removes the time (NULL), and unskip gives `queued` only
  // when another network of the post is queued, so a queued variant always belongs to a live schedule.
  await step("8. Decision A: unschedule, skip and unskip; refused while publishing or published", async () => {
    const live = queuedPost({ body: "Live plan check" });
    content.setVariantSkipped(live.id, "x", true, clock);
    assert.equal(variantOf(live.id, "x").status, "skipped", "A queued network can be skipped.");
    content.setVariantSkipped(live.id, "x", false, clock);
    assert.equal(variantOf(live.id, "x").status, "queued", "Another network is queued, so it queues again.");

    const post = queuedPost({ body: "Plan check" });
    content.unschedulePost(post.id, clock);
    const after = content.readPost(post.id);
    assert.equal(after?.scheduledFor, null, "The user removed the time.");
    assert.deepEqual(new Set(Object.values(statuses(post.id))), new Set(["draft"]));
    content.setVariantSkipped(post.id, "x", true, clock);
    assert.equal(variantOf(post.id, "x").status, "skipped");
    content.setVariantSkipped(post.id, "x", false, clock);
    assert.equal(variantOf(post.id, "x").status, "draft", "No other network is queued, so it is a draft.");
    assert.equal(content.readPost(post.id)?.scheduledFor, null, "An unskip does not bring the time back.");
    const pending = content.createPost(
      {
        body: "Pending plan",
        media: null,
        approvalState: "pending",
        scheduledFor: post.time.toISOString(),
        timezone: "UTC",
        authorAgentId: agent.id,
        variants: { x: skip },
      },
      clock,
    );
    content.setVariantSkipped(pending.id, "x", false, clock);
    assert.equal(variantOf(pending.id, "x").status, "draft", "A pending post goes back to draft.");

    assert.throws(() => content.setVariantSkipped(launchPostId, "x", true, clock), ContentStateError);
    const publishing = queuedPost({ body: "Publishing check", variants: { linkedin: skip } });
    interruptedPostId = publishing.id;
    assert.equal(content.claimVariant(variantOf(publishing.id, "x").id, null, clock), true);
    assert.equal(content.claimVariant(variantOf(publishing.id, "x").id, null, clock), false, "One claim only.");
    assert.equal(variantOf(publishing.id, "x").status, "publishing");
    assert.throws(() => content.setVariantSkipped(publishing.id, "x", true, clock), ContentStateError);
    assert.throws(() => content.unschedulePost(publishing.id, clock), ContentStateError);
    assert.throws(() => content.retryVariant(publishing.id, "x", clock), ContentStateError);
    return { planned: statuses(post.id) };
  });

  await step(
    "10. Restart: a publishing variant with no pending data fails as unknown-result and is not sent again",
    async () => {
      const recovered = content.recoverInterrupted(clock);
      assert.equal(recovered, 1);
      const x = variantOf(interruptedPostId, "x");
      assert.equal(x.status, "failed");
      assert.equal(x.errorCode, "unknown-result");
      assert.equal(x.error, "OpenBot stopped while it posted. Check X before you retry.");
      clock = new Date(clock.getTime() + 2 * 60 * 60_000);
      const sent = await requestsDuring(pass);
      assert.equal(sent.length, 0, "No automatic second request.");
      assert.equal(variantOf(interruptedPostId, "x").status, "failed");
      return { recovered };
    },
  );

  await step("11. Text over the limit or the wrong media kind fails as invalid with no request", async () => {
    // Connect X again, so only the text decides.
    browser = (page) => callback("x again", { state: page.searchParams.get("state") ?? "", code: SECRETS.xCode });
    await Effect.runPromise(accounts.connect("x"));
    const video: ContentMedia = { ...image, id: "media-2", kind: "video", mimeType: "video/mp4", file: "teaser.mp4" };
    const post = queuedPost({
      body: "Invalid check",
      variants: {
        x: { body: "x".repeat(281), title: null, media: null, status: "draft" },
        linkedin: { body: null, title: null, media: video, status: "draft" },
      },
    });
    clock = post.time;
    const sent = await requestsDuring(pass);
    assert.equal(sent.length, 0);
    const x = variantOf(post.id, "x");
    const linkedin = variantOf(post.id, "linkedin");
    assert.equal(x.errorCode, "invalid");
    assert.equal(x.error, "The text or the title is too long for this network.");
    assert.equal(linkedin.errorCode, "invalid");
    assert.equal(linkedin.error, "This network takes only images.");
    return { x: x.error, linkedin: linkedin.error };
  });

  await step("9. Decision C: deleting the author agent keeps its posts, published ids and events", async () => {
    const countEvents = () =>
      Number(
        database.connection
          .prepare(
            "SELECT COUNT(*) AS n FROM orchestration_events WHERE aggregate_type = 'content-post' AND aggregate_id = ?",
          )
          .get(launchPostId)?.n,
      );
    const events = countEvents();
    assert.ok(events > 0);
    await runCauseEffect(agents.deleteAgent(agent.id));
    assert.equal(
      agents.list().some((candidate) => candidate.id === agent.id),
      false,
      "The agent is gone.",
    );
    const post = content.readPost(launchPostId);
    assert.ok(post, "The post stays.");
    assert.equal(post.authorAgentId, agent.id);
    assert.equal(post.variants.length, 6);
    assert.equal(variantOf(launchPostId, "x").externalPostId, "1001");
    assert.equal(variantOf(launchPostId, "linkedin").externalPostId, "urn:li:share:7001");
    assert.equal(countEvents(), events, "The events stay.");
    return { events };
  });

  await step(
    "12. No token, code, verifier or client secret is in a row, an event, a receipt or a log line",
    async () => {
      const values = [...Object.values(SECRETS), ...verifiers];
      assert.ok(verifiers.length >= 2 && verifiers.every((verifier) => verifier.length >= 43));
      const text = [
        ...database.connection
          .prepare("SELECT payload_json AS t FROM orchestration_events WHERE aggregate_type LIKE 'content-%'")
          .all()
          .map((row) => String(row.t)),
        ...database.connection
          .prepare("SELECT result_json AS t FROM orchestration_command_receipts")
          .all()
          .map((row) => String(row.t)),
        ...database.connection
          .prepare("SELECT COALESCE(error, '') || ' ' || COALESCE(pending_data, '') AS t FROM content_variants")
          .all()
          .map((row) => String(row.t)),
        ...database.connection
          .prepare("SELECT token_ciphertext || ' ' || COALESCE(refresh_ciphertext, '') AS t FROM content_accounts")
          .all()
          .map((row) => String(row.t)),
        ...logs,
      ].join("\n");
      for (const value of values) assert.ok(!text.includes(value), "A secret value is stored or logged in plain text.");
      const accountEvents = database.connection
        .prepare("SELECT event_type, payload_json FROM orchestration_events WHERE aggregate_type = 'content-account'")
        .all();
      assert.ok(accountEvents.length >= 4);
      for (const event of accountEvents)
        assert.deepEqual(Object.keys(JSON.parse(String(event.payload_json))).sort(), [
          "accountId",
          "expiresAt",
          "handle",
          "platform",
          "status",
        ]);
      const appsFile = await readFile(join(root, "state", "openbot-content-apps-v1.json"), "utf8");
      for (const value of values) assert.ok(!appsFile.includes(value), "The apps file holds no plain secret.");
      return { checkedValues: values.length, events: accountEvents.length, logLines: logs.length };
    },
  );

  await step("Only the fake X and LinkedIn hosts got requests, and the global fetch was never called", async () => {
    const hosts = [...new Set(requests.map((request) => request.host))].sort();
    assert.deepEqual(hosts, ["api.linkedin.com", "api.x.com", "www.linkedin.com"]);
    assert.equal(globalFetchCalls, 0);
    return {
      hosts,
      requests: requests.length,
      callbacks: callbackAnswers.map(({ name, answer }) => [name, answer.status]),
    };
  });

  report.passed = true;
} finally {
  stopLogs();
  database.close();
  await rm(root, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${report.passed ? "passed" : "FAILED"}: ${join(OUT, "report.json")}\n`);
}

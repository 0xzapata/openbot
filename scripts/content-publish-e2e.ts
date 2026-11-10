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
import { sourceText } from "@openbot/i18n/source";
import { teeLogLines } from "@openbot/logging";
import { Effect } from "effect";
import { AgentStore } from "../src/backend/agent-store";
import { type ContentPostInput, ContentStateError, ContentStore } from "../src/backend/content/content-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { CONTENT_MEDIA_HOST_FILE, CONTENT_REDIRECT_URI, ContentAccounts } from "../src/main/content/content-accounts";
import type { ContentFetch } from "../src/main/content/content-adapter";
import { R2MediaHost } from "../src/main/content/content-media-host";
import { ContentPublisher } from "../src/main/content/content-publisher";
import { ContentService, contentPostView } from "../src/main/content/content-service";
import { escapeLinkedInCommentary, LINKEDIN_API_VERSION, LinkedInAdapter } from "../src/main/content/linkedin-adapter";
import { FacebookPageAdapter, InstagramAdapter, ThreadsAdapter } from "../src/main/content/meta-adapters";
import { X_SCOPES, XAdapter } from "../src/main/content/x-adapter";
import { YouTubeAdapter } from "../src/main/content/youtube-adapter";
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
  const content = new ContentStore(
    database,
    () => {
      arms += 1;
    },
    () => {},
    () => accounts.platforms,
  );
  // An older version queued every network; this store writes such rows for the "older data" checks.
  const olderVersion = new ContentStore(database);
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
    mediaHostPath: join(root, "state", "openbot-content-media-host-v1.json"),
    mediaHost: () => {
      throw new Error("This check sets up no image host.");
    },
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

  await step("3. An approved post publishes on X and LinkedIn at its time; approve skips the four others", async () => {
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
    assert.deepEqual(statuses(post.id), {
      x: "queued",
      linkedin: "queued",
      instagram: "skipped",
      threads: "skipped",
      facebook_page: "skipped",
      youtube: "skipped",
    });
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
      assert.equal(variant.status, "skipped");
      assert.equal(variant.error, null);
      assert.equal(variant.attempt, 0);
    }
    assert.equal(publisher.nextDueAt(), null);
    assert.equal((await requestsDuring(pass)).length, 0, "A second pass sends nothing.");
    assert.equal(contentPostStatus(content.readPost(post.id)?.variants ?? []), "published");
    return { requests: sent.length, statuses: statuses(post.id) };
  });

  await step(
    "4. Older data: a queued network with no adapter stays untouched and does not spin the timer",
    async () => {
      const older = olderVersion.createPost(
        {
          body: "Older data",
          media: null,
          approvalState: "none",
          scheduledFor: clock.toISOString(),
          timezone: "UTC",
          authorAgentId: null,
          variants: { x: skip, linkedin: skip },
        },
        clock,
      );
      assert.equal(variantOf(older.id, "instagram").status, "queued", "The older version queued it.");
      assert.equal(publisher.nextDueAt(), null, "The timer does not spin.");
      assert.equal((await requestsDuring(pass)).length, 0);
      assert.equal(variantOf(older.id, "instagram").status, "queued", "No pass changes it.");
      assert.equal(content.nextDueAt([...CONTENT_PLATFORM_KEYS]), clock.toISOString(), "It is still queued.");
      const post = content.readPost(older.id);
      assert.ok(post);
      assert.equal(contentPostStatus(post.variants), "queued");
      content.deletePost(older.id);
      return { status: contentPostStatus(post.variants) };
    },
  );

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
        assert.equal(variantOf(post.id, platform).status, "skipped", "Schedule skips a network with no adapter.");
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
    assert.equal(variantOf(post.id, "x").status, "draft");
    assert.equal(variantOf(post.id, "linkedin").status, "draft");
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

  // Step 4: all six adapters and the image host, on a second profile, so the earlier X and LinkedIn
  // checks stay as they are. The networks and the R2 bucket are a second fake `fetch`.
  const state2 = join(root, "state2");
  const database2 = new OpenBotDatabase(state2);
  try {
    await runCauseEffect(new AgentStore(state2, join(root, "home2"), database2).initialize());
    const R2 = "r2.fake.example.test";
    const PUBLIC = "pub.fake.example.test";
    const R2_SECRET = "test-r2-secret-access-key-0123456789";
    const bucket = new Map<string, Buffer>();
    let failDeletes = 0;
    // `bucket` is the bucket of an S3 request, or "public" for a read over the public URL.
    const r2Log: Array<{ method: string; key: string; bucket: string }> = [];
    const sent4: Array<{ route: string; body: string }> = [];
    const answers = { ig: "IN_PROGRESS", th: "FINISHED", yt: "processing" };
    const fetch4: ContentFetch = async (url, init) => {
      const parsed = new URL(url);
      const method = init.method ?? "GET";
      if (parsed.host === R2) {
        const key = decodeURIComponent(parsed.pathname.replace(/^\/[^/]+\//u, ""));
        r2Log.push({ method, key, bucket: parsed.pathname.split("/")[1] ?? "" });
        if (method === "PUT") {
          assert.ok(init.body instanceof Uint8Array);
          bucket.set(key, Buffer.from(init.body));
          return new Response(null, { status: 200 });
        }
        if (failDeletes > 0) {
          failDeletes -= 1;
          return new Response(null, { status: 503 });
        }
        bucket.delete(key);
        return new Response(null, { status: 204 });
      }
      if (parsed.host === PUBLIC) {
        r2Log.push({ method: "GET", key: parsed.pathname.slice(1), bucket: "public" });
        const object = bucket.get(parsed.pathname.slice(1));
        return object ? new Response(new Uint8Array(object), { status: 200 }) : new Response(null, { status: 404 });
      }
      const route = `${method} ${parsed.host}${parsed.pathname}`;
      sent4.push({ route, body: bodyText(init.body) });
      switch (route) {
        case "POST graph.instagram.com/v24.0/ig-1/media":
          return json(200, { id: "ig-c1" });
        case "GET graph.instagram.com/v24.0/ig-c1":
          return json(200, { status_code: answers.ig, status: "Error: the image could not be read" });
        case "POST graph.instagram.com/v24.0/ig-1/media_publish":
          return json(200, { id: "ig-m1" });
        case "GET graph.instagram.com/v24.0/ig-m1":
          return json(200, { permalink: "https://www.instagram.com/p/ig-m1/" });
        case "POST graph.threads.com/v1.0/th-1/threads":
          return json(200, { id: "th-c1" });
        case "GET graph.threads.com/v1.0/th-c1":
          return json(200, { status: answers.th });
        case "POST graph.threads.com/v1.0/th-1/threads_publish":
          return json(200, { id: "th-m1" });
        case "GET graph.threads.com/v1.0/th-m1":
          return json(200, { permalink: "https://www.threads.com/@t/post/th-m1" });
        case "POST graph.facebook.com/v24.0/page-1/feed":
          return json(200, { id: "page-1_1" });
        case "POST www.googleapis.com/upload/youtube/v3/videos":
          return new Response(null, {
            status: 200,
            headers: { location: `https://www.googleapis.com/upload/youtube/v3/videos?upload_id=s1` },
          });
        case "PUT www.googleapis.com/upload/youtube/v3/videos":
          return json(201, { id: "vid-1" });
        case "GET www.googleapis.com/youtube/v3/videos":
          return json(200, {
            items: [
              {
                id: "vid-1",
                status: { uploadStatus: "uploaded" },
                processingDetails: { processingStatus: answers.yt },
              },
            ],
          });
      }
      return json(404, { error: { message: `No fake route ${route}`, code: 803 } });
    };
    const options4 = { fetch: fetch4, now, sleep: async () => {} };
    let arms2 = 0;
    const build = () => {
      const store = new ContentStore(
        database2,
        () => {
          arms2 += 1;
        },
        () => {},
        () => accounts2.platforms,
      );
      const accounts2: ContentAccounts = new ContentAccounts({
        store,
        cipher,
        appsPath: join(state2, "openbot-content-apps-v1.json"),
        adapters: [
          new XAdapter(options4),
          new LinkedInAdapter(options4),
          new InstagramAdapter(options4),
          new ThreadsAdapter(options4),
          new FacebookPageAdapter(options4),
          new YouTubeAdapter(options4),
        ],
        mediaHostPath: join(state2, CONTENT_MEDIA_HOST_FILE),
        mediaHost: (settings) => new R2MediaHost({ fetch: fetch4, now, settings }),
        openExternal: async () => {},
        listen: async () => ({ close: async () => {} }),
        now,
      });
      return { store, accounts2, publisher2: new ContentPublisher({ store, accounts: accounts2, now }) };
    };
    let { store: content2, accounts2, publisher2 } = build();
    const pass2 = () => Effect.runPromise(publisher2.processDue(clock, () => true));
    const variant2 = (postId: string, platform: ContentPlatform) => {
      const found = content2.readPost(postId)?.variants.find((candidate) => candidate.platform === platform);
      assert.ok(found);
      return found;
    };
    const pendingRow = (variantId: string) => {
      const value = database2.connection
        .prepare("SELECT pending_data FROM content_variants WHERE variant_id = ?")
        .get(variantId)?.pending_data;
      return typeof value === "string" ? value : null;
    };
    const seed = (platform: ContentPlatform, externalAccountId: string) =>
      content2.saveAccount(
        {
          platform,
          externalAccountId,
          handle: `${platform}-handle`,
          displayName: null,
          tokenCiphertext: cipher.encrypt(`${platform}-token-0123456789`).toString("base64"),
          refreshCiphertext: null,
          scopes: "",
          expiresAt: null,
        },
        clock,
      );
    await mkdir(content2.mediaRoot, { recursive: true });
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);
    await writeFile(join(content2.mediaRoot, "photojpeg.jpg"), JPEG);
    await writeFile(join(content2.mediaRoot, "photopng.png"), PNG);
    // A few KB of fake video bytes: nothing reads inside them.
    await writeFile(join(content2.mediaRoot, "clipvideo.mp4"), Buffer.alloc(2048, 7));
    const photo: ContentMedia = {
      id: "m-jpg",
      kind: "image",
      mimeType: "image/jpeg",
      bytes: JPEG.length,
      name: "holiday-photo.jpg",
      file: "photojpeg.jpg",
    };
    const pngPhoto: ContentMedia = { ...image, id: "m-png", name: "holiday-photo.png", file: "photopng.png" };
    const clip: ContentMedia = {
      id: "m-mp4",
      kind: "video",
      mimeType: "video/mp4",
      bytes: 2048,
      name: "clip.mp4",
      file: "clipvideo.mp4",
    };
    const only = (platform: ContentPlatform, own: Partial<{ body: string; title: string; media: ContentMedia }> = {}) =>
      Object.fromEntries(
        CONTENT_PLATFORM_KEYS.map((key) => [
          key,
          key === platform
            ? { body: own.body ?? null, title: own.title ?? null, media: own.media ?? null, status: "draft" as const }
            : skip,
        ]),
      );
    /** A post of one network, queued for one minute later. No upload may happen here. */
    const queued2 = (
      platform: ContentPlatform,
      media: ContentMedia | null,
      own: Partial<{ title: string; media: ContentMedia }> = {},
    ) => {
      const before = r2Log.length;
      const post = content2.createPost(
        {
          body: `Post for ${platform}`,
          media,
          approvalState: "none",
          scheduledFor: null,
          timezone: "UTC",
          authorAgentId: null,
          variants: only(platform, own),
        },
        clock,
      );
      const time = new Date(clock.getTime() + 60_000);
      content2.schedulePost(post.id, time.toISOString(), clock);
      assert.equal(r2Log.length, before, "Compose and schedule upload nothing.");
      return { id: post.id, time };
    };
    const hostedPuts = () => r2Log.filter((entry) => entry.method === "PUT" && !entry.key.startsWith("t/probe-"));
    for (const [platform, id] of [
      ["instagram", "ig-1"],
      ["threads", "th-1"],
      ["facebook_page", "page-1"],
      ["youtube", "UC1"],
    ] as const)
      seed(platform, id);

    await step(
      "13. No image host: approve queues the five networks with a usable path and skips Instagram",
      async () => {
        assert.deepEqual(accounts2.platforms, ["x", "linkedin", "threads", "facebook_page", "youtube"]);
        const time = new Date(clock.getTime() + 60 * 60_000);
        const post = content2.createPost(
          {
            body: "All networks",
            media: photo,
            approvalState: "pending",
            scheduledFor: time.toISOString(),
            timezone: "UTC",
            authorAgentId: agent.id,
            variants: { youtube: { body: null, title: "A title", media: clip, status: "draft" } },
          },
          clock,
        );
        content2.approvePost(post.id, clock);
        assert.deepEqual(
          Object.fromEntries(
            (content2.readPost(post.id)?.variants ?? []).map((variant) => [variant.platform, variant.status]),
          ),
          {
            x: "queued",
            linkedin: "queued",
            instagram: "skipped",
            threads: "queued",
            facebook_page: "queued",
            youtube: "queued",
          },
        );
        content2.publishNow(post.id, clock);
        assert.equal(r2Log.length, 0, "Approve and publish-now upload nothing.");
        // Not deleted: a delete removes the media file that later steps use.
        content2.unschedulePost(post.id, clock);
        return { platforms: accounts2.platforms };
      },
    );

    await step(
      "14. No image host: a Threads image fails invalid with no request; a Threads text post publishes",
      async () => {
        const withImage = queued2("threads", pngPhoto);
        clock = withImage.time;
        await pass2();
        const failed = variant2(withImage.id, "threads");
        assert.equal(failed.status, "failed");
        assert.equal(failed.errorCode, "invalid");
        assert.equal(failed.error, "Threads needs an image host for a post with an image.");
        assert.equal(sent4.length + r2Log.length, 0, "Nothing was sent.");
        const text = queued2("threads", null);
        clock = text.time;
        await pass2();
        const waiting = variant2(text.id, "threads");
        assert.equal(waiting.status, "publishing");
        assert.equal(waiting.pendingReason, "processing");
        assert.equal(
          contentPostView(content2.readPost(text.id) ?? assert.fail()).variants.find((v) => v.platform === "threads")
            ?.pendingReason,
          "processing",
        );
        assert.equal(
          publisher2.nextDueAt(),
          new Date(clock.getTime() + 30_000).toISOString(),
          "The timer waits for the check.",
        );
        clock = new Date(clock.getTime() + 30_000);
        await pass2();
        const done = variant2(text.id, "threads");
        assert.equal(done.status, "published");
        assert.equal(done.externalPostId, "th-m1");
        assert.equal(done.pendingReason, null);
        assert.equal(r2Log.length, 0);
        return { routes: sent4.map((entry) => entry.route) };
      },
    );

    await step(
      "15. Save the image host: probe PUT, public GET, DELETE; keys encrypted; then approve queues six",
      async () => {
        await Effect.runPromise(
          accounts2.saveMediaHost({
            endpoint: `https://${R2}`,
            bucket: "content-bucket",
            publicBaseUrl: `https://${PUBLIC}`,
            accessKeyId: "test-access-key",
            secretAccessKey: R2_SECRET,
          }),
        );
        assert.deepEqual(
          r2Log.map((entry) => entry.method),
          ["PUT", "GET", "DELETE"],
        );
        assert.match(r2Log[0]?.key ?? "", /^t\/probe-[0-9a-f]{32}\.txt$/u);
        assert.equal(bucket.size, 0);
        const file = await readFile(join(state2, CONTENT_MEDIA_HOST_FILE), "utf8");
        assert.ok(!file.includes(R2_SECRET) && !file.includes("test-access-key") && !file.includes(R2));
        assert.deepEqual(accounts2.mediaHostView(), {
          configured: true,
          endpoint: `https://${R2}`,
          bucket: "content-bucket",
          publicBaseUrl: `https://${PUBLIC}`,
          hasKeys: true,
        });
        assert.ok(accounts2.platforms.includes("instagram"));
        const post = content2.createPost(
          {
            body: "All six",
            media: photo,
            approvalState: "pending",
            scheduledFor: new Date(clock.getTime() + 3_600_000).toISOString(),
            timezone: "UTC",
            authorAgentId: agent.id,
            variants: { youtube: { body: null, title: "T", media: clip, status: "draft" } },
          },
          clock,
        );
        const before = r2Log.length;
        content2.approvePost(post.id, clock);
        assert.equal(r2Log.length, before, "Approve uploads nothing.");
        assert.ok((content2.readPost(post.id)?.variants ?? []).every((variant) => variant.status === "queued"));
        // Not deleted: a delete removes the media file that later steps use.
        content2.unschedulePost(post.id, clock);
        return { probe: r2Log.map((entry) => entry.method) };
      },
    );

    await step(
      "16. Instagram: one PUT, the key recorded before it, pending processing, DELETE after FINISHED",
      async () => {
        r2Log.length = 0;
        const post = queued2("instagram", photo);
        clock = post.time;
        answers.ig = "IN_PROGRESS";
        await pass2();
        const variant = variant2(post.id, "instagram");
        assert.equal(variant.status, "publishing", variant.error ?? "");
        assert.equal(variant.pendingReason, "processing");
        assert.equal(hostedPuts().length, 1, "Exactly one upload.");
        const key = hostedPuts()[0]?.key ?? "";
        assert.match(key, /^t\/[0-9a-f]{32}\.jpg$/u);
        for (const part of ["holiday", "photo", post.id, variant.id, agent.id, "ig-1"]) assert.ok(!key.includes(part));
        assert.equal(JSON.parse(pendingRow(variant.id) ?? "{}").hostedKey, key, "The key is recorded.");
        assert.ok(bucket.has(key));
        const container = sent4.find((entry) => entry.route === "POST graph.instagram.com/v24.0/ig-1/media");
        assert.equal(new URLSearchParams(container?.body).get("image_url"), `https://${PUBLIC}/${key}`);
        assert.equal(publisher2.nextDueAt(), new Date(clock.getTime() + 60_000).toISOString());
        const early = r2Log.length + sent4.length;
        await pass2();
        assert.equal(r2Log.length + sent4.length, early, "Nothing is due before the check time.");
        clock = new Date(clock.getTime() + 60_000);
        answers.ig = "FINISHED";
        await pass2();
        const done = variant2(post.id, "instagram");
        assert.equal(done.status, "published");
        assert.equal(done.externalPostId, "ig-m1");
        assert.deepEqual(
          r2Log.map((entry) => `${entry.method} ${entry.key === key}`),
          ["PUT true", "DELETE true"],
        );
        assert.equal(bucket.size, 0);
        assert.equal(pendingRow(variant.id), null, "The key is cleared after the removal.");
        return { key };
      },
    );

    await step("17. Instagram container ERROR and the 24 h give-up fail, and both remove the object", async () => {
      for (const [answer, code, wait] of [
        ["ERROR", "rejected", 60_000],
        ["IN_PROGRESS", "unknown-result", 24 * 60 * 60_000 + 60_000],
      ] as const) {
        r2Log.length = 0;
        const post = queued2("instagram", photo);
        clock = post.time;
        answers.ig = "IN_PROGRESS";
        await pass2();
        answers.ig = answer;
        clock = new Date(clock.getTime() + wait);
        await pass2();
        const failed = variant2(post.id, "instagram");
        assert.equal(failed.status, "failed");
        assert.equal(failed.errorCode, code);
        assert.deepEqual(
          r2Log.map((entry) => entry.method),
          ["PUT", "DELETE"],
        );
        assert.equal(bucket.size, 0);
        assert.equal(pendingRow(failed.id), null);
      }
      return { checked: 2 };
    });

    await step(
      "18. A failed DELETE keeps the post published and the key recorded; the startup sweep removes it",
      async () => {
        r2Log.length = 0;
        const post = queued2("threads", pngPhoto);
        clock = post.time;
        answers.th = "IN_PROGRESS";
        await pass2();
        failDeletes = 1;
        answers.th = "FINISHED";
        clock = new Date(clock.getTime() + 30_000);
        await pass2();
        const done = variant2(post.id, "threads");
        assert.equal(done.status, "published");
        const key = JSON.parse(pendingRow(done.id) ?? "{}").hostedKey;
        assert.match(key, /^t\/[0-9a-f]{32}\.png$/u);
        assert.ok(bucket.has(key));
        assert.ok(
          logs.some((line) => line.includes("could not be removed") && line.includes(key)),
          `A warning names the key. ${logs.slice(-3).join(" | ")}`,
        );
        ({ store: content2, accounts2, publisher2 } = build());
        await Effect.runPromise(accounts2.loadMediaHost());
        await Effect.runPromise(publisher2.releaseHostedMedia());
        assert.equal(bucket.size, 0);
        assert.equal(pendingRow(done.id), null);
        return { key };
      },
    );

    await step(
      "19. Crash after the upload: restart fails the variant, keeps the key, and the sweep removes the object",
      async () => {
        r2Log.length = 0;
        const post = queued2("instagram", photo);
        clock = post.time;
        const variant = variant2(post.id, "instagram");
        // What the publisher does before the container request, then the process stops.
        assert.ok(content2.claimVariant(variant.id, null, clock));
        const key = "t/0123456789abcdef0123456789abcdef.jpg";
        content2.setHostedKey(variant.id, key, clock);
        const host = accounts2.mediaHost();
        assert.ok(host);
        await Effect.runPromise(host.put({ bytes: new Uint8Array(JPEG), mimeType: "image/jpeg" }, key));
        assert.ok(bucket.has(key));
        ({ store: content2, accounts2, publisher2 } = build());
        assert.equal(content2.recoverInterrupted(clock), 1);
        const failed = variant2(post.id, "instagram");
        assert.equal(failed.status, "failed");
        assert.equal(failed.errorCode, "unknown-result");
        assert.equal(JSON.parse(pendingRow(failed.id) ?? "{}").hostedKey, key, "The key stays for the sweep.");
        await Effect.runPromise(accounts2.loadMediaHost());
        await Effect.runPromise(publisher2.releaseHostedMedia());
        assert.equal(bucket.has(key), false);
        assert.equal(pendingRow(failed.id), null);
        return { key };
      },
    );

    await step(
      "20. A recorded key outside the content pattern is never deleted; it is cleared and logged",
      async () => {
        const post = queued2("instagram", photo);
        const variant = variant2(post.id, "instagram");
        assert.ok(content2.claimVariant(variant.id, null, clock));
        content2.setHostedKey(variant.id, "user-assets/logo.png", clock);
        content2.finishVariant(variant.id, { kind: "failed", code: "unknown-result", message: "x" }, clock);
        r2Log.length = 0;
        await Effect.runPromise(publisher2.releaseHostedMedia());
        assert.equal(r2Log.length, 0, "No DELETE is sent.");
        assert.equal(pendingRow(variant.id), null, "The record goes, so the next start does not try again.");
        assert.ok(
          logs.some(
            (line) =>
              line.includes("not a content key") && line.includes(variant.id) && line.includes("user-assets/logo.png"),
          ),
        );
        return { refused: "user-assets/logo.png" };
      },
    );

    await step(
      "20b. Host gone while Instagram is queued: it fails at its time with no request; a later one waits; Retry publishes",
      async () => {
        const due = queued2("instagram", photo);
        const later = queued2("instagram", photo);
        const laterTime = new Date(clock.getTime() + 2 * 3_600_000);
        content2.schedulePost(later.id, laterTime.toISOString(), clock);
        // A restart whose saved host cannot be read: no host.
        ({ store: content2, accounts2, publisher2 } = build());
        assert.equal(accounts2.mediaHost(), null);
        r2Log.length = 0;
        const sentBefore = sent4.length;
        await pass2();
        assert.equal(variant2(due.id, "instagram").status, "queued", "Nothing is touched before its time.");
        assert.equal(publisher2.nextDueAt(), due.time.toISOString(), "The queued variant is due at its time.");
        clock = due.time;
        await pass2();
        const failed = variant2(due.id, "instagram");
        assert.equal(failed.status, "failed");
        assert.equal(failed.errorCode, "invalid");
        assert.equal(failed.error, "Instagram needs an image host.");
        assert.equal(variant2(later.id, "instagram").status, "queued", "A future variant is not touched.");
        assert.equal(sent4.length - sentBefore + r2Log.length, 0, "No request to a network or the bucket.");
        assert.equal(publisher2.nextDueAt(), laterTime.toISOString(), "The timer does not spin.");
        await Effect.runPromise(accounts2.loadMediaHost());
        content2.retryVariant(due.id, "instagram", clock);
        answers.ig = "IN_PROGRESS";
        await pass2();
        assert.equal(variant2(due.id, "instagram").status, "publishing");
        clock = new Date(clock.getTime() + 60_000);
        answers.ig = "FINISHED";
        await pass2();
        const done = variant2(due.id, "instagram");
        assert.equal(done.status, "published", done.error ?? "");
        assert.equal(done.externalPostId, "ig-m1");
        content2.unschedulePost(later.id, clock);
        return { error: failed.error };
      },
    );

    /** The service of the current build, with the publisher's release, as `application-services.ts` wires it. */
    const service2 = () =>
      new ContentService({
        store: content2,
        accounts: accounts2,
        drafts: { resolveDraftFile: () => Effect.succeed(null) },
        now,
        releaseHostedMedia: (variantId) => publisher2.releaseHostedMedia(variantId),
      });
    const cleanupText = sourceText("error.content.mediaHostCleanup");
    /** The message of a refused service call. */
    const refusal = async (operation: Effect.Effect<unknown, { cause: unknown }>) => {
      const error = await Effect.runPromise(Effect.flip(operation));
      return error.cause instanceof Error ? error.cause.message : String(error.cause);
    };
    /** A Threads image post that is published, and whose object stays because its DELETE failed. */
    const publishedWithKept = async () => {
      const post = queued2("threads", pngPhoto);
      clock = post.time;
      answers.th = "IN_PROGRESS";
      await pass2();
      failDeletes = 1;
      answers.th = "FINISHED";
      clock = new Date(clock.getTime() + 30_000);
      await pass2();
      const done = variant2(post.id, "threads");
      assert.equal(done.status, "published");
      const key: string = JSON.parse(pendingRow(done.id) ?? "{}").hostedKey;
      assert.ok(bucket.has(key));
      return { postId: post.id, variantId: done.id, key };
    };

    await step(
      "20c. A check of a pending Instagram container runs with no host; the object goes when the host is back",
      async () => {
        const post = queued2("instagram", photo);
        clock = post.time;
        answers.ig = "IN_PROGRESS";
        await pass2();
        const variant = variant2(post.id, "instagram");
        assert.equal(variant.status, "publishing");
        const key: string = JSON.parse(pendingRow(variant.id) ?? "{}").hostedKey;
        assert.ok(bucket.has(key));
        const checkAt = new Date(clock.getTime() + 60_000);
        ({ store: content2, accounts2, publisher2 } = build());
        assert.equal(accounts2.mediaHost(), null);
        assert.equal(publisher2.nextDueAt(), checkAt.toISOString(), "The check is due with no host.");
        clock = checkAt;
        answers.ig = "FINISHED";
        r2Log.length = 0;
        await pass2();
        assert.equal(variant2(post.id, "instagram").status, "published");
        assert.equal(r2Log.length, 0, "No bucket request while there is no host.");
        assert.equal(JSON.parse(pendingRow(variant.id) ?? "{}").hostedKey, key, "The key stays recorded.");
        ({ store: content2, accounts2, publisher2 } = build());
        await Effect.runPromise(accounts2.loadMediaHost());
        await Effect.runPromise(publisher2.releaseHostedMedia());
        assert.deepEqual(r2Log, [{ method: "DELETE", key, bucket: "content-bucket" }]);
        assert.equal(bucket.has(key), false);
        assert.equal(pendingRow(variant.id), null);
        return { key };
      },
    );

    await step(
      "20d. Delete with a kept object: refused while its DELETE fails; then one DELETE of that key, then the delete",
      async () => {
        const { postId, variantId, key } = await publishedWithKept();
        failDeletes = 1;
        r2Log.length = 0;
        assert.equal(await refusal(service2().deletePost(postId)), cleanupText);
        assert.deepEqual(
          r2Log.map((entry) => `${entry.method} ${entry.key === key}`),
          ["DELETE true"],
        );
        assert.ok(content2.readPost(postId), "The post stays.");
        assert.equal(JSON.parse(pendingRow(variantId) ?? "{}").hostedKey, key, "The key stays.");
        // The store refuses too, whoever calls it.
        assert.throws(
          () => content2.deletePost(postId),
          (error) => error instanceof Error && error.message === cleanupText,
        );
        r2Log.length = 0;
        await Effect.runPromise(service2().deletePost(postId));
        assert.deepEqual(r2Log, [{ method: "DELETE", key, bucket: "content-bucket" }]);
        assert.equal(bucket.has(key), false);
        assert.equal(content2.readPost(postId), null, "The post is deleted.");
        return { key };
      },
    );

    await step(
      "20e. A new host is refused while a kept object's DELETE fails; then the old host removes it, and the save runs",
      async () => {
        await Effect.runPromise(
          accounts2.setApp("instagram", { clientId: "ig-client-id", clientSecret: "ig-client-secret-0123456789" }),
        );
        const { variantId, key } = await publishedWithKept();
        const newHost = {
          platform: "instagram" as const,
          mediaHost: { endpoint: `https://${R2}`, bucket: "new-bucket", publicBaseUrl: `https://${PUBLIC}` },
        };
        failDeletes = 1;
        r2Log.length = 0;
        assert.equal(await refusal(service2().beginConnect(newHost)), cleanupText);
        assert.deepEqual(r2Log, [{ method: "DELETE", key, bucket: "content-bucket" }], "No request to the new host.");
        assert.equal(JSON.parse(pendingRow(variantId) ?? "{}").hostedKey, key, "The key stays.");
        assert.equal(accounts2.mediaHostView().bucket, "content-bucket", "Nothing is saved.");
        r2Log.length = 0;
        const saved = await Effect.runPromise(service2().beginConnect(newHost));
        assert.equal(saved.mediaHost?.bucket, "new-bucket");
        assert.deepEqual(
          r2Log.map((entry) => `${entry.method} ${entry.bucket}`),
          ["DELETE content-bucket", "PUT new-bucket", "GET public", "DELETE new-bucket"],
        );
        assert.equal(r2Log[0]?.key, key, "The old host removes the kept object first.");
        assert.equal(pendingRow(variantId), null);
        assert.equal(bucket.size, 0);
        return { key };
      },
    );

    await step("20f. A retry is due now: a failed post moved to a future time publishes in one pass", async () => {
      const post = queued2("facebook_page", null);
      const variant = variant2(post.id, "facebook_page");
      assert.ok(content2.claimVariant(variant.id, null, clock));
      content2.finishVariant(variant.id, { kind: "failed", code: "server", message: "x" }, clock);
      const future = new Date(clock.getTime() + 3 * 3_600_000).toISOString();
      content2.schedulePost(post.id, future, clock);
      assert.equal(content2.readPost(post.id)?.scheduledFor, future, "The failed post has a future time.");
      const retried = content2.retryVariant(post.id, "facebook_page", clock);
      assert.equal(retried.scheduledFor, clock.toISOString(), "The retry is due now.");
      await pass2();
      const done = variant2(post.id, "facebook_page");
      assert.equal(done.status, "published", done.error ?? "");
      assert.equal(done.externalPostId, "page-1_1");
      return { scheduledFor: retried.scheduledFor };
    });

    await step("20g. Decision A: a retry beside a sibling queued for the future keeps the time", async () => {
      const post = queued2("facebook_page", null);
      content2.setVariantSkipped(post.id, "threads", false, clock);
      assert.equal(variant2(post.id, "threads").status, "queued");
      const variant = variant2(post.id, "facebook_page");
      assert.ok(content2.claimVariant(variant.id, null, clock));
      content2.finishVariant(variant.id, { kind: "failed", code: "server", message: "x" }, clock);
      const retried = content2.retryVariant(post.id, "facebook_page", clock);
      assert.equal(retried.scheduledFor, post.time.toISOString(), "The time stays.");
      const sent = sent4.length;
      await pass2();
      assert.equal(sent4.length, sent, "Nothing publishes before the time.");
      assert.equal(variant2(post.id, "threads").status, "queued");
      content2.unschedulePost(post.id, clock);
      return { scheduledFor: retried.scheduledFor };
    });

    await step(
      "21. YouTube: publishing -> pending (processing) -> published across passes; no upload to the host",
      async () => {
        r2Log.length = 0;
        const post = queued2("youtube", null, { title: "Launch video", media: clip });
        clock = post.time;
        answers.yt = "processing";
        await pass2();
        assert.equal(variant2(post.id, "youtube").pendingReason, "processing");
        assert.equal(publisher2.nextDueAt(), new Date(clock.getTime() + 60_000).toISOString());
        clock = new Date(clock.getTime() + 60_000);
        await pass2();
        assert.equal(variant2(post.id, "youtube").status, "publishing");
        answers.yt = "succeeded";
        clock = new Date(clock.getTime() + 60_000);
        await pass2();
        const done = variant2(post.id, "youtube");
        assert.equal(done.status, "published");
        assert.equal(done.externalPostId, "vid-1");
        assert.equal(r2Log.length, 0);
        return { video: done.externalPostId };
      },
    );

    await step(
      "22. Decision B for Facebook: a disconnected Page keeps its variant queued, then fails signed-out",
      async () => {
        const textPost = queued2("facebook_page", null);
        clock = textPost.time;
        await pass2();
        assert.equal(variant2(textPost.id, "facebook_page").externalPostId, "page-1_1");
        const post = queued2("facebook_page", null);
        const account = content2.connectedAccount("facebook_page");
        assert.ok(account);
        content2.disconnectAccount(account.id, clock);
        assert.equal(variant2(post.id, "facebook_page").status, "queued");
        clock = post.time;
        await pass2();
        const failed = variant2(post.id, "facebook_page");
        assert.equal(failed.errorCode, "signed-out");
        assert.equal(failed.error, "Sign in to Facebook again.");
        return { error: failed.error };
      },
    );

    await step("23. Privacy totals: every host upload belongs to an Instagram or Threads image publish", async () => {
      const text = [
        ...database2.connection
          .prepare("SELECT COALESCE(error, '') || COALESCE(pending_data, '') AS t FROM content_variants")
          .all()
          .map((row) => String(row.t)),
        ...database2.connection
          .prepare("SELECT payload_json AS t FROM orchestration_events")
          .all()
          .map((row) => String(row.t)),
        ...logs,
      ].join("\n");
      assert.ok(!text.includes(R2_SECRET) && !text.includes("test-access-key"));
      assert.equal(globalFetchCalls, 0);
      return { arms: arms2 };
    });
  } finally {
    database2.close();
  }

  report.passed = true;
} finally {
  stopLogs();
  database.close();
  await rm(root, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${report.passed ? "passed" : "FAILED"}: ${join(OUT, "report.json")}\n`);
}

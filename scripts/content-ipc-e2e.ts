// Checks the `content` IPC group of step 3a on a real temporary profile: the real handler group, bound
// through the real `registerIpcGroup` and `handleTrusted` (the sender check, the decoders and the error
// path), the real `ContentService`, `ContentStore`, `ContentAccounts`, X and LinkedIn adapters, the real
// SQLite database and a real attachment draft of the mailbox store. Only `electron` is a stub: its
// `ipcMain.handle` keeps each handler in a map, and this script calls it as ipcMain would. The networks
// are a fake `fetch`; the global `fetch` throws. No port is bound.
//
// Run: bunx tsx scripts/content-ipc-e2e.ts
// (bun cannot load `node:sqlite`, so this runs on Node through tsx.)
// Writes .openbot-build/content-ipc-e2e/report.json and exits non-zero on a failure.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// `electron` cannot load outside Electron. The stub keeps each `ipcMain.handle` handler.
type IpcListener = (event: { senderFrame: { url: string } | null }, payload?: unknown) => unknown;
const ipcHandlers = new Map<string, IpcListener>();
Object.assign(globalThis, { __contentIpcHandlers: ipcHandlers });
const ELECTRON_STUB = [
  "export const ipcMain = { handle: (channel, listener) => globalThis.__contentIpcHandlers.set(channel, listener) };",
  "export const app = {}; export const safeStorage = {}; export default {};",
].join("\n");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "electron")
      return { url: `data:text/javascript,${encodeURIComponent(ELECTRON_STUB)}`, shortCircuit: true };
    return next(specifier, context);
  },
});

const { IPC_ENDPOINTS } = await import("@openbot/contracts/ipc");
const { INPUT_LIMITS } = await import("@openbot/contracts/input-limits");
const { CONTENT_PLATFORM_KEYS } = await import("@openbot/contracts/ipc-content");
const { matchingSourceKeys } = await import("@openbot/i18n/source");
const { Effect } = await import("effect");
const { AgentStore } = await import("../src/backend/agent-store");
const { ContentStore } = await import("../src/backend/content/content-store");
const { runCauseEffect } = await import("../src/backend/effect-boundary");
const { MailboxStore } = await import("../src/backend/mailbox-store");
const { OpenBotDatabase } = await import("../src/backend/openbot-database");
const { CONTENT_REDIRECT_URI, ContentAccounts } = await import("../src/main/content/content-accounts");
const { ContentPublisher } = await import("../src/main/content/content-publisher");
const { ContentService } = await import("../src/main/content/content-service");
const { LinkedInAdapter } = await import("../src/main/content/linkedin-adapter");
const { XAdapter } = await import("../src/main/content/x-adapter");
const { contentIpcHandlers } = await import("../src/main/ipc/content-handlers");
const { registerIpcGroup } = await import("../src/main/ipc/define-ipc-group");
const { decodeVoid } = await import("../src/preload/app-decoding");
const { decodeContentAccountsState, decodeContentCalendar, decodeContentPost, decodeContentPosts } = await import(
  "../src/preload/content-decoding"
);
type ContentPostView = import("@openbot/contracts/ipc-content").ContentPostView;
type ContentChangedEvent = import("@openbot/contracts/ipc-content").ContentChangedEvent;
type ContentFetch = import("../src/main/content/content-adapter").ContentFetch;
type CallbackAnswer = import("../src/main/loopback-callback-server").CallbackAnswer;

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".openbot-build", "content-ipc-e2e");

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
  xCode: "x-auth-code-0123456789",
  xAccess: "x-access-token-0123456789",
  xRefresh: "x-refresh-token-0123456789",
  liClientSecret: "li-client-secret-0123456789",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let tweetStatus = 201;
let tweetId = 5000;
const fakeFetch: ContentFetch = async (url, init) => {
  const parsed = new URL(url);
  const route = `${init.method ?? "GET"} ${parsed.host}${parsed.pathname}`;
  switch (route) {
    case "POST api.x.com/2/oauth2/token":
      return json(200, {
        access_token: SECRETS.xAccess,
        refresh_token: SECRETS.xRefresh,
        expires_in: 7200,
        scope: "tweet.write",
      });
    case "GET api.x.com/2/users/me":
      return json(200, { data: { id: "x-user-1", username: "openbot_test", name: "OpenBot Test" } });
    case "POST api.x.com/2/media/upload":
      return json(200, { data: { id: "x-media-1" } });
    case "POST api.x.com/2/tweets":
      if (tweetStatus !== 201) return json(tweetStatus, { title: "Internal Error" });
      tweetId += 1;
      return json(201, { data: { id: String(tweetId) } });
  }
  return json(404, { message: `No route ${route}.` });
};

const cipher = {
  canPersist: () => true,
  encrypt: (value: string) => Buffer.from(`fake-cipher:${Buffer.from(value).reverse().toString("hex")}`),
  decrypt: (value: Buffer) => Buffer.from(value.toString().slice("fake-cipher:".length), "hex").reverse().toString(),
};

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from("ftypisom"),
  Buffer.from([0, 0, 2, 0]),
  Buffer.from("isomiso2"),
]);
const TRUSTED = { senderFrame: { url: "openbot-app://app/index.html" } };

const root = await mkdtemp(join(tmpdir(), "openbot-content-ipc-"));
const state = join(root, "state");
const database = new OpenBotDatabase(state);
const agents = new AgentStore(state, join(root, "home"), database);

try {
  await runCauseEffect(agents.initialize());
  const mailbox = new MailboxStore(state, agents.sharedRoot, database);
  await runCauseEffect(mailbox.initialize());

  let clock = new Date("2030-03-01T09:00:00.000Z");
  const now = () => clock;
  const events: ContentChangedEvent[] = [];
  let arms = 0;
  const store = new ContentStore(
    database,
    () => {
      arms += 1;
    },
    (event) => events.push(event),
  );
  const adapterOptions = { fetch: fakeFetch, now, sleep: async () => {} };
  let receive: ((url: URL) => CallbackAnswer) | null = null;
  let browser: (page: URL) => void = () => {};
  const callbackAnswers: CallbackAnswer[] = [];
  const accounts = new ContentAccounts({
    store,
    cipher,
    appsPath: join(state, "openbot-content-apps-v1.json"),
    adapters: [new XAdapter(adapterOptions), new LinkedInAdapter(adapterOptions)],
    openExternal: async (url) => {
      const page = new URL(url);
      setImmediate(() => browser(page));
    },
    listen: async (handler) => {
      receive = handler;
      return { close: async () => {} };
    },
    now,
  });
  const publisher = new ContentPublisher({ store, accounts, now });
  const service = new ContentService({ store, accounts, drafts: mailbox, now });
  registerIpcGroup("content", contentIpcHandlers({ content: service }).content);

  /** One renderer call, through the handler that `handleTrusted` gave to ipcMain. */
  const invoke = async <T>(channel: string, payload: unknown, decode: (value: unknown) => T): Promise<T> => {
    const listener = ipcHandlers.get(channel);
    assert.ok(listener, `${channel} is registered.`);
    return decode(await listener(TRUSTED, payload));
  };
  /** The same call, read through the decoder that the preload uses for the endpoint. */
  const call = {
    accounts: async (channel: string, payload?: unknown) => invoke(channel, payload, decodeContentAccountsState),
    post: async (channel: string, payload: unknown) => invoke(channel, payload, decodeContentPost),
    posts: async (payload: unknown) => invoke(IPC_ENDPOINTS.content.listPosts.channel, payload, decodeContentPosts),
    calendar: async (payload: unknown) =>
      invoke(IPC_ENDPOINTS.content.calendar.channel, payload, decodeContentCalendar),
  };
  /** One post of the list, which must exist. */
  const listed = async (postId: string) => {
    const post = (await call.posts({})).find((candidate) => candidate.id === postId);
    assert.ok(post, "The post is listed.");
    return post;
  };
  const endpoints = IPC_ENDPOINTS.content;
  /** A refusal is an Error whose message is the English of one `error.content.*` key. */
  const refused = async (channel: string, payload: unknown, key: string) => {
    const error = await invoke(channel, payload, decodeVoid).then(
      () => null,
      (cause: unknown) => cause,
    );
    assert.ok(error instanceof Error, `${channel} refuses.`);
    assert.deepEqual(matchingSourceKeys(error.message), [key], `"${error.message}" is ${key}.`);
    return error.message;
  };
  /** Every changed event fired by `run`, which must be exactly one per write. */
  const changesDuring = async <T>(run: () => Promise<T>) => {
    const before = events.length;
    const value = await run();
    return { value, fired: events.slice(before) };
  };
  const draftFile = async (name: string, bytes: Buffer) => {
    const path = join(root, name);
    await writeFile(path, bytes);
    const [draft] = await runCauseEffect(mailbox.prepareAttachments([path]));
    assert.ok(draft);
    return draft.id;
  };
  const statusOf = (post: ContentPostView, platform: string) =>
    post.variants.find((variant) => variant.platform === platform)?.status;
  const FORBIDDEN_KEYS = [
    "file",
    "path",
    "pendingData",
    "tokenCiphertext",
    "refreshCiphertext",
    "clientSecret",
    "accessToken",
  ];
  /** No key or value of a result names a secret, a ciphertext, a stored file or a path. */
  const assertClean = (value: unknown) => {
    const text = JSON.stringify(value);
    for (const key of FORBIDDEN_KEYS) assert.ok(!text.includes(`"${key}"`), `The result has no ${key} key.`);
    for (const secret of [...Object.values(SECRETS), "fake-cipher", root, "content-media"])
      assert.ok(!text.includes(secret), "The result holds no secret or path.");
  };

  await step("0. The ten requests are registered, and an untrusted sender is refused before decoding", async () => {
    const requests = Object.values(endpoints).filter((endpoint) => endpoint.kind === "request");
    assert.equal(requests.length, 10);
    for (const endpoint of requests) assert.ok(ipcHandlers.has(endpoint.channel), endpoint.channel);
    const listener = ipcHandlers.get(endpoints.listAccounts.channel);
    assert.ok(listener);
    assert.throws(
      () => listener({ senderFrame: { url: "https://evil.example/" } }),
      /Rejected IPC request from an untrusted renderer/,
    );
    return { requests: requests.map((endpoint) => endpoint.channel) };
  });

  await step("1. listAccounts: six networks in order, no secret; begin-connect then cancel", async () => {
    const initial = await call.accounts(endpoints.listAccounts.channel);
    assertClean(initial);
    assert.deepEqual(
      initial.networks.map((network) => network.platform),
      [...CONTENT_PLATFORM_KEYS],
    );
    assert.deepEqual(
      initial.networks.filter((network) => network.available).map((network) => network.platform),
      ["x", "linkedin"],
    );
    assert.equal(initial.networks.find((network) => network.platform === "linkedin")?.app.needsSecret, true);
    assert.equal(initial.connecting, null);

    await refused(endpoints.beginConnect.channel, { platform: "x" }, "error.content.addApp");
    await refused(endpoints.beginConnect.channel, { platform: "threads" }, "error.content.notSupported");
    await refused(
      endpoints.beginConnect.channel,
      { platform: "linkedin", clientId: "li-id" },
      "error.content.addSecret",
    );

    // A sign-in that waits, then the cancel form of disconnect-account stops it.
    browser = () => {};
    const waiting = call.accounts(endpoints.beginConnect.channel, { platform: "x", clientId: "x-client-id" });
    const settled = waiting.then(
      () => null,
      (error: unknown) => error,
    );
    while (accounts.connecting !== "x") await new Promise((resolve) => setImmediate(resolve));
    const during = await call.accounts(endpoints.listAccounts.channel);
    assert.equal(during.connecting, "x");
    const afterCancel = await call.accounts(endpoints.disconnectAccount.channel, {
      platform: "x",
      cancel: true,
    });
    assert.equal(afterCancel.connecting, null);
    const cancelled = await settled;
    assert.ok(cancelled instanceof Error);
    assert.deepEqual(matchingSourceKeys(cancelled.message), ["error.content.signInCancelled"]);

    // The app is saved; this sign-in ends in the browser.
    browser = (page) => {
      assert.ok(receive);
      callbackAnswers.push(
        receive(
          new URL(
            `${CONTENT_REDIRECT_URI}?${new URLSearchParams({ state: page.searchParams.get("state") ?? "", code: SECRETS.xCode })}`,
          ),
        ),
      );
    };
    const { value: connected, fired } = await changesDuring(() =>
      call.accounts(endpoints.beginConnect.channel, {
        platform: "x",
      }),
    );
    assertClean(connected);
    const x = connected.networks.find((network) => network.platform === "x");
    assert.equal(x?.account?.handle, "openbot_test");
    assert.equal(x?.account?.status, "connected");
    assert.equal(x?.app.clientId, "x-client-id");
    assert.deepEqual(fired, [{ accounts: true }], "One change for the saved account.");
    assert.deepEqual(callbackAnswers.at(-1), { status: 200, message: "error.content.redirectSignedIn" });
    return { connected: x?.account?.handle, cancelled: cancelled.message };
  });

  const createdIds: string[] = [];
  let mediaPostId = "";

  await step("2. createPost with draft media copies the files; an unknown draft is refused", async () => {
    const image = await draftFile("launch.png", PNG);
    const video = await draftFile("teaser.mp4", MP4);
    await refused(
      endpoints.createPost.channel,
      { body: "Hi", timezone: "UTC", media: { draftId: "no-such-draft" } },
      "error.content.unknownDraft",
    );
    await refused(
      endpoints.createPost.channel,
      { body: "Hi", timezone: "UTC", variants: [{ platform: "youtube", media: { draftId: image } }] },
      "error.content.takesVideo",
    );
    const text = await draftFile("notes.png", Buffer.from("This is text with a PNG name."));
    await refused(
      endpoints.createPost.channel,
      { body: "Hi", timezone: "UTC", media: { draftId: text } },
      "error.content.mediaType",
    );
    assert.deepEqual(await readdir(store.mediaRoot).catch(() => []), [], "A refusal copies nothing.");

    const { value: post, fired } = await changesDuring(() =>
      call.post(endpoints.createPost.channel, {
        body: "Launch day",
        media: { draftId: image },
        timezone: "Europe/Warsaw",
        variants: [{ platform: "youtube", title: "Teaser", media: { draftId: video } }],
      }),
    );
    assertClean(post);
    assert.equal(post.approvalState, "none");
    assert.equal(post.status, "draft");
    assert.equal(post.media?.name, "launch.png");
    assert.equal(post.media?.kind, "image");
    assert.equal(post.variants.find((variant) => variant.platform === "youtube")?.media?.kind, "video");
    assert.deepEqual(fired, [{ postId: post.id }]);
    assert.equal((await readdir(store.mediaRoot)).length, 2, "Two copies in content-media.");
    assert.ok(mailbox.draftName(image), "The draft stays a draft.");
    mediaPostId = post.id;
    createdIds.push(post.id);
    return { postId: post.id, media: post.media };
  });

  await step("3. Decision A: unschedule clears the time; unskip queues only beside a queued network", async () => {
    const time = new Date(clock.getTime() + 60 * 60_000).toISOString();
    const { value: queued, fired } = await changesDuring(() =>
      call.post(endpoints.createPost.channel, { body: "Plan", timezone: "UTC", scheduledFor: time }),
    );
    createdIds.push(queued.id);
    assert.equal(queued.status, "queued", "A user post with a time is queued at once.");
    assert.equal(fired.length, 1);
    const armsBefore = arms;
    const skipped = await call.post(endpoints.updatePost.channel, {
      postId: queued.id,
      action: "edit",
      variants: [{ platform: "x", skipped: true }],
    });
    assert.equal(statusOf(skipped, "x"), "skipped");
    const unskipped = await call.post(endpoints.updatePost.channel, {
      postId: queued.id,
      action: "edit",
      variants: [{ platform: "x", skipped: false }],
    });
    assert.equal(statusOf(unskipped, "x"), "queued", "Other networks are queued.");
    assert.ok(arms > armsBefore, "The timer plans the queued network again.");

    const { value: unscheduled, fired: unscheduleEvents } = await changesDuring(() =>
      call.post(endpoints.updatePost.channel, { postId: queued.id, action: "unschedule" }),
    );
    assert.deepEqual(unscheduleEvents, [{ postId: queued.id }]);
    assert.equal(unscheduled.scheduledFor, null, "The time is removed.");
    assert.ok(unscheduled.variants.every((variant) => variant.status === "draft"));
    await call.post(endpoints.updatePost.channel, {
      postId: queued.id,
      action: "edit",
      variants: [{ platform: "linkedin", skipped: true }],
    });
    const back = await call.post(endpoints.updatePost.channel, {
      postId: queued.id,
      action: "edit",
      variants: [{ platform: "linkedin", skipped: false }],
    });
    assert.equal(statusOf(back, "linkedin"), "draft", "No network is queued, so it stays a draft.");
    assert.equal(back.scheduledFor, null, "The unskip does not bring the time back.");
    return { afterUnschedule: unscheduled.scheduledFor, unskip: statusOf(back, "linkedin") };
  });

  let pendingId = "";

  await step("4. Approve queues a pending post with a future time; an edit keeps it pending", async () => {
    const future = new Date(clock.getTime() + 2 * 60 * 60_000).toISOString();
    const agent = await runCauseEffect(
      agents.createAgent({ name: "Herald", description: "Writes posts", avatarSeed: "herald", avatarHue: null }),
    );
    const pending = store.createPost(
      {
        body: "Proposed",
        media: null,
        approvalState: "pending",
        scheduledFor: future,
        timezone: "UTC",
        authorAgentId: agent.id,
        variants: {},
      },
      clock,
    );
    pendingId = pending.id;
    createdIds.push(pending.id);
    await refused(
      endpoints.schedulePost.channel,
      { postId: pending.id, scheduledFor: future },
      "error.content.approveFirst",
    );
    const edited = await call.post(endpoints.updatePost.channel, {
      postId: pending.id,
      action: "edit",
      body: "Proposed, edited",
    });
    assert.equal(edited.approvalState, "pending");
    assert.equal(edited.body, "Proposed, edited");
    const { value: approved, fired } = await changesDuring(() =>
      call.post(endpoints.updatePost.channel, { postId: pending.id, action: "approve" }),
    );
    assert.deepEqual(fired, [{ postId: pending.id }]);
    assert.equal(approved.approvalState, "approved");
    assert.equal(approved.status, "queued");
    assert.ok(approved.variants.every((variant) => variant.status === "queued"));
    await refused(endpoints.updatePost.channel, { postId: pending.id, action: "approve" }, "error.content.notPending");
    return { status: approved.status };
  });

  await step("5. publishNow publishes on X at the next pass; the publisher writes fire changed events", async () => {
    const created = await call.post(endpoints.createPost.channel, {
      body: "Now",
      timezone: "UTC",
      variants: CONTENT_PLATFORM_KEYS.filter((platform) => platform !== "x").map((platform) => ({
        platform,
        skipped: true,
      })),
    });
    createdIds.push(created.id);
    const { value: queued, fired } = await changesDuring(() =>
      call.post(endpoints.publishNow.channel, { postId: created.id }),
    );
    assert.deepEqual(fired, [{ postId: created.id }]);
    assert.equal(statusOf(queued, "x"), "queued");
    const { fired: passEvents } = await changesDuring(() => Effect.runPromise(publisher.processDue(clock, () => true)));
    // The pending post of step 4 is not due yet; only this post moves: claim, then finish.
    assert.deepEqual(passEvents, [{ postId: created.id }, { postId: created.id }]);
    const [after] = (await call.posts({ limit: 100 })).filter((post) => post.id === created.id);
    assert.equal(after?.status, "published");
    return { status: after?.status };
  });

  await step("6. Retry: a failed X variant fails, then retry queues it, and the next pass publishes it", async () => {
    tweetStatus = 500;
    const created = await call.post(endpoints.createPost.channel, {
      body: "Retry",
      timezone: "UTC",
      variants: CONTENT_PLATFORM_KEYS.filter((platform) => platform !== "x").map((platform) => ({
        platform,
        skipped: true,
      })),
    });
    createdIds.push(created.id);
    await call.post(endpoints.publishNow.channel, { postId: created.id });
    await Effect.runPromise(publisher.processDue(clock, () => true));
    const failed = (await call.posts({})).find((post) => post.id === created.id);
    const x = failed?.variants.find((variant) => variant.platform === "x");
    assert.equal(x?.status, "failed");
    assert.deepEqual(matchingSourceKeys(x?.error ?? ""), ["error.content.serverError"], "The stored error is a key.");
    await refused(
      endpoints.updatePost.channel,
      { postId: created.id, action: "retry", platform: "linkedin" },
      "error.content.retryOnlyFailed",
    );
    tweetStatus = 201;
    const { value: retried, fired } = await changesDuring(() =>
      call.post(endpoints.updatePost.channel, { postId: created.id, action: "retry", platform: "x" }),
    );
    assert.deepEqual(fired, [{ postId: created.id }]);
    assert.equal(statusOf(retried, "x"), "queued");
    await Effect.runPromise(publisher.processDue(clock, () => true));
    assert.equal(statusOf(await listed(created.id), "x"), "published");
    await refused(
      endpoints.updatePost.channel,
      { postId: created.id, action: "edit", body: "Changed" },
      "error.content.published",
    );
    return { error: x?.error };
  });

  await step("7. Decision B: a disconnected X keeps its variant queued; it fails signed-out at its time", async () => {
    const time = new Date(clock.getTime() + 30 * 60_000).toISOString();
    const created = await call.post(endpoints.createPost.channel, {
      body: "Disconnect",
      timezone: "UTC",
      scheduledFor: time,
      variants: CONTENT_PLATFORM_KEYS.filter((platform) => platform !== "x").map((platform) => ({
        platform,
        skipped: true,
      })),
    });
    createdIds.push(created.id);
    const current = await call.accounts(endpoints.listAccounts.channel);
    const accountId = current.networks.find((network) => network.platform === "x")?.account?.id ?? "";
    const { value: after, fired } = await changesDuring(() =>
      call.accounts(endpoints.disconnectAccount.channel, {
        accountId,
      }),
    );
    assertClean(after);
    assert.deepEqual(fired, [{ accounts: true }]);
    assert.equal(after.networks.find((network) => network.platform === "x")?.account?.status, "revoked");
    assert.equal(statusOf(await listed(created.id), "x"), "queued", "No auto-skip and no move to draft.");
    clock = new Date(time);
    await Effect.runPromise(publisher.processDue(clock, () => true));
    const failed = (await call.posts({})).find((post) => post.id === created.id);
    const x = failed?.variants.find((variant) => variant.platform === "x");
    assert.equal(x?.status, "failed");
    assert.equal(x?.errorCode, "signed-out");
    assert.deepEqual(matchingSourceKeys(x?.error ?? ""), ["error.content.signInAgainX"]);
    return { error: x?.error };
  });

  await step("8. deletePost removes the post and its media files; refused while publishing", async () => {
    const before = await readdir(store.mediaRoot);
    assert.equal(before.length, 2);
    const { fired } = await changesDuring(() =>
      invoke(endpoints.deletePost.channel, { postId: mediaPostId }, decodeVoid),
    );
    assert.deepEqual(fired, [{ postId: mediaPostId }]);
    assert.deepEqual(await readdir(store.mediaRoot), [], "No other post names the files, so both go.");
    await refused(endpoints.deletePost.channel, { postId: mediaPostId }, "error.content.unknownPost");

    const created = await call.post(endpoints.createPost.channel, { body: "Busy", timezone: "UTC" });
    createdIds.push(created.id);
    await call.post(endpoints.publishNow.channel, { postId: created.id });
    const variant = store.readPost(created.id)?.variants.find((item) => item.platform === "linkedin");
    assert.ok(variant && store.claimVariant(variant.id, null, clock));
    await refused(endpoints.deletePost.channel, { postId: created.id }, "error.content.publishing");
    return { removed: before.length };
  });

  await step("9. listPosts and calendar: range limits, the calendar shows only timed posts in range", async () => {
    const all = await call.posts({});
    assertClean(all);
    assert.equal(all.length, createdIds.length - 1, "The deleted post is gone.");
    const one = await call.posts({ limit: 1 });
    assert.equal(one.length, 1);
    const from = "2030-03-01T00:00:00.000Z";
    const to = "2030-03-02T00:00:00.000Z";
    const calendar = await call.calendar({ from, to });
    assertClean(calendar);
    assert.ok(calendar.posts.length > 0);
    assert.ok(
      calendar.posts.every((post) => post.scheduledFor !== null && post.scheduledFor >= from && post.scheduledFor < to),
    );
    assert.ok(calendar.posts.some((post) => post.id === pendingId));
    const days = (count: number) => new Date(Date.parse(from) + count * 24 * 60 * 60 * 1000).toISOString();
    await assert.rejects(
      invoke(endpoints.calendar.channel, { from, to: days(INPUT_LIMITS.contentCalendarDays + 1) }, decodeVoid),
      /Invalid content calendar range/,
    );
    await assert.rejects(
      invoke(endpoints.listPosts.channel, { limit: INPUT_LIMITS.contentPostsPage + 1 }, decodeVoid),
      /Invalid content post list/,
    );
    await assert.rejects(
      invoke(endpoints.createPost.channel, { body: "Hi", timezone: "UTC", media: { path: "/etc/passwd" } }, decodeVoid),
      /Invalid content post/,
    );
    return { listed: all.length, calendar: calendar.posts.length };
  });

  await step("10. No content event payload or receipt holds a secret, a path or pending data", async () => {
    const text = [
      ...database.connection
        .prepare("SELECT payload_json AS t FROM orchestration_events WHERE aggregate_type LIKE 'content-%'")
        .all()
        .map((row) => String(row.t)),
      ...database.connection
        .prepare("SELECT result_json AS t FROM orchestration_command_receipts")
        .all()
        .map((row) => String(row.t)),
    ].join("\n");
    for (const secret of [...Object.values(SECRETS), root]) assert.ok(!text.includes(secret));
    assert.equal(globalFetchCalls, 0);
    return { events: events.length };
  });

  report.passed = true;
} finally {
  database.close();
  await rm(root, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${report.passed ? "passed" : "FAILED"}: ${join(OUT, "report.json")}\n`);
}

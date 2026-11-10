import {
  CONTENT_PLATFORM_KEYS,
  type ContentAccountsState,
  type ContentAccountView,
  type ContentChangedEvent,
  type ContentDesktopApi,
  type ContentPlatform,
  type ContentPostView,
  type ContentVariantStatus,
  type ContentVariantView,
  contentPostStatus,
} from "@openbot/contracts/ipc";

const HOUR = 60 * 60 * 1000;
const CREATED = "2026-11-01T09:00:00.000Z";

/** Example data from docs/content-manager/content-manager.html: the queue and the Accounts screen. */
function exampleAccounts(): Map<ContentPlatform, ContentAccountView> {
  const account = (
    platform: ContentPlatform,
    handle: string,
    status: ContentAccountView["status"] = "connected",
  ): [ContentPlatform, ContentAccountView] => [
    platform,
    { id: `account-${platform}`, platform, handle, displayName: null, status, expiresAt: null },
  ];
  return new Map([
    account("x", "@studiowidget"),
    account("linkedin", "Mira Studio"),
    account("threads", "@studio.widget", "expired"),
    account("instagram", "@studio.widget"),
  ]);
}

function variant(platform: ContentPlatform, status: ContentVariantStatus, error: string | null = null) {
  return {
    id: `variant-${platform}-${crypto.randomUUID()}`,
    platform,
    accountId: null,
    body: null,
    title: null,
    media: null,
    status,
    attempt: status === "failed" || status === "published" ? 1 : 0,
    externalPostId: status === "published" ? "1001" : null,
    errorCode: error ? "rejected" : null,
    error,
    publishedAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
  } satisfies ContentVariantView;
}

function post(input: {
  id: string;
  body: string;
  scheduledFor: string | null;
  approvalState?: ContentPostView["approvalState"];
  authorAgentId?: string | null;
  statuses: Partial<Record<ContentPlatform, ContentVariantStatus>>;
  errors?: Partial<Record<ContentPlatform, string>>;
  fallback?: ContentVariantStatus;
}): ContentPostView {
  const variants = CONTENT_PLATFORM_KEYS.map((platform) =>
    variant(platform, input.statuses[platform] ?? input.fallback ?? "skipped", input.errors?.[platform] ?? null),
  );
  return {
    id: input.id,
    body: input.body,
    media: null,
    approvalState: input.approvalState ?? "none",
    scheduledFor: input.scheduledFor,
    timezone: "Europe/Warsaw",
    authorAgentId: input.authorAgentId ?? null,
    createdAt: CREATED,
    updatedAt: CREATED,
    status: contentPostStatus(variants),
    variants,
  };
}

/** Example data: the six posts of the queue and two of the done list, relative to now. */
function examplePosts(): ContentPostView[] {
  const at = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();
  return [
    post({
      id: "post-playbook",
      body: "The App Store playbook: five steps we use for every launch",
      scheduledFor: at(48),
      approvalState: "pending",
      authorAgentId: "agent-herald",
      statuses: {},
      fallback: "draft",
    }),
    post({
      id: "post-shipping",
      body: "Shipping v2 of the widget today: faster sync, offline drafts and a calendar for every routine.",
      scheduledFor: at(-1),
      statuses: { x: "failed", linkedin: "published", threads: "failed", instagram: "published" },
      errors: { x: "X limits the posts now.", threads: "Sign in to Threads again." },
    }),
    post({
      id: "post-atlas",
      body: "Customer story: how Atlas cut their release week in half",
      scheduledFor: null,
      approvalState: "approved",
      authorAgentId: "agent-herald",
      statuses: { x: "draft", linkedin: "draft" },
    }),
    post({
      id: "post-video",
      body: "Release video: what is new in v2, in two minutes",
      scheduledFor: at(2),
      statuses: { youtube: "publishing" },
    }),
    post({
      id: "post-office-hours",
      body: "Office hours tonight: bring your routine questions",
      scheduledFor: at(8),
      approvalState: "approved",
      authorAgentId: "agent-herald",
      statuses: { x: "queued", linkedin: "queued", threads: "queued" },
    }),
    post({
      id: "post-tip",
      body: "Tip: one routine can post the weekly changelog for you",
      scheduledFor: at(24),
      statuses: { x: "queued", linkedin: "queued" },
    }),
    post({
      id: "post-hiring",
      body: "Hiring: we look for a designer who likes small details",
      scheduledFor: null,
      statuses: {},
      fallback: "draft",
    }),
    post({
      id: "post-monday",
      body: "Monday notes: three routines our team runs every week",
      scheduledFor: at(-48),
      statuses: { x: "published", linkedin: "published" },
    }),
    post({
      id: "post-poll",
      body: "Weekend poll: which feature should come next?",
      scheduledFor: at(-72),
      statuses: {},
    }),
  ];
}

/** The content manager on example data. Each write changes the in-memory state and fires `changed`. */
export function createMockContent(): ContentDesktopApi {
  const accounts = exampleAccounts();
  let posts = examplePosts();
  let connecting: ContentPlatform | null = null;
  const listeners = new Set<(event: ContentChangedEvent) => void>();
  const changed = (event: ContentChangedEvent) => {
    for (const listener of listeners) listener(event);
  };
  const state = (): ContentAccountsState => ({
    networks: CONTENT_PLATFORM_KEYS.map((platform) => ({
      platform,
      available: platform === "x" || platform === "linkedin",
      app: {
        platform,
        configured: accounts.has(platform),
        clientId: accounts.has(platform) ? `example-${platform}-client` : null,
        hasSecret: platform === "linkedin" && accounts.has(platform),
        needsSecret: platform === "linkedin",
      },
      account: structuredClone(accounts.get(platform) ?? null),
    })),
    connecting,
    secretStorage: true,
  });
  const find = (postId: string) => {
    const found = posts.find((candidate) => candidate.id === postId);
    if (!found) throw new Error("This post is not known.");
    return found;
  };
  const write = (postId: string, change: (target: ContentPostView) => void) => {
    const target = find(postId);
    change(target);
    target.status = contentPostStatus(target.variants);
    target.updatedAt = new Date().toISOString();
    changed({ postId });
    return structuredClone(target);
  };
  const setStatuses = (target: ContentPostView, from: ContentVariantStatus, to: ContentVariantStatus) => {
    for (const item of target.variants) if (item.status === from) item.status = to;
  };
  /** As main: a draft of a network that this version cannot post to is skipped, not queued. */
  const queueDrafts = (target: ContentPostView) => {
    for (const item of target.variants)
      if (item.status === "draft")
        item.status = item.platform === "x" || item.platform === "linkedin" ? "queued" : "skipped";
  };
  return {
    listAccounts: async () => state(),
    beginConnect: async ({ platform }) => {
      connecting = platform;
      changed({ accounts: true });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (connecting !== platform) throw new Error("The sign-in was cancelled.");
      connecting = null;
      accounts.set(platform, {
        id: `account-${platform}`,
        platform,
        handle: "@studiowidget",
        displayName: null,
        status: "connected",
        expiresAt: null,
      });
      changed({ accounts: true });
      return state();
    },
    disconnectAccount: async (input) => {
      if ("cancel" in input) {
        if (connecting === input.platform) connecting = null;
      } else {
        const entry = [...accounts.values()].find((account) => account.id === input.accountId);
        if (entry) accounts.set(entry.platform, { ...entry, status: "revoked" });
      }
      changed({ accounts: true });
      return state();
    },
    listPosts: async (input) =>
      structuredClone(
        posts
          .filter((item) => {
            const time = item.scheduledFor ?? item.createdAt;
            return (!input.from || time >= input.from) && (!input.to || time < input.to);
          })
          .slice(0, input.limit ?? 100),
      ),
    createPost: async (input) => {
      const created = post({
        id: `post-${crypto.randomUUID()}`,
        body: input.body,
        scheduledFor: input.scheduledFor ?? null,
        statuses: Object.fromEntries(
          (input.variants ?? []).filter((item) => item.skipped).map((item) => [item.platform, "skipped"]),
        ),
        fallback: input.scheduledFor ? "queued" : "draft",
      });
      posts = [created, ...posts];
      changed({ postId: created.id });
      return structuredClone(created);
    },
    updatePost: async (input) =>
      write(input.postId, (target) => {
        if (input.action === "approve") {
          target.approvalState = "approved";
          if (target.scheduledFor && target.scheduledFor > new Date().toISOString()) queueDrafts(target);
        } else if (input.action === "unapprove") {
          target.approvalState = "pending";
          setStatuses(target, "queued", "draft");
        } else if (input.action === "unschedule") {
          target.scheduledFor = null;
          setStatuses(target, "queued", "draft");
        } else if (input.action === "retry") {
          const failed = target.variants.find((item) => item.platform === input.platform && item.status === "failed");
          if (failed) Object.assign(failed, { status: "queued", error: null, errorCode: null });
        } else {
          if (input.body !== undefined) target.body = input.body;
          for (const change of input.variants ?? []) {
            const item = target.variants.find((candidate) => candidate.platform === change.platform);
            if (!item) continue;
            if (change.body !== undefined) item.body = change.body;
            if (change.skipped === true) item.status = "skipped";
            if (change.skipped === false && item.status === "skipped")
              item.status = target.variants.some((other) => other.status === "queued") ? "queued" : "draft";
          }
        }
      }),
    deletePost: async ({ postId }) => {
      posts = posts.filter((item) => item.id !== postId);
      changed({ postId });
    },
    schedulePost: async ({ postId, scheduledFor }) =>
      write(postId, (target) => {
        target.scheduledFor = scheduledFor;
        queueDrafts(target);
      }),
    publishNow: async ({ postId }) =>
      write(postId, (target) => {
        target.scheduledFor = new Date().toISOString();
        queueDrafts(target);
      }),
    calendar: async ({ from, to }) => ({
      from,
      to,
      timezone: "Europe/Warsaw",
      posts: structuredClone(
        posts.filter((item) => item.scheduledFor !== null && item.scheduledFor >= from && item.scheduledFor < to),
      ),
    }),
    onChanged: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

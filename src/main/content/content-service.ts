/**
 * The user operations of the content manager behind the `content` IPC group, and the views that the
 * renderer reads. A view never holds a token, a ciphertext, a client secret, a stored file name, an
 * absolute path or the pending data of a network.
 *
 * Only these operations approve, queue or publish a post. Agents reach the content store through
 * `content_create_post` only, which writes a pending post.
 */

import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  CONTENT_PLATFORM_KEYS,
  type ContentAccountsState,
  type ContentAccountView,
  type ContentBeginConnectInput,
  type ContentCalendar,
  type ContentCalendarInput,
  type ContentCancelConnectInput,
  type ContentCreatePostInput,
  type ContentDisconnectInput,
  type ContentListPostsInput,
  type ContentMedia,
  type ContentMediaHostInput,
  type ContentMediaInput,
  type ContentMediaView,
  type ContentPlatform,
  type ContentPost,
  type ContentPostView,
  type ContentSaveVariantInput,
  type ContentUpdatePostInput,
  contentPostStatus,
} from "@openbot/contracts/ipc-content";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Result, Schema } from "effect";
import { localTimezone } from "../../backend/agent/routine-tools";
import { attachmentCall } from "../../backend/attachment-effects";
import type { GeneratedAttachmentSource } from "../../backend/attachment-files";
import {
  type ContentMediaRefusal,
  copyContentMedia,
  inspectContentMedia,
  isContentMediaRefusal,
} from "../../backend/content/content-media";
import {
  CONTENT_NETWORK_NAMES,
  type ContentAccountRecord,
  type ContentPostEdit,
  type ContentStore,
  type ContentVariantInput,
} from "../../backend/content/content-store";
import type { MailboxStore } from "../../backend/mailbox-store";
import { ContentAccountError, type ContentAccounts } from "./content-accounts";

/** A refused or failed user operation. `cause` is the Error that the renderer gets: `sourceText` English. */
export class ContentRequestFailed extends Schema.TaggedError<ContentRequestFailed>()("ContentRequestFailed", {
  cause: Schema.Defect(),
}) {}

function refuse(message: string): ContentRequestFailed {
  return new ContentRequestFailed({ cause: new Error(message) });
}

/** A store or account error keeps its message, which is already `sourceText` English. */
function failure(cause: unknown): ContentRequestFailed {
  if (cause instanceof ContentRequestFailed) return cause;
  if (cause instanceof ContentAccountError) return refuse(cause.message);
  return new ContentRequestFailed({ cause });
}

function storeCall<A>(operation: () => A): Effect.Effect<A, ContentRequestFailed> {
  return Effect.try({ try: operation, catch: failure });
}

function refusalText(refusal: ContentMediaRefusal): string {
  switch (refusal.refusal) {
    case "type":
      return sourceText("error.content.mediaType");
    case "size":
      return sourceText(refusal.kind === "image" ? "error.content.imageTooLarge" : "error.content.videoTooLarge", {
        size: String(refusal.limitMb),
      });
    case "kind":
      return sourceText(refusal.expected === "image" ? "error.content.takesImage" : "error.content.takesVideo", {
        network: CONTENT_NETWORK_NAMES[refusal.platform],
      });
  }
}

export function contentMediaView(media: ContentMedia | null): ContentMediaView | null {
  if (!media) return null;
  return { id: media.id, kind: media.kind, mimeType: media.mimeType, bytes: media.bytes, name: media.name };
}

export function contentPostView(post: ContentPost): ContentPostView {
  return {
    id: post.id,
    body: post.body,
    media: contentMediaView(post.media),
    approvalState: post.approvalState,
    scheduledFor: post.scheduledFor,
    timezone: post.timezone,
    authorAgentId: post.authorAgentId,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    status: contentPostStatus(post.variants),
    variants: post.variants.map((variant) => ({
      id: variant.id,
      platform: variant.platform,
      accountId: variant.accountId,
      body: variant.body,
      title: variant.title,
      media: contentMediaView(variant.media),
      status: variant.status,
      attempt: variant.attempt,
      externalPostId: variant.externalPostId,
      externalUrl: variant.externalUrl,
      errorCode: variant.errorCode,
      error: variant.error,
      publishedAt: variant.publishedAt,
      createdAt: variant.createdAt,
      updatedAt: variant.updatedAt,
      pendingReason: variant.pendingReason ?? null,
    })),
  };
}

function accountView(account: ContentAccountRecord): ContentAccountView {
  return {
    id: account.id,
    platform: account.platform,
    handle: account.handle,
    displayName: account.displayName,
    status: account.status,
    expiresAt: account.expiresAt,
  };
}

/** One draft to copy: the post's own file (`owner` null) or the own file of one network. */
interface MediaRequest {
  owner: ContentPlatform | null;
  draftId: string;
}

/** The copied media of one write, by owner. `copied` holds the new files, for removal on a failure. */
interface PreparedMedia {
  post: ContentMedia | null;
  variants: Map<ContentPlatform, ContentMedia>;
  copied: string[];
}

export interface ContentServiceOptions {
  store: ContentStore;
  accounts: ContentAccounts;
  /** The checked file of an attachment draft. */
  drafts: Pick<MailboxStore, "resolveDraftFile">;
  now: () => Date;
  /** The publisher's removal of recorded image host objects: of one variant, or of all variants. */
  releaseHostedMedia: (variantId?: string | null) => Effect.Effect<void>;
}

/**
 * Meta asks for the app secret in the token exchange. Google asks for it too: its token endpoint answers
 * "client_secret is missing" for a Desktop client, also with PKCE.
 */
const NEEDS_SECRET: ReadonlySet<ContentPlatform> = new Set([
  "linkedin",
  "instagram",
  "threads",
  "facebook_page",
  "youtube",
]);

export class ContentService {
  readonly #store: ContentStore;
  readonly #accounts: ContentAccounts;
  readonly #drafts: Pick<MailboxStore, "resolveDraftFile">;
  readonly #now: () => Date;
  readonly #releaseHostedMedia: (variantId?: string | null) => Effect.Effect<void>;

  constructor(options: ContentServiceOptions) {
    this.#store = options.store;
    this.#accounts = options.accounts;
    this.#drafts = options.drafts;
    this.#now = options.now;
    this.#releaseHostedMedia = options.releaseHostedMedia;
  }

  readonly listAccounts = Effect.fn("ContentService.listAccounts")(function* (this: ContentService) {
    const networks = [];
    for (const platform of CONTENT_PLATFORM_KEYS) {
      const app = yield* this.#accounts.app(platform).pipe(Effect.mapError(failure));
      const account = yield* storeCall(() => this.#store.latestAccount(platform));
      networks.push({
        platform,
        available: this.#accounts.adapter(platform) !== null,
        app: {
          platform,
          configured: app !== null,
          clientId: app?.clientId ?? null,
          hasSecret: Boolean(app?.clientSecret),
          needsSecret: NEEDS_SECRET.has(platform),
        },
        account: account ? accountView(account) : null,
      });
    }
    const state: ContentAccountsState = {
      networks,
      connecting: this.#accounts.connecting,
      secretStorage: this.#accounts.canPersist,
      mediaHost: this.#accounts.mediaHostView(),
    };
    return state;
  });

  /**
   * Saves the app when a client id or secret is given, then signs in. Ends when the sign-in ends: the
   * account is saved, the user cancels, or 5 minutes pass.
   */
  readonly beginConnect = Effect.fn("ContentService.beginConnect")(function* (
    this: ContentService,
    input: ContentBeginConnectInput,
  ) {
    const network = CONTENT_NETWORK_NAMES[input.platform];
    if (!this.#accounts.adapter(input.platform))
      return yield* refuse(sourceText("error.content.notSupported", { network }));
    const saved = yield* this.#accounts.app(input.platform).pipe(Effect.mapError(failure));
    const clientId = input.clientId ?? saved?.clientId;
    if (!clientId) return yield* refuse(sourceText("error.content.addApp", { network }));
    const clientSecret = input.clientSecret ?? saved?.clientSecret ?? null;
    if (NEEDS_SECRET.has(input.platform) && !clientSecret)
      return yield* refuse(sourceText("error.content.addSecret", { network }));
    if (input.platform === "instagram" && !this.#accounts.mediaHost())
      return yield* refuse(sourceText("error.content.instagramNeedsHost"));
    if (input.clientId !== undefined || input.clientSecret !== undefined)
      yield* this.#accounts.setApp(input.platform, { clientId, clientSecret }).pipe(Effect.mapError(failure));
    yield* this.#accounts.connect(input.platform).pipe(Effect.mapError(failure));
    return yield* this.listAccounts();
  });

  /**
   * Checks the image host and saves it. It needs no network app and no sign-in. Ends when the check ends:
   * it passes, fails, is cancelled, or 60 seconds pass.
   */
  readonly saveMediaHost = Effect.fn("ContentService.saveMediaHost")(function* (
    this: ContentService,
    input: ContentMediaHostInput,
  ) {
    // A recorded key does not name its bucket, so its object is removed from the current host before the
    // host changes. While one stays, nothing is saved: the new host would never find that object.
    if (this.#accounts.mediaHost()) {
      yield* this.#releaseHostedMedia(null);
      if (yield* storeCall(() => this.#store.hasHostedKeys()))
        return yield* refuse(sourceText("error.content.mediaHostCleanup"));
    }
    yield* this.#accounts.saveMediaHost(input).pipe(Effect.mapError(failure));
    return yield* this.listAccounts();
  });

  /** Stops the image host check that runs. Its save ends with `mediaHostCancelled`, and nothing is saved. */
  readonly cancelMediaHostCheck = Effect.fn("ContentService.cancelMediaHostCheck")(function* (this: ContentService) {
    this.#accounts.cancelMediaHostCheck();
    return yield* this.listAccounts();
  });

  /** Disconnects an account, or stops the sign-in of a network that waits for the browser. */
  readonly disconnectAccount = Effect.fn("ContentService.disconnectAccount")(function* (
    this: ContentService,
    input: ContentDisconnectInput | ContentCancelConnectInput,
  ) {
    if ("cancel" in input) this.#accounts.cancelConnect(input.platform);
    else {
      const { accountId } = input;
      yield* storeCall(() => this.#accounts.disconnect(accountId));
    }
    return yield* this.listAccounts();
  });

  readonly listPosts = Effect.fn("ContentService.listPosts")(function* (
    this: ContentService,
    input: ContentListPostsInput,
  ) {
    const posts = yield* storeCall(() =>
      this.#store.listPosts({
        from: input.from ?? null,
        to: input.to ?? null,
        limit: input.limit ?? INPUT_LIMITS.contentPostsPage,
      }),
    );
    return posts.map(contentPostView);
  });

  /** A post of the user: it needs no approval, and a time queues it at once. */
  readonly createPost = Effect.fn("ContentService.createPost")(function* (
    this: ContentService,
    input: ContentCreatePostInput,
  ) {
    const now = this.#now();
    if (input.scheduledFor && input.scheduledFor <= now.toISOString())
      return yield* refuse(sourceText("error.content.timeInFuture"));
    const media = yield* this.#prepareMedia(input.media, input.variants);
    const variants: Partial<Record<ContentPlatform, ContentVariantInput>> = {};
    for (const variant of input.variants ?? [])
      variants[variant.platform] = {
        body: variant.body ?? null,
        title: variant.title ?? null,
        media: media.variants.get(variant.platform) ?? null,
        status: variant.skipped ? "skipped" : "draft",
      };
    const post = yield* this.#withCopies(media, () =>
      this.#store.createPost(
        {
          body: input.body,
          media: media.post,
          approvalState: "none",
          scheduledFor: input.scheduledFor ?? null,
          timezone: input.timezone,
          authorAgentId: null,
          variants,
        },
        now,
      ),
    );
    return contentPostView(post);
  });

  readonly updatePost = Effect.fn("ContentService.updatePost")(function* (
    this: ContentService,
    input: ContentUpdatePostInput,
  ) {
    const now = this.#now();
    const { postId, platform } = input;
    switch (input.action) {
      case "approve":
        return contentPostView(yield* storeCall(() => this.#store.approvePost(postId, now)));
      case "unapprove":
        return contentPostView(yield* storeCall(() => this.#store.unapprovePost(postId, now)));
      case "unschedule":
        return contentPostView(yield* storeCall(() => this.#store.unschedulePost(postId, now)));
      case "retry":
        if (!platform) return yield* refuse(sourceText("error.content.noVariant"));
        return contentPostView(yield* storeCall(() => this.#store.retryVariant(postId, platform, now)));
      case "edit": {
        const media = yield* this.#prepareMedia(input.media, input.variants);
        const edit: ContentPostEdit = {
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(input.media === undefined ? {} : { media: media.post }),
          ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
          ...(input.variants === undefined
            ? {}
            : {
                variants: input.variants.map((variant) => ({
                  platform: variant.platform,
                  ...(variant.body === undefined ? {} : { body: variant.body }),
                  ...(variant.title === undefined ? {} : { title: variant.title }),
                  ...(variant.media === undefined ? {} : { media: media.variants.get(variant.platform) ?? null }),
                  ...(variant.skipped === undefined ? {} : { skipped: variant.skipped }),
                })),
              }),
        };
        return contentPostView(yield* this.#withCopies(media, () => this.#store.editPost(postId, edit, now)));
      }
    }
  });

  /**
   * Removes the image host objects of the post first: the store refuses the delete while a key is recorded,
   * because the variant row is the only record of that public object.
   */
  readonly deletePost = Effect.fn("ContentService.deletePost")(function* (this: ContentService, postId: string) {
    const post = yield* storeCall(() => this.#store.readPost(postId));
    for (const variant of post?.variants ?? [])
      if (this.#store.hostedKey(variant.id)) yield* this.#releaseHostedMedia(variant.id);
    yield* storeCall(() => this.#store.deletePost(postId));
  });

  readonly schedulePost = Effect.fn("ContentService.schedulePost")(function* (
    this: ContentService,
    postId: string,
    scheduledFor: string,
  ) {
    return contentPostView(yield* storeCall(() => this.#store.schedulePost(postId, scheduledFor, this.#now())));
  });

  readonly publishNow = Effect.fn("ContentService.publishNow")(function* (this: ContentService, postId: string) {
    return contentPostView(yield* storeCall(() => this.#store.publishNow(postId, this.#now())));
  });

  readonly calendar = Effect.fn("ContentService.calendar")(function* (
    this: ContentService,
    input: ContentCalendarInput,
  ) {
    const posts = yield* storeCall(() => this.#store.calendar(input));
    const calendar: ContentCalendar = {
      from: input.from,
      to: input.to,
      timezone: localTimezone(),
      posts: posts.map(contentPostView),
    };
    return calendar;
  });

  /** Runs the store write; on a failure, removes the files that this request copied. */
  #withCopies<A>(media: PreparedMedia, write: () => A): Effect.Effect<A, ContentRequestFailed> {
    return storeCall(write).pipe(
      Effect.tapError(() =>
        attachmentCall(() => Promise.allSettled(media.copied.map((file) => unlink(file)))).pipe(Effect.ignore),
      ),
    );
  }

  /**
   * Checks and copies each named draft into the media folder. The draft stays a draft. All files are
   * checked before the first copy, so a refusal copies nothing.
   */
  readonly #prepareMedia = Effect.fn("ContentService.prepareMedia")(function* (
    this: ContentService,
    postMedia: ContentMediaInput | null | undefined,
    variants: readonly ContentSaveVariantInput[] | undefined,
  ) {
    const requests: MediaRequest[] = [
      ...(postMedia ? [{ owner: null, draftId: postMedia.draftId }] : []),
      ...(variants ?? []).flatMap((variant) =>
        variant.media ? [{ owner: variant.platform, draftId: variant.media.draftId }] : [],
      ),
    ];
    const prepared: PreparedMedia = { post: null, variants: new Map(), copied: [] };
    if (requests.length === 0) return prepared;
    const sources: GeneratedAttachmentSource[] = [];
    return yield* Effect.gen({ self: this }, function* () {
      const records: Array<{ request: MediaRequest; source: GeneratedAttachmentSource; record: ContentMedia }> = [];
      for (const request of requests) {
        const file = yield* this.#drafts.resolveDraftFile(request.draftId).pipe(Effect.mapError(failure));
        if (!file) return yield* refuse(sourceText("error.content.unknownDraft"));
        const handle = yield* attachmentCall(() => open(file.path, "r")).pipe(
          Effect.mapError(() => refuse(sourceText("error.content.unknownDraft"))),
        );
        const source = { path: file.path, handle };
        sources.push(source);
        const checked = yield* inspectContentMedia(source, file.name, request.owner).pipe(
          Effect.mapError(() => refuse(sourceText("error.content.mediaCopyFailed"))),
        );
        if (isContentMediaRefusal(checked)) return yield* refuse(refusalText(checked));
        records.push({ request, source, record: checked });
      }
      const copiedAll = yield* Effect.result(
        Effect.forEach(records, ({ source, record }) =>
          copyContentMedia(source, record, join(this.#store.mediaRoot, record.file), prepared.copied),
        ),
      );
      if (Result.isFailure(copiedAll)) {
        yield* attachmentCall(() => Promise.allSettled(prepared.copied.map((file) => unlink(file)))).pipe(
          Effect.ignore,
        );
        return yield* refuse(sourceText("error.content.mediaCopyFailed"));
      }
      for (const { request, record } of records) {
        if (request.owner === null) prepared.post = record;
        else prepared.variants.set(request.owner, record);
      }
      return prepared;
    }).pipe(
      Effect.ensuring(
        attachmentCall(() => Promise.allSettled(sources.map((source) => source.handle.close()))).pipe(Effect.ignore),
      ),
    );
  });
}

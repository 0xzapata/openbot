/**
 * The publisher of the content manager, as one owner of the shared routine timer (see
 * `routine-timer.ts`).
 *
 * A pass takes at most 10 due variants, oldest first, of the networks that have an adapter. A variant
 * of another network stays `queued` and is not due, so the timer does not wake for it. Each variant is
 * claimed (`queued` -> `publishing`) before its request, so it moves out of `queued` in every pass and
 * does not fire again at once. One failure never stops the others. Nothing retries by itself: a failed
 * variant waits for the user.
 */

import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type ContentHostedHost,
  type ContentMedia,
  type ContentPlatform,
  type ContentVariantIssue,
  contentVariantIssues,
  sameContentHostedHost,
} from "@openbot/contracts/ipc-content";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect } from "effect";
import { z } from "zod";
import {
  CONTENT_NETWORK_NAMES,
  type ContentAccountRecord,
  type ContentStore,
  type ContentVariantOutcome,
  type DueContentVariant,
} from "../../backend/content/content-store";
import type { RoutineDueSource } from "../../backend/routine-timer";
import { CONTENT_REFRESH_MARGIN_MS, type ContentAccounts, signInAgain } from "./content-accounts";
import {
  ContentAdapterError,
  type ContentHostImage,
  type ContentPublishMedia,
  type ContentPublishResult,
} from "./content-adapter";
import { contentHostedKey, isContentHostedKey } from "./content-media-host";

const logger = createOpenBotLogger("content-publisher");

const PASS_LIMIT = 10;

const ISSUE_TEXT = {
  "over-limit": () => sourceText("error.content.issueOverLimit"),
  "needs-image": () => sourceText("error.content.issueNeedsImage"),
  "needs-video": () => sourceText("error.content.issueNeedsVideo"),
  "needs-title": () => sourceText("error.content.issueNeedsTitle"),
  "images-only": () => sourceText("error.content.issueImagesOnly"),
  "video-only": () => sourceText("error.content.issueVideoOnly"),
  "angle-brackets": () => sourceText("error.content.issueAngleBrackets"),
} as const satisfies Record<ContentVariantIssue, () => string>;

export interface ContentPublisherOptions {
  store: ContentStore;
  accounts: ContentAccounts;
  now: () => Date;
}

export class ContentPublisher implements RoutineDueSource {
  readonly #store: ContentStore;
  readonly #accounts: ContentAccounts;
  readonly #now: () => Date;

  constructor(options: ContentPublisherOptions) {
    this.#store = options.store;
    this.#accounts = options.accounts;
    this.#now = options.now;
  }

  nextDueAt(): string | null {
    return this.#store.nextDueAt(this.#accounts.adapterPlatforms);
  }

  readonly processDue = Effect.fn("ContentPublisher.processDue")(function* (
    this: ContentPublisher,
    now: Date,
    active: () => boolean,
  ) {
    const due = yield* Effect.try({
      try: () => this.#store.dueVariants(now, this.#accounts.adapterPlatforms, PASS_LIMIT),
      catch: (cause) => ({ cause }),
    });
    for (const item of due) {
      if (!active()) break;
      // The release runs on every exit, after the variant has its outcome.
      yield* this.#process(item).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            // The cause can name a file or a row, never a token: the adapters keep tokens out of errors.
            logger.warn("A content variant could not be processed.", {
              variantId: item.variant.id,
              platform: item.variant.platform,
              cause: String(cause),
            });
            // A claimed variant must not stay `publishing`. Only a `publishing` row changes here.
            try {
              this.#finish(item.variant.id, {
                kind: "failed",
                code: "unknown-result",
                message: sourceText("error.content.notFinished", {
                  network: CONTENT_NETWORK_NAMES[item.variant.platform],
                }),
              });
            } catch {
              // The database refused: the startup recovery ends the variant.
            }
          }),
        ),
        Effect.ensuring(this.releaseHostedMedia(item.variant.id)),
      );
    }
  });

  /**
   * Removes the image host object of each variant that the network is done with: published, failed, or
   * any status but `publishing`. Only the set-up host of the key's own bucket removes it, so a 404 means
   * that the object is gone. A failed removal does not change the post: the key stays recorded and the
   * next startup tries again. All variants at startup, or one after its publish step.
   */
  releaseHostedMedia(variantId: string | null = null): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const keys = yield* Effect.try(() => this.#store.hostedKeysToRemove(variantId)).pipe(
        Effect.orElseSucceed(() => []),
      );
      for (const { variantId: id, key, host: keyHost } of keys) {
        // The object name is not a secret: it is random and names nothing of the user. The log field is
        // `object`, because the logger hides a field named `key`.
        if (!isContentHostedKey(key)) {
          // OpenBot never made this object, so it never deletes it. The record goes, so no start tries again.
          logger.warn("A recorded image host key is not a content key; it is cleared, not deleted.", {
            variantId: id,
            object: key,
          });
          yield* Effect.try(() => this.#store.clearHostedKey(id, key)).pipe(Effect.ignore);
          continue;
        }
        // No host, a host of another bucket, or a key with no bucket: no request, and the key stays.
        const host = this.#accounts.mediaHost();
        const hostBucket = this.#accounts.mediaHostBucket();
        if (!host || !sameContentHostedHost(keyHost, hostBucket)) {
          logger.warn("An image host object waits for a host of its bucket to be set up.", {
            variantId: id,
            object: key,
            bucket: bucketName(keyHost),
            hostBucket: bucketName(hostBucket),
          });
          continue;
        }
        const removed = yield* host.remove(key).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.sync(() => {
              logger.warn("An image host object could not be removed.", {
                variantId: id,
                object: key,
                cause: error.message,
              });
              return false;
            }),
          ),
        );
        if (removed) yield* Effect.try(() => this.#store.clearHostedKey(id, key)).pipe(Effect.ignore);
      }
    });
  }

  readonly #process = Effect.fn("ContentPublisher.process")(function* (
    this: ContentPublisher,
    item: DueContentVariant,
  ) {
    const { variant } = item;
    const platform = variant.platform;
    const adapter = this.#accounts.adapter(platform);
    if (!adapter) return;
    const account = this.#store.connectedAccount(platform);

    // A check of a post that the network still works on. The variant is already `publishing`.
    if (variant.status === "publishing") {
      if (!item.pendingData) return;
      if (!account) return this.#finish(variant.id, signedOut(platform));
      const result = yield* this.#withToken(account, (accessToken) =>
        adapter.checkPostStatus({ accessToken, pendingData: pendingOf(item.pendingData ?? "") }),
      );
      return this.#write(variant.id, result);
    }

    // A key that an earlier attempt left (its removal failed): try once more before a new upload.
    yield* this.releaseHostedMedia(variant.id);
    if (!this.#store.claimVariant(variant.id, account?.id ?? null, this.#now())) return;
    // The removal failed again: no second object is made while the first one stays.
    const kept = this.#store.hostedKey(variant.id);
    if (kept)
      return this.#finish(variant.id, {
        kind: "failed",
        code: "server",
        message: this.#accounts.hostedCleanupText(kept.host),
      });

    // Decision B: Instagram with no image host fails at its time, before any request. Retry works after setup.
    if (platform === "instagram" && !this.#accounts.mediaHost())
      return this.#finish(variant.id, {
        kind: "failed",
        code: "invalid",
        message: sourceText("error.content.instagramNeedsHost"),
      });

    const body = variant.body ?? item.postBody;
    const media = variant.media ?? item.postMedia;
    const issues = contentVariantIssues({ platform, body, title: variant.title, media });
    if (issues.length > 0)
      return this.#finish(variant.id, {
        kind: "failed",
        code: "invalid",
        message: issues.map((issue) => ISSUE_TEXT[issue]()).join(" "),
      });

    const file = media ? yield* this.#readMedia(media) : null;
    if (media && !file)
      return this.#finish(variant.id, {
        kind: "failed",
        code: "invalid",
        message: sourceText("error.content.mediaUnreadable"),
      });
    // Decision B: a network with no connected account fails when its time comes.
    if (!account) return this.#finish(variant.id, signedOut(platform));
    const hostImage = this.#hostImage(variant.id, platform);
    const result = yield* this.#withToken(account, (accessToken) =>
      adapter.publish({
        accessToken,
        profile: { externalAccountId: account.externalAccountId },
        body,
        title: variant.title,
        media: file,
        ...(hostImage ? { hostImage } : {}),
      }),
    );
    this.#write(variant.id, result);
  });

  /**
   * The upload of this one variant's image, for Instagram and Threads with an image host. The key is
   * recorded on the claimed variant before the upload, so a crash after the upload leaves it for the
   * recovery. This is the only call of `put`.
   */
  #hostImage(variantId: string, platform: ContentPlatform): ContentHostImage | null {
    const host = this.#accounts.mediaHost();
    const bucket = this.#accounts.mediaHostBucket();
    if (!host || !bucket || (platform !== "instagram" && platform !== "threads")) return null;
    // One upload per publish: a second call after a token refresh gets the same URL.
    let uploaded: { url: string } | null = null;
    return (media) =>
      Effect.gen({ self: this }, function* () {
        if (uploaded) return uploaded;
        const key = contentHostedKey(media.mimeType);
        if (!key)
          return yield* new ContentAdapterError({
            code: "invalid",
            status: null,
            message: sourceText("error.content.mediaType"),
          });
        this.#store.setHostedKey(variantId, key, bucket, this.#now());
        uploaded = yield* host.put({ bytes: media.bytes, mimeType: media.mimeType }, key);
        return uploaded;
      });
  }

  /**
   * Runs `request` with a token that is not about to end. A 401 refreshes once and sends once more: a
   * 401 means that the network did not take the request. A refresh that fails makes the account `expired`.
   */
  #withToken(
    account: ContentAccountRecord,
    request: (accessToken: string) => Effect.Effect<ContentPublishResult, ContentAdapterError>,
  ): Effect.Effect<ContentPublishResult | ContentAdapterError> {
    const refresh = this.#accounts.refresh(account).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (error.code === "signed-out") this.#store.setAccountStatus(account.id, "expired", this.#now());
        }),
      ),
    );
    const margin = this.#accounts.adapter(account.platform)?.refreshMarginMs ?? CONTENT_REFRESH_MARGIN_MS;
    const endsSoon =
      account.expiresAt !== null && new Date(account.expiresAt).getTime() - this.#now().getTime() < margin;
    const first = endsSoon
      ? refresh.pipe(Effect.flatMap(request))
      : Effect.try({
          try: () => this.#accounts.accessToken(account),
          catch: () =>
            new ContentAdapterError({ code: "signed-out", status: null, message: signInAgain(account.platform) }),
        }).pipe(Effect.flatMap(request));
    return first.pipe(
      Effect.catchIf(
        (error) => error.code === "signed-out" && !endsSoon,
        () => refresh.pipe(Effect.flatMap(request)),
      ),
      Effect.catch((error) => Effect.succeed(error)),
    );
  }

  #write(variantId: string, result: ContentPublishResult | ContentAdapterError): void {
    if (result instanceof ContentAdapterError) {
      this.#finish(variantId, { kind: "failed", code: result.code, message: result.message });
      return;
    }
    if (result.kind === "published") {
      this.#finish(variantId, {
        kind: "published",
        externalPostId: result.externalPostId,
        externalUrl: httpsUrlOrNull(result.url),
      });
      return;
    }
    const checkAt = new Date(this.#now().getTime() + result.checkAfterMs).toISOString();
    this.#store.setPending(
      variantId,
      JSON.stringify({ checkAt, data: result.pendingData, ...(result.reason ? { reason: result.reason } : {}) }),
      this.#now(),
    );
  }

  #finish(variantId: string, outcome: ContentVariantOutcome): void {
    this.#store.finishVariant(variantId, outcome, this.#now());
  }

  /** The file of a media record. Only a plain file name in the media folder is read. */
  readonly #readMedia = Effect.fn("ContentPublisher.readMedia")(function* (
    this: ContentPublisher,
    media: ContentMedia,
  ) {
    if (basename(media.file) !== media.file || media.file.startsWith(".")) return null;
    const bytes = yield* Effect.promise(() => readFile(join(this.#store.mediaRoot, media.file)).catch(() => null));
    if (!bytes) return null;
    const file: ContentPublishMedia = {
      kind: media.kind,
      mimeType: media.mimeType,
      // A view, not a copy: a video can be 1 GB.
      bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      name: media.name,
    };
    return file;
  });
}

/** The bucket of a log line. The bucket and endpoint host are not secret. */
function bucketName(host: ContentHostedHost | null): string | null {
  return host ? `${host.bucket} ${host.endpointHost}` : null;
}

function signedOut(platform: ContentPlatform): Extract<ContentVariantOutcome, { kind: "failed" }> {
  return { kind: "failed", code: "signed-out", message: signInAgain(platform) };
}

const storedPendingSchema = z.object({ checkAt: z.string(), data: z.string() });

/** The adapter data inside the stored `{ checkAt, data }`. A value that is not valid goes on, and the adapter refuses it. */
function pendingOf(stored: string): string {
  try {
    return storedPendingSchema.parse(JSON.parse(stored)).data;
  } catch {
    return stored;
  }
}

/** The link of a published post, kept only when it is an https URL: the renderer opens it in the browser. */
function httpsUrlOrNull(value: string | null): string | null {
  if (value === null || !URL.canParse(value)) return null;
  return new URL(value).protocol === "https:" ? value : null;
}

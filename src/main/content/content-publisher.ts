/**
 * The publisher of the content manager, as one owner of the shared routine timer (see
 * `routine-timer.ts`).
 *
 * A pass takes at most 10 due variants, oldest first, of the networks that have an adapter. A variant
 * of another network stays `queued` and is not due, so the timer does not wake for it. The pass only
 * starts one job per variant and returns: a video upload can take an hour, and the timer must not wait
 * for it. A variant with a job is not due. Each network has one job at a time, so a slow network does not
 * delay another one, and one network never gets two posts at once. Each variant is claimed
 * (`queued` -> `publishing`) before its request. One failure never stops the others. Nothing retries by
 * itself: a failed variant waits for the user.
 */

import { openAsBlob } from "node:fs";
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
import { Effect, Fiber, Semaphore } from "effect";
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
/** 3 PUTs of up to 60 minutes each, the status queries and the waits between them. */
const VIDEO_DEADLINE_MS = 4 * 60 * 60_000;
const PUBLISH_DEADLINE_MS = 15 * 60_000;
const CHECK_DEADLINE_MS = 5 * 60_000;
/** The quit waits this long for the interrupted jobs. */
const DISPOSE_WAIT_MS = 3_000;

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
  /** Plans the routine timer again. A job can end after its pass: its next check or a sibling is then due. */
  rearm: () => void;
  /** One deadline for every job. Unset: 4 h for a YouTube publish, 15 min for another publish, 5 min for a check. */
  deadlineMs?: number;
}

export class ContentPublisher implements RoutineDueSource {
  readonly #store: ContentStore;
  readonly #accounts: ContentAccounts;
  readonly #now: () => Date;
  readonly #rearm: () => void;
  readonly #deadlineMs: number | undefined;
  /** The job of each variant that has one, waiting for its network or running. */
  readonly #running = new Map<string, Fiber.Fiber<void>>();
  /** One permit per network. */
  readonly #permits = new Map<ContentPlatform, Semaphore.Semaphore>();
  #stopping = false;

  constructor(options: ContentPublisherOptions) {
    this.#store = options.store;
    this.#accounts = options.accounts;
    this.#now = options.now;
    this.#rearm = options.rearm;
    this.#deadlineMs = options.deadlineMs;
  }

  nextDueAt(): string | null {
    return this.#store.nextDueAt(this.#accounts.adapterPlatforms, [...this.#running.keys()]);
  }

  /** True while a job waits for its network or runs. A restart waits for it. */
  busy(): boolean {
    return this.#running.size > 0;
  }

  /** Ends when no job is left, also a job that a job's end started. */
  whenIdle(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      while (this.#running.size > 0) yield* Fiber.awaitAll([...this.#running.values()]);
    });
  }

  /**
   * At quit, before the database closes. Each job is interrupted, and its request is aborted. A publish
   * that was cut off fails as `unknown-result`: the network may have the post. A check keeps its next
   * check. A hosted image key stays, and the next start removes its object.
   */
  dispose(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      this.#stopping = true;
      yield* Fiber.interruptAll([...this.#running.values()]).pipe(
        Effect.timeoutOrElse({ duration: DISPOSE_WAIT_MS, orElse: () => Effect.void }),
      );
      yield* Effect.try(() => this.#store.recoverInterrupted(this.#now())).pipe(Effect.ignore);
    });
  }

  readonly processDue = Effect.fn("ContentPublisher.processDue")(function* (
    this: ContentPublisher,
    now: Date,
    active: () => boolean,
  ) {
    if (this.#stopping) return;
    const due = yield* Effect.try({
      try: () => this.#store.dueVariants(now, this.#accounts.adapterPlatforms, PASS_LIMIT, [...this.#running.keys()]),
      catch: (cause) => ({ cause }),
    });
    for (const item of due) {
      if (!active()) break;
      this.#start(item.variant.id, item.variant.platform, active);
    }
  });

  /**
   * A root fiber, not a child of the pass: the pass is uninterruptible and must not wait. `active` is the
   * pass's live check: a suspend or a hold that comes while the job waits for its network stops it before
   * the claim, and the variant stays `queued`.
   */
  #start(variantId: string, platform: ContentPlatform, active: () => boolean): void {
    let permit = this.#permits.get(platform);
    if (!permit) {
      permit = Semaphore.makeUnsafe(1);
      this.#permits.set(platform, permit);
    }
    const fiber = Effect.runFork(
      permit
        .withPermit(Effect.suspend(() => (active() && !this.#stopping ? this.#job(variantId, platform) : Effect.void)))
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              this.#running.delete(variantId);
              if (!this.#stopping) this.#rearm();
            }),
          ),
        ),
    );
    // A job with no wait ends inside `runFork`, and its `ensuring` has already run.
    if (!fiber.pollUnsafe()) this.#running.set(variantId, fiber);
  }

  readonly #job = Effect.fn("ContentPublisher.job")(function* (
    this: ContentPublisher,
    variantId: string,
    platform: ContentPlatform,
  ) {
    // A key that an earlier attempt left (its removal failed): try once more before a new upload.
    yield* this.releaseHostedMedia(variantId);
    // The release runs on every exit, after the variant has its outcome.
    yield* Effect.gen({ self: this }, function* () {
      // The list of the pass can be old after the wait: the user may have edited, moved or unqueued the
      // post. The read and the claim run with no yield between them, and an edit is refused once the
      // variant is `publishing`, so the job sends what the read gave.
      const item = this.#store.dueVariant(variantId, this.#now(), this.#accounts.adapterPlatforms);
      if (!item) return;
      const account = this.#store.connectedAccount(platform);
      const check = item.variant.status === "publishing";
      if (!check && !this.#store.claimVariant(variantId, account?.id ?? null, this.#now())) return;
      yield* this.#process(item, account).pipe(
        Effect.timeoutOrElse({
          duration:
            this.#deadlineMs ??
            (check ? CHECK_DEADLINE_MS : platform === "youtube" ? VIDEO_DEADLINE_MS : PUBLISH_DEADLINE_MS),
          orElse: () =>
            Effect.sync(() => {
              logger.warn("A content job passed its deadline.", { variantId, platform });
              // A publish may have reached the network. A check asks again after one more deadline, with the
              // same data and the same 24 h start, so a network that hangs does not take every pass.
              if (!check) this.#finish(variantId, notFinished(platform));
              else
                this.#write(variantId, {
                  kind: "pending",
                  pendingData: pendingOf(item.pendingData ?? ""),
                  checkAfterMs: CHECK_DEADLINE_MS,
                  ...(item.variant.pendingReason ? { reason: item.variant.pendingReason } : {}),
                });
            }),
        }),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          // The cause can name a file or a row, never a token: the adapters keep tokens out of errors.
          logger.warn("A content variant could not be processed.", { variantId, platform, cause: String(cause) });
          // A claimed variant must not stay `publishing`. Only a `publishing` row changes here.
          try {
            this.#finish(variantId, notFinished(platform));
          } catch {
            // The database refused: the startup recovery ends the variant.
          }
        }),
      ),
      Effect.ensuring(this.releaseHostedMedia(variantId)),
    );
  });

  /**
   * Removes the image host object of each variant that the network is done with: published, failed, or
   * any status but `publishing`. Only the set-up host of the key's own bucket removes it, so a 404 means
   * that the object is gone. A failed removal does not change the post: the key stays recorded and the
   * next startup tries again. All variants at startup, or one after its publish step.
   */
  releaseHostedMedia(variantId: string | null = null): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      // At quit no request starts. The key stays, and the next start removes its object.
      if (this.#stopping) return;
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
    account: ContentAccountRecord | null,
  ) {
    const { variant } = item;
    const platform = variant.platform;
    const adapter = this.#accounts.adapter(platform);
    if (!adapter) return;

    // A check of a post that the network still works on. The variant is already `publishing`.
    if (variant.status === "publishing") {
      if (!item.pendingData) return;
      if (!account) return this.#finish(variant.id, signedOut(platform));
      const result = yield* this.#withToken(account, (accessToken) =>
        adapter.checkPostStatus({ accessToken, pendingData: pendingOf(item.pendingData ?? "") }),
      );
      return this.#write(variant.id, result);
    }

    // The job claimed the variant. The removal of an earlier key failed again: no second object is made while the first one stays.
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
        uploaded = yield* host.put(media, key);
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

  /**
   * The file of a media record. Only a plain file name in the media folder is read. An image is read into
   * memory. A video is a Blob of the file that `fetch` reads as it sends it: a video can be 1 GB.
   */
  readonly #readMedia = Effect.fn("ContentPublisher.readMedia")(function* (
    this: ContentPublisher,
    media: ContentMedia,
  ) {
    if (basename(media.file) !== media.file || media.file.startsWith(".")) return null;
    const path = join(this.#store.mediaRoot, media.file);
    if (media.kind === "video") {
      const file = yield* Effect.promise(() => openAsBlob(path, { type: media.mimeType }).catch(() => null));
      if (!file) return null;
      const video: ContentPublishMedia = { kind: "video", mimeType: media.mimeType, name: media.name, file };
      return video;
    }
    const bytes = yield* Effect.promise(() => readFile(path).catch(() => null));
    if (!bytes) return null;
    const image: ContentPublishMedia = {
      kind: "image",
      mimeType: media.mimeType,
      bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      name: media.name,
    };
    return image;
  });
}

/** The bucket of a log line. The bucket and endpoint host are not secret. */
function bucketName(host: ContentHostedHost | null): string | null {
  return host ? `${host.bucket} ${host.endpointHost}` : null;
}

function notFinished(platform: ContentPlatform): Extract<ContentVariantOutcome, { kind: "failed" }> {
  return {
    kind: "failed",
    code: "unknown-result",
    message: sourceText("error.content.notFinished", { network: CONTENT_NETWORK_NAMES[platform] }),
  };
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

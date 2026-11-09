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
import { type ContentMedia, type ContentPlatform, contentVariantIssues } from "@openbot/contracts/ipc-content";
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
import { CONTENT_REFRESH_MARGIN_MS, type ContentAccounts } from "./content-accounts";
import { ContentAdapterError, type ContentPublishMedia, type ContentPublishResult } from "./content-adapter";

const logger = createOpenBotLogger("content-publisher");

const PASS_LIMIT = 10;

const ISSUE_TEXT = {
  "over-limit": "The text or the title is too long for this network.",
  "needs-image": "This network needs an image.",
  "needs-video": "This network needs a video.",
  "needs-title": "This network needs a title.",
  "images-only": "This network takes only images.",
  "video-only": "This network takes only a video.",
} as const;

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
    return this.#store.nextDueAt(this.#accounts.platforms);
  }

  readonly processDue = Effect.fn("ContentPublisher.processDue")(function* (
    this: ContentPublisher,
    now: Date,
    active: () => boolean,
  ) {
    const due = yield* Effect.try({
      try: () => this.#store.dueVariants(now, this.#accounts.platforms, PASS_LIMIT),
      catch: (cause) => ({ cause }),
    });
    for (const item of due) {
      if (!active()) break;
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
                message: `OpenBot could not finish this post. Check ${CONTENT_NETWORK_NAMES[item.variant.platform]} before you retry.`,
              });
            } catch {
              // The database refused: the startup recovery ends the variant.
            }
          }),
        ),
      );
    }
  });

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

    if (!this.#store.claimVariant(variant.id, account?.id ?? null, this.#now())) return;

    const body = variant.body ?? item.postBody;
    const media = variant.media ?? item.postMedia;
    const issues = contentVariantIssues({ platform, body, title: variant.title, media });
    if (issues.length > 0)
      return this.#finish(variant.id, {
        kind: "failed",
        code: "invalid",
        message: issues.map((issue) => ISSUE_TEXT[issue]).join(" "),
      });

    const file = media ? yield* this.#readMedia(media) : null;
    if (media && !file)
      return this.#finish(variant.id, {
        kind: "failed",
        code: "invalid",
        message: "OpenBot could not read the media file of this post.",
      });
    // Decision B: a network with no connected account fails when its time comes.
    if (!account) return this.#finish(variant.id, signedOut(platform));
    const result = yield* this.#withToken(account, (accessToken) =>
      adapter.publish({
        accessToken,
        profile: { externalAccountId: account.externalAccountId },
        body,
        title: variant.title,
        media: file,
      }),
    );
    this.#write(variant.id, result);
  });

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
    const endsSoon =
      account.expiresAt !== null &&
      new Date(account.expiresAt).getTime() - this.#now().getTime() < CONTENT_REFRESH_MARGIN_MS;
    const first = endsSoon
      ? refresh.pipe(Effect.flatMap(request))
      : Effect.try({
          try: () => this.#accounts.accessToken(account),
          catch: () =>
            new ContentAdapterError({
              code: "signed-out",
              status: null,
              message: `Sign in to ${CONTENT_NETWORK_NAMES[account.platform]} again.`,
            }),
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
      this.#finish(variantId, { kind: "published", externalPostId: result.externalPostId });
      return;
    }
    const checkAt = new Date(this.#now().getTime() + result.checkAfterMs).toISOString();
    this.#store.setPending(variantId, JSON.stringify({ checkAt, data: result.pendingData }), this.#now());
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
      bytes: new Uint8Array(bytes),
      name: media.name,
    };
    return file;
  });
}

function signedOut(platform: ContentPlatform): ContentVariantOutcome {
  const name = CONTENT_NETWORK_NAMES[platform];
  return { kind: "failed", code: "signed-out", message: `Sign in to ${name} again.` };
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

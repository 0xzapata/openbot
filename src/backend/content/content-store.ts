import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  CONTENT_APPROVAL_STATES,
  CONTENT_PLATFORM_KEYS,
  CONTENT_VARIANT_STATUSES,
  type ContentApprovalState,
  type ContentMedia,
  type ContentPlatform,
  type ContentPost,
  type ContentVariant,
  decodeContentMediaJson,
  isContentPlatform,
} from "@openbot/contracts/ipc-content";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import {
  checkedColumn,
  databaseRow,
  databaseRows,
  optionalStringColumn,
  requiredNumberColumn,
  requiredStringColumn,
} from "../database/database-rows";
import type { OpenBotDatabase } from "../openbot-database";

/** The name of each network in a sentence for the user. */
export const CONTENT_NETWORK_NAMES: { readonly [platform in ContentPlatform]: string } = {
  x: "X",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  threads: "Threads",
  facebook_page: "Facebook",
  youtube: "YouTube",
};

export const CONTENT_ACCOUNT_STATUSES = ["connected", "expired", "revoked"] as const;
export type ContentAccountStatus = (typeof CONTENT_ACCOUNT_STATUSES)[number];

/** One row of `content_accounts`. The two token columns hold ciphertext only, never a token. */
export interface ContentAccountRecord {
  id: string;
  platform: ContentPlatform;
  externalAccountId: string;
  handle: string;
  displayName: string | null;
  tokenCiphertext: string;
  refreshCiphertext: string | null;
  scopes: string;
  expiresAt: string | null;
  status: ContentAccountStatus;
}

export type ContentAccountInput = Omit<ContentAccountRecord, "id" | "status">;

/** A variant that the publisher must send now, or a sent variant whose result it must check again. */
export interface DueContentVariant {
  postId: string;
  variant: ContentVariant;
  postBody: string;
  postMedia: ContentMedia | null;
  /** Set only on a `publishing` variant that waits for the network. */
  pendingData: string | null;
}

/** The result of one publish attempt that ends the attempt. */
export type ContentVariantOutcome =
  | { kind: "published"; externalPostId: string }
  | { kind: "failed"; code: string; message: string };

/** The own values of one variant. A null body or media uses the post's own. */
export interface ContentVariantInput {
  body: string | null;
  title: string | null;
  media: ContentMedia | null;
  status: "draft" | "skipped";
}

export interface ContentPostInput {
  body: string;
  media: ContentMedia | null;
  /** Only a user approves, so a new post is never `approved`. */
  approvalState: Exclude<ContentApprovalState, "approved">;
  scheduledFor: string | null;
  timezone: string;
  authorAgentId: string | null;
  /** A platform with no entry gets a draft that uses the post's text and media. */
  variants: Partial<Record<ContentPlatform, ContentVariantInput>>;
}

/** The user action does not fit the state of the post. The message is for the user. */
export class ContentStateError extends Error {}

/** The agent already has the most pending posts that it can have. */
export class ContentPendingLimitError extends Error {
  constructor() {
    super(
      `You already have ${INPUT_LIMITS.contentPendingPostsPerAgent} posts that wait for the user's approval. Ask the user to review them first.`,
    );
  }
}

/**
 * Owns the content tables (`content_posts`, `content_variants`, `content_accounts`) and the folder of
 * their media files. Each write is one `dispatch` with a `content-post` event. It never imports the
 * agent service.
 */
export class ContentStore {
  readonly #database: OpenBotDatabase;
  readonly #queued: () => void;

  /** `queued` runs after a user write that queues a variant, so the routine timer plans the new time. */
  constructor(database: OpenBotDatabase, queued: () => void = () => {}) {
    this.#database = database;
    this.#queued = queued;
  }

  /** The folder of the media files. A media record names only a file in it. */
  get mediaRoot(): string {
    return join(this.#database.userDataPath, "content-media");
  }

  /** Writes the post and one variant for each of the six platforms in one transaction. */
  createPost(input: ContentPostInput, now = new Date()): ContentPost {
    const postId = randomUUID();
    const createdAt = now.toISOString();
    return this.#database.dispatch(
      `content:create-post:${postId}`,
      [{ aggregateType: "content-post", aggregateId: postId, eventType: "content-post.created", payload: input }],
      (db, sequences) => {
        const sequence = sequences[0] ?? 0;
        // In the transaction, so two calls cannot both pass the limit.
        if (
          input.approvalState === "pending" &&
          input.authorAgentId !== null &&
          this.countPendingPosts(input.authorAgentId) >= INPUT_LIMITS.contentPendingPostsPerAgent
        )
          throw new ContentPendingLimitError();
        db.prepare(
          `INSERT INTO content_posts (
             post_id, body, media_json, approval_state, scheduled_for, timezone, author_agent_id, created_at,
             updated_at, last_event_sequence
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          postId,
          input.body,
          mediaJson(input.media),
          input.approvalState,
          input.scheduledFor,
          input.timezone,
          input.authorAgentId,
          createdAt,
          createdAt,
          sequence,
        );
        const insertVariant = db.prepare(
          `INSERT INTO content_variants (
             variant_id, post_id, platform, body, title, media_json, status, created_at, updated_at,
             last_event_sequence
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const platform of CONTENT_PLATFORM_KEYS) {
          const variant = input.variants[platform];
          insertVariant.run(
            randomUUID(),
            postId,
            platform,
            variant?.body ?? null,
            variant?.title ?? null,
            mediaJson(variant?.media ?? null),
            variant?.status ?? "draft",
            createdAt,
            createdAt,
            sequence,
          );
        }
        const post = this.readPost(postId);
        if (!post) throw new Error("The new post was not saved.");
        return post;
      },
    );
  }

  readPost(postId: string): ContentPost | null {
    const db = this.#database.connection;
    const row = databaseRow(db.prepare("SELECT * FROM content_posts WHERE post_id = ?").get(postId));
    if (!row) return null;
    const variants = databaseRows(db.prepare("SELECT * FROM content_variants WHERE post_id = ?").all(postId)).flatMap(
      decodeVariant,
    );
    variants.sort(
      (left, right) => CONTENT_PLATFORM_KEYS.indexOf(left.platform) - CONTENT_PLATFORM_KEYS.indexOf(right.platform),
    );
    return {
      id: requiredStringColumn(row, "post_id"),
      body: requiredStringColumn(row, "body"),
      media: decodeContentMediaJson(row.media_json),
      approvalState: checkedColumn(row, "approval_state", CONTENT_APPROVAL_STATES),
      scheduledFor: optionalStringColumn(row, "scheduled_for"),
      timezone: requiredStringColumn(row, "timezone"),
      authorAgentId: optionalStringColumn(row, "author_agent_id"),
      createdAt: requiredStringColumn(row, "created_at"),
      updatedAt: requiredStringColumn(row, "updated_at"),
      variants,
    };
  }

  /** The user approves a pending post. A post with a future time is queued at once. */
  approvePost(postId: string, now = new Date()): ContentPost {
    const result = this.#postWrite(postId, "content-post.approved", { postId }, (post, db, sequence) => {
      if (post.approvalState !== "pending") throw new ContentStateError("This post does not wait for approval.");
      db.prepare(
        "UPDATE content_posts SET approval_state = 'approved', updated_at = ?, last_event_sequence = ? WHERE post_id = ?",
      ).run(now.toISOString(), sequence, postId);
      if (post.scheduledFor !== null && post.scheduledFor > now.toISOString())
        this.#queueDrafts(db, postId, now, sequence);
    });
    this.#queued();
    return result;
  }

  /** Sets the one time of the post and queues every draft. A pending post must be approved first. */
  schedulePost(postId: string, scheduledFor: string, now = new Date()): ContentPost {
    const time = new Date(scheduledFor);
    if (Number.isNaN(time.getTime()) || time <= now) throw new ContentStateError("The time must be in the future.");
    return this.#queuePost(postId, time.toISOString(), now, "content-post.scheduled");
  }

  /** Queues every draft for now. The routine timer publishes them in its next pass. */
  publishNow(postId: string, now = new Date()): ContentPost {
    return this.#queuePost(postId, now.toISOString(), now, "content-post.publish-requested");
  }

  /** Every queued variant goes back to draft. The time stays as the plan. */
  unschedulePost(postId: string, now = new Date()): ContentPost {
    return this.#postWrite(postId, "content-post.unscheduled", { postId }, (post, db, sequence) => {
      if (post.variants.some((variant) => variant.status === "publishing"))
        throw new ContentStateError("OpenBot is posting this now. Wait until it ends.");
      db.prepare(
        "UPDATE content_variants SET status = 'draft', updated_at = ?, last_event_sequence = ? WHERE post_id = ? AND status = 'queued'",
      ).run(now.toISOString(), sequence, postId);
    });
  }

  /**
   * Skips one network, or takes it back. A network taken back is queued when the post is approved or
   * needs no approval and has a time, else it is a draft.
   */
  setVariantSkipped(postId: string, platform: ContentPlatform, skipped: boolean, now = new Date()): ContentPost {
    const eventType = skipped ? "content-post.variant-skipped" : "content-post.variant-unskipped";
    const result = this.#postWrite(postId, eventType, { postId, platform }, (post, db, sequence) => {
      const variant = post.variants.find((candidate) => candidate.platform === platform);
      if (!variant) throw new ContentStateError("This post has no variant for that network.");
      if (variant.status === "publishing" || variant.status === "published")
        throw new ContentStateError("This network already has the post, or OpenBot is posting it now.");
      let next: ContentVariant["status"];
      if (skipped) {
        if (variant.status !== "draft" && variant.status !== "queued")
          throw new ContentStateError("Only a draft or a queued network can be skipped.");
        next = "skipped";
      } else {
        if (variant.status !== "skipped") throw new ContentStateError("This network is not skipped.");
        next = post.approvalState !== "pending" && post.scheduledFor !== null ? "queued" : "draft";
      }
      db.prepare(
        "UPDATE content_variants SET status = ?, updated_at = ?, last_event_sequence = ? WHERE variant_id = ?",
      ).run(next, now.toISOString(), sequence, variant.id);
    });
    if (!skipped) this.#queued();
    return result;
  }

  /** Only a user action calls this. The time of the post stays, so the variant is due at once. */
  retryVariant(postId: string, platform: ContentPlatform, now = new Date()): ContentPost {
    const result = this.#postWrite(
      postId,
      "content-post.retry-requested",
      { postId, platform },
      (post, db, sequence) => {
        const variant = post.variants.find((candidate) => candidate.platform === platform);
        if (variant?.status !== "failed") throw new ContentStateError("Only a network that failed can be tried again.");
        db.prepare(
          `UPDATE content_variants SET status = 'queued', error_code = NULL, error = NULL, updated_at = ?,
           last_event_sequence = ? WHERE variant_id = ?`,
        ).run(now.toISOString(), sequence, variant.id);
      },
    );
    this.#queued();
    return result;
  }

  /**
   * The oldest due work of the networks in `platforms`, at most `limit`: queued variants whose time has
   * come, and publishing variants whose next check (`checkAt` in `pending_data`) has come. A network with
   * no adapter is not in `platforms`, so its queued variants are never due and the timer does not spin.
   */
  dueVariants(now: Date, platforms: readonly ContentPlatform[], limit: number): DueContentVariant[] {
    if (platforms.length === 0) return [];
    const time = now.toISOString();
    const rows = databaseRows(
      this.#database.connection
        .prepare(
          `SELECT v.*, p.body AS post_body, p.media_json AS post_media_json, ${DUE_AT} AS due_at
           FROM content_variants v JOIN content_posts p ON p.post_id = v.post_id
           WHERE ${DUE_WHERE} AND ${DUE_AT} <= ?
           ORDER BY due_at, v.variant_id LIMIT ?`,
        )
        .all(JSON.stringify(platforms), time, limit),
    );
    return rows.flatMap((row) =>
      decodeVariant(row).map((variant) => ({
        postId: requiredStringColumn(row, "post_id"),
        variant,
        postBody: requiredStringColumn(row, "post_body"),
        postMedia: decodeContentMediaJson(row.post_media_json),
        pendingData: optionalStringColumn(row, "pending_data"),
      })),
    );
  }

  /** The earliest time of the work that `dueVariants` returns, or null. */
  nextDueAt(platforms: readonly ContentPlatform[]): string | null {
    if (platforms.length === 0) return null;
    const row = databaseRow(
      this.#database.connection
        .prepare(
          `SELECT MIN(${DUE_AT}) AS due_at FROM content_variants v JOIN content_posts p ON p.post_id = v.post_id
           WHERE ${DUE_WHERE}`,
        )
        .get(JSON.stringify(platforms)),
    );
    return row ? optionalStringColumn(row, "due_at") : null;
  }

  /**
   * queued -> publishing, and counts the attempt. True only when this call moved the row, so two passes
   * cannot both send one variant. `accountId` is the account that the variant goes to, if any.
   */
  claimVariant(variantId: string, accountId: string | null, now = new Date()): boolean {
    try {
      return this.#variantWrite(variantId, "content-post.variant-claimed", { accountId }, (db, sequence) => {
        const changed = db
          .prepare(
            `UPDATE content_variants SET status = 'publishing', attempt = attempt + 1, account_id = COALESCE(?, account_id),
               error_code = NULL, error = NULL, pending_data = NULL, updated_at = ?, last_event_sequence = ?
             WHERE variant_id = ? AND status = 'queued'`,
          )
          .run(accountId, now.toISOString(), sequence, variantId);
        // No change: the rollback also removes the event of this call.
        if (changed.changes !== 1) throw new ClaimLost();
        return true;
      });
    } catch (error) {
      if (error instanceof ClaimLost) return false;
      throw error;
    }
  }

  /** The network has the post, or refused it. Only a `publishing` variant changes. */
  finishVariant(variantId: string, outcome: ContentVariantOutcome, now = new Date()): void {
    const eventType = outcome.kind === "published" ? "content-post.variant-published" : "content-post.variant-failed";
    const payload: Record<string, string> =
      outcome.kind === "published" ? { externalPostId: outcome.externalPostId } : { errorCode: outcome.code };
    this.#variantWrite(variantId, eventType, payload, (db, sequence) => {
      const time = now.toISOString();
      if (outcome.kind === "published")
        db.prepare(
          `UPDATE content_variants SET status = 'published', external_post_id = ?, published_at = ?, pending_data = NULL,
             error_code = NULL, error = NULL, updated_at = ?, last_event_sequence = ?
           WHERE variant_id = ? AND status = 'publishing'`,
        ).run(outcome.externalPostId, time, time, sequence, variantId);
      else
        db.prepare(
          `UPDATE content_variants SET status = 'failed', error_code = ?, error = ?, pending_data = NULL, updated_at = ?,
             last_event_sequence = ? WHERE variant_id = ? AND status = 'publishing'`,
        ).run(outcome.code, outcome.message, time, sequence, variantId);
    });
  }

  /** The network still works on the post. The variant stays `publishing` until the next check. */
  setPending(variantId: string, pendingData: string, now = new Date()): void {
    this.#variantWrite(variantId, "content-post.variant-pending", {}, (db, sequence) => {
      db.prepare(
        `UPDATE content_variants SET pending_data = ?, updated_at = ?, last_event_sequence = ?
         WHERE variant_id = ? AND status = 'publishing'`,
      ).run(pendingData, now.toISOString(), sequence, variantId);
    });
  }

  /**
   * At startup, before the publisher can fire. A `publishing` variant with no pending data was cut off
   * during its request: the network may have the post, so it fails and only the user tries again.
   */
  recoverInterrupted(now = new Date()): number {
    const rows = databaseRows(
      this.#database.connection
        .prepare(
          "SELECT variant_id, platform FROM content_variants WHERE status = 'publishing' AND pending_data IS NULL",
        )
        .all(),
    );
    for (const row of rows) {
      const platform = row.platform;
      const name = isContentPlatform(platform) ? CONTENT_NETWORK_NAMES[platform] : "the network";
      this.finishVariant(
        requiredStringColumn(row, "variant_id"),
        {
          kind: "failed",
          code: "unknown-result",
          message: `OpenBot stopped while it posted. Check ${name} before you retry.`,
        },
        now,
      );
    }
    return rows.length;
  }

  /** The connected account of a network. v1 has at most one. */
  connectedAccount(platform: ContentPlatform): ContentAccountRecord | null {
    const row = databaseRow(
      this.#database.connection
        .prepare("SELECT * FROM content_accounts WHERE platform = ? AND status = 'connected' ORDER BY updated_at DESC")
        .get(platform),
    );
    return row ? decodeAccount(row) : null;
  }

  readAccount(accountId: string): ContentAccountRecord | null {
    const row = databaseRow(
      this.#database.connection.prepare("SELECT * FROM content_accounts WHERE account_id = ?").get(accountId),
    );
    return row ? decodeAccount(row) : null;
  }

  /**
   * Saves a signed-in account as `connected`. The same network account again updates its row. v1 refuses
   * a second account of a network while one is connected.
   */
  saveAccount(input: ContentAccountInput, now = new Date()): ContentAccountRecord {
    const existing = databaseRow(
      this.#database.connection
        .prepare("SELECT account_id FROM content_accounts WHERE platform = ? AND external_account_id = ?")
        .get(input.platform, input.externalAccountId),
    );
    const accountId = existing ? requiredStringColumn(existing, "account_id") : randomUUID();
    // The dispatch returns nothing: its receipt keeps the result, and a receipt must not keep a ciphertext.
    this.#database.dispatch(
      `content:account-connected:${randomUUID()}`,
      [
        {
          aggregateType: "content-account",
          aggregateId: accountId,
          eventType: "content-account.connected",
          // Never a token or a ciphertext.
          payload: {
            accountId,
            platform: input.platform,
            handle: input.handle,
            status: "connected",
            expiresAt: input.expiresAt,
          },
        },
      ],
      (db, sequences) => {
        const other = this.connectedAccount(input.platform);
        if (other && other.id !== accountId)
          throw new ContentStateError(
            `${CONTENT_NETWORK_NAMES[input.platform]} already has a connected account (${other.handle}). Disconnect it first.`,
          );
        const time = now.toISOString();
        db.prepare(
          `INSERT INTO content_accounts (
             account_id, platform, external_account_id, handle, display_name, token_ciphertext, refresh_ciphertext,
             scopes, expires_at, status, created_at, updated_at, last_event_sequence
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET handle = excluded.handle, display_name = excluded.display_name,
             token_ciphertext = excluded.token_ciphertext, refresh_ciphertext = excluded.refresh_ciphertext,
             scopes = excluded.scopes, expires_at = excluded.expires_at, status = 'connected',
             updated_at = excluded.updated_at, last_event_sequence = excluded.last_event_sequence`,
        ).run(
          accountId,
          input.platform,
          input.externalAccountId,
          input.handle,
          input.displayName,
          input.tokenCiphertext,
          input.refreshCiphertext,
          input.scopes,
          input.expiresAt,
          time,
          time,
          sequences[0] ?? 0,
        );
      },
    );
    const saved = this.readAccount(accountId);
    if (!saved) throw new Error("The account was not saved.");
    return saved;
  }

  /** New tokens after a refresh, as ciphertext. No event: an event never holds a token. */
  updateAccountTokens(
    accountId: string,
    tokens: Pick<ContentAccountRecord, "tokenCiphertext" | "refreshCiphertext" | "expiresAt" | "scopes">,
    now = new Date(),
  ): void {
    this.#database.dispatch(`content:account-tokens:${randomUUID()}`, [], (db) => {
      db.prepare(
        `UPDATE content_accounts SET token_ciphertext = ?, refresh_ciphertext = ?, expires_at = ?, scopes = ?, updated_at = ?
         WHERE account_id = ?`,
      ).run(
        tokens.tokenCiphertext,
        tokens.refreshCiphertext,
        tokens.expiresAt,
        tokens.scopes,
        now.toISOString(),
        accountId,
      );
    });
  }

  /** `expired` after a refused refresh. */
  setAccountStatus(accountId: string, status: Exclude<ContentAccountStatus, "revoked">, now = new Date()): void {
    this.#accountWrite(accountId, "content-account.status-changed", status, (db, sequence) => {
      db.prepare(
        "UPDATE content_accounts SET status = ?, updated_at = ?, last_event_sequence = ? WHERE account_id = ?",
      ).run(status, now.toISOString(), sequence, accountId);
    });
  }

  /**
   * The user disconnects. The row stays, because published variants name it, but its tokens go: the
   * NOT NULL token column gets an empty string.
   */
  disconnectAccount(accountId: string, now = new Date()): void {
    this.#accountWrite(accountId, "content-account.disconnected", "revoked", (db, sequence) => {
      db.prepare(
        `UPDATE content_accounts SET status = 'revoked', token_ciphertext = '', refresh_ciphertext = NULL, updated_at = ?,
           last_event_sequence = ? WHERE account_id = ?`,
      ).run(now.toISOString(), sequence, accountId);
    });
  }

  #accountWrite(
    accountId: string,
    eventType: string,
    status: ContentAccountStatus,
    write: (db: DatabaseSync, sequence: number) => void,
  ): void {
    const account = this.readAccount(accountId);
    if (!account) throw new ContentStateError("This account is not known.");
    this.#database.dispatch(
      `content:${eventType}:${randomUUID()}`,
      [
        {
          aggregateType: "content-account",
          aggregateId: accountId,
          eventType,
          payload: {
            accountId,
            platform: account.platform,
            handle: account.handle,
            status,
            expiresAt: account.expiresAt,
          },
        },
      ],
      (db, sequences) => write(db, sequences[0] ?? 0),
    );
  }

  #queuePost(postId: string, scheduledFor: string, now: Date, eventType: string): ContentPost {
    const result = this.#postWrite(postId, eventType, { postId, scheduledFor }, (post, db, sequence) => {
      if (post.approvalState === "pending") throw new ContentStateError("Approve this post first.");
      db.prepare(
        "UPDATE content_posts SET scheduled_for = ?, updated_at = ?, last_event_sequence = ? WHERE post_id = ?",
      ).run(scheduledFor, now.toISOString(), sequence, postId);
      this.#queueDrafts(db, postId, now, sequence);
    });
    this.#queued();
    return result;
  }

  #queueDrafts(db: DatabaseSync, postId: string, now: Date, sequence: number): void {
    db.prepare(
      "UPDATE content_variants SET status = 'queued', updated_at = ?, last_event_sequence = ? WHERE post_id = ? AND status = 'draft'",
    ).run(now.toISOString(), sequence, postId);
  }

  /** One user write of a post, in one dispatch with one `content-post` event. */
  #postWrite(
    postId: string,
    eventType: string,
    payload: Record<string, string | null>,
    write: (post: ContentPost, db: DatabaseSync, sequence: number) => void,
  ): ContentPost {
    return this.#database.dispatch(
      `content:${eventType}:${randomUUID()}`,
      [{ aggregateType: "content-post", aggregateId: postId, eventType, payload }],
      (db, sequences) => {
        const post = this.readPost(postId);
        if (!post) throw new ContentStateError("This post is not known.");
        write(post, db, sequences[0] ?? 0);
        const saved = this.readPost(postId);
        if (!saved) throw new Error("The post was not saved.");
        return saved;
      },
    );
  }

  /** One publisher write of a variant, with one `content-post` event on the post of the variant. */
  #variantWrite<T>(
    variantId: string,
    eventType: string,
    payload: Record<string, string | null>,
    write: (db: DatabaseSync, sequence: number) => T,
  ): T {
    const row = databaseRow(
      this.#database.connection
        .prepare("SELECT post_id, platform FROM content_variants WHERE variant_id = ?")
        .get(variantId),
    );
    if (!row) throw new ContentStateError("This variant is not known.");
    const postId = requiredStringColumn(row, "post_id");
    const platform = requiredStringColumn(row, "platform");
    return this.#database.dispatch(
      `content:${eventType}:${randomUUID()}`,
      [{ aggregateType: "content-post", aggregateId: postId, eventType, payload: { ...payload, variantId, platform } }],
      (db, sequences) => write(db, sequences[0] ?? 0),
    );
  }

  countPendingPosts(agentId: string): number {
    const row = databaseRow(
      this.#database.connection
        .prepare("SELECT COUNT(*) AS count FROM content_posts WHERE author_agent_id = ? AND approval_state = 'pending'")
        .get(agentId),
    );
    return row ? requiredNumberColumn(row, "count") : 0;
  }
}

/** Thrown inside a claim that found no queued row, so its transaction rolls back. */
class ClaimLost extends Error {}

/** The due time of a variant: the post time while queued, the next check while publishing. */
const DUE_AT = `CASE v.status WHEN 'queued' THEN p.scheduled_for ELSE json_extract(v.pending_data, '$.checkAt') END`;
/** The first parameter is the platforms as a JSON array. A pending post is never due. */
const DUE_WHERE = `v.platform IN (SELECT value FROM json_each(?)) AND p.approval_state != 'pending'
  AND (v.status = 'queued' OR (v.status = 'publishing' AND v.pending_data IS NOT NULL))`;

function decodeAccount(row: DynamicRecord): ContentAccountRecord {
  const platform = row.platform;
  if (!isContentPlatform(platform)) throw new Error("Invalid SQLite column platform.");
  return {
    id: requiredStringColumn(row, "account_id"),
    platform,
    externalAccountId: requiredStringColumn(row, "external_account_id"),
    handle: requiredStringColumn(row, "handle"),
    displayName: optionalStringColumn(row, "display_name"),
    tokenCiphertext: requiredStringColumn(row, "token_ciphertext"),
    refreshCiphertext: optionalStringColumn(row, "refresh_ciphertext"),
    scopes: requiredStringColumn(row, "scopes"),
    expiresAt: optionalStringColumn(row, "expires_at"),
    status: checkedColumn(row, "status", CONTENT_ACCOUNT_STATUSES),
  };
}

function mediaJson(media: ContentMedia | null): string | null {
  return media === null ? null : JSON.stringify(media);
}

/** A variant of a platform that this version does not know is left out, so a newer row does not break the read. */
function decodeVariant(row: DynamicRecord): ContentVariant[] {
  const platform = row.platform;
  if (!isContentPlatform(platform)) return [];
  return [
    {
      id: requiredStringColumn(row, "variant_id"),
      platform,
      accountId: optionalStringColumn(row, "account_id"),
      body: optionalStringColumn(row, "body"),
      title: optionalStringColumn(row, "title"),
      media: decodeContentMediaJson(row.media_json),
      status: checkedColumn(row, "status", CONTENT_VARIANT_STATUSES),
      attempt: requiredNumberColumn(row, "attempt"),
      externalPostId: optionalStringColumn(row, "external_post_id"),
      errorCode: optionalStringColumn(row, "error_code"),
      error: optionalStringColumn(row, "error"),
      publishedAt: optionalStringColumn(row, "published_at"),
      createdAt: requiredStringColumn(row, "created_at"),
      updatedAt: requiredStringColumn(row, "updated_at"),
    },
  ];
}

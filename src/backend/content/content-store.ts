import { randomUUID } from "node:crypto";
import { join } from "node:path";
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

  constructor(database: OpenBotDatabase) {
    this.#database = database;
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

  countPendingPosts(agentId: string): number {
    const row = databaseRow(
      this.#database.connection
        .prepare("SELECT COUNT(*) AS count FROM content_posts WHERE author_agent_id = ? AND approval_state = 'pending'")
        .get(agentId),
    );
    return row ? requiredNumberColumn(row, "count") : 0;
  }
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

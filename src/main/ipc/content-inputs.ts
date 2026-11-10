// The payloads of the `content` endpoints. Each parser refuses a value with a key that the contract
// does not name. Only a malformed payload fails here, so the text stays English.

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  CONTENT_PLATFORM_KEYS,
  CONTENT_UPDATE_ACTIONS,
  type ContentBeginConnectInput,
  type ContentCalendarInput,
  type ContentCancelConnectInput,
  type ContentCreatePostInput,
  type ContentDeletePostInput,
  type ContentDisconnectInput,
  type ContentListPostsInput,
  type ContentMediaHostInput,
  type ContentPublishNowInput,
  type ContentSchedulePostInput,
  type ContentUpdatePostInput,
} from "@openbot/contracts/ipc-content";
import { z } from "zod";
import { isTimeZone } from "../../backend/agent/content-tools";

const DAY_MS = 24 * 60 * 60 * 1000;

const id = z.string().trim().min(1).max(INPUT_LIMITS.identifier);
const platform = z.enum(CONTENT_PLATFORM_KEYS);
/** ISO 8601 with an offset, stored as UTC `toISOString`, so the store can compare the text. */
const time = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const body = z
  .string()
  .max(INPUT_LIMITS.contentPostBody)
  .refine((value) => value.trim().length > 0);
const timezone = z.string().min(1).max(INPUT_LIMITS.identifier).refine(isTimeZone);
const media = z.strictObject({ draftId: id }).nullable();

const variant = z.strictObject({
  platform,
  body: body.nullable().optional(),
  title: z
    .string()
    .max(INPUT_LIMITS.contentVariantTitle)
    .refine((value) => value.trim().length > 0)
    .nullable()
    .optional(),
  media: media.optional(),
  skipped: z.boolean().optional(),
});

const variants = z
  .array(variant)
  .max(CONTENT_PLATFORM_KEYS.length)
  .refine((list) => new Set(list.map((item) => item.platform)).size === list.length, "One entry per network.")
  .refine(
    (list) => list.every((item) => item.platform === "youtube" || item.title === undefined || item.title === null),
    "Only YouTube has a title.",
  );

function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid content ${label}.`);
  return parsed.data;
}

const listPosts = z
  .strictObject({
    from: time.optional(),
    to: time.optional(),
    limit: z.number().int().min(1).max(INPUT_LIMITS.contentPostsPage).optional(),
  })
  .refine((input) => !input.from || !input.to || input.from < input.to);

export function parseContentListPosts(value: unknown): ContentListPostsInput {
  return parse(listPosts, value, "post list");
}

const createPost = z.strictObject({
  body,
  media: media.optional(),
  scheduledFor: time.nullable().optional(),
  timezone,
  variants: variants.optional(),
});

export function parseContentCreatePost(value: unknown): ContentCreatePostInput {
  return parse(createPost, value, "post");
}

const updatePost = z
  .strictObject({
    postId: id,
    action: z.enum(CONTENT_UPDATE_ACTIONS),
    body: body.optional(),
    media: media.optional(),
    timezone: timezone.optional(),
    variants: variants.optional(),
    platform: platform.optional(),
  })
  .refine((input) => (input.action === "retry") === (input.platform !== undefined), "Only retry names a network.")
  .refine(
    (input) =>
      input.action === "edit" ||
      [input.body, input.media, input.timezone, input.variants].every((field) => field === undefined),
    "Only edit changes the post.",
  );

export function parseContentUpdatePost(value: unknown): ContentUpdatePostInput {
  return parse(updatePost, value, "post change");
}

export function parseContentSchedulePost(value: unknown): ContentSchedulePostInput {
  return parse(z.strictObject({ postId: id, scheduledFor: time }), value, "schedule");
}

export function parseContentPublishNow(value: unknown): ContentPublishNowInput {
  return parse(z.strictObject({ postId: id }), value, "post");
}

export function parseContentDeletePost(value: unknown): ContentDeletePostInput {
  return parse(z.strictObject({ postId: id, leaveHostedMedia: z.literal(true).optional() }), value, "post");
}

const calendar = z
  .strictObject({ from: time, to: time })
  .refine(
    (input) =>
      input.from < input.to &&
      Date.parse(input.to) - Date.parse(input.from) <= INPUT_LIMITS.contentCalendarDays * DAY_MS,
  );

export function parseContentCalendar(value: unknown): ContentCalendarInput {
  return parse(calendar, value, "calendar range");
}

/** An https origin or address with no user, password, query or fragment. */
const httpsUrl = z
  .string()
  .trim()
  .max(INPUT_LIMITS.identifier)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
    } catch {
      return false;
    }
  })
  .transform((value) => value.replace(/\/+$/u, ""));
const mediaHostKey = z.string().trim().min(1).max(INPUT_LIMITS.mcpClientSecret);
const mediaHost = z.strictObject({
  endpoint: httpsUrl,
  // S3 bucket names: 3 to 63 lowercase letters, digits and hyphens, a letter or digit at each end.
  bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u),
  publicBaseUrl: httpsUrl,
  accessKeyId: mediaHostKey.optional(),
  secretAccessKey: mediaHostKey.optional(),
});

export function parseContentMediaHost(value: unknown): ContentMediaHostInput {
  return parse(mediaHost, value, "image host");
}

const beginConnect = z.strictObject({
  platform,
  clientId: z.string().trim().min(1).max(INPUT_LIMITS.mcpClientId).optional(),
  clientSecret: z.string().trim().min(1).max(INPUT_LIMITS.mcpClientSecret).optional(),
});

export function parseContentBeginConnect(value: unknown): ContentBeginConnectInput {
  return parse(beginConnect, value, "sign-in");
}

const disconnect = z.union([z.strictObject({ accountId: id }), z.strictObject({ platform, cancel: z.literal(true) })]);

export function parseContentDisconnect(value: unknown): ContentDisconnectInput | ContentCancelConnectInput {
  return parse(disconnect, value, "account");
}

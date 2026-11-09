import { INPUT_LIMITS } from "./input-limits";
import { isDynamicRecord, isNumber, isOneOf, isString } from "./runtime-values";

/** The networks that a post can go to, in the order the composer shows them. */
export const CONTENT_PLATFORM_KEYS = ["x", "linkedin", "instagram", "threads", "facebook_page", "youtube"] as const;
export type ContentPlatform = (typeof CONTENT_PLATFORM_KEYS)[number];

export type ContentMediaKind = "image" | "video";

export interface ContentPlatformRules {
  /** The longest text, in the units of `contentTextLength`. For YouTube, the description. */
  textLimit: number;
  /** The one kind of media file that the network takes. */
  media: ContentMediaKind;
  /** The network refuses a post with no media file. */
  mediaRequired: boolean;
  /** Only YouTube has a title. */
  titleLimit?: number;
}

export const CONTENT_PLATFORMS: { readonly [platform in ContentPlatform]: ContentPlatformRules } = {
  x: { textLimit: 280, media: "image", mediaRequired: false },
  linkedin: { textLimit: 3000, media: "image", mediaRequired: false },
  instagram: { textLimit: 2200, media: "image", mediaRequired: true },
  threads: { textLimit: 500, media: "image", mediaRequired: false },
  facebook_page: { textLimit: 63206, media: "image", mediaRequired: false },
  youtube: { textLimit: 5000, media: "video", mediaRequired: true, titleLimit: INPUT_LIMITS.contentVariantTitle },
};

export const CONTENT_APPROVAL_STATES = ["none", "pending", "approved"] as const;
export type ContentApprovalState = (typeof CONTENT_APPROVAL_STATES)[number];

export const CONTENT_VARIANT_STATUSES = ["draft", "queued", "publishing", "published", "failed", "skipped"] as const;
export type ContentVariantStatus = (typeof CONTENT_VARIANT_STATUSES)[number];
/** The status of a post, derived from its variants by `contentPostStatus`. It is never stored. */
export type ContentPostStatus = ContentVariantStatus;

/** One media file of a post or a variant. `file` is the stored file name, never a path. */
export interface ContentMedia {
  id: string;
  kind: ContentMediaKind;
  mimeType: string;
  bytes: number;
  name: string;
  file: string;
}

/** One network of a post. A null body or media means that the variant uses the post's own. */
export interface ContentVariant {
  id: string;
  platform: ContentPlatform;
  accountId: string | null;
  body: string | null;
  title: string | null;
  media: ContentMedia | null;
  status: ContentVariantStatus;
  attempt: number;
  externalPostId: string | null;
  errorCode: string | null;
  error: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContentPost {
  id: string;
  body: string;
  media: ContentMedia | null;
  approvalState: ContentApprovalState;
  /** One time for all networks. On a pending post it is only the agent's proposal. */
  scheduledFor: string | null;
  timezone: string;
  authorAgentId: string | null;
  createdAt: string;
  updatedAt: string;
  variants: ContentVariant[];
}

export type ContentVariantIssue =
  | "over-limit"
  | "needs-image"
  | "needs-video"
  | "needs-title"
  | "images-only"
  | "video-only";

export function isContentPlatform(value: unknown): value is ContentPlatform {
  return isOneOf(CONTENT_PLATFORM_KEYS, value);
}

export function isContentApprovalState(value: unknown): value is ContentApprovalState {
  return isOneOf(CONTENT_APPROVAL_STATES, value);
}

export function isContentVariantStatus(value: unknown): value is ContentVariantStatus {
  return isOneOf(CONTENT_VARIANT_STATUSES, value);
}

/** A stored file name: one path segment, so it cannot point outside the media folder. */
function isStoredFileName(value: unknown): value is string {
  return isString(value) && /^[A-Za-z0-9-]+\.[a-z0-9]+$/u.test(value);
}

export function isContentMedia(value: unknown): value is ContentMedia {
  return (
    isDynamicRecord(value) &&
    isString(value.id) &&
    isOneOf(["image", "video"] as const, value.kind) &&
    isString(value.mimeType) &&
    isNumber(value.bytes) &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 0 &&
    isString(value.name) &&
    isStoredFileName(value.file)
  );
}

/** Decodes the `media_json` column. Null for no media; a value that is not valid media throws. */
export function decodeContentMediaJson(value: unknown): ContentMedia | null {
  if (value === null || value === undefined) return null;
  const parsed = isString(value) ? JSON.parse(value) : value;
  if (!isContentMedia(parsed)) throw new Error("The stored content media is not valid.");
  return parsed;
}

/**
 * The status of a post. The first rule that matches wins. The approval state is a separate stored field
 * and is not an input.
 */
export function contentPostStatus(variants: readonly Pick<ContentVariant, "status">[]): ContentPostStatus {
  const statuses = variants.map((variant) => variant.status);
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("publishing")) return "publishing";
  if (statuses.includes("queued")) return "queued";
  if (statuses.length > 0 && statuses.every((status) => status === "skipped")) return "skipped";
  const sent = statuses.filter((status) => status !== "skipped");
  if (sent.length > 0 && sent.every((status) => status === "published")) return "published";
  return "draft";
}

const URL_PATTERN = /https?:\/\/\S+/giu;
const X_URL_LENGTH = 23;

/**
 * The length of a text as the network counts it: code points, and for X each http(s) URL counts 23.
 * ponytail: X weights some scripts and emoji as 2; use the exact weighting when the composer needs it.
 */
export function contentTextLength(platform: ContentPlatform, text: string): number {
  if (platform !== "x") return Array.from(text).length;
  const urls = text.match(URL_PATTERN) ?? [];
  return Array.from(text.replace(URL_PATTERN, "")).length + urls.length * X_URL_LENGTH;
}

/** What stops a variant from being published, from its effective values after inheritance. */
export function contentVariantIssues(input: {
  platform: ContentPlatform;
  body: string;
  title: string | null;
  media: Pick<ContentMedia, "kind"> | null;
}): ContentVariantIssue[] {
  const rules = CONTENT_PLATFORMS[input.platform];
  const issues: ContentVariantIssue[] = [];
  const titleTooLong =
    rules.titleLimit !== undefined && input.title !== null && Array.from(input.title).length > rules.titleLimit;
  if (contentTextLength(input.platform, input.body) > rules.textLimit || titleTooLong) issues.push("over-limit");
  if (input.media === null && rules.mediaRequired) issues.push(rules.media === "image" ? "needs-image" : "needs-video");
  if (input.media !== null && input.media.kind !== rules.media)
    issues.push(rules.media === "image" ? "images-only" : "video-only");
  if (rules.titleLimit !== undefined && !input.title?.trim()) issues.push("needs-title");
  return issues;
}

const MP4_BRANDS = new Set(["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "dash", "mmp4"]);

export interface ContentMediaType {
  kind: ContentMediaKind;
  mimeType: string;
  extension: string;
}

/**
 * The type of a media file from its first bytes, never from its name: PNG, JPEG, WEBP and GIF images,
 * and MP4 and QuickTime videos (an `ftyp` box). Null for any other file. Give it at least 12 bytes.
 */
export function detectContentMediaType(head: Uint8Array): ContentMediaType | null {
  const startsWith = (expected: readonly number[], offset = 0) =>
    expected.every((value, index) => head[offset + index] === value);
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { kind: "image", mimeType: "image/png", extension: "png" };
  if (startsWith([0xff, 0xd8, 0xff])) return { kind: "image", mimeType: "image/jpeg", extension: "jpg" };
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8))
    return { kind: "image", mimeType: "image/webp", extension: "webp" };
  if (startsWith([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))
    return { kind: "image", mimeType: "image/gif", extension: "gif" };
  // ISO base media: a 4-byte box size, then `ftyp`, then the major brand.
  // HEIC images and M4A audio have an `ftyp` box too, so only these brands count as video.
  if (startsWith([0x66, 0x74, 0x79, 0x70], 4) && head.length >= 12) {
    const brand = String.fromCharCode(...head.subarray(8, 12));
    if (brand === "qt  ") return { kind: "video", mimeType: "video/quicktime", extension: "mov" };
    if (MP4_BRANDS.has(brand)) return { kind: "video", mimeType: "video/mp4", extension: "mp4" };
  }
  return null;
}

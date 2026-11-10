import { INPUT_LIMITS } from "./input-limits";
import { type DynamicRecord, isBoolean, isDynamicRecord, isNumber, isOneOf, isString } from "./runtime-values";

/** The networks that a post can go to, in the order the composer shows them. */
export const CONTENT_PLATFORM_KEYS = ["x", "linkedin", "instagram", "threads", "facebook_page", "youtube"] as const;
export type ContentPlatform = (typeof CONTENT_PLATFORM_KEYS)[number];

export type ContentMediaKind = "image" | "video";

/**
 * The address that every network sends the sign-in back to. X and LinkedIn compare the registered
 * callback exactly, so the port is fixed. 28417 is the MCP listener. LinkedIn asks for https redirect
 * addresses in its documents: whether it takes `http://127.0.0.1` is not confirmed, and the user must
 * test it when they register the app.
 */
export const CONTENT_REDIRECT_PORT = 28_418;
export const CONTENT_REDIRECT_PATH = "/content-auth";
export const CONTENT_REDIRECT_URI = `http://127.0.0.1:${CONTENT_REDIRECT_PORT}${CONTENT_REDIRECT_PATH}`;

export interface ContentPlatformRules {
  /** The longest text, in the units of `contentTextLength`. For YouTube, the description. */
  textLimit: number;
  /** The one kind of media file that the network takes. */
  media: ContentMediaKind;
  /** The network refuses a post with no media file. */
  mediaRequired: boolean;
  /** Only YouTube has a title. */
  titleLimit?: number;
  /** A limit of the text in UTF-8 bytes, next to `textLimit`. Only YouTube has one. */
  textBytesLimit?: number;
}

export const CONTENT_PLATFORMS: { readonly [platform in ContentPlatform]: ContentPlatformRules } = {
  x: { textLimit: 280, media: "image", mediaRequired: false },
  linkedin: { textLimit: 3000, media: "image", mediaRequired: false },
  instagram: { textLimit: 2200, media: "image", mediaRequired: true },
  threads: { textLimit: 500, media: "image", mediaRequired: false },
  facebook_page: { textLimit: 63206, media: "image", mediaRequired: false },
  youtube: {
    textLimit: 5000,
    media: "video",
    mediaRequired: true,
    titleLimit: INPUT_LIMITS.contentVariantTitle,
    textBytesLimit: 5000,
  },
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

/** Why a `publishing` variant waits: the network accepted the post and still processes it. */
export const CONTENT_PENDING_REASONS = ["processing"] as const;
export type ContentPendingReason = (typeof CONTENT_PENDING_REASONS)[number];

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
  /** The https link that the network returned for the published post. Null when it returned none. */
  externalUrl: string | null;
  errorCode: string | null;
  error: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Set only on a `publishing` variant that waits for the network. Absent in older views. */
  pendingReason?: ContentPendingReason | null;
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
  | "video-only"
  | "angle-brackets";

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
  const bodyTooLong =
    contentTextLength(input.platform, input.body) > rules.textLimit ||
    (rules.textBytesLimit !== undefined && new TextEncoder().encode(input.body).length > rules.textBytesLimit);
  if (bodyTooLong || titleTooLong) issues.push("over-limit");
  if (input.media === null && rules.mediaRequired) issues.push(rules.media === "image" ? "needs-image" : "needs-video");
  if (input.media !== null && input.media.kind !== rules.media)
    issues.push(rules.media === "image" ? "images-only" : "video-only");
  if (rules.titleLimit !== undefined && !input.title?.trim()) issues.push("needs-title");
  // YouTube refuses `<` and `>` in the title and the description.
  if (input.platform === "youtube" && /[<>]/u.test(`${input.title ?? ""}${input.body}`)) issues.push("angle-brackets");
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

// The `content` IPC group. Every view leaves out tokens, ciphertext, client secrets, stored file names
// and absolute paths, and the decoders refuse a value with a key that the view does not name.

/** A media file as the renderer sees it: the stored file name stays in main. */
export type ContentMediaView = Omit<ContentMedia, "file">;

export type ContentVariantView = Omit<ContentVariant, "media"> & { media: ContentMediaView | null };

export type ContentPostView = Omit<ContentPost, "media" | "variants"> & {
  /** Derived in main with `contentPostStatus`. */
  status: ContentPostStatus;
  media: ContentMediaView | null;
  variants: ContentVariantView[];
};

export const CONTENT_ACCOUNT_VIEW_STATUSES = ["connected", "expired", "revoked"] as const;

export interface ContentAccountView {
  id: string;
  platform: ContentPlatform;
  handle: string;
  displayName: string | null;
  status: (typeof CONTENT_ACCOUNT_VIEW_STATUSES)[number];
  expiresAt: string | null;
}

export interface ContentAppView {
  platform: ContentPlatform;
  configured: boolean;
  clientId: string | null;
  hasSecret: boolean;
  /** LinkedIn and the Meta networks need a client secret; X and YouTube do not. */
  needsSecret: boolean;
}

export interface ContentNetworkView {
  platform: ContentPlatform;
  /** The network has an adapter in this version. */
  available: boolean;
  app: ContentAppView;
  account: ContentAccountView | null;
}

/** The image host that Instagram and Threads fetch images from. Never the access key or the secret. */
export interface ContentMediaHostView {
  configured: boolean;
  endpoint: string;
  bucket: string;
  publicBaseUrl: string;
  hasKeys: boolean;
}

export interface ContentAccountsState {
  /** One per platform, in `CONTENT_PLATFORM_KEYS` order. */
  networks: ContentNetworkView[];
  connecting: ContentPlatform | null;
  secretStorage: boolean;
  /** Absent in older views. */
  mediaHost?: ContentMediaHostView | null;
}

export interface ContentCalendar {
  from: string;
  to: string;
  timezone: string;
  /** Posts with a `scheduledFor` in the range. */
  posts: ContentPostView[];
}

export interface ContentChangedEvent {
  postId?: string;
  accounts?: true;
}

/** An attachment draft that the composer attachment flow made. The renderer never sends a path. */
export interface ContentMediaInput {
  draftId: string;
}

export interface ContentListPostsInput {
  from?: string;
  to?: string;
  limit?: number;
}

export interface ContentSaveVariantInput {
  platform: ContentPlatform;
  /** Null takes the post's own back; absent leaves it as it is. */
  body?: string | null;
  title?: string | null;
  media?: ContentMediaInput | null;
  skipped?: boolean;
}

export interface ContentCreatePostInput {
  body: string;
  media?: ContentMediaInput | null;
  scheduledFor?: string | null;
  timezone: string;
  variants?: ContentSaveVariantInput[];
}

export const CONTENT_UPDATE_ACTIONS = ["edit", "approve", "unapprove", "unschedule", "retry"] as const;

export interface ContentUpdatePostInput {
  postId: string;
  action: (typeof CONTENT_UPDATE_ACTIONS)[number];
  body?: string;
  media?: ContentMediaInput | null;
  timezone?: string;
  variants?: ContentSaveVariantInput[];
  /** Only for `retry`. */
  platform?: ContentPlatform;
}

export interface ContentSchedulePostInput {
  postId: string;
  scheduledFor: string;
}

export interface ContentPublishNowInput {
  postId: string;
}

export interface ContentDeletePostInput {
  postId: string;
}

export interface ContentCalendarInput {
  from: string;
  to: string;
}

/** The image host values. An absent key field keeps the saved one. */
export interface ContentMediaHostInput {
  endpoint: string;
  bucket: string;
  publicBaseUrl: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

/** Saves the app when a client id is given, then signs in. */
export interface ContentBeginConnectInput {
  platform: ContentPlatform;
  clientId?: string;
  clientSecret?: string;
}

export interface ContentDisconnectInput {
  accountId: string;
}

/** Stops the sign-in that waits for the browser. */
export interface ContentCancelConnectInput {
  platform: ContentPlatform;
  cancel: true;
}

/** True when the record has all `required` keys and no key outside `required` and `optional`. */
function hasKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is DynamicRecord {
  if (!isDynamicRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

const isNullableString = (value: unknown): value is string | null => value === null || isString(value);

export function isContentMediaView(value: unknown): value is ContentMediaView {
  return (
    hasKeys(value, ["id", "kind", "mimeType", "bytes", "name"]) &&
    isString(value.id) &&
    isOneOf(["image", "video"] as const, value.kind) &&
    isString(value.mimeType) &&
    isNumber(value.bytes) &&
    isString(value.name)
  );
}

const isNullableMediaView = (value: unknown): value is ContentMediaView | null =>
  value === null || isContentMediaView(value);

const VARIANT_KEYS = [
  "id",
  "platform",
  "accountId",
  "body",
  "title",
  "media",
  "status",
  "attempt",
  "externalPostId",
  "externalUrl",
  "errorCode",
  "error",
  "publishedAt",
  "createdAt",
  "updatedAt",
] as const;

export function isContentVariantView(value: unknown): value is ContentVariantView {
  return (
    hasKeys(value, VARIANT_KEYS, ["pendingReason"]) &&
    (value.pendingReason === undefined ||
      value.pendingReason === null ||
      isOneOf(CONTENT_PENDING_REASONS, value.pendingReason)) &&
    isString(value.id) &&
    isContentPlatform(value.platform) &&
    isNullableString(value.accountId) &&
    isNullableString(value.body) &&
    isNullableString(value.title) &&
    isNullableMediaView(value.media) &&
    isContentVariantStatus(value.status) &&
    isNumber(value.attempt) &&
    isNullableString(value.externalPostId) &&
    isNullableString(value.externalUrl) &&
    isNullableString(value.errorCode) &&
    isNullableString(value.error) &&
    isNullableString(value.publishedAt) &&
    isString(value.createdAt) &&
    isString(value.updatedAt)
  );
}

const POST_KEYS = [
  "id",
  "body",
  "media",
  "approvalState",
  "scheduledFor",
  "timezone",
  "authorAgentId",
  "createdAt",
  "updatedAt",
  "status",
  "variants",
] as const;

export function isContentPostView(value: unknown): value is ContentPostView {
  return (
    hasKeys(value, POST_KEYS) &&
    isString(value.id) &&
    isString(value.body) &&
    isNullableMediaView(value.media) &&
    isContentApprovalState(value.approvalState) &&
    isNullableString(value.scheduledFor) &&
    isString(value.timezone) &&
    isNullableString(value.authorAgentId) &&
    isString(value.createdAt) &&
    isString(value.updatedAt) &&
    isContentVariantStatus(value.status) &&
    Array.isArray(value.variants) &&
    value.variants.every(isContentVariantView)
  );
}

export function isContentPostViews(value: unknown): value is ContentPostView[] {
  return Array.isArray(value) && value.every(isContentPostView);
}

export function isContentAccountView(value: unknown): value is ContentAccountView {
  return (
    hasKeys(value, ["id", "platform", "handle", "displayName", "status", "expiresAt"]) &&
    isString(value.id) &&
    isContentPlatform(value.platform) &&
    isString(value.handle) &&
    isNullableString(value.displayName) &&
    isOneOf(CONTENT_ACCOUNT_VIEW_STATUSES, value.status) &&
    isNullableString(value.expiresAt)
  );
}

export function isContentAppView(value: unknown): value is ContentAppView {
  return (
    hasKeys(value, ["platform", "configured", "clientId", "hasSecret", "needsSecret"]) &&
    isContentPlatform(value.platform) &&
    isBoolean(value.configured) &&
    isNullableString(value.clientId) &&
    isBoolean(value.hasSecret) &&
    isBoolean(value.needsSecret)
  );
}

export function isContentNetworkView(value: unknown): value is ContentNetworkView {
  return (
    hasKeys(value, ["platform", "available", "app", "account"]) &&
    isContentPlatform(value.platform) &&
    isBoolean(value.available) &&
    isContentAppView(value.app) &&
    (value.account === null || isContentAccountView(value.account))
  );
}

export function isContentMediaHostView(value: unknown): value is ContentMediaHostView {
  return (
    hasKeys(value, ["configured", "endpoint", "bucket", "publicBaseUrl", "hasKeys"]) &&
    isBoolean(value.configured) &&
    isString(value.endpoint) &&
    isString(value.bucket) &&
    isString(value.publicBaseUrl) &&
    isBoolean(value.hasKeys)
  );
}

export function isContentAccountsState(value: unknown): value is ContentAccountsState {
  return (
    hasKeys(value, ["networks", "connecting", "secretStorage"], ["mediaHost"]) &&
    (value.mediaHost === undefined || value.mediaHost === null || isContentMediaHostView(value.mediaHost)) &&
    Array.isArray(value.networks) &&
    value.networks.every(isContentNetworkView) &&
    (value.connecting === null || isContentPlatform(value.connecting)) &&
    isBoolean(value.secretStorage)
  );
}

export function isContentCalendar(value: unknown): value is ContentCalendar {
  return (
    hasKeys(value, ["from", "to", "timezone", "posts"]) &&
    isString(value.from) &&
    isString(value.to) &&
    isString(value.timezone) &&
    isContentPostViews(value.posts)
  );
}

export function isContentChangedEvent(value: unknown): value is ContentChangedEvent {
  return (
    hasKeys(value, [], ["postId", "accounts"]) &&
    (value.postId === undefined || isString(value.postId)) &&
    (value.accounts === undefined || value.accounts === true)
  );
}

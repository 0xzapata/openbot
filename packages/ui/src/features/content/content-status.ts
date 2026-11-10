// The display rules of the content queue, the network chips and the composer network rows. DOM-free:
// `scripts/content-status-map-e2e.ts` asserts every rule. Values map to text keys, never to text.

import type {
  ContentMediaKind,
  ContentNetworkView,
  ContentPlatform,
  ContentPostView,
  ContentVariantStatus,
} from "@openbot/contracts/ipc-content";
import { CONTENT_PLATFORMS, contentTextLength } from "@openbot/contracts/ipc-content";
import type { AppTextKey } from "@openbot/i18n";
import { addCalendarDays, type CalendarDay, calendarDayOf } from "@openbot/team-client/routine-calendar-dates";

/** The brand names of the networks. They are not translated. */
export const CONTENT_NETWORK_NAMES: { readonly [platform in ContentPlatform]: string } = {
  x: "X",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  threads: "Threads",
  facebook_page: "Facebook Page",
  youtube: "YouTube",
};

export type ContentBadgeVariant = "primary-light" | "destructive-light" | "secondary" | "outline" | "success-light";

/** The derived status of a post in the queue. */
export type ContentPostStatusKind =
  | "pending"
  | "failed"
  | "publishing"
  | "queued"
  | "approved"
  | "skipped"
  | "published"
  | "draft";

export interface ContentPostBadge {
  kind: ContentPostStatusKind;
  /** No variant: the post is queued and shows no badge; the row shows its time. */
  variant: ContentBadgeVariant | null;
  /** The count of failed networks. */
  count: number;
  /** A pending post whose proposed time has passed. Approve then asks for a new time. */
  timePassed: boolean;
}

/** The badge text of each status that takes no value. `failed` and `queued` take one. */
export const CONTENT_STATUS_LABEL = {
  pending: "content.status.pending",
  publishing: "content.status.publishing",
  approved: "content.status.approved",
  skipped: "content.status.skipped",
  published: "content.status.published",
  draft: "content.status.draft",
} as const satisfies Record<Exclude<ContentPostStatusKind, "failed" | "queued">, AppTextKey>;

const statuses = (post: Pick<ContentPostView, "variants">) => post.variants.map((variant) => variant.status);

/** True when a network has the post, or OpenBot posts it now: then the text and the networks cannot change. */
export function contentPostLocked(post: Pick<ContentPostView, "variants">): boolean {
  return statuses(post).some((status) => status === "publishing" || status === "published");
}

/** The status badge of a queue row. The first rule that matches wins (docs/content-manager/ux.md section 1). */
export function postBadge(
  post: Pick<ContentPostView, "approvalState" | "scheduledFor" | "variants">,
  now: Date,
): ContentPostBadge {
  const all = statuses(post);
  const count = all.filter((status) => status === "failed").length;
  const timePassed =
    post.approvalState === "pending" && post.scheduledFor !== null && Date.parse(post.scheduledFor) <= now.getTime();
  const badge = (kind: ContentPostStatusKind, variant: ContentBadgeVariant | null): ContentPostBadge => ({
    kind,
    variant,
    count,
    timePassed,
  });
  if (post.approvalState === "pending") return badge("pending", "primary-light");
  if (count > 0) return badge("failed", "destructive-light");
  if (all.includes("publishing")) return badge("publishing", "secondary");
  if (all.includes("queued")) return badge("queued", null);
  if (post.approvalState === "approved" && post.scheduledFor === null) return badge("approved", "primary-light");
  if (all.length > 0 && all.every((status) => status === "skipped")) return badge("skipped", "outline");
  const sent = all.filter((status) => status !== "skipped");
  if (sent.length > 0 && sent.every((status) => status === "published")) return badge("published", "success-light");
  return badge("draft", "secondary");
}

export type ContentChipGlyph = "none" | "clock" | "check" | "x";

export interface ContentChip {
  /** The `data-status` of the chip: its colour and outline. */
  look: ContentVariantStatus;
  glyph: ContentChipGlyph;
  /** A toggle button with `aria-pressed`; else a status image with a label. */
  toggle: boolean;
  /** For a toggle: the network is in the post. */
  pressed: boolean;
  /** The accessible name: `content.chip.skip` or `content.chip.include` for a toggle, else `content.chip.label`. */
  labelKey: "content.chip.skip" | "content.chip.include" | "content.chip.label";
  /** The status word of the network, for the label of a status image and its tooltip. */
  statusKey: AppTextKey;
}

const VARIANT_KEY = {
  draft: "content.variant.draft",
  queued: "content.variant.queued",
  publishing: "content.variant.publishing",
  published: "content.variant.published",
  failed: "content.variant.failed",
  skipped: "content.variant.skipped",
} as const satisfies Record<ContentVariantStatus, AppTextKey>;

const CHIP_GLYPH = {
  draft: "none",
  queued: "none",
  publishing: "clock",
  published: "check",
  failed: "x",
  skipped: "none",
} as const satisfies Record<ContentVariantStatus, ContentChipGlyph>;

/**
 * The chip of one network. `pending` is the variant of a post that waits for approval. A chip is a toggle
 * only while its network is a draft, queued, pending or skipped, and the post is not `locked`
 * (`contentPostLocked`): the store refuses to skip a network of a post that a network already has.
 */
export function variantChip(status: ContentVariantStatus | "pending", locked = false): ContentChip {
  const look = status === "pending" ? "draft" : status;
  const statusKey = status === "pending" ? "content.variant.pending" : VARIANT_KEY[status];
  const toggle = !locked && (look === "draft" || look === "queued" || look === "skipped");
  const pressed = toggle && look !== "skipped";
  const labelKey = !toggle ? "content.chip.label" : pressed ? "content.chip.skip" : "content.chip.include";
  return { look, glyph: CHIP_GLYPH[look], toggle, pressed, labelKey, statusKey };
}

export type ContentQueueSection = "needsYou" | "today" | "tomorrow" | `day:${CalendarDay}` | "drafts" | "done";

/** The queue section of a post. A due or publishing post from an earlier day shows under Today. */
export function queueSection(
  post: Pick<ContentPostView, "approvalState" | "scheduledFor" | "variants">,
  now: Date,
  timeZone: string,
): ContentQueueSection {
  const { kind } = postBadge(post, now);
  if (kind === "pending" || kind === "failed" || kind === "approved") return "needsYou";
  if (kind === "skipped" || kind === "published") return "done";
  if (post.scheduledFor === null || (kind !== "queued" && kind !== "publishing")) return "drafts";
  const today = calendarDayOf(now, timeZone);
  const day = calendarDayOf(new Date(post.scheduledFor), timeZone);
  if (day <= today) return "today";
  if (day === addCalendarDays(today, 1)) return "tomorrow";
  return `day:${day}`;
}

/** The time of the last network that has the post, else the post time, else its last change. */
function doneAt(post: Pick<ContentPostView, "scheduledFor" | "updatedAt" | "variants">): number {
  const published = post.variants.flatMap((variant) => (variant.publishedAt ? [Date.parse(variant.publishedAt)] : []));
  if (published.length > 0) return Math.max(...published);
  return Date.parse(post.scheduledFor ?? post.updatedAt);
}

export interface ContentQueueGroup<T> {
  section: ContentQueueSection;
  posts: T[];
}

/**
 * The queue in reading order: Needs you (oldest first), Today, Tomorrow and each later day (in time order),
 * Drafts (last change first), Done (newest first). An empty section is left out.
 */
export function queueSections<T extends ContentPostView>(
  posts: readonly T[],
  now: Date,
  timeZone: string,
): ContentQueueGroup<T>[] {
  const bySection = new Map<ContentQueueSection, T[]>();
  for (const post of posts) {
    const section = queueSection(post, now, timeZone);
    bySection.set(section, [...(bySection.get(section) ?? []), post]);
  }
  const time = (post: T) => Date.parse(post.scheduledFor ?? post.createdAt);
  const days = [...bySection.keys()].filter((section) => section.startsWith("day:")).sort();
  const order: ContentQueueSection[] = ["needsYou", "today", "tomorrow", ...days, "drafts", "done"];
  return order.flatMap((section) => {
    const list = bySection.get(section);
    if (!list) return [];
    const sorted = [...list];
    if (section === "needsYou") sorted.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    else if (section === "drafts")
      sorted.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    else if (section === "done") sorted.sort((left, right) => doneAt(right) - doneAt(left));
    else sorted.sort((left, right) => time(left) - time(right));
    return [{ section, posts: sorted }];
  });
}

/** Why a network cannot be chosen in the composer. Null: it can. */
export type ContentNetworkBlock = "unavailable" | "notConnected" | "needsVideo" | "imagesOnly" | null;
/** What stops a chosen network. The first one is the footer reason. */
export type ContentNetworkIssue = "overLimit" | "needsImage" | "noTitle";

export interface ContentNetworkRow {
  block: ContentNetworkBlock;
  /** Only for a chosen network that is not blocked. */
  issues: ContentNetworkIssue[];
  /** The length of the text as the network counts it, and its limit. */
  length: number;
  limit: number;
}

/** The network row rules of the composer (docs/content-manager/ux.md section 3, S3). */
export function networkRow(input: {
  network: Pick<ContentNetworkView, "platform" | "available" | "account">;
  chosen: boolean;
  /** The text this network posts: its own text, or the main text. */
  text: string;
  title: string;
  media: ContentMediaKind | null;
}): ContentNetworkRow {
  const rules = CONTENT_PLATFORMS[input.network.platform];
  const length = contentTextLength(input.network.platform, input.text);
  const row = (block: ContentNetworkBlock, issues: ContentNetworkIssue[] = []): ContentNetworkRow => ({
    block,
    issues,
    length,
    limit: rules.textLimit,
  });
  if (!input.network.available) return row("unavailable");
  const account = input.network.account;
  if (!account || account.status === "revoked") return row("notConnected");
  if (input.media !== null && input.media !== rules.media)
    return row(rules.media === "video" ? "needsVideo" : "imagesOnly");
  // A video network with no video cannot be chosen; an image network with no image can, and blocks (Instagram).
  if (input.media === null && rules.mediaRequired && rules.media === "video") return row("needsVideo");
  if (!input.chosen) return row(null);
  const issues: ContentNetworkIssue[] = [];
  const titleTooLong = rules.titleLimit !== undefined && Array.from(input.title).length > rules.titleLimit;
  if (length > rules.textLimit || titleTooLong) issues.push("overLimit");
  if (input.media === null && rules.mediaRequired && rules.media === "image") issues.push("needsImage");
  if (rules.titleLimit !== undefined && !input.title.trim()) issues.push("noTitle");
  return row(null, issues);
}

/** The Instagram gate of v1 is Meta app review; YouTube waits for Google verification. */
export function contentGateKey(platform: ContentPlatform): "content.gate.meta" | "content.gate.google" {
  return platform === "youtube" ? "content.gate.google" : "content.gate.meta";
}

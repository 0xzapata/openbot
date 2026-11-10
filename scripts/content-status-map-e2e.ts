// Checks the display rules of the content manager: the post badge table (docs/content-manager/ux.md
// section 1, in its order), the chip of every variant status, the queue section rules and the order of the
// sections and of Done, and the composer network row rules. It runs the shared module that the Content page
// renders with, on example posts of the preview mock shape.
//
// Run: bunx tsx scripts/content-status-map-e2e.ts
// Writes .openbot-build/content-status-map-e2e/report.json and exits non-zero on a failure.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CONTENT_PLATFORM_KEYS,
  CONTENT_VARIANT_STATUSES,
  type ContentNetworkView,
  type ContentPlatform,
  type ContentPostView,
  type ContentVariantStatus,
  contentPostStatus,
} from "@openbot/contracts/ipc-content";
import {
  contentPostLocked,
  networkRow,
  postBadge,
  queueSection,
  queueSections,
  variantChip,
} from "@openbot/ui/features/content/content-status";

const OUT = resolve(import.meta.dirname, "../.openbot-build/content-status-map-e2e");
const ZONE = "Europe/Warsaw";
/** Tuesday, November 10, 2026, 10:00 in Warsaw. */
const NOW = new Date("2026-11-10T09:00:00.000Z");
const HOUR = 3_600_000;
const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR).toISOString();

interface Step {
  name: string;
  passed: boolean;
  detail?: unknown;
  error?: string;
}
const report: { passed: boolean; steps: Step[] } = { passed: false, steps: [] };

function step(name: string, run: () => unknown): void {
  try {
    report.steps.push({ name, passed: true, detail: run() });
  } catch (error) {
    report.steps.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) });
  }
}

let next = 0;
function post(input: {
  approvalState?: ContentPostView["approvalState"];
  scheduledFor?: string | null;
  statuses: Partial<Record<ContentPlatform, ContentVariantStatus>>;
  createdAt?: string;
  updatedAt?: string;
  publishedAt?: string;
}): ContentPostView {
  next += 1;
  const created = input.createdAt ?? at(-100);
  const variants = CONTENT_PLATFORM_KEYS.map((platform) => {
    const status = input.statuses[platform] ?? "skipped";
    return {
      id: `variant-${next}-${platform}`,
      platform,
      accountId: null,
      body: null,
      title: null,
      media: null,
      status,
      attempt: 0,
      externalPostId: null,
      errorCode: null,
      error: null,
      publishedAt: status === "published" ? (input.publishedAt ?? created) : null,
      createdAt: created,
      updatedAt: created,
    };
  });
  return {
    id: `post-${next}`,
    body: `Post ${next}`,
    media: null,
    approvalState: input.approvalState ?? "none",
    scheduledFor: input.scheduledFor === undefined ? null : input.scheduledFor,
    timezone: ZONE,
    authorAgentId: null,
    createdAt: created,
    updatedAt: input.updatedAt ?? created,
    status: contentPostStatus(variants),
    variants,
  };
}

try {
  step("1. The badge table: the first rule that matches wins, in the ux.md order", () => {
    const cases: Array<[string, ContentPostView, string, string | null, number?]> = [
      // Rule 1 wins over a failed network.
      [
        "pending",
        post({ approvalState: "pending", scheduledFor: at(24), statuses: { x: "failed" } }),
        "pending",
        "primary-light",
      ],
      [
        "failed (2)",
        post({ scheduledFor: at(-1), statuses: { x: "failed", linkedin: "published", threads: "failed" } }),
        "failed",
        "destructive-light",
        2,
      ],
      // Rule 2 wins over publishing.
      [
        "failed over publishing",
        post({ scheduledFor: at(-1), statuses: { x: "failed", youtube: "publishing" } }),
        "failed",
        "destructive-light",
        1,
      ],
      [
        "publishing",
        post({ scheduledFor: at(-1), statuses: { youtube: "publishing", x: "queued" } }),
        "publishing",
        "secondary",
      ],
      ["queued", post({ scheduledFor: at(2), statuses: { x: "queued" } }), "queued", null],
      ["approved, no time", post({ approvalState: "approved", statuses: { x: "draft" } }), "approved", "primary-light"],
      // Rule 4 wins over rule 5: approved with a time and queued networks.
      [
        "approved and queued",
        post({ approvalState: "approved", scheduledFor: at(8), statuses: { x: "queued" } }),
        "queued",
        null,
      ],
      ["all skipped", post({ scheduledFor: at(-72), statuses: {} }), "skipped", "outline"],
      [
        "published",
        post({ scheduledFor: at(-48), statuses: { x: "published", linkedin: "published" } }),
        "published",
        "success-light",
      ],
      ["draft", post({ statuses: { linkedin: "draft" } }), "draft", "secondary"],
      // A post with a published and a draft network is not done.
      ["partly published", post({ statuses: { x: "published", linkedin: "draft" } }), "draft", "secondary"],
    ];
    for (const [name, example, key, variant, count] of cases) {
      const badge = postBadge(example, NOW);
      assert.equal(badge.kind, key, name);
      assert.equal(badge.variant, variant, name);
      if (count !== undefined) assert.equal(badge.count, count, name);
      assert.equal(badge.timePassed, false, name);
    }
    return { cases: cases.length };
  });

  step("2. A pending post whose time has passed says so; one in the future or with no time does not", () => {
    assert.equal(
      postBadge(post({ approvalState: "pending", scheduledFor: at(-1), statuses: {} }), NOW).timePassed,
      true,
    );
    assert.equal(
      postBadge(post({ approvalState: "pending", scheduledFor: at(1), statuses: {} }), NOW).timePassed,
      false,
    );
    assert.equal(postBadge(post({ approvalState: "pending", statuses: {} }), NOW).timePassed, false);
    assert.equal(postBadge(post({ scheduledFor: at(-1), statuses: { x: "draft" } }), NOW).timePassed, false);
  });

  step("3. The chip of every variant status, and of a pending post", () => {
    const expected = {
      draft: { look: "draft", glyph: "none", toggle: true, pressed: true, labelKey: "content.chip.skip" },
      queued: { look: "queued", glyph: "none", toggle: true, pressed: true, labelKey: "content.chip.skip" },
      publishing: { look: "publishing", glyph: "clock", toggle: false, pressed: false, labelKey: "content.chip.label" },
      published: { look: "published", glyph: "check", toggle: false, pressed: false, labelKey: "content.chip.label" },
      failed: { look: "failed", glyph: "x", toggle: false, pressed: false, labelKey: "content.chip.label" },
      skipped: { look: "skipped", glyph: "none", toggle: true, pressed: false, labelKey: "content.chip.include" },
    } as const;
    for (const status of CONTENT_VARIANT_STATUSES) {
      const chip = variantChip(status);
      assert.deepEqual(
        { look: chip.look, glyph: chip.glyph, toggle: chip.toggle, pressed: chip.pressed, labelKey: chip.labelKey },
        expected[status],
        status,
      );
      assert.equal(chip.statusKey, `content.variant.${status}`);
    }
    const pending = variantChip("pending");
    assert.deepEqual(
      [pending.look, pending.toggle, pending.pressed, pending.statusKey],
      ["draft", true, true, "content.variant.pending"],
    );
    // A post that a network already has cannot skip or take back a network: no chip is a toggle.
    for (const status of ["draft", "queued", "skipped"] as const) {
      const chip = variantChip(status, true);
      assert.equal(chip.toggle, false, status);
      assert.equal(chip.labelKey, "content.chip.label", status);
    }
    const sent = post({ statuses: { x: "published", linkedin: "draft" } });
    assert.equal(contentPostLocked(sent), true);
    assert.equal(contentPostLocked(post({ statuses: { x: "failed", linkedin: "draft" } })), false);
    return { statuses: CONTENT_VARIANT_STATUSES.length + 1 };
  });

  step("4. The section of each kind of post", () => {
    const cases: Array<[string, ContentPostView, string]> = [
      ["pending", post({ approvalState: "pending", scheduledFor: at(48), statuses: { x: "draft" } }), "needsYou"],
      ["failed", post({ scheduledFor: at(-1), statuses: { x: "failed" } }), "needsYou"],
      ["approved, no time", post({ approvalState: "approved", statuses: { x: "draft" } }), "needsYou"],
      ["queued today", post({ scheduledFor: at(8), statuses: { x: "queued" } }), "today"],
      // A due post and a publishing post from an earlier hour stay under Today.
      ["publishing", post({ scheduledFor: at(-2), statuses: { youtube: "publishing" } }), "today"],
      ["due yesterday", post({ scheduledFor: at(-30), statuses: { x: "queued" } }), "today"],
      // 23:30 in Warsaw is still today; 00:30 is tomorrow.
      ["queued late today", post({ scheduledFor: "2026-11-10T22:30:00.000Z", statuses: { x: "queued" } }), "today"],
      ["queued tomorrow", post({ scheduledFor: "2026-11-10T23:30:00.000Z", statuses: { x: "queued" } }), "tomorrow"],
      ["queued later", post({ scheduledFor: "2026-11-13T08:00:00.000Z", statuses: { x: "queued" } }), "day:2026-11-13"],
      ["draft", post({ statuses: { linkedin: "draft" } }), "drafts"],
      ["published", post({ scheduledFor: at(-48), statuses: { x: "published" } }), "done"],
      ["skipped", post({ scheduledFor: at(-72), statuses: {} }), "done"],
    ];
    for (const [name, example, section] of cases) assert.equal(queueSection(example, NOW, ZONE), section, name);
    return { cases: cases.length };
  });

  step("5. The sections in reading order, each in its own order; Done newest first", () => {
    const needsOld = post({ approvalState: "pending", statuses: { x: "draft" }, createdAt: at(-50) });
    const needsNew = post({ scheduledFor: at(-1), statuses: { x: "failed" }, createdAt: at(-5) });
    const todayLate = post({ scheduledFor: at(8), statuses: { x: "queued" } });
    const todayEarly = post({ scheduledFor: at(2), statuses: { x: "queued" } });
    const tomorrow = post({ scheduledFor: at(24), statuses: { x: "queued" } });
    const friday = post({ scheduledFor: "2026-11-13T08:00:00.000Z", statuses: { x: "queued" } });
    const thursday = post({ scheduledFor: "2026-11-12T08:00:00.000Z", statuses: { x: "queued" } });
    const draftOld = post({ statuses: { x: "draft" }, updatedAt: at(-10) });
    const draftNew = post({ statuses: { x: "draft" }, updatedAt: at(-1) });
    const doneOld = post({ scheduledFor: at(-72), statuses: {} });
    const doneNew = post({ scheduledFor: at(-48), statuses: { x: "published" }, publishedAt: at(-47) });
    // Published late: its publish time, not its post time, places it.
    const doneLate = post({ scheduledFor: at(-96), statuses: { x: "published" }, publishedAt: at(-3) });
    const groups = queueSections(
      [
        doneOld,
        draftOld,
        friday,
        todayLate,
        needsNew,
        doneNew,
        tomorrow,
        thursday,
        draftNew,
        needsOld,
        todayEarly,
        doneLate,
      ],
      NOW,
      ZONE,
    );
    const shape = groups.map((group) => [group.section, group.posts.map((item) => item.id)]);
    assert.deepEqual(shape, [
      ["needsYou", [needsOld.id, needsNew.id]],
      ["today", [todayEarly.id, todayLate.id]],
      ["tomorrow", [tomorrow.id]],
      ["day:2026-11-12", [thursday.id]],
      ["day:2026-11-13", [friday.id]],
      ["drafts", [draftNew.id, draftOld.id]],
      ["done", [doneLate.id, doneNew.id, doneOld.id]],
    ]);
    // An empty section is left out.
    assert.deepEqual(
      queueSections([draftOld], NOW, ZONE).map((group) => group.section),
      ["drafts"],
    );
    return { sections: groups.length };
  });

  step("6. The composer network row rules", () => {
    const network = (
      platform: ContentPlatform,
      account: "connected" | "expired" | "revoked" | null = "connected",
      available = true,
    ): Pick<ContentNetworkView, "platform" | "available" | "account"> => ({
      platform,
      available,
      account: account
        ? { id: `a-${platform}`, platform, handle: "@a", displayName: null, status: account, expiresAt: null }
        : null,
    });
    const row = (
      platform: ContentPlatform,
      options: {
        account?: "connected" | "expired" | "revoked" | null;
        available?: boolean;
        chosen?: boolean;
        text?: string;
        title?: string;
        media?: "image" | "video" | null;
      } = {},
    ) =>
      networkRow({
        network: network(
          platform,
          options.account === undefined ? "connected" : options.account,
          options.available ?? true,
        ),
        chosen: options.chosen ?? true,
        text: options.text ?? "Hello",
        title: options.title ?? "",
        media: options.media ?? null,
      });
    assert.equal(row("instagram", { available: false }).block, "unavailable");
    assert.equal(row("x", { account: null }).block, "notConnected");
    assert.equal(row("x", { account: "revoked" }).block, "notConnected");
    // A signed-out account can still be chosen: the queue shows the banner, and publish fails until sign-in.
    assert.equal(row("x", { account: "expired" }).block, null);
    assert.equal(row("youtube", { media: "image" }).block, "needsVideo");
    assert.equal(row("youtube").block, "needsVideo");
    assert.equal(row("x", { media: "video" }).block, "imagesOnly");
    assert.deepEqual(row("instagram").issues, ["needsImage"]);
    assert.deepEqual(row("instagram", { media: "image" }).issues, []);
    assert.deepEqual(row("youtube", { media: "video" }).issues, ["noTitle"]);
    assert.deepEqual(row("youtube", { media: "video", title: "What is new" }).issues, []);
    const long = "a".repeat(541);
    const threads = row("threads", { text: long });
    assert.deepEqual([threads.issues, threads.length, threads.limit], [["overLimit"], 541, 500]);
    // X counts a link as 23.
    const link = row("x", { text: `See https://example.com/${"p".repeat(300)}` });
    assert.deepEqual([link.issues, link.length], [[], 27]);
    // A network that is not chosen shows no issue.
    assert.deepEqual(row("instagram", { chosen: false }).issues, []);
  });

  report.passed = report.steps.every((entry) => entry.passed);
} finally {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  for (const entry of report.steps) if (!entry.passed) process.stderr.write(`FAILED ${entry.name}: ${entry.error}\n`);
  process.stdout.write(`${report.passed ? "passed" : "FAILED"}: ${join(OUT, "report.json")}\n`);
  if (!report.passed) process.exitCode = 1;
}

// Checks the `content_create_post` agent tool on a real temporary profile: the real SQLite database
// with migration 60, the real agent store, and the real attachment gateway that opens the agent's
// files. Each call goes through `handleContentTool` as the tool router sends it, and a failed Effect
// becomes the tool failure of the router. The agent's workspace holds a real PNG, a real MP4 (`ftyp`
// box), a file with a PNG name and other bytes, a symbolic link, and the profile has a file outside the
// permitted folders. No app, provider, account or network is started.
//
// Run: bunx tsx scripts/content-create-post-e2e.ts
// (bun cannot load `node:sqlite`, so this runs on Node through tsx.)
// Writes .openbot-build/content-create-post-e2e/report.json and exits non-zero on a failure.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  CONTENT_PLATFORM_KEYS,
  type ContentPostStatus,
  type ContentVariantStatus,
  contentPostStatus,
} from "@openbot/contracts/ipc-content";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { AttachmentGateway } from "../src/backend/agent/attachment-gateway";
import { CONTENT_CREATE_POST, handleContentTool } from "../src/backend/agent/content-tools";
import { ConversationRuntime } from "../src/backend/agent/conversation-runtime";
import { openBotToolFailure } from "../src/backend/agent/routine-tools";
import { AgentStore } from "../src/backend/agent-store";
import { ContentStore } from "../src/backend/content/content-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { OpenBotDatabase } from "../src/backend/openbot-database";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".openbot-build", "content-create-post-e2e");

interface Step {
  name: string;
  passed: boolean;
  detail?: unknown;
  error?: string;
}

const report: { passed: boolean; steps: Step[] } = { passed: false, steps: [] };

async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  process.stdout.write(`- ${name}\n`);
  try {
    const value = await run();
    report.steps.push({ name, passed: true, detail: value });
    return value;
  } catch (error) {
    report.steps.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/** The `variants` of a tool answer: the platform, length, limit and issue texts of each network. */
function answerVariants(value: DynamicRecord) {
  assert.ok(Array.isArray(value.variants), "The answer lists the variants.");
  return value.variants.map((variant: unknown) => {
    assert.ok(isDynamicRecord(variant), "A variant is an object.");
    const { platform, length, limit, issues } = variant;
    assert.ok(typeof platform === "string" && typeof length === "number" && typeof limit === "number");
    assert.ok(Array.isArray(issues) && issues.every((issue) => typeof issue === "string"));
    return { platform, length, limit, issues };
  });
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
// One `ftyp` box: size 24, brand `isom`, minor version 512, compatible brands `isom` and `iso2`.
const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from("ftypisom"),
  Buffer.from([0, 0, 2, 0]),
  Buffer.from("isomiso2"),
]);

const root = await mkdtemp(join(tmpdir(), "openbot-content-post-"));
const database = new OpenBotDatabase(join(root, "state"));
const store = new AgentStore(join(root, "state"), join(root, "home"), database);

try {
  await runCauseEffect(store.initialize());
  const agent = await runCauseEffect(
    store.createAgent({ name: "Herald", description: "Writes posts", avatarSeed: "herald", avatarHue: null }),
  );
  const content = new ContentStore(database);
  const mailbox = new MailboxStore(join(root, "state"), store.sharedRoot, database);
  const conversation = new ConversationRuntime(
    store,
    () => {},
    () => store.list(),
  );
  const attachments = new AttachmentGateway({
    conversation,
    mailbox,
    sharedRoot: store.sharedRoot,
    hooks: { emit: () => {}, emitError: () => {} },
  });

  const workspace = agent.workspacePath;
  await writeFile(join(workspace, "launch.png"), PNG);
  await writeFile(join(workspace, "teaser.mp4"), MP4);
  await writeFile(join(workspace, "fake.png"), "This is text with a PNG name.");
  await symlink(join(workspace, "launch.png"), join(workspace, "link.png"));
  const outside = join(root, "outside.png");
  await writeFile(outside, PNG);

  /** One call from the agent, answered as the tool router answers it. */
  const call = async (args: unknown): Promise<{ success: boolean; value: DynamicRecord }> => {
    const response = await Effect.runPromise(
      handleContentTool(CONTENT_CREATE_POST, args, agent.id, { content, attachments }).pipe(
        Effect.catch((failure) =>
          Effect.succeed(
            openBotToolFailure(failure.cause instanceof Error ? failure.cause.message : String(failure.cause)),
          ),
        ),
      ),
    );
    assert.ok(response, "The content tool answers its own tool.");
    const item = response.contentItems[0];
    assert.ok(item && item.type === "inputText", "The answer is text.");
    const value = JSON.parse(item.text);
    assert.ok(isDynamicRecord(value), "The answer is a JSON object.");
    return { success: response.success, value };
  };
  const postCount = () => Number(database.connection.prepare("SELECT COUNT(*) AS n FROM content_posts").get()?.n);
  const variantCount = () => Number(database.connection.prepare("SELECT COUNT(*) AS n FROM content_variants").get()?.n);
  const mediaFiles = async () => (await readdir(content.mediaRoot).catch(() => [])).sort();
  const future = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

  await step("another tool goes on down the router chain", async () => {
    const response = await Effect.runPromise(handleContentTool("list_tables", {}, agent.id, { content, attachments }));
    assert.equal(response, null);
    return { answer: response };
  });

  await step("a body-only post is pending with six inheriting drafts", async () => {
    const result = await call({ body: "We ship on Friday." });
    assert.equal(result.success, true, JSON.stringify(result.value));
    const post = content.readPost(String(result.value.postId));
    assert.ok(post);
    assert.equal(post.approvalState, "pending");
    assert.equal(post.authorAgentId, agent.id);
    assert.equal(post.scheduledFor, null);
    assert.equal(post.media, null);
    assert.deepEqual(
      post.variants.map((variant) => variant.platform),
      [...CONTENT_PLATFORM_KEYS],
    );
    for (const variant of post.variants) {
      assert.equal(variant.status, "draft");
      assert.equal(variant.body, null);
      assert.equal(variant.media, null);
      assert.equal(variant.title, null);
      assert.equal(variant.accountId, null);
    }
    assert.equal(result.value.approvalState, "pending");
    assert.match(String(result.value.next), /waits for the user's approval/);
    const issues = Object.fromEntries(
      answerVariants(result.value).map((variant) => [variant.platform, variant.issues]),
    );
    assert.deepEqual(issues.instagram, ["This network needs an image."]);
    assert.deepEqual(issues.youtube, ["This network needs a video.", "This network needs a title."]);
    assert.deepEqual(issues.x, []);
    return { postId: post.id, issues };
  });

  await step("a post with an image, six own variants, a video, a title and one skip is stored exactly", async () => {
    const threadsText = "t".repeat(501);
    const xText = `Read the launch notes https://example.com/${"a".repeat(80)} today`;
    const result = await call({
      body: "Main launch text",
      media: "launch.png",
      scheduledFor: future.toISOString().replace("Z", "+00:00"),
      timezone: "Europe/Warsaw",
      variants: [
        { platform: "x", body: xText },
        { platform: "linkedin", body: "LinkedIn text" },
        { platform: "instagram", body: "Instagram text" },
        { platform: "threads", body: threadsText },
        { platform: "facebook_page", body: "Facebook text", skip: true },
        { platform: "youtube", body: "Video description", title: "Launch video", media: "teaser.mp4" },
      ],
    });
    assert.equal(result.success, true, JSON.stringify(result.value));
    const post = content.readPost(String(result.value.postId));
    assert.ok(post);
    assert.equal(post.approvalState, "pending");
    assert.equal(post.scheduledFor, future.toISOString());
    assert.equal(post.timezone, "Europe/Warsaw");
    assert.equal(post.media?.kind, "image");
    assert.equal(post.media?.mimeType, "image/png");
    assert.equal(post.media?.bytes, PNG.length);
    assert.equal(post.media?.name, "launch.png");
    const variants = Object.fromEntries(post.variants.map((variant) => [variant.platform, variant]));
    assert.equal(variants.x?.body, xText);
    assert.equal(variants.threads?.body, threadsText);
    assert.equal(variants.facebook_page?.status, "skipped");
    assert.equal(variants.youtube?.title, "Launch video");
    assert.equal(variants.youtube?.media?.kind, "video");
    assert.equal(variants.youtube?.media?.mimeType, "video/mp4");
    assert.equal(variants.instagram?.media, null, "Instagram inherits the post image.");
    for (const platform of ["x", "linkedin", "instagram", "threads", "youtube"] as const)
      assert.equal(variants[platform]?.status, "draft");
    const files = await mediaFiles();
    assert.ok(post.media && files.includes(post.media.file));
    assert.ok(variants.youtube?.media && files.includes(variants.youtube.media.file));
    const answers = Object.fromEntries(answerVariants(result.value).map((variant) => [variant.platform, variant]));
    assert.deepEqual(answers.threads?.issues, ["The text or the title is too long for this network."]);
    assert.equal(answers.threads?.length, 501);
    assert.equal(answers.threads?.limit, 500);
    assert.equal(answers.x?.length, Array.from("Read the launch notes  today").length + 23, "A link counts 23 on X.");
    assert.deepEqual(answers.x?.issues, []);
    assert.deepEqual(answers.instagram?.issues, []);
    assert.deepEqual(answers.youtube?.issues, []);
    assert.deepEqual(answers.facebook_page?.issues, []);
    assert.equal(result.value.scheduledFor, future.toISOString());
    return { postId: post.id, answers, files };
  });

  const rejections: Array<{ name: string; args: unknown; reason: RegExp }> = [
    {
      name: "duplicate platform",
      args: { body: "Hi", variants: [{ platform: "x" }, { platform: "x", body: "Two" }] },
      reason: /two entries for x/,
    },
    {
      name: "title off youtube",
      args: { body: "Hi", variants: [{ platform: "x", title: "T" }] },
      reason: /youtube only/,
    },
    {
      name: "past time",
      args: { body: "Hi", scheduledFor: "2020-01-01T10:00:00+01:00" },
      reason: /must be in the future/,
    },
    { name: "time with no offset", args: { body: "Hi", scheduledFor: "2030-01-01T10:00:00" }, reason: /scheduledFor/ },
    { name: "impossible date", args: { body: "Hi", scheduledFor: "2030-02-30T10:00:00Z" }, reason: /scheduledFor/ },
    { name: "unknown time zone", args: { body: "Hi", timezone: "Mars/Olympus" }, reason: /not a known IANA/ },
    {
      name: "image for youtube",
      args: { body: "Hi", variants: [{ platform: "youtube", media: "launch.png", title: "T" }] },
      reason: /youtube takes a video/,
    },
    {
      name: "video for instagram",
      args: { body: "Hi", variants: [{ platform: "instagram", media: "teaser.mp4" }] },
      reason: /instagram takes an image/,
    },
    { name: "PNG name with other bytes", args: { body: "Hi", media: "fake.png" }, reason: /not a supported image/ },
    { name: "symbolic link", args: { body: "Hi", media: "link.png" }, reason: /symbolic link/ },
    { name: "file outside the folders", args: { body: "Hi", media: outside }, reason: /outside these folders/ },
    { name: "missing file", args: { body: "Hi", media: "missing.png" }, reason: /media/ },
    { name: "empty body", args: { body: "  " }, reason: /body/ },
    { name: "unknown platform", args: { body: "Hi", variants: [{ platform: "tiktok" }] }, reason: /platform/ },
    { name: "approval argument", args: { body: "Hi", approvalState: "approved" }, reason: /approvalState/ },
    {
      name: "variant status argument",
      args: { body: "Hi", variants: [{ platform: "x", status: "queued" }] },
      reason: /status/,
    },
    { name: "seven variants", args: { body: "Hi", variants: Array(7).fill({ platform: "x" }) }, reason: /variants/ },
  ];

  await step("every rejection is a correctable failure that leaves no row and no file", async () => {
    const posts = postCount();
    const variants = variantCount();
    const files = await mediaFiles();
    const results: Record<string, string> = {};
    for (const rejection of rejections) {
      const result = await call(rejection.args);
      assert.equal(result.success, false, `${rejection.name} is refused.`);
      assert.match(String(result.value.error), rejection.reason, rejection.name);
      results[rejection.name] = String(result.value.error);
    }
    assert.equal(postCount(), posts);
    assert.equal(variantCount(), variants);
    assert.deepEqual(await mediaFiles(), files);
    return results;
  });

  await step("a failed database write deletes the copied media", async () => {
    const posts = postCount();
    const files = await mediaFiles();
    database.connection.exec(`CREATE TEMP TRIGGER fail_post BEFORE INSERT ON content_posts
      BEGIN SELECT RAISE(ABORT, 'forced failure'); END;`);
    try {
      const result = await call({
        body: "Hi",
        media: "launch.png",
        variants: [{ platform: "youtube", media: "teaser.mp4", title: "T" }],
      });
      assert.equal(result.success, false);
      assert.match(String(result.value.error), /forced failure/);
    } finally {
      database.connection.exec("DROP TRIGGER fail_post");
    }
    assert.equal(postCount(), posts);
    assert.deepEqual(await mediaFiles(), files);
    return { files: files.length };
  });

  await step("no argument stores a state other than pending, draft or skipped", async () => {
    const states = database.connection
      .prepare("SELECT DISTINCT approval_state FROM content_posts ORDER BY approval_state")
      .all()
      .map((row) => row.approval_state);
    const statuses = database.connection
      .prepare("SELECT DISTINCT status FROM content_variants ORDER BY status")
      .all()
      .map((row) => row.status);
    assert.deepEqual(states, ["pending"]);
    assert.deepEqual(statuses, ["draft", "skipped"]);
    return { states, statuses };
  });

  await step("contentPostStatus derives the post status from the variants", async () => {
    const table: Array<[ContentVariantStatus[], ContentPostStatus]> = [
      [[], "draft"],
      [["draft", "draft"], "draft"],
      [["skipped"], "skipped"],
      [["skipped", "skipped", "skipped"], "skipped"],
      [["draft", "skipped"], "draft"],
      [["queued", "draft"], "queued"],
      [["queued", "skipped"], "queued"],
      [["publishing", "queued"], "publishing"],
      [["published", "publishing"], "publishing"],
      [["failed", "publishing", "queued"], "failed"],
      [["published", "failed"], "failed"],
      [["published", "published"], "published"],
      [["published", "skipped"], "published"],
      [["published", "draft"], "draft"],
      [["failed", "skipped"], "failed"],
    ];
    for (const [statuses, expected] of table)
      assert.equal(
        contentPostStatus(statuses.map((status) => ({ status }))),
        expected,
        `${statuses.join(",") || "no variants"} is ${expected}`,
      );
    return { cases: table.length };
  });

  await step("the agent cannot have more pending posts than the cap", async () => {
    while (content.countPendingPosts(agent.id) < INPUT_LIMITS.contentPendingPostsPerAgent)
      content.createPost({
        body: "Filler",
        media: null,
        approvalState: "pending",
        scheduledFor: null,
        timezone: "UTC",
        authorAgentId: agent.id,
        variants: {},
      });
    const posts = postCount();
    const files = await mediaFiles();
    const result = await call({ body: "One more", media: "launch.png" });
    assert.equal(result.success, false);
    assert.match(String(result.value.error), /wait for the user's approval/);
    assert.equal(postCount(), posts);
    assert.deepEqual(await mediaFiles(), files);
    return { pending: content.countPendingPosts(agent.id) };
  });

  report.passed = true;
} finally {
  database.close();
  await rm(root, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${report.passed ? "passed" : "FAILED"}: ${join(OUT, "report.json")}\n`);
}

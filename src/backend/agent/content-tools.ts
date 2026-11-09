import { randomUUID } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  CONTENT_PLATFORM_KEYS,
  CONTENT_PLATFORMS,
  type ContentMedia,
  type ContentPlatform,
  type ContentPost,
  type ContentVariantIssue,
  contentTextLength,
  contentVariantIssues,
  detectContentMediaType,
} from "@openbot/contracts/ipc-content";
import { Effect, Result } from "effect";
import { z } from "zod";
import { attachmentCall } from "../attachment-effects";
import type { GeneratedAttachmentSource } from "../attachment-files";
import { ContentPendingLimitError, type ContentStore, type ContentVariantInput } from "../content/content-store";
import type { AttachmentGateway } from "./attachment-gateway";
import { localTimezone, openBotToolFailure, openBotToolResult } from "./routine-tools";
import { ToolOperationFailed, toolStep, toToolOperationFailed } from "./tool-operation";

export const CONTENT_CREATE_POST = "content_create_post";

const MB = 1024 * 1024;
const COPY_CHUNK_BYTES = MB;
const MEDIA_RULE = `PNG, JPEG, WEBP or GIF images up to ${INPUT_LIMITS.contentImageBytes / MB} MB, MP4 or MOV videos up to ${INPUT_LIMITS.contentVideoBytes / MB / 1024} GB`;

const mediaPath = z.string().trim().min(1).max(INPUT_LIMITS.path);
const variantSchema = z.strictObject({
  platform: z.enum(CONTENT_PLATFORM_KEYS),
  body: z.string().trim().min(1).max(INPUT_LIMITS.contentPostBody).optional(),
  title: z.string().trim().min(1).max(INPUT_LIMITS.contentVariantTitle).optional(),
  media: mediaPath.optional(),
  skip: z.boolean().optional(),
});
const createPostSchema = z.strictObject({
  body: z.string().trim().min(1).max(INPUT_LIMITS.contentPostBody),
  media: mediaPath.optional(),
  scheduledFor: z.iso.datetime({ offset: true }).optional(),
  timezone: z.string().trim().min(1).max(INPUT_LIMITS.identifier).optional(),
  variants: z.array(variantSchema).max(CONTENT_PLATFORM_KEYS.length).optional(),
});
type CreatePostInput = z.infer<typeof createPostSchema>;

export const CONTENT_TOOL_DEFINITIONS = [
  {
    name: CONTENT_CREATE_POST,
    description: `Write a social media post for the user to review in the content manager. The post goes to six networks: ${CONTENT_PLATFORM_KEYS.join(", ")}. It waits for the user's approval: you cannot approve, schedule or publish it. body is the main text, up to ${INPUT_LIMITS.contentPostBody} characters. media is the path of one image or video file in your workspace, the shared folder or a folder the user gave you: ${MEDIA_RULE}; OpenBot reads the type from the file content, not the name. scheduledFor proposes one time for all networks, ISO 8601 with an offset and in the future; the user decides. timezone is an IANA zone, default this computer's zone. variants changes one network each, at most one entry per platform: body and media replace the main ones, title is for youtube only (up to ${INPUT_LIMITS.contentVariantTitle} characters), the youtube media must be a video and the other networks take images, and skip leaves the network out. A network with no entry uses the main text and media. Text limits: x 280 (a link counts 23), linkedin 3000, instagram 2200 and needs an image, threads 500, facebook_page 63206, youtube 5000 and needs a video and a title. You can have at most ${INPUT_LIMITS.contentPendingPostsPerAgent} posts that wait for approval. The result lists the problems of each network; fix them with a new post only when the user asks.`,
    shape: createPostSchema.shape,
  },
];

const ISSUE_TEXT: Record<ContentVariantIssue, string> = {
  "over-limit": "The text or the title is too long for this network.",
  "needs-image": "This network needs an image.",
  "needs-video": "This network needs a video.",
  "needs-title": "This network needs a title.",
  "images-only": "This network takes only images.",
  "video-only": "This network takes only a video.",
};

export interface ContentToolDependencies {
  content: ContentStore;
  attachments: Pick<AttachmentGateway, "openSources">;
}

/** One media file that a call names: the post's own, or the own file of one variant. */
interface MediaRequest {
  owner: ContentPlatform | null;
  argument: string;
  path: string;
}

/**
 * Answers `content_create_post`, and `null` for any other tool so the caller keeps walking its chain.
 *
 * The router does not decode OpenBot tools, and the advertised schema has no limits, so this decodes the
 * full schema. Every refusal that the agent can correct is a tool failure with a short reason. The post is
 * always `pending` with six `draft` or `skipped` variants: no argument can approve, queue or publish it.
 */
export const handleContentTool = Effect.fn("ContentTools.handle")(function* (
  tool: string,
  args: unknown,
  agentId: string,
  dependencies: ContentToolDependencies,
) {
  if (tool !== CONTENT_CREATE_POST) return null;
  const parsed = createPostSchema.safeParse(args ?? {});
  if (!parsed.success) return openBotToolFailure(`${z.prettifyError(parsed.error)}\nCorrect the arguments and retry.`);
  const input = parsed.data;
  const now = new Date();
  const refusal = inputRefusal(input, now);
  if (refusal) return openBotToolFailure(refusal);
  const pending = yield* toolStep(() => dependencies.content.countPendingPosts(agentId));
  if (pending >= INPUT_LIMITS.contentPendingPostsPerAgent)
    return openBotToolFailure(new ContentPendingLimitError().message);

  const requests: MediaRequest[] = [
    ...(input.media ? [{ owner: null, argument: "media", path: input.media }] : []),
    ...(input.variants ?? []).flatMap((variant, index) =>
      variant.media ? [{ owner: variant.platform, argument: `variants[${index}].media`, path: variant.media }] : [],
    ),
  ];
  const sources: GeneratedAttachmentSource[] = [];
  return yield* Effect.gen(function* () {
    const media: Array<{ request: MediaRequest; source: GeneratedAttachmentSource; record: ContentMedia }> = [];
    for (const request of requests) {
      const opened = yield* Effect.result(
        dependencies.attachments.openSources(agentId, [request.path], { allowAnyReadablePath: false }),
      );
      if (Result.isFailure(opened))
        return openBotToolFailure(`${request.argument}: ${causeMessage(opened.failure.cause)}`);
      const [source] = opened.success;
      if (!source) return openBotToolFailure(`${request.argument}: OpenBot could not open the file.`);
      sources.push(source);
      const checked = yield* inspectMedia(source, request);
      if (typeof checked === "string") return openBotToolFailure(`${request.argument}: ${checked}`);
      media.push({ request, source, record: checked });
    }

    const copied: string[] = [];
    const removeCopies = attachmentCall(() => Promise.allSettled(copied.map((file) => unlink(file)))).pipe(
      Effect.ignore,
    );
    // ponytail: a crash between a copy and the database write leaves an orphan file in content-media.
    // A sweep that removes files no row names can remove those later.
    const copiedAll = yield* Effect.result(
      Effect.forEach(media, ({ source, record }) =>
        copyMedia(source, record, join(dependencies.content.mediaRoot, record.file), copied),
      ),
    );
    if (Result.isFailure(copiedAll)) {
      yield* removeCopies;
      return yield* new ToolOperationFailed({ cause: copiedAll.failure.cause });
    }

    const postMedia = media.find((item) => item.request.owner === null)?.record ?? null;
    const variants: Partial<Record<ContentPlatform, ContentVariantInput>> = {};
    for (const variant of input.variants ?? []) {
      variants[variant.platform] = {
        body: variant.body ?? null,
        title: variant.title ?? null,
        media: media.find((item) => item.request.owner === variant.platform)?.record ?? null,
        status: variant.skip ? "skipped" : "draft",
      };
    }
    const written = yield* Effect.result(
      toolStep(() =>
        dependencies.content.createPost({
          body: input.body,
          media: postMedia,
          approvalState: "pending",
          scheduledFor: input.scheduledFor ? new Date(input.scheduledFor).toISOString() : null,
          timezone: input.timezone ?? localTimezone(),
          authorAgentId: agentId,
          variants,
        }),
      ),
    );
    if (Result.isFailure(written)) {
      yield* removeCopies;
      if (written.failure.cause instanceof ContentPendingLimitError)
        return openBotToolFailure(written.failure.cause.message);
      return yield* written.failure;
    }
    return openBotToolResult(createdResult(written.success));
  }).pipe(
    Effect.ensuring(
      attachmentCall(() => Promise.allSettled(sources.map((source) => source.handle.close()))).pipe(Effect.ignore),
    ),
  );
});

/** The checks that the schema cannot express. Null when the input is valid. */
function inputRefusal(input: CreatePostInput, now: Date): string | null {
  const platforms = (input.variants ?? []).map((variant) => variant.platform);
  const duplicate = platforms.find((platform, index) => platforms.indexOf(platform) !== index);
  if (duplicate) return `variants has two entries for ${duplicate}. Give at most one entry per platform.`;
  const titled = input.variants?.find((variant) => variant.title !== undefined && variant.platform !== "youtube");
  if (titled) return `title is for youtube only. Remove it from ${titled.platform}.`;
  if (input.scheduledFor !== undefined && Date.parse(input.scheduledFor) <= now.getTime())
    return `scheduledFor must be in the future. It is now ${now.toISOString()}.`;
  if (input.timezone !== undefined && !isTimeZone(input.timezone))
    return `timezone ${input.timezone} is not a known IANA time zone, such as Europe/Warsaw.`;
  return null;
}

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The media record of an opened file, or the reason the file cannot be used. */
const inspectMedia = Effect.fn("ContentTools.inspectMedia")(function* (
  source: GeneratedAttachmentSource,
  request: MediaRequest,
) {
  const { size } = yield* attachmentCall(() => source.handle.stat()).pipe(toToolOperationFailed);
  const head = new Uint8Array(16);
  const { bytesRead } = yield* attachmentCall(() => source.handle.read(head, 0, head.length, 0)).pipe(
    toToolOperationFailed,
  );
  const type = detectContentMediaType(head.subarray(0, bytesRead));
  if (!type) return `The file is not a supported image or video. Use ${MEDIA_RULE}.`;
  const limit = type.kind === "image" ? INPUT_LIMITS.contentImageBytes : INPUT_LIMITS.contentVideoBytes;
  if (size > limit) return `The ${type.kind} is larger than ${limit / MB} MB.`;
  if (request.owner !== null && type.kind !== CONTENT_PLATFORMS[request.owner].media)
    return `${request.owner} takes ${CONTENT_PLATFORMS[request.owner].media === "image" ? "an image" : "a video"}, not ${type.kind === "image" ? "an image" : "a video"}.`;
  const id = randomUUID();
  return {
    id,
    kind: type.kind,
    mimeType: type.mimeType,
    bytes: size,
    name: basename(source.path),
    file: `${id}.${type.extension}`,
  } satisfies ContentMedia;
});

/** Copies the opened file to a new file that only this call creates, and records it in `copied` first. */
function copyMedia(source: GeneratedAttachmentSource, record: ContentMedia, target: string, copied: string[]) {
  return attachmentCall(async () => {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const output = await open(target, "wx", 0o600);
    copied.push(target);
    try {
      // A loop, not a stream: the caller owns and closes the source handle.
      const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
      let position = 0;
      for (;;) {
        const { bytesRead } = await source.handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        await output.write(buffer, 0, bytesRead);
        position += bytesRead;
      }
      if (position !== record.bytes) throw new Error("The file changed while OpenBot copied it.");
    } finally {
      await output.close();
    }
  });
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** What the agent reads back: the stored post, and the length, limit and problems of each network. */
function createdResult(post: ContentPost) {
  return {
    postId: post.id,
    approvalState: post.approvalState,
    scheduledFor: post.scheduledFor,
    timezone: post.timezone,
    variants: post.variants.map((variant) => {
      const body = variant.body ?? post.body;
      const rules = CONTENT_PLATFORMS[variant.platform];
      const issues =
        variant.status === "skipped"
          ? []
          : contentVariantIssues({
              platform: variant.platform,
              body,
              title: variant.title,
              media: variant.media ?? post.media,
            });
      return {
        platform: variant.platform,
        status: variant.status,
        length: contentTextLength(variant.platform, body),
        limit: rules.textLimit,
        issues: issues.map((issue) => ISSUE_TEXT[issue]),
      };
    }),
    next: "The post waits for the user's approval. Nothing is published or scheduled until the user approves it.",
  };
}

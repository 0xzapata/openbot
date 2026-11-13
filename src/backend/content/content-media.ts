import { randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  CONTENT_PLATFORMS,
  type ContentMedia,
  type ContentMediaKind,
  type ContentPlatform,
  detectContentMediaType,
} from "@openbot/contracts/ipc-content";
import { Effect } from "effect";
import { attachmentCall } from "../attachment-effects";
import type { GeneratedAttachmentSource } from "../attachment-files";

const MB = 1024 * 1024;
const COPY_CHUNK_BYTES = MB;

/** Why a file cannot be the media of a post or of one network. Each caller words it for its reader. */
export type ContentMediaRefusal =
  | { refusal: "type" }
  | { refusal: "size"; kind: ContentMediaKind; limitMb: number }
  | { refusal: "kind"; platform: ContentPlatform; expected: ContentMediaKind };

/**
 * The media record of an opened file, from its first bytes and its size, or the reason that it cannot be
 * used. `owner` is the network of a variant's own file, or null for the post's file.
 */
export const inspectContentMedia = Effect.fn("ContentMedia.inspect")(function* (
  source: GeneratedAttachmentSource,
  name: string,
  owner: ContentPlatform | null,
) {
  const { size } = yield* attachmentCall(() => source.handle.stat());
  const head = new Uint8Array(16);
  const { bytesRead } = yield* attachmentCall(() => source.handle.read(head, 0, head.length, 0));
  const type = detectContentMediaType(head.subarray(0, bytesRead));
  if (!type) return { refusal: "type" } satisfies ContentMediaRefusal;
  const limit = type.kind === "image" ? INPUT_LIMITS.contentImageBytes : INPUT_LIMITS.contentVideoBytes;
  if (size > limit) return { refusal: "size", kind: type.kind, limitMb: limit / MB } satisfies ContentMediaRefusal;
  if (owner !== null && type.kind !== CONTENT_PLATFORMS[owner].media)
    return { refusal: "kind", platform: owner, expected: CONTENT_PLATFORMS[owner].media } satisfies ContentMediaRefusal;
  const id = randomUUID();
  return {
    id,
    kind: type.kind,
    mimeType: type.mimeType,
    bytes: size,
    name,
    file: `${id}.${type.extension}`,
  } satisfies ContentMedia;
});

export function isContentMediaRefusal(value: ContentMedia | ContentMediaRefusal): value is ContentMediaRefusal {
  return "refusal" in value;
}

/** Copies the opened file to a new file that only this call creates, and records it in `copied` first. */
export function copyContentMedia(
  source: GeneratedAttachmentSource,
  record: ContentMedia,
  target: string,
  copied: string[],
) {
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

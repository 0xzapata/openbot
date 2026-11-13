import type { OpenBotDesktopApi } from "@openbot/contracts/ipc";

/**
 * The bridge calls of the Content page: the `content` group, and the attachment draft calls that make
 * and discard the media of a post. Content is local only, so every call goes to this computer.
 */
export interface ContentPort {
  content: OpenBotDesktopApi["content"];
  agent: Pick<OpenBotDesktopApi["agent"], "chooseAttachments" | "importAttachmentData" | "discardDraftAttachment">;
}

/** Read on each call: tests and stories replace `window.openbot` per case. */
export function contentPort(): ContentPort {
  return window.openbot;
}

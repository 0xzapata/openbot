// The content manager of this computer. Local only: the posts, accounts and tokens stay here.

import { runCauseEffect } from "../../backend/effect-boundary";
import type { ContentService } from "../content/content-service";
import {
  parseContentBeginConnect,
  parseContentCalendar,
  parseContentCreatePost,
  parseContentDeletePost,
  parseContentDisconnect,
  parseContentListPosts,
  parseContentPublishNow,
  parseContentSchedulePost,
  parseContentUpdatePost,
} from "./content-inputs";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";

export interface ContentIpcDependencies {
  content: ContentService;
}

export function contentIpcHandlers({ content }: ContentIpcDependencies): Pick<IpcGroupHandlers, "content"> {
  return {
    content: {
      listAccounts: handler(() => runCauseEffect(content.listAccounts())),
      beginConnect: payloadHandler(parseContentBeginConnect, (input) => runCauseEffect(content.beginConnect(input))),
      disconnectAccount: payloadHandler(parseContentDisconnect, (input) =>
        runCauseEffect(content.disconnectAccount(input)),
      ),
      listPosts: payloadHandler(parseContentListPosts, (input) => runCauseEffect(content.listPosts(input))),
      createPost: payloadHandler(parseContentCreatePost, (input) => runCauseEffect(content.createPost(input))),
      updatePost: payloadHandler(parseContentUpdatePost, (input) => runCauseEffect(content.updatePost(input))),
      deletePost: payloadHandler(parseContentDeletePost, (input) => runCauseEffect(content.deletePost(input.postId))),
      schedulePost: payloadHandler(parseContentSchedulePost, (input) =>
        runCauseEffect(content.schedulePost(input.postId, input.scheduledFor)),
      ),
      publishNow: payloadHandler(parseContentPublishNow, (input) => runCauseEffect(content.publishNow(input.postId))),
      calendar: payloadHandler(parseContentCalendar, (input) => runCauseEffect(content.calendar(input))),
    },
  };
}

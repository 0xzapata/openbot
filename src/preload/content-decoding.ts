// What main answers for the content manager. A view never carries a token, a ciphertext, a client
// secret, a stored file name or a path: the decoders refuse any key that the view does not name, so a
// main-process bug cannot put one in renderer state.

import {
  isContentAccountsState,
  isContentCalendar,
  isContentChangedEvent,
  isContentPostView,
  isContentPostViews,
} from "@openbot/contracts/ipc-content";
import { guardedDecoder } from "@openbot/contracts/ipc-decoding";

export const decodeContentAccountsState = guardedDecoder(isContentAccountsState, "content accounts");
export const decodeContentPost = guardedDecoder(isContentPostView, "content post");
export const decodeContentPosts = guardedDecoder(isContentPostViews, "content posts");
export const decodeContentCalendar = guardedDecoder(isContentCalendar, "content calendar");
export const decodeContentChanged = guardedDecoder(isContentChangedEvent, "content change");

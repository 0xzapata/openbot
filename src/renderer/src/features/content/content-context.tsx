import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { LOCAL_SERVER_ID } from "@openbot/contracts/ipc";
import type { ContentAccountsState, ContentPlatform, ContentPostView } from "@openbot/contracts/ipc-content";
import type { ContentMediaFieldFile } from "@openbot/ui/features/content/ContentParts";
import { queueSection } from "@openbot/ui/features/content/content-status";
import { createEffect, createMemo, createSignal, createStore, type StoreSetter, snapshot } from "solid-js";
import { usePlatform } from "../../platform";
import { createSimpleContext } from "../../simple-context";
import { useServers } from "../servers/servers-context";
import { type ContentPort, contentPort } from "./content-port";

export type ContentPane = "queue" | "calendar";

/**
 * The open composer: a new post (`postId` null) or one post. `post` is the post as the composer opened it,
 * so a post that is not in the loaded page still shows. `session` keys the form: it changes only when the
 * composer opens, not when a new post gets its id.
 */
export interface ContentComposerTarget {
  postId: string | null;
  post: ContentPostView | null;
  session: number;
  /** The post was deleted while the composer was open: the composer shows an error and writes nothing. */
  deleted: boolean;
  /** The start time of a new post, as an instant; null takes tomorrow at 09:00. */
  startAt: string | null;
}

/** The file of the post: the one it has, or a new attachment draft. */
export interface ComposerMedia extends ContentMediaFieldFile {
  draftId: string | null;
}

export interface ComposerNetwork {
  chosen: boolean;
  /** Null: the network posts the main text. */
  ownText: string | null;
  title: string;
}

export interface ComposerForm {
  body: string;
  media: ComposerMedia | null;
  when: "now" | "later";
  date: string;
  time: string;
  networks: Record<ContentPlatform, ComposerNetwork>;
}

/**
 * The form of the open composer, kept here so that leaving the page (another rail page, Settings, a server
 * switch) does not lose unsaved text.
 */
export interface ContentComposerDraft {
  session: number;
  initial: ComposerForm;
  form: ComposerForm;
  setForm: StoreSetter<ComposerForm>;
}

export interface ContentStateStore {
  phase: "loading" | "ready" | "error";
  posts: ContentPostView[];
  accounts: ContentAccountsState | null;
  /** The last accounts read failed; the dialog shows Retry. */
  accountsError: boolean;
  pane: ContentPane;
  composer: ContentComposerTarget | null;
  /** The Accounts dialog, opened on one network or on none. */
  accountsDialog: { platform: ContentPlatform | null } | null;
}

/**
 * The posts and accounts of the content manager on this computer, and what the page shows. The rail dot,
 * the command palette and the page read the same state.
 */
export function createContentState(port: () => ContentPort, active: () => boolean) {
  const [state, setState] = createStore<ContentStateStore>({
    phase: "loading",
    posts: [],
    accounts: null,
    accountsError: false,
    pane: "queue",
    composer: null,
    accountsDialog: null,
  });
  const [now, setNow] = createSignal(new Date());
  // Not reactive: the composer writes it while it renders, and only event handlers (Back, the palette, a
  // new composer) read it. The form inside is a store, so the fields stay reactive.
  let composerDraft: ContentComposerDraft | null = null;
  let generation = 0;
  let sessions = 0;

  /** A refresh that an event starts keeps the list on screen; only the first load and Retry blank it. */
  async function reload(background = false): Promise<void> {
    const request = ++generation;
    if (!background)
      setState((draft) => {
        draft.phase = "loading";
      });
    try {
      // ponytail: one page of the newest posts (`contentPostsPage`); page through older posts when a queue holds more.
      const posts = await port().content.listPosts({ limit: INPUT_LIMITS.contentPostsPage });
      if (request !== generation) return;
      setNow(new Date());
      setState((draft) => {
        draft.posts = posts;
        draft.phase = "ready";
      });
    } catch {
      if (request !== generation || (background && state.phase === "ready")) return;
      setState((draft) => {
        draft.phase = "error";
      });
    }
  }

  async function reloadAccounts(): Promise<void> {
    try {
      const accounts = await port().content.listAccounts();
      setState((draft) => {
        draft.accounts = accounts;
        draft.accountsError = false;
      });
    } catch {
      // The accounts keep their last state; the dialog shows the error and Retry.
      setState((draft) => {
        draft.accountsError = true;
      });
    }
  }

  /**
   * The composer post is not in the loaded page after a change to it: read the post by its time keys. Not
   * found under any of them means another window deleted it.
   * ponytail: a post that another window moved to a new time also reads as deleted; add a by-id read then.
   */
  async function checkComposerPost(postId: string): Promise<void> {
    const post = state.composer?.postId === postId ? state.composer.post : null;
    if (!post || state.posts.some((candidate) => candidate.id === postId)) return;
    const keys = [...new Set([post.scheduledFor, post.createdAt].filter((key): key is string => key !== null))];
    for (const key of keys) {
      const to = new Date(Date.parse(key) + 1).toISOString();
      const found = await port()
        .content.listPosts({ from: key, to, limit: INPUT_LIMITS.contentPostsPage })
        .catch(() => null);
      // A failed read proves nothing: the composer keeps its post.
      if (found === null) return;
      const match = found.find((candidate) => candidate.id === postId);
      if (match) {
        setState((draft) => {
          if (draft.composer?.postId === postId) draft.composer.post = match;
        });
        return;
      }
    }
    setState((draft) => {
      if (draft.composer?.postId === postId) draft.composer.deleted = true;
    });
  }

  // Content is local only: on a joined server nothing loads and nothing listens. The memo runs the effect
  // only when the answer changes, not on each server list update.
  const on = createMemo(active);
  createEffect(on, (isOn) => {
    if (!isOn) return;
    void reload();
    void reloadAccounts();
    const unsubscribe = port().content.onChanged((event) => {
      if (event.accounts) void reloadAccounts();
      // A sign-in changes which posts can go out, so the posts load again with the accounts.
      void reload(true).then(() => {
        if (event.postId && event.postId === state.composer?.postId) void checkComposerPost(event.postId);
      });
    });
    // A queued post moves from Tomorrow to Today without an event.
    const clock = window.setInterval(() => setNow(new Date()), 60_000);
    return () => {
      generation++;
      unsubscribe();
      window.clearInterval(clock);
    };
  });

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const needsYou = createMemo(
    () => state.posts.filter((post) => queueSection(post, now(), timeZone) === "needsYou").length,
  );

  /** The post of the open composer: the loaded one when it is in the page, else the one it opened with. */
  const composerPost = createMemo((): ContentPostView | null => {
    const composer = state.composer;
    if (!composer?.postId) return null;
    return state.posts.find((post) => post.id === composer.postId) ?? composer.post;
  });

  /** True while the open composer holds changes that are not saved. */
  const composerDirty = () => {
    const draft = composerDraft;
    return draft !== null && JSON.stringify(snapshot(draft.form)) !== JSON.stringify(draft.initial);
  };

  return {
    state,
    now,
    timeZone,
    port,
    needsYou,
    reload,
    reloadAccounts,
    composerPost,
    composerDirty,
    setPane(pane: ContentPane) {
      setState((draft) => {
        draft.pane = pane;
      });
    },
    /**
     * Opens the composer on a post, or on a new post. A composer with unsaved changes stays open: its own
     * Back asks before it discards them.
     */
    openComposer(post: ContentPostView | null, startAt: string | null = null) {
      if (state.composer && composerDirty()) return;
      composerDraft = null;
      setState((draft) => {
        draft.composer = { postId: post?.id ?? null, post, session: ++sessions, deleted: false, startAt };
      });
    },
    /** The new post of the composer now has an id: later writes edit it and never create a second post. */
    adoptComposerPost(post: ContentPostView) {
      setState((draft) => {
        if (!draft.composer) return;
        draft.composer.postId = post.id;
        draft.composer.post = post;
      });
    },
    /** Closes the composer and drops its form. The composer discards its attachment draft first. */
    closeComposer() {
      composerDraft = null;
      setState((draft) => {
        draft.composer = null;
      });
    },
    /** The kept form of a composer session, or null when the session has none yet. */
    composerForm(session: number): ContentComposerDraft | null {
      return composerDraft?.session === session ? composerDraft : null;
    },
    keepComposerForm(draft: ContentComposerDraft) {
      composerDraft = draft;
    },
    openAccounts(platform: ContentPlatform | null = null) {
      setState((draft) => {
        draft.accountsDialog = { platform };
      });
    },
    closeAccounts() {
      setState((draft) => {
        draft.accountsDialog = null;
      });
    },
    /** Puts a written post in the list at once; the `content:changed` refresh confirms it. */
    remember(post: ContentPostView) {
      setState((draft) => {
        const index = draft.posts.findIndex((candidate) => candidate.id === post.id);
        if (index >= 0) draft.posts[index] = post;
        else draft.posts.unshift(post);
      });
    },
    forget(postId: string) {
      setState((draft) => {
        draft.posts = draft.posts.filter((post) => post.id !== postId);
        if (draft.composer?.postId === postId) draft.composer.deleted = true;
      });
    },
    setAccounts(accounts: ContentAccountsState) {
      setState((draft) => {
        draft.accounts = accounts;
        draft.accountsError = false;
      });
    },
  };
}

export type ContentState = ReturnType<typeof createContentState>;

const context = createSimpleContext({
  name: "ContentProvider",
  init: () => {
    const { activeServer } = useServers();
    const platform = usePlatform();
    // A chat window shows no rail and no Content page, so it loads nothing and does not listen.
    return createContentState(
      contentPort,
      () => platform.chatWindow === null && activeServer()?.id === LOCAL_SERVER_ID,
    );
  },
});

export const ContentProvider = context.provider;
export const useContent = context.use;

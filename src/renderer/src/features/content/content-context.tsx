import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { LOCAL_SERVER_ID } from "@openbot/contracts/ipc";
import type { ContentAccountsState, ContentPlatform, ContentPostView } from "@openbot/contracts/ipc-content";
import { queueSection } from "@openbot/ui/features/content/content-status";
import { createEffect, createMemo, createSignal, createStore } from "solid-js";
import { usePlatform } from "../../platform";
import { createSimpleContext } from "../../simple-context";
import { useServers } from "../servers/servers-context";
import { type ContentPort, contentPort } from "./content-port";

export type ContentPane = "queue" | "calendar";

/** The open composer: a new post (`postId` null) or one post. */
export interface ContentComposerTarget {
  postId: string | null;
}

export interface ContentStateStore {
  phase: "loading" | "ready" | "error";
  posts: ContentPostView[];
  accounts: ContentAccountsState | null;
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
    pane: "queue",
    composer: null,
    accountsDialog: null,
  });
  const [now, setNow] = createSignal(new Date());
  let generation = 0;

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
      });
    } catch {
      // The accounts keep their last state; the dialog shows its own errors.
    }
  }

  // Content is local only: on a joined server nothing loads and nothing listens.
  createEffect(active, (on) => {
    if (!on) return;
    void reload();
    void reloadAccounts();
    const unsubscribe = port().content.onChanged((event) => {
      if (event.accounts) void reloadAccounts();
      // A sign-in changes which posts can go out, so the posts load again with the accounts.
      void reload(true);
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

  return {
    state,
    now,
    timeZone,
    port,
    needsYou,
    reload,
    reloadAccounts,
    setPane(pane: ContentPane) {
      setState((draft) => {
        draft.pane = pane;
      });
    },
    openComposer(postId: string | null) {
      setState((draft) => {
        draft.composer = { postId };
      });
    },
    closeComposer() {
      setState((draft) => {
        draft.composer = null;
      });
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
      });
    },
    setAccounts(accounts: ContentAccountsState) {
      setState((draft) => {
        draft.accounts = accounts;
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

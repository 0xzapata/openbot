/**
 * The Content page on the preview mock (`src/renderer/src/preview/mock-content.ts`): the real
 * `ContentView` and its state, without the window shell. Each story can change the mock first.
 */

import type { ContentDesktopApi } from "@openbot/contracts/ipc";
import type { ContentPostView } from "@openbot/contracts/ipc-content";
import { createRoot, onSettled, untrack } from "solid-js";
import { ContentView } from "../src/features/content/ContentPanel";
import { type ContentPane, createContentState } from "../src/features/content/content-context";
import type { ContentPort } from "../src/features/content/content-port";
import { createMockContent } from "../src/preview/mock-content";
import { STORY_AGENTS } from "./fixtures";

export interface ContentStoryOptions {
  /** Changes the mock API before the page reads it, for an empty, failing or slow page. */
  api?: (api: ContentDesktopApi) => ContentDesktopApi;
  pane?: ContentPane;
  /** Opens the composer on the first post that this picks, or on a new post with `"new"`. */
  composer?: "new" | ((posts: ContentPostView[]) => ContentPostView | undefined);
  accounts?: boolean;
  local?: boolean;
}

/** An agent with the id of the example posts' author. */
const HERALD = { id: "agent-herald", name: "Herald", avatarSeed: "herald", avatarHue: null, avatarUrl: null };

export function ContentStory(props: { options?: ContentStoryOptions }) {
  // The options only set up the story; a change of the args remounts it. Storybook passes the args as a
  // store, so the fields are copied out once.
  const options: ContentStoryOptions = untrack(() => ({ ...props.options }));
  const base = createMockContent();
  const api = options.api ? options.api(base) : base;
  const port: ContentPort = {
    content: api,
    agent: {
      chooseAttachments: async () => [],
      importAttachmentData: async () => [],
      discardDraftAttachment: async () => undefined,
    },
  };
  // The state owns its listener and clock; the story disposes them with the story.
  const { content, dispose } = createRoot((dispose) => ({
    content: createContentState(
      () => port,
      () => options.local !== false,
    ),
    dispose,
  }));
  onSettled(() => {
    if (options.pane) content.setPane(options.pane);
    if (options.accounts) content.openAccounts();
    const pick = options.composer;
    if (pick === "new") content.openComposer(null);
    else if (pick)
      void api.listPosts({}).then((posts) => {
        const post = pick(posts);
        if (post) content.openComposer(post.id);
      });
    return dispose;
  });
  return (
    <main style={{ height: "100vh", "max-width": "1280px" }}>
      <ContentView
        content={content}
        agents={[HERALD, ...STORY_AGENTS]}
        hostName="Studio Mac"
        local={options.local !== false}
      />
    </main>
  );
}

/** A mock that answers every list with nothing. */
export const emptyContent = (api: ContentDesktopApi): ContentDesktopApi => ({
  ...api,
  listPosts: async () => [],
  calendar: async (input) => ({ ...input, timezone: "Europe/Warsaw", posts: [] }),
});

/** A mock whose lists never answer, so the page stays loading. */
export const loadingContent = (api: ContentDesktopApi): ContentDesktopApi => ({
  ...api,
  listPosts: () => new Promise(() => undefined),
  calendar: () => new Promise(() => undefined),
});

/** A mock whose lists fail. */
export const failingContent = (api: ContentDesktopApi): ContentDesktopApi => ({
  ...api,
  listPosts: async () => {
    throw new Error("The database is busy.");
  },
  calendar: async () => {
    throw new Error("The database is busy.");
  },
});

/** A mock with no connected account and no post. */
export const noAccountsContent = (api: ContentDesktopApi): ContentDesktopApi => ({
  ...emptyContent(api),
  listAccounts: async () => {
    const state = await api.listAccounts();
    return { ...state, networks: state.networks.map((network) => ({ ...network, account: null })) };
  },
});

/**
 * The Threads text of the post that waits for approval is 41 characters over the limit. v1 posts only to
 * X and LinkedIn, so this story opens Threads as the mockup draws it.
 */
export const overLimitContent = (api: ContentDesktopApi): ContentDesktopApi => ({
  ...api,
  listAccounts: async () => {
    const state = await api.listAccounts();
    return {
      ...state,
      networks: state.networks.map((network) =>
        network.platform === "threads" ? { ...network, available: true } : network,
      ),
    };
  },
  listPosts: async (input) =>
    (await api.listPosts(input)).map((post) =>
      post.id === "post-playbook"
        ? {
            ...post,
            variants: post.variants.map((variant) =>
              variant.platform === "threads" ? { ...variant, body: THREADS_TEXT } : variant,
            ),
          }
        : post,
    ),
});

/** 541 characters: Threads takes 500. */
const THREADS_TEXT = "We shipped v2 of the widget today, and it is the biggest release since we started. "
  .repeat(7)
  .slice(0, 541);

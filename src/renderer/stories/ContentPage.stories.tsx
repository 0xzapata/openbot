import type { ContentPostView } from "@openbot/contracts/ipc-content";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  ContentStory,
  emptyContent,
  failingContent,
  hostCleanContent,
  instagramNoHostContent,
  keepImageContent,
  loadingContent,
  noAccountsContent,
  overLimitContent,
  setupContent,
  waitingContent,
} from "./content-story-support";

/*
 * The Content page (docs/content-manager/content-manager.html, screens 1 to 3) on the example data of the
 * preview mock: the queue with needs-you, failed, publishing, scheduled, draft and done rows, the composer,
 * the Accounts dialog and the calendar. Threads signed the user out, so the queue shows the banner.
 */
const meta = {
  title: "Content/Page",
  component: ContentStory,
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof ContentStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Queue: Story = {};

export const QueueEmpty: Story = { args: { options: { api: emptyContent } } };

export const QueueNoAccounts: Story = { args: { options: { api: noAccountsContent } } };

export const QueueLoading: Story = { args: { options: { api: loadingContent } } };

export const QueueError: Story = { args: { options: { api: failingContent } } };

/** A joined server: one notice, and no content call. */
export const JoinedServer: Story = { args: { options: { local: false } } };

/** The post that Herald drafted, with its own Threads text 41 characters over the limit. */
export const ComposerReview: Story = {
  args: {
    options: {
      api: overLimitContent,
      composer: (posts: ContentPostView[]) => posts.find((post) => post.id === "post-playbook"),
    },
  },
};

export const ComposerNew: Story = { args: { options: { composer: "new" } } };

/** The host row names the bucket where 2 images wait to be removed. */
export const Accounts: Story = { args: { options: { accounts: true } } };

export const AccountsHostClean: Story = { args: { options: { accounts: true, api: hostCleanContent } } };

/** Instagram is connected, and no image host is set up: the needs-host badge and Set up image host. */
export const AccountsInstagramNoHost: Story = {
  args: { options: { accounts: true, api: instagramNoHostContent } },
};

/** X and LinkedIn have no app: Connect opens the setup step with the redirect URI and Copy. */
export const AccountsSetup: Story = { args: { options: { accounts: true, api: setupContent } } };

/** The sign-in of X waits for the browser. */
export const AccountsWaiting: Story = { args: { options: { accounts: true, api: waitingContent } } };

/** Delete in a row menu is refused while no host can remove the image: the keep-image confirm opens. */
export const QueueKeepImage: Story = { args: { options: { api: keepImageContent } } };

export const CalendarWeek: Story = { args: { options: { pane: "calendar" } } };

export const CalendarEmpty: Story = { args: { options: { pane: "calendar", api: emptyContent } } };

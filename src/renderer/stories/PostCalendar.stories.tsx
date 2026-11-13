import { PostCalendar } from "@openbot/ui/features/content/PostCalendar";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createMockContent } from "../src/preview/mock-content";

/*
 * The post calendar: the routine calendar layout, with the network marks of each post in place of agent
 * avatars and the post status mark before its time. Skipped networks do not show. Example data of the
 * preview mock, around now.
 */
const posts = await createMockContent().listPosts({});
const WARSAW = "Europe/Warsaw";

const meta = {
  title: "Content/Calendar",
  component: PostCalendar,
  render: (args) => (
    <main style={{ width: "min(1400px, 100vw)", padding: "var(--openbot-space-6)" }}>
      <PostCalendar {...args} />
    </main>
  ),
  args: {
    posts,
    now: new Date(),
    timeZone: WARSAW,
    state: "ready",
    onOpenPost: fn(),
    onNewPost: fn(),
    onRangeChange: fn(),
    onRetry: fn(),
  },
  argTypes: {
    state: { control: "inline-radio", options: ["ready", "loading", "error"] },
    initialView: { control: "inline-radio", options: ["month", "week", "day"] },
  },
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof PostCalendar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Week: Story = {};

export const Day: Story = { args: { initialView: "day" } };

export const Month: Story = { args: { initialView: "month" } };

/** No post with a time in the range: the week stays, with one line and New post. */
export const Empty: Story = { args: { posts: [] } };

export const Loading: Story = { args: { state: "loading" } };

export const LoadFailed: Story = { args: { state: "error" } };

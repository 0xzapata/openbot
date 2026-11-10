import { Plus } from "@openbot/ui";
import { ContentEmpty } from "@openbot/ui/features/content/ContentParts";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";

/* An empty Content page: one title, one line, one action. */
const meta = {
  title: "Content/Empty",
  component: ContentEmpty,
  parameters: { a11y: { test: "error" } },
} satisfies Meta<typeof ContentEmpty>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NoPosts: Story = {
  args: {
    title: "No posts yet",
    body: "Write a post, or ask an agent to draft one. You approve each post before it goes out.",
    action: "New post",
    icon: <Plus aria-hidden="true" />,
    onAction: fn(),
  },
};

export const NoAccounts: Story = {
  args: {
    title: "Connect a network first",
    body: "OpenBot posts with your own accounts. Sign-in stays on this computer.",
    action: "Connect accounts",
    onAction: fn(),
  },
};

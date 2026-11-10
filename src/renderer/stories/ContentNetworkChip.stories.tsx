import { CONTENT_PLATFORM_KEYS, CONTENT_VARIANT_STATUSES } from "@openbot/contracts/ipc-content";
import { ContentNetworkChip } from "@openbot/ui/features/content/ContentParts";
import { For } from "solid-js";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";

/* The network chip of the queue rows: a toggle while the network can be skipped or taken back, then a
 * status image. Each status has a glyph or an outline, so colour is never the only cue. */
const meta = {
  title: "Content/Network chip",
  component: ContentNetworkChip,
  parameters: { a11y: { test: "error" } },
} satisfies Meta<typeof ContentNetworkChip>;

export default meta;
type Story = StoryObj<typeof meta>;

const column = { display: "grid", gap: "var(--openbot-space-3)", "justify-items": "start" } as const;

/** A draft, queued or pending chip skips its network; a skipped one takes it back. Then each one is a status. */
export const States: Story = {
  args: { platform: "x", status: "draft", onToggle: fn() },
  render: () => (
    <div style={column}>
      <For each={[...CONTENT_VARIANT_STATUSES, "pending" as const]}>
        {(status) => (
          <ContentNetworkChip
            platform="x"
            status={status}
            error={status === "failed" ? "X limits the posts now." : null}
            onToggle={fn()}
          />
        )}
      </For>
    </div>
  ),
};

/** A post that a network already has: no chip is a toggle. */
export const Locked: Story = { args: { platform: "linkedin", status: "draft", locked: true } };

/** Every network mark; Facebook Pages use the Facebook mark, and YouTube the new mark in brand-marks.tsx. */
export const Networks: Story = {
  args: { platform: "x", status: "published" },
  render: () => (
    <div style={{ display: "flex", gap: "var(--openbot-space-1)" }}>
      <For each={CONTENT_PLATFORM_KEYS}>
        {(platform) => <ContentNetworkChip platform={platform} status="published" />}
      </For>
    </div>
  ),
};

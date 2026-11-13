import { ContentMediaField } from "@openbot/ui/features/content/ContentParts";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";

/* One image or video for a post: choose or drop a file, then the file with a remove button. */
const meta = {
  title: "Content/Media field",
  component: ContentMediaField,
  parameters: { a11y: { test: "error" } },
} satisfies Meta<typeof ContentMediaField>;

export default meta;
type Story = StoryObj<typeof meta>;

const column = { display: "grid", gap: "var(--openbot-space-3)", "justify-items": "start" } as const;

const render = (args: Parameters<typeof ContentMediaField>[0]) => (
  <div style={{ ...column, width: "28rem" }}>
    <span class="ui-label" id={args.labelledBy}>
      Image or video
    </span>
    <ContentMediaField {...args} />
  </div>
);

export const Empty: Story = {
  args: { labelledBy: "media-empty", file: null, onChoose: fn(), onDrop: fn(), onRemove: fn() },
  render,
};

export const Image: Story = {
  args: {
    labelledBy: "media-image",
    file: { name: "widget-v2-hero.png", kind: "image", bytes: 421_888 },
    onChoose: fn(),
    onDrop: fn(),
    onRemove: fn(),
  },
  render,
};

export const Busy: Story = {
  args: { labelledBy: "media-busy", file: null, busy: true, onChoose: fn(), onDrop: fn(), onRemove: fn() },
  render,
};

/** A dropped file while main reads and copies it. Over 100 MB the line says that it takes a while. */
export const Reading: Story = {
  args: {
    labelledBy: "media-reading",
    file: null,
    busy: true,
    reading: { name: "launch-video.mp4", bytes: 412 * 1024 * 1024 },
    onChoose: fn(),
    onDrop: fn(),
    onRemove: fn(),
  },
  render,
};

/** A refused file: the field stays empty, the text is under the drop area, and Choose names it. */
export const Refused: Story = {
  args: {
    labelledBy: "media-refused",
    file: null,
    error: "The image is larger than 20 MB.",
    onChoose: fn(),
    onDrop: fn(),
    onRemove: fn(),
  },
  render,
};

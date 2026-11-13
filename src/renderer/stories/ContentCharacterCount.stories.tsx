import { ContentCharacterCount } from "@openbot/ui/features/content/ContentParts";
import type { Meta, StoryObj } from "storybook-solidjs-vite";

/* The characters left for one network, on RadialProgress: accent, warning at 10% left, danger when over. */
const meta = {
  title: "Content/Character count",
  component: ContentCharacterCount,
  parameters: { a11y: { test: "error" } },
} satisfies Meta<typeof ContentCharacterCount>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Plenty: Story = { args: { length: 122, limit: 280, id: "count-plenty" } };

export const Warning: Story = { args: { length: 263, limit: 280, id: "count-warning" } };

export const Over: Story = { args: { length: 541, limit: 500, id: "count-over" } };

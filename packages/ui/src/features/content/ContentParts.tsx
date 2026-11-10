import type { ContentMediaKind, ContentPlatform, ContentVariantStatus } from "@openbot/contracts/ipc-content";
import {
  Button,
  Check,
  Clock3,
  Film,
  Image,
  ImageRemoveButton,
  LabelTooltip,
  LabelTooltipTrigger,
  RadialProgress,
  Text,
  TriangleAlert,
  X,
} from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { createSignal, createUniqueId, Match, Show, Switch } from "solid-js";
import { useText } from "../../text";
import { YouTubeMark } from "../settings/brand-marks";
import { SocialNetworkMark } from "../social-follow/social-marks";
import type { SocialNetworkId } from "../social-follow/social-networks";
import { CONTENT_NETWORK_NAMES, variantChip } from "./content-status";

/** The mark of a content network. Facebook Pages use the Facebook mark; YouTube has its own. */
export function ContentNetworkMark(props: { platform: ContentPlatform; class?: string | undefined }) {
  const social = (): SocialNetworkId | null =>
    props.platform === "youtube" ? null : props.platform === "facebook_page" ? "facebook" : props.platform;
  return (
    <Show when={social()} fallback={<YouTubeMark class={props.class} />}>
      {(network) => <SocialNetworkMark network={network()} class={props.class} />}
    </Show>
  );
}

export interface ContentNetworkChipProps {
  platform: ContentPlatform;
  /** The variant status, or `pending` for a network of a post that waits for approval. */
  status: ContentVariantStatus | "pending";
  /** A network already has the post: no network can be skipped or taken back. */
  locked?: boolean;
  /** A publishing network that accepted the post and still processes it. */
  processing?: boolean;
  /** The stored error of a failed network: `sourceText` English or provider text. It shows localized. */
  error?: string | null;
  /** Why the network cannot post yet, as `sourceText` English. A triangle shows, and the chip stays a toggle. */
  warning?: string;
  /** Skips the network (`false`) or takes it back (`true`). Only a toggle chip calls it. */
  onToggle?: (included: boolean) => void;
}

/**
 * One network of a post. A draft, queued, pending or skipped network is a toggle button; after that the
 * chip is a status image with a label. A glyph or a dashed outline goes with each colour.
 */
export function ContentNetworkChip(props: ContentNetworkChipProps) {
  const { t, errorMessage, sourceText } = useText();
  const chip = () => variantChip(props.status, props.locked);
  const network = () => CONTENT_NETWORK_NAMES[props.platform];
  const statusLabel = () =>
    t("content.chip.label", {
      network: network(),
      status: props.processing ? t("content.variant.processing") : t(chip().statusKey),
    });
  const errorLabel = () =>
    props.error
      ? t("content.chip.error", {
          label: statusLabel(),
          reason: errorMessage(props.error, t("content.variant.failed")),
        })
      : statusLabel();
  const toggleLabel = () => {
    const label = chip().pressed
      ? t("content.chip.skip", { network: network() })
      : t("content.chip.include", { network: network() });
    return props.warning ? t("content.chip.error", { label, reason: sourceText(props.warning) }) : label;
  };
  const glyph = () => (
    <Switch>
      <Match when={chip().glyph === "clock"}>
        <Clock3 class="content-chip-glyph" aria-hidden="true" />
      </Match>
      <Match when={chip().glyph === "check"}>
        <Check class="content-chip-glyph" aria-hidden="true" />
      </Match>
      <Match when={chip().glyph === "x"}>
        <X class="content-chip-glyph" aria-hidden="true" />
      </Match>
    </Switch>
  );
  return (
    <Show
      when={chip().toggle}
      fallback={
        <LabelTooltip content={errorLabel()}>
          <LabelTooltipTrigger
            as="span"
            class="content-chip"
            data-status={chip().look}
            role="img"
            tabindex={props.error ? 0 : undefined}
            aria-label={errorLabel()}
          >
            <ContentNetworkMark platform={props.platform} />
            {glyph()}
          </LabelTooltipTrigger>
        </LabelTooltip>
      }
    >
      <LabelTooltip content={toggleLabel()}>
        <LabelTooltipTrigger
          as={Button}
          variant="ghost"
          class="content-chip"
          data-status={chip().look}
          aria-pressed={chip().pressed ? "true" : "false"}
          aria-label={toggleLabel()}
          onClick={() => props.onToggle?.(!chip().pressed)}
        >
          <ContentNetworkMark platform={props.platform} />
          <Show when={props.warning}>
            <TriangleAlert class="content-chip-glyph content-chip-warning" aria-hidden="true" />
          </Show>
        </LabelTooltipTrigger>
      </LabelTooltip>
    </Show>
  );
}

export interface ContentCharacterCountProps {
  /** The length as the network counts it (`contentTextLength`). */
  length: number;
  limit: number;
  /** The id of the count text, for the `aria-describedby` of the text field. */
  id: string;
}

/** The characters left for one network: a ring and a line. Warning at 10% left, danger when over. */
export function ContentCharacterCount(props: ContentCharacterCountProps) {
  const { t } = useText();
  const left = () => props.limit - props.length;
  const tone = () => (left() < 0 ? "danger" : left() <= props.limit / 10 ? "warning" : "accent");
  return (
    <span class="content-count" data-tone={tone()}>
      <RadialProgress
        class="content-count-ring"
        value={(props.length / props.limit) * 100}
        tone={tone()}
        aria-hidden="true"
      />
      <Text id={props.id} variant="caption" tone={left() < 0 ? "danger" : "muted"}>
        {left() < 0 ? t("content.composer.over", { count: -left() }) : t("content.composer.left", { count: left() })}
      </Text>
    </span>
  );
}

export interface ContentEmptyProps {
  title: string;
  body: string;
  action: string;
  icon?: JSX.Element;
  onAction: () => void;
}

/** An empty page: one title, one line, one action. */
export function ContentEmpty(props: ContentEmptyProps) {
  return (
    <div class="content-empty">
      <h3>{props.title}</h3>
      <p>{props.body}</p>
      <Button size="lg" onClick={() => props.onAction()}>
        {props.icon}
        {props.action}
      </Button>
    </div>
  );
}

export interface ContentMediaFieldFile {
  name: string;
  kind: ContentMediaKind;
  bytes: number;
}

export interface ContentMediaFieldProps {
  /** The id of the label that names the field. */
  labelledBy: string;
  file: ContentMediaFieldFile | null;
  busy?: boolean;
  /** While busy: the name and size of the file being read, for the status text. */
  reading?: { name: string; bytes: number | null } | null;
  /** Why the last file was refused. The field stays empty. */
  error?: string;
  /** The post cannot change: no choose, drop or remove. */
  disabled?: boolean;
  /** Opens the file dialog of the platform. */
  onChoose: () => void;
  /** Takes the first file of a drop. */
  onDrop: (file: File) => void;
  onRemove: () => void;
}

/** One image or video for the post: choose or drop a file; the chosen file shows with a remove button. */
const LARGE_READ_BYTES = 100 * 1024 * 1024;

export function ContentMediaField(props: ContentMediaFieldProps) {
  const { t, format } = useText();
  const [over, setOver] = createSignal(false);
  const errorId = createUniqueId();
  const readingText = () => {
    const file = props.reading;
    if (!props.busy || !file) return "";
    return file.bytes !== null && file.bytes > LARGE_READ_BYTES
      ? t("content.media.readingLarge", { name: file.name, size: format.fileSize(file.bytes) })
      : t("content.media.reading", { name: file.name });
  };
  const hasFiles = (event: DragEvent) => [...(event.dataTransfer?.items ?? [])].some((item) => item.kind === "file");
  return (
    <fieldset
      class="content-media"
      aria-labelledby={props.labelledBy}
      aria-busy={props.busy ? "true" : undefined}
      disabled={props.disabled}
    >
      <Show
        when={props.file}
        fallback={
          // The Choose button is the keyboard path; a drop is the pointer shortcut.
          <section
            class="content-drop"
            aria-labelledby={props.labelledBy}
            data-over={over() ? "" : undefined}
            data-invalid={props.error ? "" : undefined}
            onDragOver={(event) => {
              if (!hasFiles(event)) return;
              event.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(event) => {
              setOver(false);
              const file = event.dataTransfer?.files[0];
              if (!file || props.disabled) return;
              event.preventDefault();
              props.onDrop(file);
            }}
          >
            <Image class="content-drop-icon" aria-hidden="true" />
            <span>
              <Button
                variant="link"
                loading={props.busy}
                aria-describedby={props.error ? errorId : undefined}
                onClick={() => props.onChoose()}
              >
                {t("content.composer.mediaChoose")}
              </Button>{" "}
              <span role="status">{readingText() || t("content.composer.mediaDrop")}</span>
            </span>
          </section>
        }
      >
        {(file) => (
          <div class="content-attachment">
            <span class="content-thumb" aria-hidden="true">
              <Show when={file().kind === "video"} fallback={<Image />}>
                <Film />
              </Show>
            </span>
            <span class="content-attachment-copy">
              <strong>{file().name}</strong>
              <small>
                {t(file().kind === "video" ? "content.composer.mediaVideo" : "content.composer.mediaImage", {
                  size: format.fileSize(file().bytes),
                })}
              </small>
            </span>
            <ImageRemoveButton
              label={t("content.composer.mediaRemove", { name: file().name })}
              disabled={props.disabled}
              onClick={() => props.onRemove()}
            />
          </div>
        )}
      </Show>
      <Show when={props.error}>
        {(error) => (
          <Text id={errorId} variant="caption" tone="danger" role="alert">
            {error()}
          </Text>
        )}
      </Show>
    </fieldset>
  );
}

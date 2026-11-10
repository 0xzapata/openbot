import { LOCAL_SERVER_ID } from "@openbot/contracts/ipc";
import {
  CONTENT_PLATFORM_KEYS,
  CONTENT_PLATFORMS,
  type ContentMediaKind,
  type ContentNetworkView,
  type ContentPlatform,
  type ContentPostView,
  type ContentSaveVariantInput,
} from "@openbot/contracts/ipc-content";
import { addCalendarDays, calendarDayOf } from "@openbot/team-client/routine-calendar-dates";
import { routineOnceInstant } from "@openbot/team-client/routine-schedule";
import {
  Alert,
  AlertActions,
  AlertContent,
  AlertDescription,
  ArrowLeft,
  Badge,
  Button,
  buttonVariants,
  Checkbox,
  ConfirmDialog,
  DropdownMenu,
  Field,
  IconButton,
  Input,
  Label,
  Megaphone,
  RadioGroup,
  Textarea,
  TriangleAlert,
} from "@openbot/ui";
import { AgentAvatar } from "@openbot/ui/features/agents/AgentAvatar";
import {
  ContentCharacterCount,
  ContentMediaField,
  ContentNetworkMark,
} from "@openbot/ui/features/content/ContentParts";
import {
  CONTENT_NETWORK_NAMES,
  type ContentNetworkRow,
  contentGateKey,
  contentPostLocked,
  networkRow,
} from "@openbot/ui/features/content/content-status";
import type { RoutineCalendarAgent } from "@openbot/ui/features/conversation/RoutineCalendar";
import { RoutineDateField } from "@openbot/ui/features/conversation/RoutineDateField";
import { RoutineTimeField } from "@openbot/ui/features/conversation/RoutineTimeField";
import { useText } from "@openbot/ui/text";
import { createMemo, createStore, For, onSettled, Show, snapshot, untrack } from "solid-js";
import type { ComposerForm, ComposerNetwork, ContentState } from "./content-context";

type BlockReason =
  | { kind: "noNetwork" }
  | { kind: "noText" }
  | { kind: "overLimit"; platform: ContentPlatform }
  | { kind: "needsImage" }
  | { kind: "noTitle" }
  | { kind: "pastTime" };

const HOUR_MINUTE = new Map<string, Intl.DateTimeFormat>();
/** "HH:mm" of an instant in a zone. A key, not display text, so the locale is fixed. */
function clockOf(at: Date, timeZone: string): string {
  let formatter = HOUR_MINUTE.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" });
    HOUR_MINUTE.set(timeZone, formatter);
  }
  return formatter.format(at);
}

function formFor(
  post: ContentPostView | null,
  networks: readonly ContentNetworkView[],
  now: Date,
  zone: string,
): ComposerForm {
  const usable = new Set(
    networks.flatMap((network) =>
      network.available && network.account && network.account.status !== "revoked" ? [network.platform] : [],
    ),
  );
  const at = post?.scheduledFor ? new Date(post.scheduledFor) : null;
  const network = (platform: ContentPlatform): ComposerNetwork => {
    const own = post?.variants.find((item) => item.platform === platform);
    return {
      // A new post starts on every network the user can post to that needs no file.
      chosen: post ? own?.status !== "skipped" : usable.has(platform) && !CONTENT_PLATFORMS[platform].mediaRequired,
      ownText: own?.body ?? null,
      title: own?.title ?? "",
    };
  };
  return {
    body: post?.body ?? "",
    media: post?.media
      ? { draftId: null, name: post.media.name, kind: post.media.kind, bytes: post.media.bytes }
      : null,
    when: "later",
    // A post with no time starts on tomorrow at 09:00.
    date: at ? calendarDayOf(at, zone) : addCalendarDays(calendarDayOf(now, zone), 1),
    time: at ? clockOf(at, zone) : "09:00",
    networks: {
      x: network("x"),
      linkedin: network("linkedin"),
      instagram: network("instagram"),
      threads: network("threads"),
      facebook_page: network("facebook_page"),
      youtube: network("youtube"),
    },
  };
}

export interface ContentComposerProps {
  /** The open composer is `content.state.composer`; its post is `content.composerPost()`. */
  content: ContentState;
  agents: readonly RoutineCalendarAgent[];
  onClose: () => void;
}

/** The composer of one post: one text for every network, or a text per network; one file; one time. */
export function ContentComposer(props: ContentComposerProps) {
  const { t, errorMessage } = useText();
  const zone = () => props.content.timeZone;
  const networks = () => props.content.state.accounts?.networks ?? [];
  const post = () => props.content.composerPost();
  /** The id from when the composer opened, or of the post its first save made. Never lost. */
  const postId = () => props.content.state.composer?.postId ?? null;
  const deleted = () => props.content.state.composer?.deleted === true;
  // The form lives in the content state, so leaving the page and coming back keeps unsaved text.
  const session = untrack(() => props.content.state.composer?.session ?? 0);
  const kept = untrack(() => props.content.composerForm(session));
  const first = kept?.initial ?? untrack(() => formFor(post(), networks(), props.content.now(), zone()));
  const [form, setForm] = kept ? [kept.form, kept.setForm] : createStore<ComposerForm>(structuredClone(first));
  if (!kept) props.content.keepComposerForm({ session, initial: first, form, setForm });
  /** The form as it was last saved or opened. */
  const initial = () => props.content.composerForm(session)?.initial ?? first;
  const [ui, setUi] = createStore<{
    busy: "save" | "main" | "media" | null;
    error: unknown;
    /** The action that the user tried while the form was blocked; its reason shows in the footer. */
    attempt: "save" | "main" | null;
    confirm: "publishNow" | "discard" | null;
  }>({ busy: null, error: null, attempt: null, confirm: null });
  let root: HTMLElement | undefined;
  let heading: HTMLHeadingElement | undefined;

  const pending = () => post()?.approvalState === "pending";
  const locked = () => {
    const current = post();
    return current ? contentPostLocked(current) : false;
  };
  /** No write runs: the post is on a network or OpenBot posts it now, or another window deleted it. */
  const readOnly = () => locked() || deleted();
  const lockedText = () =>
    post()?.variants.some((variant) => variant.status === "publishing")
      ? t("error.content.publishing")
      : t("error.content.published");
  const author = () => props.agents.find((agent) => agent.id === post()?.authorAgentId);
  const variantStatus = (platform: ContentPlatform) =>
    post()?.variants.find((variant) => variant.platform === platform)?.status;
  /** A network of a saved post can be chosen or left out only while it is a draft, queued or skipped. */
  const toggleable = (platform: ContentPlatform) => {
    const status = variantStatus(platform);
    return status === undefined || status === "draft" || status === "queued" || status === "skipped";
  };

  const textFor = (platform: ContentPlatform) => form.networks[platform].ownText ?? form.body;
  const rows = createMemo(() =>
    networks().map((network) => ({
      network,
      row: networkRow({
        network,
        chosen: form.networks[network.platform].chosen,
        text: textFor(network.platform),
        title: form.networks[network.platform].title,
        media: form.media?.kind ?? null,
      }),
    })),
  );
  const chosen = () =>
    rows().filter(({ network, row }) => form.networks[network.platform].chosen && row.block === null);

  const scheduledFor = () =>
    routineOnceInstant({ kind: "once", date: form.date, time: form.time }, zone()).toISOString();

  /** The checks that do not depend on a time. Save draft runs these; main refuses an empty post too. */
  const draftReason = createMemo((): { kind: "noNetwork" | "noText" } | null => {
    const list = chosen();
    if (list.length === 0) return { kind: "noNetwork" };
    if (!form.body.trim() || list.some(({ network }) => !textFor(network.platform).trim())) return { kind: "noText" };
    return null;
  });
  const blockReason = createMemo((): BlockReason | null => {
    const list = chosen();
    const basic = draftReason();
    if (basic) return basic;
    const over = list.find(({ row }) => row.issues.includes("overLimit"));
    if (over) return { kind: "overLimit", platform: over.network.platform };
    if (list.some(({ row }) => row.issues.includes("needsImage"))) return { kind: "needsImage" };
    if (list.some(({ row }) => row.issues.includes("noTitle"))) return { kind: "noTitle" };
    if (form.when === "later" && Date.parse(scheduledFor()) <= Date.now()) return { kind: "pastTime" };
    return null;
  });
  /** The reason of the last refused action while it holds; else the reason the main action is blocked. */
  const footerReason = () => (ui.attempt === "save" ? draftReason() : null) ?? blockReason();
  const blockText = () => {
    const reason = footerReason();
    if (!reason) return "";
    switch (reason.kind) {
      case "noNetwork":
        return t("content.composer.blocked.noNetwork");
      case "noText":
        return t("content.composer.blocked.noText");
      case "overLimit":
        return t("content.composer.blocked.overLimit", { network: CONTENT_NETWORK_NAMES[reason.platform] });
      case "needsImage":
        return t("content.composer.blocked.needsImage");
      case "noTitle":
        return t("content.composer.blocked.noTitle");
      case "pastTime":
        return t("content.composer.blocked.pastTime");
    }
  };

  /** The first control of a problem. A click on a blocked action moves focus there. */
  function focusProblem(reason: BlockReason) {
    const find = (selector: string) => root?.querySelector<HTMLElement>(selector) ?? null;
    // The text field of the network that has the problem, when it has its own; else the main text.
    const ownOrMain = (platform: ContentPlatform | undefined) =>
      (platform ? find(`#content-text-${platform}`) : null) ?? find("#content-composer-body");
    const emptyOwn = chosen().find(
      ({ network }) => form.networks[network.platform].ownText !== null && !textFor(network.platform).trim(),
    )?.network.platform;
    const target = {
      noNetwork: () => find(".content-network-row input:not(:disabled)"),
      noText: () => (form.body.trim() ? ownOrMain(emptyOwn) : find("#content-composer-body")),
      overLimit: () => ownOrMain(reason.kind === "overLimit" ? reason.platform : undefined),
      needsImage: () => find(".content-media button"),
      noTitle: () => find("#content-title-youtube"),
      pastTime: () => find(".content-composer-when .routine-chip"),
    }[reason.kind]();
    target?.focus();
  }

  /** The variants of the write. A saved network sends only what changed, so the store does not refuse it. */
  const variants = (): ContentSaveVariantInput[] =>
    CONTENT_PLATFORM_KEYS.flatMap((platform) => {
      const next = form.networks[platform];
      const before = initial().networks[platform];
      const saved = post() !== null;
      const row = rows().find((item) => item.network.platform === platform)?.row;
      const skipped = !next.chosen || (row?.block ?? null) !== null;
      const input: ContentSaveVariantInput = { platform };
      if (!saved || (toggleable(platform) && skipped !== (variantStatus(platform) === "skipped")))
        input.skipped = skipped;
      if (!saved || next.ownText !== before.ownText) input.body = next.ownText;
      if (platform === "youtube" && (!saved || next.title !== before.title)) input.title = next.title || null;
      return Object.keys(input).length > 1 ? [input] : [];
    });

  const mediaInput = () => {
    const media = form.media;
    if (media?.draftId) return { draftId: media.draftId };
    if (media === null && initial().media !== null) return null;
    return undefined;
  };

  /**
   * The post is saved: the composer keeps its id, so a retry or a second action edits it and never makes a
   * second post. Main copied the file, so the draft goes, and the saved form is the new start.
   */
  function markSaved(saved: ContentPostView) {
    props.content.adoptComposerPost(saved);
    const next = structuredClone(snapshot(form));
    const draftId = next.media?.draftId;
    if (next.media) next.media.draftId = null;
    if (draftId) {
      void props.content.port().agent.discardDraftAttachment(draftId, LOCAL_SERVER_ID);
      setForm((draft) => {
        if (draft.media) draft.media.draftId = null;
      });
    }
    props.content.keepComposerForm({ session, initial: next, form, setForm });
  }

  /** Writes the text, the file and the networks. Returns the saved post. */
  async function save(scheduled: string | null): Promise<ContentPostView> {
    const api = props.content.port().content;
    const media = mediaInput();
    const id = postId();
    const current = post();
    if (id !== null && current && locked()) return current;
    const saved =
      id === null
        ? await api.createPost({
            body: form.body,
            timezone: zone(),
            scheduledFor: scheduled,
            variants: variants(),
            ...(media === undefined ? {} : { media }),
          })
        : await api.updatePost({
            postId: id,
            action: "edit",
            body: form.body,
            timezone: zone(),
            variants: variants(),
            ...(media === undefined ? {} : { media }),
          });
    markSaved(saved);
    return saved;
  }

  /** One write at a time: a click while a write runs does nothing. */
  async function run(kind: "save" | "main", work: () => Promise<ContentPostView>) {
    if (ui.busy !== null || readOnly()) return;
    setUi((draft) => {
      draft.busy = kind;
      draft.error = null;
    });
    try {
      props.content.remember(await work());
      props.onClose();
    } catch (error) {
      // The form keeps every value.
      setUi((draft) => {
        draft.error = error;
      });
    } finally {
      setUi((draft) => {
        draft.busy = null;
      });
    }
  }

  /** Decision 5: Save draft saves the text and keeps the post as it is, also its time. */
  function saveDraft() {
    const reason = draftReason();
    if (reason) {
      setUi((draft) => {
        draft.attempt = "save";
      });
      focusProblem(reason);
      return;
    }
    void run("save", () => save(null));
  }

  function mainAction() {
    if (ui.busy !== null) return;
    const reason = blockReason();
    if (reason) {
      setUi((draft) => {
        draft.attempt = "main";
      });
      focusProblem(reason);
      return;
    }
    if (form.when === "now") {
      setUi((draft) => {
        draft.confirm = "publishNow";
      });
      return;
    }
    void run("main", async () => {
      const api = props.content.port().content;
      const time = scheduledFor();
      let saved = await save(postId() === null ? time : null);
      if (saved.approvalState === "pending") saved = await api.updatePost({ postId: saved.id, action: "approve" });
      if (saved.scheduledFor !== time || saved.status !== "queued")
        saved = await api.schedulePost({ postId: saved.id, scheduledFor: time });
      return saved;
    });
  }

  async function publishNow() {
    await run("main", async () => {
      const api = props.content.port().content;
      let saved = await save(null);
      if (saved.approvalState === "pending") saved = await api.updatePost({ postId: saved.id, action: "approve" });
      return api.publishNow({ postId: saved.id });
    });
    setUi((draft) => {
      draft.confirm = null;
    });
  }

  function back() {
    if (props.content.composerDirty()) {
      setUi((draft) => {
        draft.confirm = "discard";
      });
      return;
    }
    leave();
  }

  function leave() {
    const draftId = form.media?.draftId;
    if (draftId) void props.content.port().agent.discardDraftAttachment(draftId, LOCAL_SERVER_ID);
    props.onClose();
  }

  /** A new attachment draft replaces the one the composer made before. */
  function useDraft(attachment: { id: string; name: string; size: number; mimeType: string } | undefined) {
    if (!attachment) return;
    const old = form.media?.draftId;
    if (old) void props.content.port().agent.discardDraftAttachment(old, LOCAL_SERVER_ID);
    const kind: ContentMediaKind = attachment.mimeType.startsWith("video/") ? "video" : "image";
    setForm((draft) => {
      draft.media = { draftId: attachment.id, name: attachment.name, kind, bytes: attachment.size };
    });
  }

  async function attach(work: () => Promise<{ id: string; name: string; size: number; mimeType: string }[]>) {
    setUi((draft) => {
      draft.busy = "media";
      draft.error = null;
    });
    try {
      useDraft((await work())[0]);
    } catch (error) {
      setUi((draft) => {
        draft.error = error;
      });
    } finally {
      setUi((draft) => {
        draft.busy = null;
      });
    }
  }

  // ponytail: the picker offers images only (`filter: "images"`); offer "all" when YouTube video posts open.
  const chooseFile = () =>
    void attach(() => props.content.port().agent.chooseAttachments({ filter: "images" }, LOCAL_SERVER_ID));
  const dropFile = (file: File) =>
    void attach(async () =>
      props.content
        .port()
        .agent.importAttachmentData(
          [{ name: file.name, mimeType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) }],
          LOCAL_SERVER_ID,
        ),
    );

  const title = () =>
    postId() === null
      ? t("content.composer.titleNew")
      : pending()
        ? t("content.composer.titleReview")
        : t("content.composer.titleEdit");
  const mainLabel = () =>
    form.when === "now"
      ? t("content.action.publishNow")
      : pending()
        ? t("content.composer.approveSchedule")
        : t("content.composer.schedule");
  /** The counts of the networks that post the main text describe the main text field. */
  const mainCounts = () =>
    chosen()
      .filter(({ network }) => form.networks[network.platform].ownText === null)
      .map(({ network }) => `content-count-${network.platform}`);
  const mainOver = () =>
    chosen().some(
      ({ network, row }) => form.networks[network.platform].ownText === null && row.issues.includes("overLimit"),
    );

  onSettled(() => {
    heading?.focus();
  });

  return (
    <section class="content-composer" aria-labelledby="content-composer-heading" ref={root}>
      <header class="content-composer-header">
        <IconButton variant="ghost" label={t("common.back")} onClick={back}>
          <ArrowLeft />
        </IconButton>
        <h2 id="content-composer-heading" ref={heading} tabindex={-1}>
          {title()}
        </h2>
        <Show when={post()?.authorAgentId}>
          <span class="content-composer-by">
            <Show when={author()} fallback={t("content.queue.byAgentGone")}>
              {(agent) => (
                <>
                  <AgentAvatar agent={agent()} motion="idle" class="content-row-avatar" />
                  {t("content.queue.byAgent", { name: agent().name })}
                </>
              )}
            </Show>
          </span>
        </Show>
        <Show when={pending()}>
          <Badge variant="primary-light">{t("content.status.pending")}</Badge>
        </Show>
      </header>

      <Show when={deleted()}>
        <Alert tone="danger" role="alert" class="content-composer-error">
          <AlertContent>
            <AlertDescription>{t("error.content.unknownPost")}</AlertDescription>
          </AlertContent>
        </Alert>
      </Show>
      <Show when={locked() && !deleted()}>
        <Alert tone="neutral" role="status" class="content-composer-error">
          <AlertContent>
            <AlertDescription id="content-composer-locked">{lockedText()}</AlertDescription>
          </AlertContent>
        </Alert>
      </Show>

      <div class="content-composer-body">
        <div class="content-composer-main">
          <div class="content-composer-field">
            <Label for="content-composer-body">{t("content.composer.body")}</Label>
            <Textarea
              id="content-composer-body"
              class="content-composer-text"
              value={form.body}
              placeholder={t("content.composer.bodyPlaceholder")}
              readonly={readOnly()}
              aria-describedby={[
                "content-composer-length",
                ...mainCounts(),
                ...(locked() && !deleted() ? ["content-composer-locked"] : []),
              ].join(" ")}
              aria-invalid={mainOver() ? "true" : undefined}
              onValueChange={(value) =>
                setForm((draft) => {
                  draft.body = value;
                })
              }
            />
            <p id="content-composer-length" class="content-composer-hint">
              {t("content.composer.length", { count: Array.from(form.body).length })}
            </p>
          </div>

          <div class="content-composer-field">
            <span class="ui-label" id="content-composer-media">
              {t("content.composer.media")}
            </span>
            <ContentMediaField
              labelledBy="content-composer-media"
              file={form.media}
              busy={ui.busy === "media"}
              disabled={readOnly()}
              onChoose={chooseFile}
              onDrop={dropFile}
              onRemove={() => {
                const draftId = form.media?.draftId;
                if (draftId) void props.content.port().agent.discardDraftAttachment(draftId, LOCAL_SERVER_ID);
                setForm((draft) => {
                  draft.media = null;
                });
              }}
            />
            <p class="content-composer-hint">{t("content.composer.mediaHint")}</p>
          </div>

          <RadioGroup.Root
            class="content-composer-when"
            value={form.when}
            disabled={readOnly()}
            onChange={(value) =>
              setForm((draft) => {
                draft.when = value === "now" ? "now" : "later";
              })
            }
          >
            <RadioGroup.Label class="ui-label">{t("content.composer.when")}</RadioGroup.Label>
            <div class="content-composer-when-options">
              <RadioGroup.Item value="now" class="content-radio">
                <RadioGroup.ItemInput />
                <RadioGroup.ItemControl class="content-radio-control" />
                <RadioGroup.ItemLabel>{t("content.composer.whenNow")}</RadioGroup.ItemLabel>
              </RadioGroup.Item>
              <RadioGroup.Item value="later" class="content-radio">
                <RadioGroup.ItemInput />
                <RadioGroup.ItemControl class="content-radio-control" />
                <RadioGroup.ItemLabel>{t("content.composer.whenLater")}</RadioGroup.ItemLabel>
              </RadioGroup.Item>
            </div>
            <Show when={form.when === "later"}>
              <div class="content-composer-when-fields">
                <RoutineDateField
                  value={form.date}
                  today={new Date()}
                  disabled={readOnly()}
                  onChange={(date) =>
                    setForm((draft) => {
                      draft.date = date;
                    })
                  }
                />
                <RoutineTimeField
                  label={t("content.composer.time")}
                  value={form.time}
                  disabled={readOnly()}
                  onChange={(time) =>
                    setForm((draft) => {
                      draft.time = time;
                    })
                  }
                />
              </div>
              <p class="content-composer-hint">
                {t("content.composer.oneTime")} {t("routine.calendar.timeZone", { zone: zone().replaceAll("_", " ") })}
              </p>
            </Show>
          </RadioGroup.Root>
        </div>

        <div class="content-composer-side">
          <h3 class="ui-label" id="content-composer-networks">
            {t("content.composer.networks")}
          </h3>
          <ul class="ui-item-group content-networks" aria-labelledby="content-composer-networks">
            <For each={rows()} keyed={(item) => item.network.platform}>
              {(item) => (
                <ComposerNetworkRow
                  network={item().network}
                  row={item().row}
                  state={form.networks[item().network.platform]}
                  mainText={form.body}
                  media={form.media?.kind ?? null}
                  toggleable={!readOnly() && toggleable(item().network.platform)}
                  readOnly={readOnly()}
                  others={chosen()
                    .filter(({ network }) => network.platform !== item().network.platform)
                    .map(({ network }) => ({ platform: network.platform, text: textFor(network.platform) }))}
                  onChange={(change) =>
                    setForm((draft) => {
                      Object.assign(draft.networks[item().network.platform], change);
                    })
                  }
                  onConnect={() => props.content.openAccounts(item().network.platform)}
                />
              )}
            </For>
          </ul>
        </div>
      </div>

      <Show when={ui.error}>
        <Alert tone="danger" role="alert" class="content-composer-error">
          <AlertContent>
            <AlertDescription>{errorMessage(ui.error, t("content.error.saveFailed"))}</AlertDescription>
          </AlertContent>
          <AlertActions>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setUi((draft) => {
                  draft.error = null;
                })
              }
            >
              {t("common.close")}
            </Button>
          </AlertActions>
        </Alert>
      </Show>

      <footer class="content-composer-footer">
        {/* Always rendered and polite, so a screen reader hears the reason when its text changes. */}
        <p
          id="content-composer-blocked"
          class="content-composer-hint"
          role="status"
          aria-live="polite"
          // Choose at least one network is advice on a new post; any other reason is a problem now.
          data-tone={
            ui.attempt !== null || (footerReason() && footerReason()?.kind !== "noNetwork") ? "danger" : undefined
          }
        >
          {readOnly() ? "" : blockText()}
        </p>
        <div class="content-actions">
          {/* A post that a network already has cannot change: Retry is a queue action. */}
          <Show when={!readOnly()}>
            <Button
              variant="outline"
              size="sm"
              loading={ui.busy === "save"}
              disabled={ui.busy !== null && ui.busy !== "save"}
              aria-describedby={draftReason() ? "content-composer-blocked" : undefined}
              onClick={saveDraft}
            >
              {t("content.composer.saveDraft")}
            </Button>
            <Button
              size="sm"
              loading={ui.busy === "main"}
              disabled={ui.busy !== null && ui.busy !== "main"}
              aria-describedby={blockReason() ? "content-composer-blocked" : undefined}
              onClick={mainAction}
            >
              {mainLabel()}
            </Button>
          </Show>
        </div>
      </footer>

      <ConfirmDialog
        open={ui.confirm === "publishNow"}
        tone="default"
        icon={<Megaphone />}
        title={t("content.confirm.publishNow.title")}
        description={t("content.confirm.publishNow.body", { count: chosen().length })}
        confirmLabel={t("content.confirm.publishNow.action")}
        onCancel={() =>
          setUi((draft) => {
            draft.confirm = null;
          })
        }
        onConfirm={publishNow}
      />
      <ConfirmDialog
        open={ui.confirm === "discard"}
        icon={<TriangleAlert />}
        title={t("content.confirm.discard.title")}
        description={t("content.confirm.discard.body")}
        confirmLabel={t("content.confirm.discard.action")}
        onCancel={() =>
          setUi((draft) => {
            draft.confirm = null;
          })
        }
        onConfirm={leave}
      />
    </section>
  );
}

interface ComposerNetworkRowProps {
  network: ContentNetworkView;
  row: ContentNetworkRow;
  state: ComposerNetwork;
  mainText: string;
  media: ContentMediaKind | null;
  toggleable: boolean;
  /** The post cannot change: the text fields are read-only and their buttons do nothing. */
  readOnly: boolean;
  /** The other chosen networks and their text, for "Copy from…". */
  others: { platform: ContentPlatform; text: string }[];
  onChange: (change: Partial<ComposerNetwork>) => void;
  onConnect: () => void;
}

/** One network: checkbox, mark, name and handle, the count; then its text and, for YouTube, the title. */
function ComposerNetworkRow(props: ComposerNetworkRowProps) {
  const { t } = useText();
  const platform = () => props.network.platform;
  const name = () => CONTENT_NETWORK_NAMES[platform()];
  const open = () => props.state.chosen && props.row.block === null;
  const note = () => {
    switch (props.row.block) {
      case "unavailable":
        return t(contentGateKey(platform()));
      case "notConnected":
        return t("content.composer.notConnected");
      case "needsVideo":
        return t("content.composer.needsVideo");
      case "imagesOnly":
        return t("content.composer.imagesOnly");
    }
    if (props.state.chosen && props.row.issues.includes("needsImage")) return t("content.composer.needsImage");
    return props.network.account?.displayName ?? props.network.account?.handle ?? "";
  };
  const danger = () => props.state.chosen && props.row.issues.includes("needsImage");
  const countId = () => `content-count-${platform()}`;
  const noteId = () => `content-note-${platform()}`;
  return (
    <li
      class="content-network-row"
      data-disabled={props.row.block ? "" : undefined}
      data-invalid={open() && props.row.issues.length > 0 ? "" : undefined}
    >
      <div class="content-network-head">
        <Checkbox
          checked={open()}
          disabled={props.row.block !== null || !props.toggleable}
          aria-label={name()}
          // A disabled network says why: its note is the reason.
          aria-describedby={props.row.block !== null && note() ? noteId() : undefined}
          onChange={(event) => props.onChange({ chosen: event.currentTarget.checked })}
        />
        <ContentNetworkMark platform={platform()} class="content-network-mark" />
        <span class="content-network-name">
          <strong>{name()}</strong>
          <small id={noteId()} class={danger() ? "content-network-danger" : undefined}>
            {note()}
          </small>
        </span>
        <Show when={props.row.block === "notConnected"}>
          <Button variant="outline" size="xs" onClick={() => props.onConnect()}>
            {t("content.composer.connect")}
          </Button>
        </Show>
        <Show when={props.row.block === "unavailable"}>
          <Badge variant="outline">{t("content.composer.unavailable")}</Badge>
        </Show>
        <Show when={open()}>
          <ContentCharacterCount length={props.row.length} limit={props.row.limit} id={countId()} />
        </Show>
      </div>
      <Show when={open()}>
        <Show
          when={props.state.ownText !== null}
          fallback={
            <div class="content-network-text">
              <span>{t("content.composer.sameText")}</span>
              <Button
                variant="link"
                size="xs"
                disabled={props.readOnly}
                onClick={() => props.onChange({ ownText: props.mainText })}
              >
                {t("content.composer.editText")}
              </Button>
            </div>
          }
        >
          <Textarea
            id={`content-text-${platform()}`}
            class="content-network-own"
            value={props.state.ownText ?? ""}
            readonly={props.readOnly}
            aria-label={t("content.composer.textFor", { network: name() })}
            aria-describedby={countId()}
            aria-invalid={props.row.issues.includes("overLimit") ? "true" : undefined}
            onValueChange={(value) => props.onChange({ ownText: value })}
          />
          <div class="content-network-text">
            <Button
              variant="link"
              size="xs"
              disabled={props.readOnly}
              onClick={() => props.onChange({ ownText: null })}
            >
              {t("content.composer.resetText")}
            </Button>
            <Show when={props.others.length > 0 && !props.readOnly}>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger class={buttonVariants({ variant: "link", size: "xs" })}>
                  {t("content.composer.copyFrom")}
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content>
                    <For each={props.others}>
                      {(other) => (
                        <DropdownMenu.Item onSelectAfterClose={() => props.onChange({ ownText: other.text })}>
                          {t("content.composer.copyFromNetwork", { network: CONTENT_NETWORK_NAMES[other.platform] })}
                        </DropdownMenu.Item>
                      )}
                    </For>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </Show>
          </div>
        </Show>
        <Show when={platform() === "youtube" && props.media === "video"}>
          <Field label={t("content.composer.videoTitle")} htmlFor="content-title-youtube" required>
            <Input
              id="content-title-youtube"
              value={props.state.title}
              readonly={props.readOnly}
              onValueChange={(value) => props.onChange({ title: value })}
            />
          </Field>
        </Show>
      </Show>
    </li>
  );
}

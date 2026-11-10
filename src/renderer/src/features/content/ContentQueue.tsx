import type {
  ContentAccountView,
  ContentPlatform,
  ContentPostView,
  ContentVariantView,
} from "@openbot/contracts/ipc-content";
import type { AppTextKey } from "@openbot/i18n";
import { addCalendarDays, calendarDayDate, calendarDayOf } from "@openbot/team-client/routine-calendar-dates";
import { routineOnceInstant } from "@openbot/team-client/routine-schedule";
import {
  Alert,
  AlertActions,
  AlertContent,
  AlertDescription,
  AlertIcon,
  Badge,
  Button,
  buttonVariants,
  Clock3,
  ConfirmDialog,
  DropdownMenu,
  Ellipsis,
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemTitle,
  Megaphone,
  Pencil,
  Plus,
  Popover,
  RotateCcw,
  Skeleton,
  TOAST_DURATION,
  TriangleAlert,
  toast,
} from "@openbot/ui";
import { AgentAvatar } from "@openbot/ui/features/agents/AgentAvatar";
import { ContentEmpty, ContentNetworkChip } from "@openbot/ui/features/content/ContentParts";
import {
  CONTENT_NETWORK_NAMES,
  CONTENT_STATUS_LABEL,
  type ContentQueueSection,
  contentPostLocked,
  networkRow,
  postBadge,
  queueSections,
} from "@openbot/ui/features/content/content-status";
import { contentPostTitle } from "@openbot/ui/features/content/PostCalendar";
import type { RoutineCalendarAgent } from "@openbot/ui/features/conversation/RoutineCalendar";
import { RoutineDateField } from "@openbot/ui/features/conversation/RoutineDateField";
import { RoutineTimeField } from "@openbot/ui/features/conversation/RoutineTimeField";
import { useText } from "@openbot/ui/text";
import { createMemo, createSignal, createStore, For, Match, Show, Switch } from "solid-js";
import type { ContentState } from "./content-context";

const DONE_LIMIT = 5;

const SECTION_LABEL = {
  needsYou: "content.queue.section.needsYou",
  today: "content.queue.section.today",
  tomorrow: "content.queue.section.tomorrow",
  drafts: "content.queue.section.drafts",
  done: "content.queue.section.done",
} as const satisfies Record<Exclude<ContentQueueSection, `day:${string}`>, AppTextKey>;

const isNamedSection = (section: ContentQueueSection): section is keyof typeof SECTION_LABEL =>
  !section.startsWith("day:");

/** A confirm that a row action opens. */
type QueueConfirm =
  | { kind: "publishNow"; post: ContentPostView }
  | { kind: "delete"; post: ContentPostView }
  | { kind: "retryUnknown"; post: ContentPostView; networks: ContentPlatform[] };

export interface ContentQueueProps {
  content: ContentState;
  agents: readonly RoutineCalendarAgent[];
}

/** The networks of `platforms` that can post this post now: available, connected, and the right file. */
function postable(content: ContentState, post: ContentPostView, platforms: readonly ContentPlatform[]) {
  const networks = content.state.accounts?.networks ?? [];
  return platforms.filter((platform) => {
    const network = networks.find((candidate) => candidate.platform === platform);
    const variant = post.variants.find((candidate) => candidate.platform === platform);
    return (
      network !== undefined &&
      networkRow({
        network,
        chosen: true,
        text: variant?.body ?? post.body,
        title: variant?.title ?? "",
        media: post.media?.kind ?? null,
      }).block === null
    );
  });
}

/** The networks that Publish now posts to: every network that is not skipped and can post. */
const publishCount = (content: ContentState, post: ContentPostView) =>
  postable(
    content,
    post,
    post.variants.filter((variant) => variant.status !== "skipped").map((variant) => variant.platform),
  ).length;

/** The approval queue: what needs the user first, then each day, then drafts, then what is done. */
export function ContentQueue(props: ContentQueueProps) {
  const { t, format, errorMessage } = useText();
  const content = () => props.content;
  const [view, setView] = createStore<{ showAllDone: boolean; confirm: QueueConfirm | null }>({
    showAllDone: false,
    confirm: null,
  });
  /** The posts with a write in flight. One row's write does not end another row's wait. */
  const [busy, setBusy] = createSignal<ReadonlySet<string>>(new Set());
  const groups = createMemo(() => queueSections(content().state.posts, content().now(), content().timeZone));
  const today = () => calendarDayOf(content().now(), content().timeZone);

  const sectionLabel = (section: ContentQueueSection) =>
    isNamedSection(section)
      ? t(SECTION_LABEL[section])
      : format.date(calendarDayDate(section.slice(4)), {
          weekday: "long",
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        });

  /** The networks that signed the user out and still have queued posts. */
  const signedOut = createMemo(() => {
    const queued = new Set(
      content()
        .state.posts.flatMap((post) => post.variants)
        .filter((variant) => variant.status === "queued")
        .map((variant) => variant.platform),
    );
    return (content().state.accounts?.networks ?? []).flatMap((network): ContentAccountView[] =>
      // Expired only: a revoked account is one the user disconnected; its posts fail at their time.
      network.account?.status === "expired" && queued.has(network.platform) ? [network.account] : [],
    );
  });

  /** No connected or signed-out account. A revoked account counts as no account. */
  const noAccounts = () =>
    content().state.accounts !== null &&
    content().state.accounts?.networks.every(
      (network) => network.account === null || network.account.status === "revoked",
    ) === true;

  /**
   * Runs one write of a post. A click on a row whose write still runs does nothing. A failure shows as a
   * toast; the row stays as it was.
   */
  async function write(postId: string, run: () => Promise<ContentPostView | undefined>): Promise<boolean> {
    if (busy().has(postId)) return false;
    setBusy((current) => new Set(current).add(postId));
    try {
      const post = await run();
      if (post) content().remember(post);
      return true;
    } catch (error) {
      toast.error(errorMessage(error, t("content.error.actionFailed")));
      return false;
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(postId);
        return next;
      });
    }
  }

  const api = () => content().port().content;

  /** The time of a post in its row: the time alone in a day section, else the day and the time. */
  const rowTime = (post: ContentPostView, section: ContentQueueSection) => {
    if (!post.scheduledFor) return null;
    const at = new Date(post.scheduledFor);
    const time = format.date(at, { hour: "numeric", minute: "2-digit", timeZone: content().timeZone });
    if (section === "today" || section === "tomorrow" || section.startsWith("day:")) return { day: null, time };
    const day = calendarDayOf(at, content().timeZone);
    if (day === today()) return { day: t("content.queue.section.today"), time };
    if (day === addCalendarDays(today(), 1)) return { day: t("content.queue.section.tomorrow"), time };
    return { day: format.date(at, { weekday: "short", timeZone: content().timeZone }), time };
  };
  const longTime = (post: ContentPostView) =>
    post.scheduledFor
      ? format.date(new Date(post.scheduledFor), {
          weekday: "short",
          hour: "numeric",
          minute: "2-digit",
          timeZone: content().timeZone,
        })
      : "";

  /**
   * Approve writes at once. A post with a future time is scheduled; a post with no time is "Approved" and
   * shows Pick a time. Only a proposed time that has passed opens the composer for a new time. Undo is a
   * real reverse write: the post waits for approval again.
   */
  async function approve(post: ContentPostView) {
    if (postBadge(post, content().now()).timePassed) {
      content().openComposer(post);
      return;
    }
    let approved: ContentPostView | undefined;
    const done = await write(post.id, async () => {
      approved = await api().updatePost({ postId: post.id, action: "approve" });
      return approved;
    });
    if (!done || !approved) return;
    toast(
      approved.scheduledFor
        ? t("content.toast.approved", { time: longTime(approved) })
        : t("content.toast.approvedNoTime"),
      {
        duration: TOAST_DURATION,
        action: {
          label: t("content.toast.undo"),
          onClick: () => void write(post.id, () => api().updatePost({ postId: post.id, action: "unapprove" })),
        },
      },
    );
  }

  async function skipPost(post: ContentPostView) {
    const skipped = post.variants
      .filter((variant) => variant.status === "draft" || variant.status === "queued")
      .map((variant) => variant.platform);
    const wasQueued = post.variants.some((variant) => variant.status === "queued");
    const done = await write(post.id, () =>
      api().updatePost({
        postId: post.id,
        action: "edit",
        variants: skipped.map((platform) => ({ platform, skipped: true })),
      }),
    );
    if (!done) return;
    toast(t("content.toast.skipped"), {
      duration: TOAST_DURATION,
      action: {
        label: t("content.toast.undo"),
        onClick: () => void restore(post, postable(content(), post, skipped), wasQueued),
      },
    });
  }

  /** Takes networks back. Each one comes back as a draft; a post that was queued is queued again. */
  async function restore(post: ContentPostView, platforms: readonly ContentPlatform[], requeue: boolean) {
    const done = await write(post.id, () =>
      api().updatePost({
        postId: post.id,
        action: "edit",
        variants: platforms.map((platform) => ({ platform, skipped: false })),
      }),
    );
    const time = post.scheduledFor;
    if (done && requeue && time && Date.parse(time) > Date.now())
      await write(post.id, () => api().schedulePost({ postId: post.id, scheduledFor: time }));
  }

  /** The Restore of a skipped post brings back only the networks that can post it. */
  const restorable = (post: ContentPostView) =>
    postable(
      content(),
      post,
      post.variants.map((variant) => variant.platform),
    );

  function toggleNetwork(post: ContentPostView, variant: ContentVariantView, included: boolean) {
    void write(post.id, () =>
      api().updatePost({
        postId: post.id,
        action: "edit",
        variants: [{ platform: variant.platform, skipped: !included }],
      }),
    );
  }

  /** Retries every failed network. One confirm first names every network whose result is unknown. */
  async function retry(post: ContentPostView, checked = false) {
    const failed = post.variants.filter((variant) => variant.status === "failed");
    const unknown = failed.filter((variant) => variant.errorCode === "unknown-result");
    if (unknown.length > 0 && !checked) {
      setView((draft) => {
        draft.confirm = { kind: "retryUnknown", post, networks: unknown.map((variant) => variant.platform) };
      });
      return;
    }
    await write(post.id, async () => {
      let last: ContentPostView | undefined;
      for (const variant of failed)
        last = await api().updatePost({ postId: post.id, action: "retry", platform: variant.platform });
      return last;
    });
  }

  const closeConfirm = () =>
    setView((draft) => {
      draft.confirm = null;
    });

  async function confirm() {
    const current = view.confirm;
    if (!current) return;
    if (current.kind === "publishNow")
      await write(current.post.id, () => api().publishNow({ postId: current.post.id }));
    else if (current.kind === "delete") {
      const done = await write(current.post.id, async () => {
        await api().deletePost({ postId: current.post.id });
        return undefined;
      });
      if (done) content().forget(current.post.id);
    } else await retry(current.post, true);
    closeConfirm();
  }

  const confirmNetwork = () => {
    const current = view.confirm;
    return current?.kind === "retryUnknown"
      ? format.list(current.networks.map((platform) => CONTENT_NETWORK_NAMES[platform]))
      : "";
  };

  return (
    <div class="content-queue">
      <For each={signedOut()} keyed={(account) => account.id}>
        {(item) => {
          const account = () => item();
          return (
            <Alert tone="warning" role="status">
              <AlertIcon>
                <TriangleAlert />
              </AlertIcon>
              <AlertContent>
                <AlertDescription>
                  {t("content.banner.signedOut", {
                    network: CONTENT_NETWORK_NAMES[account().platform],
                    handle: account().handle,
                  })}
                </AlertDescription>
              </AlertContent>
              <AlertActions>
                <Button variant="outline" size="sm" onClick={() => content().openAccounts(account().platform)}>
                  {t("content.banner.reconnect")}
                </Button>
              </AlertActions>
            </Alert>
          );
        }}
      </For>

      <Switch>
        <Match when={content().state.phase === "loading" && content().state.posts.length === 0}>
          <div class="content-queue-loading" aria-busy="true">
            <p class="sr-only" role="status">
              {t("content.queue.loading")}
            </p>
            <For each={[0, 1]}>
              {() => (
                <div class="content-section">
                  <Skeleton class="content-skeleton-heading" />
                  <Skeleton class="content-skeleton-row" />
                  <Skeleton class="content-skeleton-row" />
                  <Skeleton class="content-skeleton-row" />
                </div>
              )}
            </For>
          </div>
        </Match>
        <Match when={content().state.phase === "error" && content().state.posts.length === 0}>
          <Alert tone="danger" role="alert">
            <AlertContent>
              <AlertDescription>{t("content.error.loadFailed")}</AlertDescription>
            </AlertContent>
            <AlertActions>
              <Button variant="outline" size="sm" onClick={() => void content().reload()}>
                {t("common.retry")}
              </Button>
            </AlertActions>
          </Alert>
        </Match>
        <Match when={content().state.posts.length === 0}>
          <Show
            when={noAccounts()}
            fallback={
              <ContentEmpty
                title={t("content.empty.title")}
                body={t("content.empty.body")}
                action={t("content.action.new")}
                icon={<Plus aria-hidden="true" />}
                onAction={() => content().openComposer(null)}
              />
            }
          >
            <ContentEmpty
              title={t("content.empty.noAccounts.title")}
              body={t("content.empty.noAccounts.body")}
              action={t("content.empty.noAccounts.action")}
              onAction={() => content().openAccounts()}
            />
          </Show>
        </Match>
        <Match when={true}>
          {/* Keyed by section and by post, so a clock tick or a refresh keeps the rows, focus and menus. */}
          <For each={groups()} keyed={(group) => group.section}>
            {(group) => {
              const headingId = () => `content-section-${group().section.replace(":", "-")}`;
              const shown = () =>
                group().section === "done" && !view.showAllDone ? group().posts.slice(0, DONE_LIMIT) : group().posts;
              return (
                <section
                  class="content-section"
                  data-closed={group().section === "done" ? "" : undefined}
                  aria-labelledby={headingId()}
                >
                  <h3 id={headingId()} class="content-section-heading">
                    <span>{sectionLabel(group().section)}</span>
                    <span class="content-section-count">{group().posts.length}</span>
                  </h3>
                  <ItemGroup role="list">
                    <For each={shown()} keyed={(post) => post.id}>
                      {(post) => (
                        <ContentQueueRow
                          post={post()}
                          section={group().section}
                          time={rowTime(post(), group().section)}
                          longTime={longTime(post())}
                          content={content()}
                          agents={props.agents}
                          busy={busy().has(post().id)}
                          canRestore={restorable(post()).length > 0}
                          onApprove={() => void approve(post())}
                          onEdit={() => content().openComposer(post())}
                          onRetry={() => void retry(post())}
                          onSkip={() => void skipPost(post())}
                          onRestore={() => void restore(post(), restorable(post()), false)}
                          onSchedule={(scheduledFor) =>
                            write(post().id, () => api().schedulePost({ postId: post().id, scheduledFor }))
                          }
                          onUnschedule={() =>
                            void write(post().id, () => api().updatePost({ postId: post().id, action: "unschedule" }))
                          }
                          onPublishNow={() =>
                            setView((draft) => {
                              draft.confirm = { kind: "publishNow", post: post() };
                            })
                          }
                          onDelete={() =>
                            setView((draft) => {
                              draft.confirm = { kind: "delete", post: post() };
                            })
                          }
                          onToggle={(variant, included) => toggleNetwork(post(), variant, included)}
                        />
                      )}
                    </For>
                  </ItemGroup>
                  <Show when={group().section === "done" && group().posts.length > DONE_LIMIT}>
                    <Button
                      variant="ghost"
                      size="sm"
                      class="content-show-all"
                      aria-expanded={view.showAllDone ? "true" : "false"}
                      onClick={() =>
                        setView((draft) => {
                          draft.showAllDone = !draft.showAllDone;
                        })
                      }
                    >
                      {view.showAllDone
                        ? t("content.queue.showLess")
                        : t("content.queue.showAll", { count: group().posts.length })}
                    </Button>
                  </Show>
                </section>
              );
            }}
          </For>
        </Match>
      </Switch>

      <ConfirmDialog
        open={view.confirm?.kind === "publishNow"}
        tone="default"
        icon={<Megaphone />}
        title={t("content.confirm.publishNow.title")}
        description={t("content.confirm.publishNow.body", {
          count: view.confirm?.kind === "publishNow" ? publishCount(content(), view.confirm.post) : 0,
        })}
        confirmLabel={t("content.confirm.publishNow.action")}
        onCancel={closeConfirm}
        onConfirm={confirm}
      />
      <ConfirmDialog
        open={view.confirm?.kind === "delete"}
        title={t("content.confirm.delete.title")}
        description={t("content.confirm.delete.body")}
        confirmLabel={t("common.delete")}
        onCancel={closeConfirm}
        onConfirm={confirm}
      />
      <ConfirmDialog
        open={view.confirm?.kind === "retryUnknown"}
        tone="default"
        icon={<TriangleAlert />}
        initialFocus="cancel"
        title={t("content.confirm.retryUnknown.title", { network: confirmNetwork() })}
        description={t("content.confirm.retryUnknown.body", { network: confirmNetwork() })}
        confirmLabel={t("content.confirm.retryUnknown.action")}
        onCancel={closeConfirm}
        onConfirm={confirm}
      />
    </div>
  );
}

interface ContentQueueRowProps {
  post: ContentPostView;
  section: ContentQueueSection;
  time: { day: string | null; time: string } | null;
  longTime: string;
  content: ContentState;
  agents: readonly RoutineCalendarAgent[];
  busy: boolean;
  /** A skipped post has a network that can post it, so Restore can bring it back. */
  canRestore: boolean;
  onApprove: () => void;
  onEdit: () => void;
  onRetry: () => void;
  onSkip: () => void;
  onRestore: () => void;
  /** Sets the time of an approved post. Resolves true when the write succeeded. */
  onSchedule: (scheduledFor: string) => Promise<boolean>;
  onUnschedule: () => void;
  onPublishNow: () => void;
  onDelete: () => void;
  onToggle: (variant: ContentVariantView, included: boolean) => void;
}

/** One post: time, title, the network chips and a note, the status, and the actions of its status. */
function ContentQueueRow(props: ContentQueueRowProps) {
  const { t, errorMessage } = useText();
  const badge = () => postBadge(props.post, props.content.now());
  const title = () => contentPostTitle(props.post.body) || t("content.queue.untitled");
  const locked = () => contentPostLocked(props.post);
  const pending = () => props.post.approvalState === "pending";
  const statusText = () => {
    const current = badge();
    if (current.kind === "failed") return t("content.status.failed", { count: current.count });
    if (current.kind === "queued") return t("content.status.queued", { time: props.longTime });
    return t(CONTENT_STATUS_LABEL[current.kind]);
  };
  const author = () => props.agents.find((agent) => agent.id === props.post.authorAgentId);
  // The stored error is `sourceText` English or provider text: `errorMessage` shows it in the reader's language.
  // Each reason is a sentence, so each failed network gets its own line rather than a joined list.
  const failures = () =>
    props.post.variants
      .filter((variant) => variant.status === "failed")
      .map((variant) => ({
        id: variant.id,
        text: t("content.queue.failedNote", {
          network: CONTENT_NETWORK_NAMES[variant.platform],
          reason: errorMessage(variant.error, t("content.variant.failed")),
        }),
      }));
  // The networks of the post, and while a click can still change them, the skipped networks the user can post to.
  const connected = () =>
    new Set(
      (props.content.state.accounts?.networks ?? []).flatMap((network) =>
        network.available && network.account && network.account.status !== "revoked" ? [network.platform] : [],
      ),
    );
  const chips = () =>
    badge().kind === "skipped"
      ? []
      : props.post.variants.filter(
          (variant) => variant.status !== "skipped" || (!locked() && connected().has(variant.platform)),
        );
  const menuItems = () => {
    const kind = badge().kind;
    const items: Array<{ key: AppTextKey; run: () => void; destructive?: boolean }> = [];
    if (kind === "pending") items.push({ key: "content.action.skipPost", run: props.onSkip });
    if (kind === "approved")
      items.push({ key: "common.edit", run: props.onEdit }, { key: "content.action.skipPost", run: props.onSkip });
    if (kind === "queued")
      items.push(
        { key: "common.edit", run: props.onEdit },
        { key: "content.action.publishNow", run: props.onPublishNow },
        { key: "content.action.unschedule", run: props.onUnschedule },
        { key: "content.action.skipPost", run: props.onSkip },
      );
    if (kind === "failed" && !locked()) items.push({ key: "common.edit", run: props.onEdit });
    if (kind === "draft") items.push({ key: "content.action.publishNow", run: props.onPublishNow });
    if (kind !== "publishing") items.push({ key: "common.delete", run: props.onDelete, destructive: true });
    return items;
  };
  return (
    <Item size="compact" class="content-row" role="listitem" aria-busy={props.busy ? "true" : undefined}>
      <span class="content-row-time" data-none={props.time ? undefined : ""}>
        <Show when={props.time} fallback={t("content.queue.noTime")}>
          {(time) => (
            <>
              <Show when={time().day}>
                {(day) => (
                  <>
                    {day()}
                    <br />
                  </>
                )}
              </Show>
              {time().time}
            </>
          )}
        </Show>
      </span>
      <ItemContent>
        <ItemTitle>{title()}</ItemTitle>
        <span class="content-row-meta">
          <Show when={chips().length > 0}>
            <span class="content-chips">
              <For each={chips()} keyed={(variant) => variant.id}>
                {(variant) => (
                  <ContentNetworkChip
                    platform={variant().platform}
                    status={pending() && variant().status === "draft" ? "pending" : variant().status}
                    locked={locked()}
                    error={variant().error}
                    onToggle={(included) => props.onToggle(variant(), included)}
                  />
                )}
              </For>
            </span>
          </Show>
          <Switch>
            <Match when={badge().kind === "failed"}>
              <span class="content-row-error">
                <For each={failures()} keyed={(failure) => failure.id}>
                  {(failure) => <span class="content-row-error-line">{failure().text}</span>}
                </For>
              </span>
            </Match>
            <Match when={badge().timePassed}>
              <span>{t("content.status.timePassed")}</span>
            </Match>
            <Match when={badge().kind === "skipped"}>
              <span>{t("content.status.skipped")}</span>
            </Match>
            <Match when={props.post.authorAgentId}>
              <Show when={author()} fallback={<span>{t("content.queue.byAgentGone")}</span>}>
                {(agent) => (
                  <>
                    <AgentAvatar agent={agent()} motion="idle" class="content-row-avatar" />
                    <span>{t("content.queue.byAgent", { name: agent().name })}</span>
                  </>
                )}
              </Show>
            </Match>
          </Switch>
        </span>
      </ItemContent>
      <Show when={badge().variant} fallback={<span class="sr-only">{statusText()}</span>}>
        {(variant) => <Badge variant={variant()}>{statusText()}</Badge>}
      </Show>
      <ItemActions>
        <Switch>
          <Match when={badge().kind === "pending"}>
            <Button variant="outline" size="xs" onClick={() => props.onEdit()}>
              {t("common.edit")}
            </Button>
            <Button size="xs" loading={props.busy} onClick={() => props.onApprove()}>
              {t("content.action.approve")}
            </Button>
          </Match>
          <Match when={badge().kind === "approved"}>
            <ContentPickTime content={props.content} title={title()} busy={props.busy} onSchedule={props.onSchedule} />
          </Match>
          <Match when={badge().kind === "failed"}>
            <Button variant="outline" size="xs" loading={props.busy} onClick={() => props.onRetry()}>
              <RotateCcw aria-hidden="true" />
              {t("common.retry")}
            </Button>
          </Match>
          <Match when={badge().kind === "draft"}>
            <Button variant="outline" size="xs" onClick={() => props.onEdit()}>
              <Pencil aria-hidden="true" />
              {t("common.edit")}
            </Button>
          </Match>
          <Match when={badge().kind === "skipped"}>
            <Button
              variant="ghost"
              size="xs"
              loading={props.busy}
              disabled={!props.canRestore}
              onClick={() => props.onRestore()}
            >
              {t("content.action.restore")}
            </Button>
          </Match>
        </Switch>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            class={`${buttonVariants({ variant: "ghost", size: "icon-sm" })} ui-icon-button`}
            disabled={badge().kind === "publishing"}
            aria-label={t("content.action.more", { title: title() })}
          >
            <Ellipsis aria-hidden="true" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content>
              <For each={menuItems()}>
                {(item) => (
                  <DropdownMenu.Item data-destructive={item.destructive ? "" : undefined} onSelectAfterClose={item.run}>
                    {t(item.key)}
                  </DropdownMenu.Item>
                )}
              </For>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </ItemActions>
    </Item>
  );
}

/** A tomorrow-at-09:00 start in the zone, as the composer uses for a post with no time. */
function defaultPick(now: Date, timeZone: string) {
  return { date: addCalendarDays(calendarDayOf(now, timeZone), 1), time: "09:00" };
}

/**
 * Pick a time for an approved post with no time: a small popover with the date, the time and the zone,
 * and Schedule. Kobalte gives the focus trap, Escape and the return of focus to the button.
 */
function ContentPickTime(props: {
  content: ContentState;
  title: string;
  busy: boolean;
  onSchedule: (scheduledFor: string) => Promise<boolean>;
}) {
  const { t } = useText();
  const [pick, setPick] = createStore({ open: false, date: "", time: "", attempted: false });
  const zone = () => props.content.timeZone;
  const instant = () => routineOnceInstant({ kind: "once", date: pick.date, time: pick.time }, zone());
  const past = () => instant().getTime() <= Date.now();
  async function schedule() {
    if (props.busy) return;
    if (past()) {
      setPick((draft) => {
        draft.attempted = true;
      });
      return;
    }
    if (await props.onSchedule(instant().toISOString()))
      setPick((draft) => {
        draft.open = false;
      });
  }
  return (
    <Popover.Root
      open={pick.open}
      onOpenChange={(open) =>
        setPick((draft) => {
          if (open) Object.assign(draft, defaultPick(props.content.now(), zone()), { attempted: false });
          draft.open = open;
        })
      }
      placement="bottom-end"
      gutter={6}
    >
      <Popover.Trigger
        class={buttonVariants({ size: "xs" })}
        aria-label={t("content.pickTime.label", { title: props.title })}
      >
        <Clock3 aria-hidden="true" />
        {t("content.action.pickTime")}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content class="ui-popover-menu-surface routine-popover content-pick-time">
          <Popover.Title class="ui-label">{t("content.action.pickTime")}</Popover.Title>
          <div class="content-composer-when-fields">
            <RoutineDateField
              value={pick.date}
              today={new Date()}
              onChange={(date) =>
                setPick((draft) => {
                  draft.date = date;
                })
              }
            />
            <RoutineTimeField
              label={t("content.composer.time")}
              value={pick.time}
              onChange={(time) =>
                setPick((draft) => {
                  draft.time = time;
                })
              }
            />
          </div>
          <p class="content-composer-hint">{t("routine.calendar.timeZone", { zone: zone().replaceAll("_", " ") })}</p>
          <p class="content-composer-hint" role="status" data-tone={pick.attempted && past() ? "danger" : undefined}>
            {pick.attempted && past() ? t("content.composer.blocked.pastTime") : ""}
          </p>
          <div class="content-actions">
            <Button size="sm" loading={props.busy} onClick={() => void schedule()}>
              {t("content.composer.schedule")}
            </Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

import type {
  ContentAccountView,
  ContentPlatform,
  ContentPostView,
  ContentVariantView,
} from "@openbot/contracts/ipc-content";
import type { AppTextKey } from "@openbot/i18n";
import { addCalendarDays, calendarDayDate, calendarDayOf } from "@openbot/team-client/routine-calendar-dates";
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
  postBadge,
  queueSections,
} from "@openbot/ui/features/content/content-status";
import { contentPostTitle } from "@openbot/ui/features/content/PostCalendar";
import type { RoutineCalendarAgent } from "@openbot/ui/features/conversation/RoutineCalendar";
import { useText } from "@openbot/ui/text";
import { createMemo, createStore, For, Match, Show, Switch } from "solid-js";
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
  | { kind: "retryUnknown"; post: ContentPostView; network: ContentPlatform };

export interface ContentQueueProps {
  content: ContentState;
  agents: readonly RoutineCalendarAgent[];
}

/** The networks a post goes to: every variant that is not skipped. */
const sentNetworks = (post: ContentPostView) => post.variants.filter((variant) => variant.status !== "skipped");

/** The approval queue: what needs the user first, then each day, then drafts, then what is done. */
export function ContentQueue(props: ContentQueueProps) {
  const { t, format, errorMessage } = useText();
  const content = () => props.content;
  const [view, setView] = createStore<{ showAllDone: boolean; confirm: QueueConfirm | null; busy: string | null }>({
    showAllDone: false,
    confirm: null,
    busy: null,
  });
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
      network.account && network.account.status !== "connected" && queued.has(network.platform)
        ? [network.account]
        : [],
    );
  });

  const noAccounts = () =>
    content().state.accounts !== null &&
    content().state.accounts?.networks.every((network) => network.account === null) === true;

  /** Runs one write. A failure shows as a toast; the row stays as it was. */
  async function write(postId: string, run: () => Promise<ContentPostView | undefined>): Promise<boolean> {
    setView((draft) => {
      draft.busy = postId;
    });
    try {
      const post = await run();
      if (post) content().remember(post);
      return true;
    } catch (error) {
      toast.error(errorMessage(error, t("content.error.actionFailed")));
      return false;
    } finally {
      setView((draft) => {
        draft.busy = null;
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

  function approve(post: ContentPostView) {
    const badge = postBadge(post, content().now());
    // A post with no time, or a time that has passed, gets a new time in the composer first.
    if (!post.scheduledFor || badge.timePassed) {
      content().openComposer(post.id);
      return;
    }
    // The approval waits for the toast, so Undo needs no reverse action. Until then the row shows it.
    const original = post;
    content().remember({
      ...post,
      approvalState: "approved",
      status: "queued",
      variants: post.variants.map((variant) =>
        variant.status === "draft" ? { ...variant, status: "queued" as const } : variant,
      ),
    });
    let undone = false;
    let committed = false;
    const commit = () => {
      if (undone || committed) return;
      committed = true;
      void write(post.id, () => api().updatePost({ postId: post.id, action: "approve" }));
    };
    toast(t("content.toast.approved", { time: longTime(post) }), {
      duration: TOAST_DURATION,
      action: {
        label: t("content.toast.undo"),
        onClick: () => {
          if (committed) return;
          undone = true;
          content().remember(original);
        },
      },
      onAutoClose: commit,
      onDismiss: commit,
    });
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
        onClick: () => void restore(post, skipped, wasQueued),
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

  function toggleNetwork(post: ContentPostView, variant: ContentVariantView, included: boolean) {
    void write(post.id, () =>
      api().updatePost({
        postId: post.id,
        action: "edit",
        variants: [{ platform: variant.platform, skipped: !included }],
      }),
    );
  }

  async function retry(post: ContentPostView, checked = false) {
    const failed = post.variants.filter((variant) => variant.status === "failed");
    const unknown = failed.find((variant) => variant.errorCode === "unknown-result");
    if (unknown && !checked) {
      setView((draft) => {
        draft.confirm = { kind: "retryUnknown", post, network: unknown.platform };
      });
      return;
    }
    for (const variant of failed)
      await write(post.id, () => api().updatePost({ postId: post.id, action: "retry", platform: variant.platform }));
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
    return current?.kind === "retryUnknown" ? CONTENT_NETWORK_NAMES[current.network] : "";
  };

  return (
    <div class="content-queue">
      <For each={signedOut()}>
        {(account) => (
          <Alert tone="warning" role="status">
            <AlertIcon>
              <TriangleAlert />
            </AlertIcon>
            <AlertContent>
              <AlertDescription>
                {t("content.banner.signedOut", {
                  network: CONTENT_NETWORK_NAMES[account.platform],
                  handle: account.handle,
                })}
              </AlertDescription>
            </AlertContent>
            <AlertActions>
              <Button variant="outline" size="sm" onClick={() => content().openAccounts(account.platform)}>
                {t("content.banner.reconnect")}
              </Button>
            </AlertActions>
          </Alert>
        )}
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
          <For each={groups()}>
            {(group) => {
              const headingId = () => `content-section-${group.section.replace(":", "-")}`;
              const shown = () =>
                group.section === "done" && !view.showAllDone ? group.posts.slice(0, DONE_LIMIT) : group.posts;
              return (
                <section
                  class="content-section"
                  data-closed={group.section === "done" ? "" : undefined}
                  aria-labelledby={headingId()}
                >
                  <h3 id={headingId()} class="content-section-heading">
                    <span>{sectionLabel(group.section)}</span>
                    <span class="content-section-count">{group.posts.length}</span>
                  </h3>
                  <ItemGroup role="list">
                    <For each={shown()} keyed={(post) => post.id}>
                      {(post) => (
                        <ContentQueueRow
                          post={post()}
                          section={group.section}
                          time={rowTime(post(), group.section)}
                          longTime={longTime(post())}
                          content={content()}
                          agents={props.agents}
                          busy={view.busy === post().id}
                          onApprove={() => approve(post())}
                          onEdit={() => content().openComposer(post().id)}
                          onRetry={() => void retry(post())}
                          onSkip={() => void skipPost(post())}
                          onRestore={() =>
                            void restore(
                              post(),
                              post().variants.map((variant) => variant.platform),
                              false,
                            )
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
                  <Show when={group.section === "done" && group.posts.length > DONE_LIMIT}>
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
                        : t("content.queue.showAll", { count: group.posts.length })}
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
          count: view.confirm?.kind === "publishNow" ? sentNetworks(view.confirm.post).length : 0,
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
  onApprove: () => void;
  onEdit: () => void;
  onRetry: () => void;
  onSkip: () => void;
  onRestore: () => void;
  onUnschedule: () => void;
  onPublishNow: () => void;
  onDelete: () => void;
  onToggle: (variant: ContentVariantView, included: boolean) => void;
}

/** One post: time, title, the network chips and a note, the status, and the actions of its status. */
function ContentQueueRow(props: ContentQueueRowProps) {
  const { t } = useText();
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
  const failures = () =>
    props.post.variants
      .filter((variant) => variant.status === "failed")
      .map((variant) =>
        t("content.queue.failedNote", {
          network: CONTENT_NETWORK_NAMES[variant.platform],
          reason: variant.error ?? t("content.variant.failed"),
        }),
      )
      .join(" · ");
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
              <span class="content-row-error">{failures()}</span>
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
            <Button size="xs" onClick={() => props.onEdit()}>
              <Clock3 aria-hidden="true" />
              {t("content.action.pickTime")}
            </Button>
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
            <Button variant="ghost" size="xs" loading={props.busy} onClick={() => props.onRestore()}>
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

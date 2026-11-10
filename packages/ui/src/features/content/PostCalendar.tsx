import type { ContentPlatform, ContentPostView } from "@openbot/contracts/ipc-content";
import type { AppTextKey } from "@openbot/i18n";
import {
  addCalendarDays,
  addCalendarMonths,
  type CalendarDay,
  calendarDayDate,
  calendarDayOf,
  calendarDays,
  calendarHourOf,
  calendarMonthStart,
  calendarWeekStart,
} from "@openbot/team-client/routine-calendar-dates";
import {
  Alert,
  AlertActions,
  AlertContent,
  AlertDescription,
  Button,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  IconButton,
  Plus,
  Skeleton,
  SlidingTabs,
  X,
} from "@openbot/ui";
import { createMemo, createStore, For, Match, Show, Switch, untrack } from "solid-js";
import { useText } from "../../text";
import { ContentNetworkMark } from "./ContentParts";
import { postBadge } from "./content-status";

// The post calendar copies the layout and classes of `RoutineCalendar` (`routine-planner-*`). A post is
// not a routine run, so it has its own component; RoutineCalendar keeps its props.

export type PostCalendarView = "month" | "week" | "day";
/** The mark of a post: a pending post is dashed and faded, as a paused run. */
export type PostCalendarStatus = "pending" | "draft" | "queued" | "publishing" | "published" | "failed";

export interface PostCalendarProps {
  /** The posts with a time in and near the shown range. Skipped networks do not show. */
  posts: readonly ContentPostView[];
  now: Date;
  timeZone: string;
  state?: "ready" | "loading" | "error";
  initialView?: PostCalendarView;
  /** 0 is Sunday, 1 is Monday. */
  weekStartsOn?: number;
  /** The first and last day shown, after each move, so the host can load their posts. */
  onRangeChange?: (first: CalendarDay, last: CalendarDay) => void;
  onOpenPost: (postId: string) => void;
  onNewPost?: () => void;
  onRetry?: () => void;
}

interface CalendarEntry {
  post: ContentPostView;
  at: string;
  status: PostCalendarStatus;
  networks: ContentPlatform[];
  title: string;
}

const DAY_CELL_LIMIT = { week: 4, month: 3 } as const;
const UPCOMING_LIMIT = 6;

const STATUS_LABEL = {
  pending: "content.status.pending",
  draft: "content.variant.draft",
  queued: "content.variant.queued",
  publishing: "content.variant.publishing",
  published: "content.variant.published",
  failed: "content.variant.failed",
} as const satisfies Record<PostCalendarStatus, AppTextKey>;

const PREVIOUS_LABEL = {
  month: "routine.calendar.previousMonth",
  week: "routine.calendar.previousWeek",
  day: "routine.calendar.previousDay",
} as const satisfies Record<PostCalendarView, AppTextKey>;

const NEXT_LABEL = {
  month: "routine.calendar.nextMonth",
  week: "routine.calendar.nextWeek",
  day: "routine.calendar.nextDay",
} as const satisfies Record<PostCalendarView, AppTextKey>;

/** The first line of a post, which names it in the queue and the calendar. */
export function contentPostTitle(body: string): string {
  return body.trim().split("\n")[0]?.trim() ?? "";
}

function calendarStatus(post: ContentPostView): PostCalendarStatus {
  if (post.approvalState === "pending") return "pending";
  if (post.status === "skipped") return "draft";
  return post.status;
}

export function PostCalendar(props: PostCalendarProps) {
  const { t, format } = useText();
  const today = () => calendarDayOf(props.now, props.timeZone);
  // The props only seed the view: after that, the person moves it.
  const [state, setState] = createStore(
    untrack(() => ({
      view: props.initialView ?? "week",
      anchor: calendarDayOf(props.now, props.timeZone),
    })),
  );

  const daysFor = (anchor: CalendarDay, view: PostCalendarView) => {
    if (view === "day") return [anchor];
    const weekStartsOn = props.weekStartsOn ?? 1;
    if (view === "week") return calendarDays(calendarWeekStart(anchor, weekStartsOn), 7);
    const next = addCalendarMonths(anchor, 1);
    const days: CalendarDay[] = [];
    for (let week = calendarWeekStart(calendarMonthStart(anchor), weekStartsOn); week < next; ) {
      days.push(...calendarDays(week, 7));
      week = addCalendarDays(week, 7);
    }
    return days;
  };
  const visibleDays = createMemo(() => daysFor(state.anchor, state.view));

  const entries = createMemo(() =>
    props.posts
      .flatMap((post): CalendarEntry[] => {
        if (!post.scheduledFor) return [];
        const networks = post.variants.filter((item) => item.status !== "skipped").map((item) => item.platform);
        if (networks.length === 0) return [];
        const title = contentPostTitle(post.body) || t("content.queue.untitled");
        return [{ post, at: post.scheduledFor, status: calendarStatus(post), networks, title }];
      })
      .sort((left, right) => Date.parse(left.at) - Date.parse(right.at)),
  );

  const entriesByDay = createMemo(() => {
    const byDay = new Map<CalendarDay, CalendarEntry[]>();
    for (const entry of entries()) {
      const day = calendarDayOf(new Date(entry.at), props.timeZone);
      byDay.set(day, [...(byDay.get(day) ?? []), entry]);
    }
    return byDay;
  });

  const upcoming = createMemo(() =>
    entries()
      .filter(
        (entry) =>
          (entry.status === "queued" || entry.status === "pending") && Date.parse(entry.at) >= props.now.getTime(),
      )
      .slice(0, UPCOMING_LIMIT),
  );

  const outsideMonth = (day: CalendarDay) =>
    state.view === "month" && calendarMonthStart(day) !== calendarMonthStart(state.anchor);
  const dayText = (day: CalendarDay, options: Intl.DateTimeFormatOptions) =>
    format.date(calendarDayDate(day), { ...options, timeZone: "UTC" });
  const longDay = (day: CalendarDay) => dayText(day, { weekday: "long", month: "long", day: "numeric" });
  const timeText = (at: string) =>
    format.date(new Date(at), { hour: "numeric", minute: "2-digit", timeZone: props.timeZone });

  /** The status line of an entry: the failed count, else the status word. */
  const statusText = (entry: CalendarEntry) => {
    const badge = postBadge(entry.post, props.now);
    if (badge.kind === "failed") return t("content.status.failed", { count: badge.count });
    return t(STATUS_LABEL[entry.status]);
  };
  const entryNote = (entry: CalendarEntry) =>
    entry.status === "queued" ? t("content.calendar.networks", { count: entry.networks.length }) : statusText(entry);

  const rangeLabel = () => {
    const days = visibleDays();
    const first = days[0] ?? state.anchor;
    const last = days.at(-1) ?? state.anchor;
    if (state.view === "day") return longDay(first);
    if (state.view === "month") return dayText(state.anchor, { month: "long", year: "numeric" });
    return t("routine.calendar.range", {
      start: dayText(first, { month: "short", day: "numeric" }),
      end: dayText(last, { month: "short", day: "numeric", year: "numeric" }),
    });
  };

  let range: HTMLParagraphElement | undefined;
  const moveTo = (anchor: CalendarDay, view: PostCalendarView = state.view) => {
    setState((draft) => {
      draft.anchor = anchor;
      draft.view = view;
    });
    const days = daysFor(anchor, view);
    const first = days[0];
    const last = days.at(-1);
    if (first && last) props.onRangeChange?.(first, last);
  };
  /** Today disables itself, and a day leaves the week: focus goes to the range, not to the page. */
  const moveFrom = (anchor: CalendarDay, view?: PostCalendarView) => {
    moveTo(anchor, view);
    range?.focus();
  };
  const step = (direction: -1 | 1) =>
    moveTo(
      state.view === "month"
        ? addCalendarMonths(state.anchor, direction)
        : addCalendarDays(state.anchor, direction * (state.view === "week" ? 7 : 1)),
    );
  const showsToday = () =>
    state.view === "month"
      ? calendarMonthStart(state.anchor) === calendarMonthStart(today())
      : visibleDays().includes(today());

  const upcomingWhen = (at: string) => {
    const day = calendarDayOf(new Date(at), props.timeZone);
    const time = timeText(at);
    if (day === today()) return t("routine.history.today", { time });
    if (day === addCalendarDays(today(), 1)) return t("routine.calendar.tomorrowAt", { time });
    return t("routine.card.nextRunAt", {
      day: dayText(day, { weekday: "short", month: "short", day: "numeric" }),
      time,
    });
  };

  const rangeEmpty = () =>
    (props.state ?? "ready") === "ready" && visibleDays().every((day) => !entriesByDay().get(day)?.length);

  const weekdayHeads = () => (
    <Show when={state.view === "month"}>
      <div class="routine-planner-weekdays" aria-hidden="true">
        <For each={visibleDays().slice(0, 7)}>{(day) => <span>{dayText(day, { weekday: "short" })}</span>}</For>
      </div>
    </Show>
  );

  return (
    <section class="routine-planner post-calendar" aria-labelledby="post-calendar-range" data-view={state.view}>
      <header class="routine-planner-header">
        <div class="routine-planner-toolbar">
          <div class="routine-planner-nav">
            <IconButton variant="ghost" label={t(PREVIOUS_LABEL[state.view])} onClick={() => step(-1)}>
              <ChevronLeft aria-hidden="true" />
            </IconButton>
            <Button variant="outline" size="sm" disabled={showsToday()} onClick={() => moveFrom(today())}>
              {t("routine.calendar.today")}
            </Button>
            <IconButton variant="ghost" label={t(NEXT_LABEL[state.view])} onClick={() => step(1)}>
              <ChevronRight aria-hidden="true" />
            </IconButton>
            <p id="post-calendar-range" class="routine-planner-range" ref={range} tabindex={-1} aria-live="polite">
              {rangeLabel()}
            </p>
            <p class="routine-planner-note">
              {t("routine.calendar.timeZone", { zone: props.timeZone.replaceAll("_", " ") })}
            </p>
          </div>
          <SlidingTabs.Root
            value={state.view}
            onChange={(value) => moveTo(state.anchor, value === "day" || value === "month" ? value : "week")}
          >
            <SlidingTabs.List aria-label={t("routine.calendar.view")}>
              <SlidingTabs.Trigger value="day">{t("routine.calendar.viewDay")}</SlidingTabs.Trigger>
              <SlidingTabs.Trigger value="week">{t("routine.calendar.viewWeek")}</SlidingTabs.Trigger>
              <SlidingTabs.Trigger value="month">{t("routine.calendar.viewMonth")}</SlidingTabs.Trigger>
            </SlidingTabs.List>
          </SlidingTabs.Root>
        </div>
        <Show when={rangeEmpty() && state.view !== "day"}>
          <div class="post-calendar-empty">
            <p class="routine-planner-note">{t("content.calendar.empty")}</p>
            <Show when={props.onNewPost}>
              {(onNewPost) => (
                <Button variant="outline" size="sm" onClick={() => onNewPost()()}>
                  <Plus aria-hidden="true" />
                  {t("content.action.new")}
                </Button>
              )}
            </Show>
          </div>
        </Show>
      </header>

      <Switch>
        <Match when={(props.state ?? "ready") === "loading"}>
          <div class="routine-planner-body" aria-busy="true">
            <p class="sr-only" role="status">
              {t("content.calendar.loading")}
            </p>
            <div class="routine-planner-grid">
              {weekdayHeads()}
              <div class="routine-planner-week routine-planner-loading">
                <For each={visibleDays()}>
                  {(day) => (
                    <div class="routine-planner-day" data-outside={outsideMonth(day) ? "" : undefined}>
                      <Skeleton class="routine-planner-skeleton-heading" />
                      <Skeleton class="routine-planner-skeleton-run" />
                      <Skeleton class="routine-planner-skeleton-run" />
                    </div>
                  )}
                </For>
              </div>
            </div>
          </div>
        </Match>
        <Match when={props.state === "error"}>
          <Alert tone="danger" class="routine-planner-error">
            <AlertContent>
              <AlertDescription>{t("content.calendar.loadFailed")}</AlertDescription>
            </AlertContent>
            <Show when={props.onRetry}>
              <AlertActions>
                <Button variant="outline" size="sm" onClick={() => props.onRetry?.()}>
                  {t("common.retry")}
                </Button>
              </AlertActions>
            </Show>
          </Alert>
        </Match>
        <Match when={true}>
          <div class="routine-planner-body">
            <Show
              when={state.view !== "day"}
              fallback={
                <PostCalendarDay
                  entries={entriesByDay().get(state.anchor) ?? []}
                  timeZone={props.timeZone}
                  timeText={timeText}
                  note={entryNote}
                  statusText={statusText}
                  onOpenPost={props.onOpenPost}
                />
              }
            >
              <div class="routine-planner-grid">
                {weekdayHeads()}
                <ol class="routine-planner-week">
                  <For each={visibleDays()}>
                    {(day) => {
                      const dayEntries = () => entriesByDay().get(day) ?? [];
                      const limit = () => (state.view === "month" ? DAY_CELL_LIMIT.month : DAY_CELL_LIMIT.week);
                      const hidden = () => Math.max(0, dayEntries().length - limit());
                      return (
                        <li
                          class="routine-planner-day"
                          aria-current={day === today() ? "date" : undefined}
                          data-past={day < today() ? "" : undefined}
                          data-outside={outsideMonth(day) ? "" : undefined}
                        >
                          <h3 class="routine-planner-day-heading">
                            <Button
                              variant="ghost"
                              size="xs"
                              class="routine-planner-day-button"
                              aria-label={t("routine.calendar.openDay", { day: longDay(day) })}
                              onClick={() => moveFrom(day, "day")}
                            >
                              <span>{dayText(day, { weekday: "short" })}</span>
                              <strong>{dayText(day, { day: "numeric" })}</strong>
                            </Button>
                          </h3>
                          <Show when={dayEntries().length > 0}>
                            <ul class="routine-planner-runs">
                              <For each={dayEntries().slice(0, limit())}>
                                {(entry) => (
                                  <li>
                                    <Button
                                      variant="ghost"
                                      class="routine-planner-run"
                                      data-status={entry.status}
                                      aria-label={t("content.calendar.entry", {
                                        title: entry.title,
                                        time: timeText(entry.at),
                                        status: statusText(entry),
                                      })}
                                      onClick={() => props.onOpenPost(entry.post.id)}
                                    >
                                      <PostCalendarStatusMark status={entry.status} />
                                      <span class="routine-planner-run-time">{timeText(entry.at)}</span>
                                      <span class="routine-planner-run-name">{entry.title}</span>
                                      <span class="routine-planner-avatars post-calendar-marks" aria-hidden="true">
                                        <For each={entry.networks}>
                                          {(platform) => <ContentNetworkMark platform={platform} />}
                                        </For>
                                      </span>
                                    </Button>
                                  </li>
                                )}
                              </For>
                            </ul>
                          </Show>
                          <Show when={hidden() > 0}>
                            <Button
                              variant="ghost"
                              size="xs"
                              class="routine-planner-more"
                              aria-label={longDay(day)}
                              onClick={() => moveFrom(day, "day")}
                            >
                              {t("routine.calendar.more", { count: hidden() })}
                            </Button>
                          </Show>
                        </li>
                      );
                    }}
                  </For>
                </ol>
              </div>
            </Show>

            <aside class="routine-planner-upcoming" aria-labelledby="post-calendar-upcoming-heading">
              <h3 id="post-calendar-upcoming-heading">{t("content.calendar.upcoming")}</h3>
              <Show
                when={upcoming().length > 0}
                fallback={<p class="routine-planner-note">{t("content.calendar.upcomingEmpty")}</p>}
              >
                <ul class="routine-planner-entries">
                  <For each={upcoming()}>
                    {(entry) => (
                      <PostCalendarEntry
                        entry={entry}
                        meta={t("content.calendar.entryMeta", { when: upcomingWhen(entry.at), note: entryNote(entry) })}
                        onOpenPost={props.onOpenPost}
                      />
                    )}
                  </For>
                </ul>
              </Show>
            </aside>
          </div>
        </Match>
      </Switch>
    </section>
  );
}

/** One day, in hours. */
function PostCalendarDay(props: {
  entries: CalendarEntry[];
  timeZone: string;
  timeText: (at: string) => string;
  note: (entry: CalendarEntry) => string;
  statusText: (entry: CalendarEntry) => string;
  onOpenPost: (postId: string) => void;
}) {
  const { t, format } = useText();
  const hours = createMemo(() => {
    const byHour = new Map<number, CalendarEntry[]>();
    for (const entry of props.entries) {
      const hour = calendarHourOf(new Date(entry.at), props.timeZone);
      byHour.set(hour, [...(byHour.get(hour) ?? []), entry]);
    }
    return [...byHour.values()];
  });
  return (
    <div class="routine-planner-day-view">
      <Show when={hours().length > 0} fallback={<p class="routine-planner-note">{t("content.calendar.dayEmpty")}</p>}>
        <For each={hours()}>
          {(group) => (
            <section class="routine-planner-hour">
              <h3>{format.date(new Date(group[0]?.at ?? 0), { hour: "numeric", timeZone: props.timeZone })}</h3>
              <ul class="routine-planner-entries">
                <For each={group}>
                  {(entry) => (
                    <PostCalendarEntry
                      entry={entry}
                      meta={t("content.calendar.entryMeta", {
                        when: props.timeText(entry.at),
                        note: props.note(entry),
                      })}
                      onOpenPost={props.onOpenPost}
                    />
                  )}
                </For>
              </ul>
            </section>
          )}
        </For>
      </Show>
    </div>
  );
}

function PostCalendarEntry(props: { entry: CalendarEntry; meta: string; onOpenPost: (postId: string) => void }) {
  return (
    <li class="routine-planner-entry" data-status={props.entry.status}>
      <Button variant="ghost" class="routine-planner-entry-main" onClick={() => props.onOpenPost(props.entry.post.id)}>
        <PostCalendarStatusMark status={props.entry.status} />
        <span class="routine-planner-entry-text">
          <span class="routine-planner-entry-name">{props.entry.title}</span>
          <span class="routine-planner-entry-meta">{props.meta}</span>
        </span>
      </Button>
    </li>
  );
}

/** The look of the routine calendar status mark: a dot before, a glyph after. Never colour alone. */
function PostCalendarStatusMark(props: { status: PostCalendarStatus }) {
  return (
    <span class="routine-planner-status" data-status={props.status} aria-hidden="true">
      <Switch fallback={<span class="routine-planner-status-dot" />}>
        <Match when={props.status === "publishing"}>
          <Clock3 />
        </Match>
        <Match when={props.status === "failed"}>
          <X />
        </Match>
        <Match when={props.status === "published"}>
          <Check />
        </Match>
      </Switch>
    </span>
  );
}

import { LOCAL_SERVER_ID } from "@openbot/contracts/ipc";
import type { ContentPostView } from "@openbot/contracts/ipc-content";
import { Alert, AlertContent, AlertDescription, Button, Plus, SlidingTabs } from "@openbot/ui";
import { PostCalendar } from "@openbot/ui/features/content/PostCalendar";
import type { RoutineCalendarAgent } from "@openbot/ui/features/conversation/RoutineCalendar";
import { useText } from "@openbot/ui/text";
import { createEffect, createStore, Match, Show, Switch } from "solid-js";
import { useAgents } from "../agents/agents-context";
import { ContentAccountsDialog } from "./ContentAccountsDialog";
import { ContentComposer } from "./ContentComposer";
import { ContentQueue } from "./ContentQueue";
import { type ContentState, useContent } from "./content-context";

const DAY = 86_400_000;

interface ContentPanelProps {
  serverId: string;
  hostName: string;
}

/** The Content page in the window: the posts of this computer. A joined server shows a notice. */
export function ContentPanel(props: ContentPanelProps) {
  const content = useContent();
  const { agentList } = useAgents();
  return (
    <ContentView
      content={content}
      agents={agentList()}
      hostName={props.hostName}
      local={props.serverId === LOCAL_SERVER_ID}
    />
  );
}

export interface ContentViewProps {
  content: ContentState;
  agents: readonly RoutineCalendarAgent[];
  hostName: string;
  /** False on a joined server: the page shows the local-only notice and makes no content call. */
  local: boolean;
}

/** The Content page: the title, the Queue and Calendar views, the composer and the Accounts dialog. */
export function ContentView(props: ContentViewProps) {
  const { t } = useText();
  const content = () => props.content;
  const composerPost = (): ContentPostView | null => {
    const id = content().state.composer?.postId;
    return id ? (content().state.posts.find((post) => post.id === id) ?? null) : null;
  };
  return (
    <section class="content-page" aria-labelledby="content-page-heading">
      <header class="content-page-title">
        <h2 id="content-page-heading">
          {t("content.title")} <span aria-hidden="true">/</span> <span>{props.hostName}</span>
        </h2>
      </header>
      <div class="content-page-body">
        <Show
          when={props.local}
          fallback={
            <div class="content-queue">
              <Alert tone="neutral" role="status">
                <AlertContent>
                  <AlertDescription>{t("content.page.localOnly")}</AlertDescription>
                </AlertContent>
              </Alert>
            </div>
          }
        >
          <Show
            when={content().state.composer}
            fallback={
              <>
                <header class="content-header">
                  <SlidingTabs.Root
                    value={content().state.pane}
                    onChange={(value) => content().setPane(value === "calendar" ? "calendar" : "queue")}
                  >
                    <SlidingTabs.List aria-label={t("content.view.label")}>
                      <SlidingTabs.Trigger value="queue">{t("content.view.queue")}</SlidingTabs.Trigger>
                      <SlidingTabs.Trigger value="calendar">{t("content.view.calendar")}</SlidingTabs.Trigger>
                    </SlidingTabs.List>
                  </SlidingTabs.Root>
                  <div class="content-actions">
                    <Button variant="outline" size="sm" onClick={() => content().openAccounts()}>
                      {t("content.action.accounts")}
                    </Button>
                    <Button size="sm" onClick={() => content().openComposer(null)}>
                      <Plus aria-hidden="true" />
                      {t("content.action.new")}
                    </Button>
                  </div>
                </header>
                <Switch>
                  <Match when={content().state.pane === "queue"}>
                    <ContentQueue content={content()} agents={props.agents} />
                  </Match>
                  <Match when={content().state.pane === "calendar"}>
                    <ContentCalendar content={content()} />
                  </Match>
                </Switch>
              </>
            }
          >
            {/* Keyed by the post, so a new target starts a new form. */}
            <Show when={content().state.composer?.postId ?? "new"} keyed>
              <ContentComposer
                content={content()}
                post={composerPost()}
                agents={props.agents}
                onClose={() => content().closeComposer()}
              />
            </Show>
          </Show>
          <ContentAccountsDialog content={content()} />
        </Show>
      </div>
    </section>
  );
}

/** The calendar range in instants: one day more on each side, for the zones far from UTC. */
function rangeAround(first: string, last: string) {
  return {
    from: new Date(Date.parse(first) - DAY).toISOString(),
    to: new Date(Date.parse(last) + 2 * DAY).toISOString(),
  };
}

/** The posts with a time, read through `content:calendar` for the days on screen. */
function ContentCalendar(props: { content: ContentState }) {
  const [state, setState] = createStore<{ phase: "loading" | "ready" | "error"; posts: ContentPostView[] }>({
    phase: "loading",
    posts: [],
  });
  let range = rangeAround(new Date(Date.now() - 7 * DAY).toISOString(), new Date(Date.now() + 7 * DAY).toISOString());
  let generation = 0;

  async function load(background = false) {
    const request = ++generation;
    if (!background)
      setState((draft) => {
        draft.phase = "loading";
      });
    try {
      const calendar = await props.content.port().content.calendar({ ...range });
      if (request !== generation) return;
      setState((draft) => {
        draft.posts = calendar.posts;
        draft.phase = "ready";
      });
    } catch {
      if (request !== generation || (background && state.phase === "ready")) return;
      setState((draft) => {
        draft.phase = "error";
      });
    }
  }

  // The queue reloads on each `content:changed`; the calendar follows its posts and keeps its days on screen.
  createEffect(
    () => props.content.state.posts,
    () => {
      void load(state.phase === "ready");
    },
  );

  return (
    <div class="content-calendar">
      <PostCalendar
        posts={state.posts}
        now={props.content.now()}
        timeZone={props.content.timeZone}
        state={state.phase}
        onRangeChange={(first, last) => {
          range = rangeAround(first, last);
          void load();
        }}
        onOpenPost={(postId) => {
          const post = state.posts.find((candidate) => candidate.id === postId);
          if (post && !props.content.state.posts.some((candidate) => candidate.id === postId))
            props.content.remember(post);
          props.content.openComposer(postId);
        }}
        onNewPost={() => props.content.openComposer(null)}
        onRetry={() => void load()}
      />
    </div>
  );
}

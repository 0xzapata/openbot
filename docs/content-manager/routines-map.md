# How routines work, and the seams a sibling feature must use

A map of the existing routines feature: scheduled standing instructions on an agent, and on a
channel. Read this before you design the content manager. The content manager is a sibling domain:
it shares the scheduler shape, the projection-table shape, the IPC shape and the calendar shape, and
it must not share their owners.

Facts in this document come from the files named. Version at the time of writing: `0.65.0`,
upstream `main` at `3f2a9ef09`.

## 1. The short model

1. A **routine** is a name, an instruction, an `active` flag, a time zone, and one trigger.
2. A trigger is either a **schedule** (`once`, `hourly`, `daily`, `weekly`, `monthly`, `yearly`,
   `custom` cron, or an interval) or a **webhook** route.
3. One timer in the process finds due triggers. For each due trigger it makes one **run** row.
4. A run becomes a **mailbox delivery** to the agent. The agent runs a normal turn with the routine
   instruction. The run status follows the turn: `queued`, `running`, `succeeded`, `failed`,
   `interrupted`, `cancelled`, `needs-attention`.
5. The UI reads a calendar of routines and their runs, plus the run history of one routine.

Two owners exist today: an agent and a channel. `RoutineStore` writes the SQL for both. The owner is
three table names, one owner column and one handle column.

## 2. Contracts

| File | Owns |
| --- | --- |
| `packages/contracts/src/ipc-routines.ts` | `RoutineSchedule`, `RoutineTrigger`, `Routine`, `RoutineRun`, input types, `RoutineCalendar*` types, and the `is*` decoders. Released-schedule helpers: `isReleasedRoutineSchedule`, `ReleasedRoutineSchedule`. |
| `packages/contracts/src/ipc-channel-routines.ts` | `ChannelRoutine`, `ChannelRoutineRun`, and the channel run status list. |
| `packages/contracts/src/ipc-routine-results.ts` | Result records that a routine run can write. |
| `packages/contracts/src/ipc-routine-flows.ts` | Handoff links from one agent routine to the next. |
| `packages/contracts/src/ipc-endpoints.ts` | Groups `agentRoutines` (wire prefix `agent:`), `channelRoutines`, `routineResults`, `routineFlows`, `routineFeed`. Group paths for `window.openbot` are in `IPC_GROUP_PATHS` in the same file (`agentRoutines: "agent"`). |
| `packages/contracts/src/ipc-desktop-apis.ts` | `GroupApi<IpcEndpoints["agentRoutines"]>` and friends. Bridged groups need no per-method line. |
| `packages/contracts/src/ipc-agent-events.ts` | Events `routines-changed` (`agentId`) and `channel-routines-changed` (`channelId`). |
| `packages/contracts/src/input-limits.ts` | `agentRoutines: 64`, `routineName: 80`, `routineInstruction: 100_000`, `routineRunsPage: 100`, calendar range limits. |
| `packages/contracts/src/team-protocol/routine-*.ts` | Released wire additions: `routine-recovery-v1`, `routine-results-v1`, `routine-run-place-v1`, `routine-flows-v1`. Each exports its capability constant. |
| `packages/i18n/src/messages/en/routine.ts` | Every user-visible string of the feature, 361 lines. Other locales mirror the keys. |

Endpoints of the `agentRoutines` group:

```
agent:list-routines          scoped, agentId -> Routine[]
agent:create-routine         scoped, CreateRoutineInput -> Routine
agent:update-routine         scoped, UpdateRoutineInput -> Routine
agent:delete-routine         scoped, DeleteRoutineInput -> void
agent:test-routine           scoped, TestRoutineInput -> RoutineRun
agent:list-routine-runs      scoped, ListRoutineRunsInput -> RoutineRun[]
agent:automation-run-command scoped, TestRoutineInput -> string (local only)
agent:routine-calendar       scoped, RoutineCalendarInput -> RoutineCalendar
```

## 3. Schedule math

`packages/team-client/src/routine-schedule.ts` is the only place that computes occurrences:
`normalizeRoutineSchedule`, `nextRoutineOccurrence`, `nextValidRoutineOccurrence`,
`validateRoutineSchedule`, `validateStoredRoutineSchedule`, `routineOnceInstant`.

`routine-schedule-draft.ts` converts between the editor draft and the stored schedule.
`routine-calendar.ts` (`buildRoutineCalendar`) builds the calendar. `routine-calendar-dates.ts` has
the day arithmetic that desktop and mobile both use. All are package exports of
`@openbot/team-client`.

The calendar input is an instant range. `SchedulePanel` adds one day at each end to cover the
viewer's time zone (`rangeAround` in `src/renderer/src/features/schedule/SchedulePanel.tsx`).

## 4. Storage

### Tables

`src/backend/openbot-database-schema.ts` holds both build paths: `LATEST_SCHEMA_SQL` (line 584) for a
new database, and `MIGRATIONS` (line 696) for an existing one. The file had 51 migrations, from
version 9 to version 59. Each change must touch both, plus `openbot-database-schema-history.json`.

Agent tables (LATEST_SCHEMA_SQL, lines 150 to 197):

```sql
projection_agent_routines(routine_id PK, agent_id, name, instruction, active, timezone,
                          limit_policy, missed_policy, created_at, updated_at, last_event_sequence)
projection_routine_triggers(trigger_id PK, routine_id FK CASCADE, schedule_json, next_run_at,
                            created_at, updated_at, last_event_sequence, UNIQUE(routine_id))
projection_routine_runs(run_id PK, routine_id FK CASCADE, agent_id, trigger_id, run_kind,
                        scheduled_for, routine_name, instruction, delivery_id, status, error,
                        created_at, updated_at, last_event_sequence,
                        UNIQUE(trigger_id, scheduled_for))
projection_routine_webhooks(routine_id PK, route_id UNIQUE, event_type, filters_json,
                            secret_ciphertext, url, ...)
```

Channel twins are `projection_channel_routines`, `projection_channel_routine_triggers`,
`projection_channel_routine_runs` (handle column `request_message_id`), and
`projection_channel_routine_webhooks`.

Indexes that the scheduler depends on: `routine_triggers_due(next_run_at, routine_id)`,
`routine_runs_routine`, `routine_runs_delivery` (unique partial), and the channel equivalents.

### Writes

`src/backend/routine-store.ts` (1349 lines) owns all routine SQL for both owners. A write is one
`database.dispatch(commandId, events, project)` call: the events go to the event log, and `project`
runs in the same transaction as the projection update. Command ids include the routine id and a
UUID. Aggregate types are `agent-routine` / `routine-run`, and the channel twins. `agent-roster.ts`
purges a deleted agent's events by those aggregate names, so a third owner must use new names.

`src/backend/routine-tables.ts` holds `ROUTINE_TABLES`: the per-owner table names, columns,
aggregate names, command and event prefixes, and limits.

`agent-routine-store.ts` and `channel-routine-store.ts` are thin name adapters over `RoutineStore`.
`src/backend/routine-store.ts` also handles webhook receipts, missed-run collapse, and trigger
advance.

`src/backend/routine-records.ts` is the owner-neutral surface for the events API. It picks the agent
or channel scheduler and owns `WebhookRouteStore`.

## 5. Scheduling and delivery

`src/backend/routine-timer.ts` owns the **one** `setTimeout` of the process. It is constructed with a
list of `RoutineDueSource` objects (`nextDueAt`, `processDue`), so two schedulers cannot fight for
the wake time. It clamps the delay to `MAX_DELAY` (2_147_000_000 ms), and it has `suspend`,
`resume`, `hold` and `release` for sleep and for restart.

`src/backend/agent/routine-scheduler.ts` (1372 lines) owns one agent's routines:

- `create`, `update`, `delete`, `test`, `saveRecord`, `listRuns`.
- `processDue`: re-reads each due routine, skips a stale entry, collapses missed occurrences
  (`collapseMissedOccurrences`), then calls `createRun`.
- `enqueueRun`: makes a mailbox delivery with `sender.kind = "routine"`, attaches the delivery id to
  the run, wakes a wait, and updates the agent preview.
- `reconcileDelivery`, `markRunningForTurn`, `markNeedsAttention`, `resumePendingRuns` follow the
  turn lifecycle.
- `handleTool` is the agent tool surface.

`src/backend/channel-routine-scheduler.ts` does the channel equivalent and writes a message into the
channel instead of a mailbox delivery.

Wiring is in `src/backend/agent-service.ts`: `new RoutineTimer(() => [routines, channelRoutines,
...extraRoutineSources()], ...)` around line 721, and `new RoutineScheduler(...)` around line 738.
`src/main/application-services.ts:2082` passes workflow triggers as an extra source. This is the
documented seam for a third due source.

`routine-hold-file.ts` and `routine-wake.ts` keep a restart-safe hold. `boot-recovery.ts` resumes
pending runs at start. `agent/routine-quiet-runs.ts` handles the no-update answer.

Agent tools: `agent/routine-tools.ts`, `routine-tool-schema.ts`, `agent/webhook-routine-tool.ts`,
`routine-flows/routine-flow-tools.ts`.

## 6. Main process (IPC and Team API)

| File | Owns |
| --- | --- |
| `src/main/ipc/routine-handlers.ts` | The `agentRoutines` group. `scopedHandler(parseX, { local, remote })` for each endpoint, so one handler serves this computer and a joined server. |
| `src/main/ipc/channel-routine-handlers.ts` | The `channelRoutines` group. |
| `src/main/ipc/routine-result-handlers.ts`, `routine-flow-handlers.ts`, `routine-feed-handlers.ts` | The sibling groups. |
| `src/main/ipc/agent-inputs.ts` | Payload parsers: `parseCreateRoutine`, `parseUpdateRoutine`, `parseRoutineCalendar`, and the others. |
| `src/main/index.ts` | `registerIpcHandlers` supplies dependencies and passes every group object to `registerIpcGroups`. A missing group is a `TS2741`. |
| `src/main/local-routine-calendar.ts` | The local `RoutineCalendarSource`. |
| `src/main/remote-agent-decoding.ts` | Decoders for remote routine payloads. |
| `src/main/routine-feed-server.ts`, `routine-feed-ics.ts` | The iCalendar feed. |
| `src/main/team-api/route-agent-routines.ts` | Team API routes `GET/POST /agents/:id/routines`, `PATCH/DELETE /agents/:id/routines/:rid`, `POST .../test`, `GET .../runs`. Bodies use the same parsers as IPC. |
| `src/main/team-api/route-routine-results.ts`, `route-routine-flows.ts`, `route-routine-run-place.ts` | Capability-gated additions. |

Remote routing notes: a released schedule must pass `isReleasedRoutineSchedule`, so a `once` routine
stays on this computer. Run places go on their own capability-gated route after the save, because the
released routine routes do not carry them.

## 7. Preload

`src/preload/index.ts:1307` builds the group with `bridgeGroup(IPC_ENDPOINTS.agentRoutines, { ... })`.
Decoders live in `src/preload/remote-agent-decoding.ts`-style modules: `agent-decoding.ts`,
`routine-result-decoding.ts`, `routine-flow-decoding.ts`. A bridged group needs one decoder per
endpoint; `tsc` names a missing one.

## 8. Renderer

- `src/renderer/src/features/conversation/routines-port.ts` is the bridge for the settings panel and
  the chat cards. It also subscribes to `routines-changed`.
- `src/renderer/src/features/conversation/AgentRoutinesSettings.tsx` (1293 lines) is the editor:
  list, draft, schedule draft, webhook draft, run history.
- `src/renderer/src/features/conversation/RoutineChatCard.tsx`, `routine-summary.ts`,
  `routine-run-timeline.ts` render a run in the chat.
- `src/renderer/src/features/schedule/SchedulePanel.tsx` (224 lines) is the calendar page.
  `schedule-port.ts` defines `ScheduleSource` (`calendar`, `onStale`) and `changesSchedule`.
  `routine-timezone-prompt.ts` asks to move routines after a time-zone change.
- `packages/ui/src/features/conversation/RoutineCalendar.tsx` is the shared calendar component.
- Page wiring: `HostPaneView` in `src/renderer/src/features/usage/usage-context.tsx`,
  `window-page-context.tsx`, `WindowPageView.tsx` (`<Match when={usage.state.view === "schedule"}>`),
  `WorkspacePageRail.tsx` (`onSchedule`), `lazy-views.ts:73`
  (`ScheduleView`), and `global-search-sources.ts:144` (the command palette entry).
- Web client: `src/renderer/src/features/web-client/web-schedule.ts`, and the `HostPageView` switch in
  `WebWorkspace.tsx`.
- Preview: `src/renderer/src/preview/mock-openbot.ts`, `mock-routine-feed.ts`,
  `mock-routine-calendar.ts`, `mock-routine-results.ts`, `mock-routine-flows.ts`, and
  `src/renderer/stories/RoutineCalendar.stories.tsx`.

## 9. Mobile

Routes: `apps/mobile/src/app/(app)/server-routines/index.tsx` (re-export),
`agent-routine.tsx`, `channel-routine.tsx`, and `agent-info/[agentId]/routines.tsx`.

Screens and components: `apps/mobile/src/features/servers/screens/server-routines-screen.tsx` (490
lines, the calendar), `features/agents/components/agent-routines.tsx`, `routine-schedule-fields.tsx`,
`routine-trigger-picker.tsx`, `routine-webhook-trigger.tsx`, `routine-result-destination.tsx`,
`routine-active-switch.tsx`, and `features/servers/components/day-strip.tsx`.

The mobile app calls the same IPC surface over the Team API. It has no local database.

## 10. Checks and tests

- Migration tests: `src/backend/routine-*-migration.test.ts` (results, run columns, run place),
  plus `openbot-database-schema-parity.test.ts`.
- E2E scripts: `scripts/routine-cron-syntax-e2e.ts`, `routine-dst-order`, `routine-due-revalidation`,
  `routine-flow-sweep`, `routine-fresh-session`, `routine-overnight-window`, `routine-pause-resume`,
  `routine-recovery`, `routine-report-failure`, `routine-run-place`, `routine-timezone-move`,
  `agent-webhook-routine-e2e.ts`.

## 11. Seams a sibling domain must use

| Concern | Exact seam | Copy from |
| --- | --- | --- |
| Types and decoders | New file under `packages/contracts/src/` and an `export *` in `ipc.ts` | `ipc-routines.ts` |
| IPC endpoints | New group in `packages/contracts/src/ipc-endpoints.ts`, plus `IPC_GROUP_PATHS` | `agentRoutines` |
| Renderer signature | Nothing, when the preload bridges the group | `ipc-desktop-apis.ts` |
| Main handlers | New `src/main/ipc/<domain>-handlers.ts` returning `*IpcHandlers`; spread it in `registerIpcHandlers` | `routine-handlers.ts` |
| Payload parsers | New `*-inputs.ts` beside the handlers, or extend one | `agent-inputs.ts` |
| Preload | One `bridgeGroup` entry with a decoder per endpoint | `src/preload/index.ts:1307` |
| Preview | Methods in `mock-openbot.ts` or a `mock-*.ts` module. A typed mock must satisfy `OpenBotDesktopApi` | `mock-routine-calendar.ts` |
| Tables | New `projection_*` tables in `LATEST_SCHEMA_SQL`, one new migration at version 60, one new entry in `openbot-database-schema-history.json` | routine tables |
| Writes | `database.dispatch(commandId, events, project)` with a new aggregate type | `routine-store.ts` |
| Due work | Implement `RoutineDueSource` (`nextDueAt`, `processDue`) and pass it through `extraRoutineSources` | `channel-routine-scheduler.ts` |
| Timer | None. Never add a second `setTimeout`. | `routine-timer.ts` |
| Change event | New event in `ipc-agent-events.ts` when an agent owns it, or a new event endpoint for a host-level domain | `routines-changed` |
| Page | Add a `HostPaneView`, a `WindowPageView` match, a rail button, a `lazy-views.ts` entry, and a palette entry | schedule page |
| Shared UI | A feature component under `packages/ui/src/features/<domain>/` | `RoutineCalendar.tsx` |
| Text | New `packages/i18n/src/messages/en/<domain>.ts`, registered in the locale index of every language | `routine.ts` |
| E2E | A `scripts/<domain>-*-e2e.ts` that writes a report under `.openbot-build/` | `routine-*-e2e.ts` |
| Remote access | Teams API route file per domain, a capability constant, and a protocol adapter. Released adapters are permanent. | `route-agent-routines.ts` |

## 12. Constraints that the design must obey

- A migration is irreversible. There is no backup of `openbot.db`.
- `LATEST_SCHEMA_SQL` and the migration list must agree. The parity test enforces it.
- One timer per process.
- Every write is a command and an event in one transaction.
- The renderer never gets a token or a secret. Main decrypts with `SecretStorageCipher`.
- The IPC sender check runs before decoding; handlers use `handleTrusted*` through
  `define-ipc-group.ts`.
- A new Team API capability is additive and optional. A required field or a changed meaning needs a
  new protocol version.
- User text comes from `@openbot/i18n`. Errors from main use `sourceText(key)`.

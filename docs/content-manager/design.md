# Content manager: design

Status: steps 1 to 3 are built (agent tool; X and LinkedIn publisher; IPC and the Content page). Step 4
(Instagram, Threads, Facebook Pages and YouTube) is on branch `feat/content-manager-meta`.

## 0. Settled decisions

The user made these decisions. They replace the older text in sections 3 to 17 when the two
disagree. Do not open them again.

| # | Decision | Where it applies |
| --- | --- | --- |
| 1 | Six networks: X, LinkedIn personal profile, Instagram, Threads, Facebook Pages, YouTube. Build order: agent tool, X and LinkedIn, UI, then Meta and YouTube. | All steps |
| 2 | Users and agents write posts. An agent's post is `pending` until the user approves it. | `content_create_post` |
| 3 | Three tables: `content_accounts`, `content_posts`, `content_variants`. No deliveries table: one shared time makes a delivery one variant. | Migration 60 |
| 4 | One shared scheduled time for all networks of a post. Approve once, skip per network. | Store, UI |
| 5 | One image per post (a video for YouTube), copied to all networks and replaceable for each network. | Store, composer |
| 6 | The post status is derived by `contentPostStatus`, never stored. Statuses: `draft`, `queued`, `publishing`, `published`, `failed`, `skipped`. | Contracts |
| 7 | Manual retry only. No automatic backoff, no retry ladder. | Publisher |
| 8 | Ten IPC endpoints. | Step 3 |
| A | `update-post` can move a queued post back to `draft` (unschedule) and can undo a skip for one network. There is no eleventh endpoint. | Store, step 3 |
| B | When the user disconnects a network, its variants stay `queued`. At publish time they fail with "Sign in to {network} again." No automatic skip and no move to draft. | Publisher |
| C | Deleting an agent keeps its posts, its variants and their events. A published variant keeps its external post id for audit. | Agent deletion |
| D | A network with no adapter in a version is skipped at approve, schedule and publish now, so a post never waits for it. Instagram counts as having no adapter until an image host is saved. | Store, step 3 and 4 |
| E | `update-post` has an `unapprove` action: the Undo of Approve. | Store, step 3 |
| F | Instagram and Threads images go through the user's own Cloudflare R2 bucket (default `dev-assets-bucket`, public address `pub-451ea606e71242028630e5aadc8cd8aa.r2.dev`; both are settings). Upload only while that one post publishes; delete after success and failure; delete leftovers at the next start; delete only keys `t/<32 hex>.<ext>` that this code made, one at a time. The user's words: "only for images i choose to post, never automatically". | Publisher, PRIVACY.md |
| G | The image host settings travel on `content:begin-connect` as an optional `mediaHost`, are checked by a probe (upload, public read, delete) before they are saved, and are shown back only as `configured`, endpoint, bucket, public address and `hasKeys`. | Step 4 |
| H | Facebook connects only when the user manages exactly one Page in v1. A Page picker comes after v1. | Step 4 |
| I | A post that a network accepted but has not made live yet (YouTube processing, a Meta container in progress) is `publishing` with `pendingReason: "processing"` in the view. | Contracts, step 4 |

Sections 5 and 6 still describe `content_deliveries`, `needs-attention` and a backoff ladder. Decisions
3, 6 and 7 replace that text: a variant is the delivery, an unknown result is `failed` with the code
`unknown-result`, and the user retries.

## 1. Summary

Add a native content manager to OpenBot. It manages social posts beside the routines feature:
connected accounts, a composer, a queue and calendar, per-platform variants, and delivery status.

Routines schedule **agent work**. The content manager schedules **content**. They share the shape,
not the owners.

v1 ships one platform (X) and one computer. The data model and the seams leave room for more
platforms and for a joined server. Do not add those in v1.

## 2. Goals

- Connect one or more X accounts. Keep the tokens in the existing secret store, never in the repo or
  the renderer.
- Write a post in a composer. Edit it before it is sent.
- Publish immediately, or schedule it at a local time.
- Show a queue and a calendar of posts and their outcomes.
- Keep one delivery record for each account and each scheduled time.
- Recover from a restart without a lost post and without a double post.
- Use the routines seams: one process timer, projection tables, commands plus events, IPC groups,
  i18n keys, shared calendar component.

## 3. Non-goals for v1

- Platforms other than X. The table has a `platform` column, and an adapter interface, but only one
  adapter ships.
- Media attachments, threads, replies, quotes, polls. Text only.
- Recurring or evergreen posts. One scheduled time for one post.
- Analytics, link tracking, UTM management.
- Comments, mentions, and any inbox.
- Multi-user approval. This is a single-user product on one computer.
- Joined servers, the Team API, and the mobile app. v1 is this computer only.
- Agent tools that create posts. Planned for v1.1, see section 10.
- Draft autosave outside the database.

## 4. Product model

| Term | Meaning |
| --- | --- |
| Account | One connected social account: platform, external id, handle, encrypted tokens, status. |
| Post | The author's content item. It has a body, an optional title, an approval state, and a plan. |
| Variant | The body for one account. v1 has one variant per account. It is the seam for per-platform text. |
| Delivery | One attempt to publish one variant at one time. It has its own status and result. |
| Queue | Deliveries in `queued` or `publishing`. |
| Calendar | Posts by scheduled time, with the state of each delivery. |

The post has no stored publish status. The UI derives it from its deliveries:

| Deliveries | Shown as |
| --- | --- |
| none | Draft |
| all `queued`, time in the future | Scheduled |
| any `publishing` | Publishing |
| all `published` | Published |
| all `cancelled` | Draft |
| any `failed` or `needs-attention`, none `queued` or `publishing` | Needs attention |
| some `published`, the rest terminal failure | Partly published |

Put this derivation in `packages/contracts/src/ipc-content.ts` as one pure function, so desktop and
mobile agree when mobile arrives later.

## 5. Data model

New tables. Follow the routine table rules: text ids, ISO text timestamps, `last_event_sequence`,
`CHECK` constraints, and a cascade from the owner.

```sql
CREATE TABLE IF NOT EXISTS content_accounts (
  account_id TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK(platform IN ('x')),
  external_account_id TEXT NOT NULL,
  handle TEXT NOT NULL,
  display_name TEXT,
  token_ciphertext TEXT NOT NULL,
  refresh_ciphertext TEXT,
  scopes TEXT NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('connected', 'expired', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_event_sequence INTEGER NOT NULL,
  UNIQUE(platform, external_account_id)
);

CREATE TABLE IF NOT EXISTS content_posts (
  post_id TEXT PRIMARY KEY,
  title TEXT,
  body TEXT NOT NULL,
  approval_state TEXT NOT NULL DEFAULT 'none'
    CHECK(approval_state IN ('none', 'pending', 'approved')),
  scheduled_for TEXT,
  timezone TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_event_sequence INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS content_posts_schedule ON content_posts(scheduled_for, post_id);

CREATE TABLE IF NOT EXISTS content_variants (
  variant_id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES content_posts(post_id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES content_accounts(account_id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK(platform IN ('x')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_event_sequence INTEGER NOT NULL,
  UNIQUE(post_id, account_id)
);

CREATE TABLE IF NOT EXISTS content_deliveries (
  delivery_id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES content_posts(post_id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL REFERENCES content_variants(variant_id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES content_accounts(account_id) ON DELETE CASCADE,
  scheduled_for TEXT NOT NULL,
  next_attempt_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'queued', 'publishing', 'needs-attention', 'published', 'failed', 'cancelled'
  )),
  attempt INTEGER NOT NULL DEFAULT 0,
  external_post_id TEXT,
  error TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_event_sequence INTEGER NOT NULL,
  UNIQUE(variant_id, scheduled_for)
);
CREATE INDEX IF NOT EXISTS content_deliveries_due
  ON content_deliveries(status, next_attempt_at, delivery_id);
CREATE INDEX IF NOT EXISTS content_deliveries_post
  ON content_deliveries(post_id, created_at DESC, delivery_id);
```

`UNIQUE(variant_id, scheduled_for)` is the routine `UNIQUE(trigger_id, scheduled_for)` seam: one
variant cannot have two deliveries at the same time. The publish command uses it for idempotency.

`UNIQUE(platform, external_account_id)` prevents two rows for one X account.

`content_posts.scheduled_for` is the plan time that the calendar reads. The deliveries carry the
real time and the retries. Write the post time and its deliveries in one `dispatch`, so they cannot
disagree. `content_posts` keeps no copy of a delivery status; section 4 derives it.

`content_deliveries` has no `last_event_sequence` conflict with the event log: each write is one
`database.dispatch` call with a new aggregate type.

New aggregate types: `content-account`, `content-post`, `content-delivery`. Do not reuse
`agent-routine` or `routine-run`; `agent-roster.ts` purges those on agent deletion.

### Migration

- Append migration version 60 to `MIGRATIONS` in `src/backend/openbot-database-schema.ts`. The file
  had 51 migrations, from version 9 to version 59.
- Copy the same DDL into `LATEST_SCHEMA_SQL`.
- Add the new entry to `openbot-database-schema-history.json`. The parity test prints the entry.
- Add a migration test with a data-preservation fixture: an existing database at version 59, then a
  migration, then all earlier rows still present. Also cover failure, rollback, retry, missing
  version, foreign key and integrity. Follow `src/backend/*-migration.test.ts`.
- No column change to an existing table. v1 is additive only.

### Stores

| File | Owns |
| --- | --- |
| `src/backend/content/content-store.ts` | The four tables. Each write is one `dispatch` with an event. No secrets are decrypted here. |
| `src/backend/content/content-queries.ts` | List posts, read calendar range, read deliveries, read due deliveries. |
| `src/main/content/content-account-store.ts` | Account rows and the ciphertext. Main encrypts and decrypts with the existing `SecretStorageCipher`; the backend only stores text. |

Follow `routine-store.ts`: one class, prepared statements, `#` private fields, `dispatch` per write,
and no import of `AgentService`.

## 6. Scheduling and publishing

### Timer

Reuse the one `RoutineTimer` instance. Do not add a second `setTimeout`.

`AgentService` already accepts `extraRoutineSources`. `src/main/application-services.ts` passes the
workflow triggers there. Pass the content publisher the same way:

```ts
extraRoutineSources: () => [
  ...(workflowTriggers ? [workflowTriggers] : []),
  ...(contentPublisher ? [contentPublisher] : []),
],
```

The content publisher implements the `RoutineDueSource` shape (`nextDueAt`, `processDue`). Rename
the interface to `DueSource` in a separate commit, because it is no longer routine-only. That rename
is a safe internal change; no wire contract changes.

### Claim and publish

1. `nextDueAt` reads `MIN(next_attempt_at)` for `status = 'queued'`.
2. `processDue(now)` reads at most 10 due deliveries, oldest first.
3. For each delivery, claim it in one statement:
   `UPDATE content_deliveries SET status='publishing', attempt=attempt+1, updated_at=? WHERE delivery_id=? AND status='queued'`.
   Continue only if exactly one row changed.
4. Decrypt the account token with the cipher. Refresh it first when `expires_at` is within 60
   seconds. Refresh is single-flight for each account.
5. Call the platform adapter. The X adapter posts one text to `POST /2/tweets`.
6. On success, write `published`, `external_post_id` and `published_at`.
7. On a retryable error (network, 5xx, 429), write `queued` and the next time: attempt 1 after 1
   minute, attempt 2 after 5 minutes, attempt 3 after 30 minutes. After the third failure write
   `needs-attention`.
8. On a permanent error (400, 401 after refresh, 403, 404), write `failed` or `needs-attention` with
   the provider message. Never retry a 4xx that will not change.
9. One delivery failure does not stop the other deliveries of the post.

Status values: `queued`, `publishing`, `needs-attention`, `published`, `failed`, `cancelled`. This
matches the routine run vocabulary, so the UI and the user already know it.

Retries do not change `scheduled_for`. The calendar shows the plan; the run history shows the
attempts. `attempt` and `error` are enough for v1; do not add a separate attempts table.

### Restart safety

X has no idempotency key. A crash between the HTTP request and the database write leaves an unknown
result.

- On start, every `publishing` delivery becomes `needs-attention` with error code
  `unknown-delivery`. Do not retry it.
- The UI offers "Check on X" and "Retry". The user decides. Never auto-retry an unknown result.
- This rule is a test case: kill the process after the request, restart, and assert one
  `needs-attention` row and zero automatic second requests.

### Time zones

Store `scheduled_for` as a UTC instant and `timezone` as the zone the user chose. The composer shows
local time. Reuse the routine time-zone handling in `routines` settings; do not invent a second
zone picker.

A post that is scheduled in the past is rejected at save time with a typed error.

## 7. OAuth and secrets

X uses OAuth 2.0 Authorization Code with PKCE.

- The user supplies an X app client id once in Content settings. The repository never contains a
  client id or a secret. Do not ship a shared app credential.
- `content:begin-connect` starts a loopback listener on `127.0.0.1` with a random port, makes a
  random `state` and a PKCE `code_verifier`, opens the system browser, and waits for the callback.
  The promise resolves with the new `ContentAccount`, or rejects on timeout after 5 minutes. A
  `content:cancel-connect` endpoint ends it early.
- Verify `state` before the token exchange. Bind the listener to loopback only. Never accept a
  redirect with a token in the URL. PKCE with `S256`.
- Encrypt the access token and the refresh token with the existing `SecretStorageCipher`, the same
  way `projection_routine_webhooks.secret_ciphertext` and the channel tokens work. Store base64
  text. Main encrypts before the store call and decrypts only inside the publisher.
- The renderer receives `handle`, `display_name`, `status` and `expires_at`. It never receives a
  token, a refresh token, or a client secret.
- Redact tokens on every log path. Never log a request body that contains a token, and never log an
  `Authorization` header.
- Add the outbound destination to `PRIVACY.md`: the user's post text and account handle go to
  `api.x.com`. Nothing else leaves the computer.

The account token belongs to the computer that runs OpenBot. That is the same rule as routines:
the user's SQLite is the source of truth.

## 8. IPC contracts

New group `content` in `packages/contracts/src/ipc-endpoints.ts`. v1 is local only, so the endpoints
use `request` and not `scopedRequest`. This follows `routineFeed`, which is also a host feature of
this computer. The renderer shows the page only for a local server.

```
content:list-accounts      request<undefined, ContentAccount[]>()
content:begin-connect      request<{ platform: "x" }, ContentAccount>()   // resolves after OAuth
content:cancel-connect     request<undefined, void>()
content:disconnect-account request<{ accountId: string }, void>()
content:list-posts         request<{ from?: string; to?: string; limit?: number },
                            ContentPost[]>()
content:create-post        request<CreatePostInput, ContentPost>()
content:update-post        request<UpdatePostInput, ContentPost>()
content:delete-post        request<{ postId: string }, void>()
content:schedule-post      request<{ postId: string; scheduledFor: string }, ContentPost>()
content:unschedule-post    request<{ postId: string }, ContentPost>()
content:publish-now        request<{ postId: string }, ContentPost>()
content:list-deliveries    request<{ postId: string }, ContentDelivery[]>()
content:calendar           request<{ from: string; to: string }, ContentCalendar>()
content:changed            event<{ postId?: string; accountId?: string }>()
```

Types live in `packages/contracts/src/ipc-content.ts` with `isContentAccount`, `isContentPost`,
`isContentDelivery`, `isContentCalendar`, and the derived post state function. Limits go in
`input-limits.ts`: `contentPostBody: 25_000`, `contentPostsPage: 100`, `contentAccounts: 20`,
`contentCalendarDays: 62`.

Post body limit: the generic store limit is large; each platform adapter returns its own limit
(X: 280 characters for a standard account) and the composer shows the count. Reject at save only
when the body exceeds the store limit; show the platform warning in the composer.

The preload bridges the group (`bridgeGroup`), so `ipc-desktop-apis.ts` needs no line. Add the mock
methods to `mock-openbot.ts` or a `mock-content.ts` module. `tsc` names every missing piece.

Events: send `content:changed` from main after each write. The renderer subscribes in
`content-port.ts` and reloads the list or the calendar.

## 9. UI surfaces

v1 is desktop only.

### Page

New `HostPaneView` value `"content"`. Wire it in:

- `src/renderer/src/features/usage/usage-context.tsx` (`openContent`).
- `src/renderer/src/features/window/window-page-context.tsx`.
- `src/renderer/src/features/window/WindowPageView.tsx` (a `<Match>`).
- `src/renderer/src/features/window/WorkspacePageRail.tsx` (a rail button with a Lucide icon).
- `src/renderer/src/lazy-views.ts`.
- `src/renderer/src/global-search-sources.ts` (palette entry).
- Hide the page when the selected server is not local, and state why in one sentence.

### Content page

`src/renderer/src/features/content/`:

```
content-port.ts        the IPC calls, the change subscription
ContentPanel.tsx       header, tabs, empty state
ContentQueue.tsx       list of posts with derived state
ContentCalendar.tsx    the schedule view (shared component below)
PostComposer.tsx       body, account picker, character count, schedule picker
AccountSheet.tsx       connect, disconnect, status
```

Shared component: `packages/ui/src/features/content/PostCalendar.tsx`. Reuse the layout, day strip and
status chips of `packages/ui/src/features/conversation/RoutineCalendar.tsx`, but do not change that
component's props; a content post is not a routine run.

### Empty and failure states

- No account: one call to action, "Connect X". Explain that the user needs an X app client id.
- Account expired: banner with "Reconnect", and the queue stops.
- Delivery `needs-attention`: row shows "Check on X", "Retry", "Cancel".
- A local-only page viewed on a joined server: one sentence, no calls.

### Text

All strings go to `packages/i18n/src/messages/en/content.ts`, registered in every locale index. Use
the same key naming style as `routine.ts` (`content.composer.…`, `content.status.…`).

### Mobile

Out of scope for v1. The mobile app has no database and would need a Team API capability. Do not add
one until desktop v1 is stable.

## 10. Approval flow

`approval_state` exists in v1 with three values:

- `none`: the user wrote the post. It can be scheduled at once.
- `pending`: an agent wrote the post. It cannot be scheduled until a user approves it.
- `approved`: a user approved it. It can be scheduled.

v1 sets `none` for every post. The column and the state function ship now, because v1.1 adds the
agent tool `content_create_post`, which writes `pending`. The UI then gets one "Approve" action in
the queue. This is a state on the post, not a second user role: the product is single-user.

## 11. Platform abstraction

One interface, in `src/main/content/content-adapter.ts`:

```ts
export interface ContentAdapter {
  readonly platform: "x";
  readonly textLimit: number;
  connect(input: { clientId: string }): Promise<ConnectedAccount>;
  refresh(input: { refreshToken: string }): Promise<RefreshedTokens>;
  publish(input: { accessToken: string; body: string }): Promise<{ externalPostId: string }>;
  mapError(error: unknown): { retryable: boolean; status: "failed" | "needs-attention"; message: string };
}
```

`x-adapter.ts` implements it with `fetch`. Adding a platform later means: a new adapter, a new value
for the `platform` column check, a new variant rule, and new i18n text. It does not mean a new table.

Do not copy code from Postiz. Read its data model for naming ideas only. Write original code, and
keep the PolyForm Noncommercial license of this repository.

## 12. Implementation conventions

- Use Effect 4.0.0 for the new main and backend async services: named `Effect.fn`,
  `Effect.gen`, `Schema.TaggedError`, and `Effect.tryPromise` at the HTTP adapter. Run the Effect at
  the handler boundary. Read the installed Effect source first.
- Decode IPC payloads in `src/main/ipc/content-inputs.ts` with the shared validation primitives.
  The sender check runs first, as `define-ipc-group.ts` enforces.
- Use `sourceText(key)` for errors that main sends. Use `@openbot/i18n` keys for every rendered
  string.
- Write a release note in `changelog.d/feat-content-manager.md` with the first code commit. The
  design-only pull request gets the `no-changelog` label.
- Keep `TASKS.md` at the worktree root current while the work continues.

## 13. Security review

| Risk | Control |
| --- | --- |
| Token theft | Token never leaves main. Cipher at rest. Redaction on logs. No token in IPC, errors or analytics. |
| OAuth callback spoofing | PKCE S256, random `state`, loopback bind, 5-minute timeout, one use. |
| Renderer compromise | The renderer can only call typed endpoints. It cannot choose a URL, a header or a token. |
| Double post | One delivery row per variant and time, claim by conditional update, unknown result becomes `needs-attention`. |
| Content leak | Post text goes only to the chosen platform. `PRIVACY.md` states it. |
| SSRF through a provider URL | No user-supplied URL. The adapter has a fixed base URL. |
| Rate limit exhaustion | 429 backoff, typed `needs-attention`, no unbounded retry. |

## 14. Testing

- Migration test: version 59 database plus data, migrate, compare. Include failure and rollback.
- Schema parity: covered by the existing test after the `LATEST_SCHEMA_SQL` mirror.
- E2E: `scripts/content-schedule-e2e.ts` with a local fake X server. Cases: publish now, schedule,
  reschedule, cancel, retry after 500, 429 backoff, permanent 403, restart with a `publishing` row.
  Write the report to `.openbot-build/`.
- E2E: `scripts/content-oauth-e2e.ts` against a fake authorize server. Assert: wrong `state`
  rejected, timeout, token stored as ciphertext, renderer payload has no token.
- Manual smoke: connect, compose, schedule one minute ahead, watch the queue, delete the post.
- No unit test outside the protected areas of `AGENTS.md`.

## 15. Implementation order (tracer bullets)

1. Migration 60, the four tables, the store, and the migration test.
2. Contracts, the `content` IPC group, the handlers, the preload bridge and the mock with an empty
   page. This proves the seam end to end.
3. Accounts: settings, client id, OAuth, list, disconnect. No publishing.
4. Composer and post CRUD. "Publish now" calls a fake adapter that records the call.
5. Publisher as a due source, the X adapter, statuses, retries and restart recovery.
6. Queue and calendar UI, plus the derived status.
7. Release notes, `PRIVACY.md`, screenshots, and the smoke report.

Each step is one commit and one focused check set.

## 16. Risks

1. **A crash can duplicate or lose a publish.** X has no idempotency key. The design refuses to
   guess: an unknown result becomes `needs-attention` for the user. This is safe but not automatic.
2. **X API access is the main external dependency.** The API tier, the cost, the app review and the
   write limit can change. The user supplies the app client id, and the adapter is one file. Verify
   the current tier rules before the build starts.
3. **Irreversible migration on user data.** There is no backup. The change is additive, but it needs
   the fixture test and the parity mirror in the same commit.
4. **Scope creep into a social suite.** Media, threads, analytics and more platforms each double the
   work. The non-goals list is the guard.
5. **Token refresh races.** Two deliveries for one account can refresh at the same time. Refresh is
   single-flight; a stale refresh does not clear a new token.

## 17. Open questions for review

1. Do we ship the page for a joined server in v2, which makes a permanent Team API capability, or
   keep content local to the computer that owns the accounts? The recommendation is local.
2. Is text-only acceptable for v1, or must v1 include one image? An image adds upload, size checks,
   and a media status wait on X.
3. Should the agent get `content_create_post` in v1.1 with `pending` approval, or is the composer
   enough? The recommendation is v1.1.
4. Which X access tier does the user have? If the app cannot post, v1 can still ship the composer,
   the queue and a dry-run adapter, and clearly say that publishing is off.

---
name: verify-openbot
description: Prove that a change to the OpenBot desktop app works, in the real app, with the narrowest checks this repository allows. Use before reporting a change as done, when asked to verify or check a change, or when a pull request needs evidence. Covers setup, the narrowest test command per area, driving the app, and where the evidence goes.
---

# Verify OpenBot

A change is done when the app shows the new behavior, not when the code
compiles. Drive the app, keep the evidence, and say what you did not check.

Read `AGENTS.md` first. It forbids broad checks locally: no repository-wide
lint, no aggregate `bun run typecheck`, no full suite, no build. CI runs
those. This skill lists what to run instead.

For the step-by-step app driving loop, read the `smoke` skill. This skill
decides what to run and what to keep.

## Before you start

- `node --version`. Node 24 is required.
- In a fresh worktree: `bun install --frozen-lockfile`, then
  `bun run dev:bootstrap` once. When it reports a missing `.env.keys`, copy
  the file from the main checkout. Do not create a new one.
- Prefix every `bun run dev*` command with `env -u ELECTRON_RUN_AS_NODE`.
- Check `bun run dev:status` before starting anything. Reuse a live stack in
  this worktree; never start a second one.

## Step 1 - The narrowest check that fits the change

Run one command at a time, one worker where supported.

| The change touches | Run |
| --- | --- |
| Any source file | `bun run test:changed` (one worker, tests that import what you changed) |
| Named source files | `bun run test:related -- <source>` |
| One test file | `bun run test:desktop -- <path>` |
| `src/main`, `src/backend`, `src/preload`, `scripts` | `bun run typecheck:node` |
| `src/renderer`, `packages/ui` | `bun run typecheck:renderer` |
| One package or app | that package's `typecheck` script |
| Changed files only | `biome check --write --max-diagnostics=none <paths>` |
| Setup and runtime state | `bun run dev:verify` |

`bun run test:changed` needs a current `origin/main`. Fetch it first. Without
`origin/main` it exits with code 0 and runs nothing, which looks like a pass.

Never run `bun run format`, `bun run typecheck`, or a full suite locally.

## Step 2 - Drive the app

Follow the `smoke` skill. The short form:

```bash
bun run dev:automation instances
bun run dev:automation snapshot --wait-for=<role>,<name>
bun run dev:automation click --role=<role>,<name> --allow-mutations --instance=<id> --wait-for=<role>,<name>
```

The accessibility snapshot is the evidence. Take a screenshot only when the
result is visual and a snapshot cannot show it, or when the user asks for PR
evidence.

## Step 3 - Feature map for the content manager

| Area | Narrowest check | What to drive |
| --- | --- | --- |
| Accounts dialog (`src/renderer/src/features/content/ContentAccountsDialog.tsx`) | `bun run test:related -- src/renderer/src/features/content/ContentAccountsDialog.tsx` | Open the dialog, add an account, close it, reopen it |
| Composer and per-network variants (`ContentComposer.tsx`) | `bun run test:related -- src/renderer/src/features/content/ContentComposer.tsx` | Type in the composer, switch network, check the variant, check the character count |
| Queue (`ContentQueue.tsx`) | `bun run test:related -- src/renderer/src/features/content/ContentQueue.tsx` | Queue an item, cancel it, reorder it |
| Panel and empty state (`ContentPanel.tsx`) | `bun run test:related -- src/renderer/src/features/content/ContentPanel.tsx` | Load with no items, then with items |
| Backend schema and store (`src/backend/content/`) | `bun run test:desktop -- src/backend/content-migration.test.ts` and `bun run typecheck:node` | Restart the app and confirm the queue survived |
| Media handling and uploads (`src/backend/content/content-media.ts`) | `bun run test:desktop -- src/preload/content-decoding.test.ts`, `bun run test:desktop -- src/main/content-security-policy.test.ts` | Attach an image, remove it, attach another |
| Delivery status map | `bun run test:content-status-map` | Send a draft and watch its status change |
| Content agent tools (`src/backend/agent/content-tools.ts`) | `bun run test:related -- src/backend/agent/content-tools.ts` | Ask an agent to list the queue |

A check with no test file yet returns no tests and exits 0. That is not
evidence. Drive the app for that area and say that no automated test covers
it.

## Step 4 - Keep the evidence

- Evidence belongs in `.openbot-build/dev-automation/`. Never commit it.
- `AGENTS.md` forbids pull request screenshots in the repository. A committed
  screenshot stays in the history of `main`.
- Report the path of each artifact, the command that produced it, and the
  commit it shows.

## Step 5 - Report

Give one table:

| # | Feature | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Short name | pass / fail / not checked | Snapshot text, log line, or file path |

Then give the stack and flags you used, each failure with the steps to
reproduce it, and each item you did not check with the reason.

Do not fix a failure unless the user asks. A failing check that you did not
fix is a valid result.

## Anti-jobs

- This skill does not run broad checks. `AGENTS.md` forbids them locally.
- This skill does not commit evidence.
- This skill does not change the code.

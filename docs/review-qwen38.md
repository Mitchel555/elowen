# Code review — `e90d3d1f..HEAD` (7 commits)

Reviewer: skeptical senior pass. Scope: read-only; every claim below was checked against the
actual source (callers, types, schema, tests), not the diff alone. Per the task constraints I did
**not** execute the test suite — test-pass statements are the commit messages'; I verified by reading
that each new test is non-hollow (would fail on the pre-fix code). Where I could not fully establish
something by reading, it is marked **needs verification**.

## Summary verdict

Solid batch. Five of the seven changes are correct and well-reasoned, and the two risky ones (#5 plan
persistence, #1 sub-agent progress) are functionally sound after verification — but #5 carries a real,
avoidable per-poll cost regression that I would fix before merge, and #1's public type is a fragile
facade over the real event type. No correctness regressions found that would break an untouched path.
No `any` / `@ts-ignore` introduced in `src`/`web`. The only `!` added is in a test and matches the
repo's pervasive test idiom. Nothing here is a blocker except, in my view, the #5 hot-path gate.

Severity legend: **HIGH** = likely bug / regression to fix before merge · **MEDIUM** = real issue,
fix strongly recommended · **LOW** = worth addressing · **NIT** = cosmetic / optional.

---

## 1. `89b89bbc` — DelegateContinue shows as a running sub-agent

**Verdict: correct and production-wired.** I traced the whole callback chain, not just the plugin:
plugin `ctx.continueSubagent(id, msg, onEvent)` → `registry.ts:356` → bridge `continue(..., onEvent)`
(`bootstrap.ts:650`) → `brainService.continueSubagent(..., onEvent)` (`brainService.ts:1283`) →
`sendDelegated` (`brainService.ts:1341`) → `channelService.send({ onEvent })` (`channels.ts:83,475`) →
`runOne` adds it to `ch.listeners` (`channels.ts:~364`) and also emits synthetic `session`/`idle`
events with a real `BrainUsage` (`channels.ts:~367,~450`). So the plugin's `onEvent` genuinely receives
`tool`/`step`/`idle` events carrying `usage.totalTokens` in production — the progress row is not a
test-only fiction. The distillation in `plugins/subagent/index.mjs:717-720` is a faithful copy of the
Delegate handler's (`index.mjs:425-429`). The row always settles: `push('done')` on success,
`push('error')` in the catch (`index.mjs:724,730`), and the awaited promise cannot hang indefinitely
under normal operation, so it does not leak.

- **MEDIUM — public type is a structural facade over the real event type.**
  `SubagentProgressEvent` (`src/plugins/api.ts:15-22`) declares `type: string` + all-optional fields,
  but the value actually delivered is a full `BrainEvent` (`brainService.ts:1283` types the callback
  `(e: BrainEvent) => void`). The plugin-facing `(e: SubagentProgressEvent) => void` only type-checks
  against `(e: BrainEvent) => void` because every `BrainEvent` union member happens to be structurally
  assignable to `SubagentProgressEvent` (`type: string`, everything else optional). That is coincidence,
  not contract: a future `BrainEvent` member with a conflicting required field, or narrowing
  `SubagentProgressEvent.type`, silently breaks the assignability or — worse — type-checks while
  mis-describing what the callback receives. Suggested fix: make the plugin-facing callback
  `(e: BrainEvent) => void` (import the real type), or define `SubagentProgressEvent` as an explicit
  `Pick`/discriminated subset and map `BrainEvent → SubagentProgressEvent` at one boundary in
  `brainService.continueSubagent` instead of relying on structural luck.

- **LOW — test mocks the bridge, so the wiring above is uncovered.**
  `tests/plugins/subagentResume.test.ts:56-60` stubs `continue` and drives `onEvent` by hand. It
  correctly asserts the plugin's distillation + `pushJob` (running row keyed on the call id `call-42`,
  `tools:1`/`detail:'Read a.ts'`, `tokens:500`, final `done`) and would fail on the pre-fix code (which
  emitted nothing). But it cannot catch a break in the `bootstrap`/`brainService`/`channels` threading I
  verified manually. A thin integration test that runs a real `continueSubagent` against a stubbed
  channel emitting one `tool` + one `idle` event would lock that chain. Optional.

- **LOW — abort-during-continuation settlement is untested.**
  If the parent turn is aborted while `await ctx.continueSubagent(...)` is in flight, the row clears
  only if that promise rejects (→ `push('error')`). I did not establish that an abort reliably rejects
  this specific await rather than leaving it pending; if it can hang, clients that already received the
  `running` row keep a stuck spinner. The Delegate handler has the same exposure plus more, so this is
  not a new class of bug — **needs verification** that abort rejects the continuation.

- **NIT — `state.id` is dead.** `index.mjs:704` mints `dlg-continue-${randomUUID()}`, but `pushJob`
  emits `id: job.toolCallId` (`index.mjs:235`) and this state is never added to the `jobs` map nor passed
  to a completion emitter, so `state.id` is never read. Drop it, or keep it only if a future use is
  planned. (Delegate's `id` is used as the jobs-map key; this one has no such consumer.)

- **NIT — `state.status = 'done'/'error'` is effectively unused** (`index.mjs:723,729`): `pushJob`
  takes the status as its argument and `describeJob`/`jobDetails` only run for `jobs`-map entries.
  Harmless, kept for symmetry with Delegate.

---

## 2. `c14e513f` — background shells only in the right rail

**Verdict: correct, deliberate tradeoff, no dead code.** The filter at `src/cli/chat/chatComposition.ts:822`
now drops the `bg-processes` card unconditionally. `panelVisible`/`panelAvailable` are still used at
lines 316/374/377/386/439/744/814/823/1350, so removing this one call site orphans nothing.

- **MEDIUM (behavioral, acknowledged) — information loss on narrow terminals.**
  The previous code kept the compact card when the rail could not fit (`!panelVisible()`); the new code
  removes the only above-the-input surface for running background shells on a terminal too narrow for
  the rail. The comment owns this ("by design"). It is acceptable as a product decision, but it is a
  genuine regression for narrow-terminal users: a long-running `Bash(background:true)` becomes invisible
  until they widen the terminal. If that audience matters, consider keeping the card only when
  `!panelAvailable()` (rail can never fit) rather than dropping it always — that preserves the
  de-duplication on wide layouts while keeping the narrow-terminal fallback. If narrow terminals are
  rare for this tool, the current change is fine; flagging so the tradeoff is a conscious one.

---

## 3. `f560656d` — toasts top-right, smaller on phones

**Verdict: correct, presentation-only.** Placement moves to `fixed top-3 right-3` mobile-first,
stepping to `sm:top-5 sm:right-5 sm:w-[26rem]` (`web/components/ui/Toast.tsx:89-92`); the `toast-in`
keyframe now slides from above (`translateY(calc(var(--motion-distance-md) * -1))`,
`web/app/styles/animations.css:2`), consistent with a top-anchored toast. `toast-in` is consumed only by
`Toast.tsx`, so the reversed direction has no other consumer to break.

- **NIT — desktop width quietly shrank 28rem → 26rem.** The commit message frames this as
  mobile-only, but the `sm` width also changed. Harmless; just note it if the desktop size was
  intentional before.

---

## 4. `eb7e46bd` — blur-and-spinner reconnect overlay

**Verdict: correct; no flash-on-load and no stuck-true path found after tracing every recovery path.**

Why it does not flash on first load: the initial `connect()` runs directly, not through the controller,
and `onActive` only fires from `retry`/`now`/`succeeded`/`stop`. The first snapshot frame lazily creates
the controller and calls `succeeded()` (`BrainChatProvider.tsx:468`), but `setActive` is guarded by
`if (active === v) return` (`web/lib/reconnect.ts:50`), so a false→false transition emits nothing. The
overlay is gated on `reconnecting`, not `!ready`, so boot (`setReady(false)` at `:399`) shows the normal
empty state, not the blur.

Why it clears on every path: every trigger that sets `active=true` — snapshot timeout (`:447`), error
frame (`:534`), silence watchdog (`:1026,1037`) — funnels a `connect()` that arms the snapshot timer
(`:444`). That timer is the universal safety net: a delivered snapshot calls `succeeded()` → false
(`:468`); a missing snapshot retries and stays true (correct). `stop()` on unmount forces false
(`reconnect.ts:75`, `BrainChatProvider.tsx:1044`). A `connect()` that resolves but is superseded by a
newer generation returns early without a snapshot, but the newer generation's snapshot still calls
`succeeded()`, so `active` still clears.

- **LOW — a resolved-but-frameless reconnect holds the overlay until the snapshot timer fires.**
  `now()`/`retry()` set `active=true` and `run()` resolves `connect()` as soon as the `EventSource` is
  created; `active` only drops on a real snapshot frame. Because `snapshot=1` guarantees a first frame
  and the `SNAPSHOT_TIMEOUT_MS` timer retries otherwise, this is bounded and correct — but the overlay
  is up for the whole window between "socket open" and "first frame," which on a slow network is exactly
  when it should be, so this is confirmation rather than a defect. **Needs verification** only that
  `SNAPSHOT_TIMEOUT_MS` is short enough that a silently-dead stream does not leave the overlay up for an
  uncomfortably long single backoff window.

- **LOW — `setReconnecting(false)` can fire after unmount.** `stop()` runs in the unmount effect and
  calls `onActive(false)` → `setReconnecting`. React 18 treats a post-unmount state set as a no-op (no
  warning), so this is harmless, but a `mountedRef` guard would be cleaner if the codebase avoids
  post-unmount sets elsewhere.

- **LOW — provider-level behavior is not directly tested.** `web/tests/lib/reconnect.test.ts:93-113`
  tests the controller well (active stays true through a resolved-but-unconfirmed connect; coalesces
  duplicate `now()`; clears on `stop()`), and both assertions would fail on a naive implementation. But
  nothing asserts the overlay does not flash on first load or that `BrainChatSurface` renders it — that
  guarantee rests on the "first connect bypasses the controller" invariant, which is architectural and
  untested. A one-line provider test (mount → expect `reconnecting` false before any drop) would lock it.

- **i18n: complete and consistent.** `reconnecting` is present in all three dictionaries at the same
  position inside the `brainChat` object (`cs.ts:1550` 'Obnovuji spojení…', `sk.ts:1550` 'Obnovujem
  spojenie…', `en.ts:1550` 'Reconnecting…'). Czech is impersonal (no ty/vy), matching the surrounding
  keys; usage `t.brainChat.reconnecting` (`BrainChatSurface.tsx:632`) matches the key path. No issue.

- **NIT — overlay z-index vs. open modals.** The overlay is `absolute inset-0 z-40`
  (`BrainChatSurface.tsx:624`); toasts are `z-50` (correctly above). If the stats/agents modals render
  below `z-40`, a reconnect triggered while one is open would blur over it. Minor; verify the modal
  stacking if it matters.

---

## 5. `79022bd2` — pending plan survives a daemon restart

**Verdict: correct fix, and the SQL is right — but it removes the early-exit that kept ordinary
(build-mode) status polls off the database, replacing it with a per-poll O(session-length) scan. That
is the one change I would rework before merge.**

Correctness first. `planState` (`src/brain/service/statusService.ts:174-184`) now derives the pending
plan from durable history via `getLatestTurn` instead of gating on the in-memory `live.lastTurnMode`,
and reports `workMode: pendingPlan ? 'plan' : (live?.lastTurnMode ?? 'build')`. The restart case works:
after a redeploy `live` is `undefined`, so a submitted-but-undecided `ExitPlanMode` in the newest turn
restores both `pendingPlan` and `workMode:'plan'`. A decision clears it because "Implement" sends a real
user message (`src/cli/chat/flows.ts:88-90`), which starts a new turn and pushes the `ExitPlanMode` out
of the newest-turn window that `pendingSubmittedPlan` scans (`src/brain/messageView.ts:100-128`). The
snapshot path passes already-loaded `rows` (`statusService.ts:417`), so it adds no query.

`getLatestTurn`'s SQL (`src/store/brainStore.ts:362-367`) is correct: the floor is
`MAX(rowid) WHERE session_id=? AND role='user'` (0 when the session has no user message yet), and the
tail is `rowid > floor ORDER BY rowid ASC`. This matches `pendingSubmittedPlan`'s own turn boundary
(`role === 'user'`), so the two agree (the function re-scans for a user row, finds none in the tail, and
uses all of it). `rowid` is the implicit PK, so the tail select is a cheap range scan.

- **MEDIUM — the build-mode early-exit is gone; every status poll now does an O(n) scan.**
  The old code returned `{ pendingPlan: null }` immediately whenever `workMode !== 'plan'`, so the
  common build-mode poll touched no history. The new code calls `getLatestTurn` on **every** poll with a
  sessionId (`statusService.ts:182`). The `MAX(rowid) ... role='user'` query must scan the session's rows
  to find the newest user rowid: the only index is `idx_brain_messages_session ON brain_messages(session_id)`
  (`src/store/schema.sql:187`), and `role` is not in it, so SQLite reads a table row per session entry —
  O(messages-in-session) per poll. The comment's claim that this "stays off the full-history query" is
  true relative to `getMessages` (no materializing / `JSON.parse` of every row) but overstates it: the
  scan still walks every row's `role`. Web status is event-driven (connect + settle/usage refreshes, no
  tight timer — `BrainChatProvider.tsx:420,579,633,911`), but the CLI status line polls, and a long
  conversation makes each poll measurably heavier than before.

  Suggested fix (preserves the fix, restores the cheap path): keep the live stamp authoritative while a
  live brain exists, and only fall back to durable history when it is needed —
  ```ts
  if (live && live.lastTurnMode !== 'plan') return { workMode: live.lastTurnMode, pendingPlan: null };
  const pendingPlan = pendingSubmittedPlan(rows ?? this.d.store.getLatestTurn(sessionId));
  return { workMode: pendingPlan ? 'plan' : (live?.lastTurnMode ?? 'build'), pendingPlan };
  ```
  Rationale: while a brain is live, `lastTurnMode` is stamped per send and accurately reflects whether
  the current turn is plan; a live `build` turn cannot have an undecided `ExitPlanMode` in its newest
  turn (a plan is only submitted in a plan-mode turn). The restart case (`live` absent) still falls
  through to the durable read, so the fix is intact. Alternatively/additionally, a covering index
  `(session_id, role, rowid)` would make the `MAX` a pure index seek. Exact poll frequency and measured
  cost: **needs verification**, but the gate fix is cheap and strictly better regardless.

- **LOW — duplicated turn-boundary definition.** The "newest turn = rows after the last user row" rule
  now lives in two places: SQL (`brainStore.ts:363`, `role='user'`) and TS (`messageView.ts:102-104`,
  `role === 'user'`). They agree today; if one changes, `getLatestTurn` could hand
  `pendingSubmittedPlan` a window that disagrees with its own internal slice. Consider having
  `getLatestTurn` return the raw tail and letting `pendingSubmittedPlan` own the boundary alone, or
  document that the two must move together.

- **LOW — dismiss-then-restart re-raises the plan.** "Cancel" closes the modal client-side without a
  message, so the `ExitPlanMode` stays in the newest turn; after a restart (or in a fresh tab, where the
  per-tab `planDecided` key resets) the daemon reports `pendingPlan` again and the modal re-appears.
  This is arguably correct (a dismissed plan is still pending until implemented) and is largely
  pre-existing, but the durable-history source makes it more durable than before. Worth a conscious
  product confirmation, not a code change.

- **Test quality: non-hollow.** `tests/brain/brainService.test.ts:3670-3692` reuses one real
  `BrainStore(openDb(':memory:'))` (`fakeDeps`, `:93,116`) across two `BrainService` instances, which
  faithfully simulates a restart (live sessions gone, durable store kept). The post-restart assertion
  would fail on the old code (`live` undefined → `workMode:'build'` → early `pendingPlan:null`), so it
  genuinely exercises the fix, including the snapshot via `tapSessionSnapshot`. It depends on
  `fakeDeps().lifecycle.activeSessionId` returning the stored session so `activeId` resolves without a
  live brain (`statusService.ts:258`) — the passing assertion is evidence it does; **needs verification**
  only in the sense that I did not run it.

---

## 6. `6e2d8dde` — per-file `testTimeout(30s)` on two slow suites

**Verdict: reasonable.** `vi.setConfig({ testTimeout: 30_000 })` at module scope in
`tests/api/cli-detection.test.ts:16` and `tests/plugins/toolNaming.test.ts:9`, with comments explaining
the genuine cost (spawning 9 `--version` binaries, one of which boots a daemon; importing every plugin's
module graph). Vitest scopes this per file, so it does not loosen other suites.

- **NIT — a per-`it` timeout would be more surgical** (e.g. `it('...', { timeout: 30_000 }, ...)` or a
  third-arg timeout) since only specific cases are slow, but file-wide is defensible and the comments
  justify it. The risk of a 30s ceiling masking a real hang is low given the explained baseline; if these
  ever grow, revisit rather than ratchet further.

---

## 7. `9d62f3b4` — clear the shared prompt mock between LSP step cases

**Verdict: correct fix for the stated bug.** `beforeEach(() => { vi.clearAllMocks(); })`
(`tests/cli/setup/lspStep.test.ts:24`) clears the call log of the file-wide hoisted `select` mock, so the
"never called" assertion in the first case no longer depends on execution order (shuffle / worker
interleaving). The comment explains the root cause accurately.

- **LOW — `clearAllMocks` vs `resetAllMocks`.** `vi.clearAllMocks()` clears calls/instances/results but
  does **not** remove implementations set via `mockImplementation`/`mockReturnValue` (that is
  `resetAllMocks`). For the reported bug (call-count leakage) `clearAllMocks` is exactly right and
  sufficient. But if any case stubs a return value that a later case assumes is the default, that
  implementation would still leak. If the suite sets implementations per-case, prefer
  `vi.resetAllMocks()` (or `restoreAllMocks`) for a stronger isolation guarantee; otherwise this is fine
  as-is. **Needs verification** that no case relies on a pristine default implementation another case
  overrides.

---

## Cross-cutting

- **Strict TS:** no `any`, `as any`, `@ts-ignore`, or `@ts-expect-error` introduced in `src`/`web`.
  The one non-null `!` added (`tests/plugins/subagentResume.test.ts`, `res.content[0]!.text`) matches the
  repo's pervasive test idiom (the adjacent pre-existing case at `:216` does the same), so it is
  consistent with surrounding code even though a stricter reading of the criterion would flag it. NIT at
  most.
- **AGENTS.md adherence:** plugin behavior stays in the plugin (#1), shared transport/runtime stays in
  `src` (#5, #4), i18n preserved across cs/sk/en with formal Czech (#4). No unrelated work touched.
- **Not executed:** per task scope I read but did not run the suite; the "would fail on old code"
  judgments are from reading the assertions and the pre-fix control flow.

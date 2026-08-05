import type { MemoryStore } from '../store/memoryStore.js';
import type { MemoryService } from './memoryService.js';
import type { MemoryCategorizer } from './memoryCategorizer.js';
import type { InferenceClient } from '../inference/types.js';
import type { Logger } from '../shared/logger.js';

/** Upper bound on how many memory mutations one turn's curation may apply. Keeps a single exchange from
 *  rewriting the whole store if the model over-produces. Measured before this was cut from 4: the curator
 *  wrote 480 memories in 14 days while the user manually deleted 690 — over-capture, not under-capture,
 *  is the failure mode this store actually has. */
const MAX_OPS_PER_TURN = 2;
/** How much of each side of the exchange the extraction prompt sees — a durable fact never needs the
 *  full transcript, and this bounds the relay round-trip. */
const MAX_TEXT_CHARS = 2000;

/** A near-duplicate refresh REPLACES the matched memory's body. That is right when the new text restates
 *  the same fact, and destructive when the match is merely closely related and the existing memory holds
 *  detail the new one does not — the matched memory's content is simply gone, with no way to recover it
 *  from the audit trail's body-less diff. Length is the one signal available before the write: a
 *  replacement under half the length of what it overwrites is dropping content, so the curator adds a
 *  separate memory instead and leaves the original intact. It can still shorten a memory deliberately by
 *  addressing it with an explicit `update` op. */
function overwritesRicherMemory(existing: string, replacement: string): boolean {
  return replacement.trim().length * 2 < existing.trim().length;
}

/** One curator operation as returned by the cheap extraction model. `add` stores a new durable fact
 *  (deduped against near-identical existing memories → update instead); `update`/`delete` address an
 *  existing memory by id; `merge` collapses several ids into one consolidated body. */
interface CuratorOp {
  action: 'add' | 'update' | 'delete' | 'merge';
  id?: number;
  ids?: number[];
  body?: string;
  kind?: string;
  importance?: number;
}

/** Post-turn memory curation: after an owner exchange settles, ask a CHEAP model to distill any durable,
 *  reusable facts and apply them to the user's memory as a small, capped batch. Best-effort by design —
 *  it runs fire-and-forget from BrainService.send() and NEVER throws into the caller: every failure
 *  (no model, relay error, malformed JSON, a bad op) is swallowed and logged. Memory is per-user; the
 *  caller passes the genuine owner's id (owner-chat only), and every mutation is audited as 'agent'. */
export class MemoryCurator {
  private readonly store: MemoryStore;
  private readonly service: MemoryService;
  private readonly inference: () => InferenceClient | null;
  private readonly categorizer?: MemoryCategorizer;
  private readonly logger?: Logger;
  /** Operator-tuned cap on writes per exchange (Settings → Elowen AI → Runtime). Absent or non-finite →
   *  {@link MAX_OPS_PER_TURN}. Read per run so a change applies without a restart; 0 is a legitimate
   *  value and means the curator distills but writes nothing. */
  private readonly maxOps?: () => number;

  constructor(deps: {
    store: MemoryStore;
    service: MemoryService;
    inference: () => InferenceClient | null;
    /** Optional auto-categorizer: after a genuinely NEW add, best-effort classifies the memory into one
     *  of the owner's categories (fire-and-forget). Absent → new memories are simply left uncategorized. */
    categorizer?: MemoryCategorizer;
    maxOps?: () => number;
    logger?: Logger;
  }) {
    this.store = deps.store;
    this.service = deps.service;
    this.inference = deps.inference;
    this.categorizer = deps.categorizer;
    this.maxOps = deps.maxOps;
    this.logger = deps.logger;
  }

  /** How many operations this run may apply. */
  private opBudget(): number {
    const configured = this.maxOps?.();
    return typeof configured === 'number' && Number.isFinite(configured) && configured >= 0
      ? Math.floor(configured)
      : MAX_OPS_PER_TURN;
  }

  /** Distill + persist durable facts from one exchange. Resolves quietly on ANY failure (this is
   *  fire-and-forget); it never rejects, so a `void curator.run(...)` at the call site is safe. */
  async run(userId: number, userText: string, assistantText: string): Promise<void> {
    try {
      const inf = this.inference();
      if (!inf) return; // no memory model configured → no-op (memory still works via the explicit Memory* tools)
      const user = userText.trim();
      if (user === '') return;
      // Show the model the memories it ALREADY holds that are relevant to this exchange, so it can
      // UPDATE/MERGE/skip instead of adding yet another paraphrase of a fact it already knows. The
      // findSimilar guard in applyOne only catches near-identical (≥0.85 cosine); this catches the
      // "same point, different wording" redundancy (e.g. "Alex" vs "Alex Kim, the operator").
      let existing: { id: number; body: string }[] = [];
      try {
        // searchSemantic (NOT retrieve): the curator is BROWSING what's already stored to avoid
        // paraphrase duplicates — it must not markUsed, or every curated turn would silently inflate
        // use_count/last_used_at on tangentially-related memories and skew future recall ranking.
        const rows = await this.service.searchSemantic(userId, `${user}\n${assistantText}`, 8);
        existing = rows.map((m) => ({ id: m.id, body: m.body }));
      } catch { /* retrieval is best-effort — fall back to a blind curation pass */ }
      const budget = this.opBudget();
      if (budget === 0) return; // automatic writing switched off — do not even ask the model
      const { text } = await inf.decide(buildPrompt(user, assistantText, existing));
      const ops = parseOps(text);
      if (ops.length === 0) return; // model ran but distilled nothing durable this turn — expected + quiet
      // Record WHICH model distilled these facts on every add/update audit row.
      await this.apply(userId, ops.slice(0, budget), inf.model);
      this.logger?.info('memory curator applied memory op(s)', { userId, ops: Math.min(ops.length, budget), model: inf.model });
    } catch (err) {
      this.logger?.warn('memory curator failed', { userId, error: String(err) });
    }
  }

  /** Apply the capped op batch. Each op is independent — a single bad op is logged and skipped, never
   *  aborting the rest. `add` first checks findSimilar so a near-duplicate becomes an update, not a
   *  fresh row. Every mutation is audited as the agent. */
  private async apply(userId: number, ops: CuratorOp[], model: string): Promise<void> {
    for (const op of ops) {
      try {
        await this.applyOne(userId, op, model);
      } catch (err) {
        this.logger?.warn('memory curator op failed', { userId, action: op.action, error: String(err) });
      }
    }
  }

  private async applyOne(userId: number, op: CuratorOp, model: string): Promise<void> {
    switch (op.action) {
      case 'add': {
        const body = (op.body ?? '').trim();
        if (body === '') return;
        // Prefer updating a near-duplicate over piling on a paraphrase. This branch REPLACES the matched
        // memory's body, so it is only safe while the match is genuinely the same fact — see
        // `overwritesRicherMemory` for the one case where that assumption breaks.
        const near = await this.service.findSimilar(userId, body);
        const match = near[0];
        if (match && !overwritesRicherMemory(match.memory.body, body)) {
          this.store.update(userId, match.memory.id, { body, kind: op.kind, importance: op.importance },
            'agent', 'curator: refreshed near-duplicate', model);
          return;
        }
        const row = this.store.add(userId, { body, kind: op.kind, importance: op.importance, source: 'agent' },
          'agent', 'curator: new durable fact', model);
        // Auto-categorize the NEW memory only (not the near-duplicate refresh above).
        this.categorizer?.classifyNewMemory(userId, row.id, 'agent');
        return;
      }
      case 'update': {
        if (op.id === undefined) return;
        const body = op.body?.trim();
        this.store.update(userId, op.id,
          { body: body === '' ? undefined : body, kind: op.kind, importance: op.importance },
          'agent', 'curator: revised fact', model);
        return;
      }
      case 'delete': {
        if (op.id === undefined) return;
        this.store.softDelete(userId, op.id, 'agent', 'curator: obsolete fact');
        return;
      }
      case 'merge': {
        const ids = op.ids ?? [];
        const body = (op.body ?? '').trim();
        if (ids.length === 0 || body === '') return;
        this.store.merge(userId, ids, body, 'agent', 'curator: consolidated facts');
        return;
      }
    }
  }
}

/** The extraction prompt, modeled on mem0's fact-retrieval + update prompts: user-anchored facts only,
 *  strict source rules (the assistant's reply is NOT a knowledge source), few-shot calibration with
 *  empty-output examples, date grounding — the cheap model otherwise "helps" by saving trivia from the
 *  assistant's explanations. Output contract unchanged (JSON array of ops, parseOps). */
function buildPrompt(userText: string, assistantText: string, existing: { id: number; body: string }[] = []): string {
  const u = userText.slice(0, MAX_TEXT_CHARS);
  const a = assistantText.slice(0, MAX_TEXT_CHARS);
  const knownBlock = existing.length
    ? [
        '',
        'ALREADY-STORED relevant memories (id — text):',
        ...existing.map((m) => `#${m.id} — ${m.body}`),
        'ANTI-DUPLICATION RULE: if a new point is already covered by one of these, do NOT add a paraphrase.',
        'Instead "update" the closest one (more precise/complete wording), or "merge" several into one. Only',
        '"add" facts that are NOT already among the stored ones. Never keep two memories with the same meaning.',
        'If a new fact CONTRADICTS a stored memory, "update" it (or "delete" it if it is simply no longer true).',
      ]
    : [];
  return [
    'You are the long-term memory curator for the assistant Elowen. Below is ONE exchange (one user message',
    'and the assistant\'s reply). Extract durable, reusable facts ABOUT THE USER worth remembering in',
    `future sessions, and emit memory operations. Today's date is ${new Date().toISOString().slice(0, 10)}.`,
    '',
    'WHAT TO EXTRACT (each fact must be anchored to the user or their projects):',
    '- Stable preferences and working style (tools, stack, formatting, how they like answers)',
    '- Decisions the user made or approved ("User decided to use pnpm for project X")',
    '- Personal/professional details the user shared (name, role, people, recurring commitments)',
    '- Plans, goals and intentions the user stated',
    '- Infrastructure and external systems the assistant CANNOT simply read: deployment topology, service',
    '  ports and hostnames, third-party API behaviour and quirks, credentials location (never the secret',
    '  itself) — keep paths, ports, versions and commands verbatim',
    '- Non-obvious gotchas discovered in the user\'s environment that will bite again — but only where the',
    '  code alone would not reveal them',
    '- Feedback on how the assistant should work — BOTH corrections ("no, not that", "don\'t do X",',
    '  "stop doing that") AND confirmations that a non-obvious approach worked ("yes, exactly",',
    '  "perfect, keep doing that", an unusual choice accepted without pushback). Confirmations are',
    '  quieter than corrections and easy to miss — watch for them: saving only corrections avoids past',
    '  mistakes but drifts away from approaches the user has already validated',
    '',
    'SOURCE RULES:',
    '- The USER\'s message is the primary source of facts.',
    '- From the ASSISTANT\'s reply, extract ONLY: (a) durable outcomes of work done for the user this turn',
    '  that they will rely on later, and (b) specific recommendations or decisions the user accepted.',
    '  Frame them from the user\'s side ("User\'s daemon listens on :4400").',
    '- NEVER extract general knowledge, explanations, definitions, tutorials or trivia from the',
    '  assistant\'s reply. If the assistant explained how something works, that is NOT a memory.',
    '- Never store the same fact twice because the assistant echoed the user\'s own words back.',
    '',
    'DO NOT STORE:',
    '- Greetings, chit-chat, thanks, small talk',
    '- Transient state ("X is running", "not committed yet", "still debugging")',
    '- One-off debug steps, error messages, or the mechanics of this conversation',
    '- Meta-descriptions ("User asked about X", "Assistant explained Y", "Assistant fixed a bug") —',
    '  store the resulting durable fact or decision itself, or nothing',
    '- General world/technical knowledge that is not specific to this user',
    '- Anything that reads as a negative judgement of the user, or that is not relevant to their work',
    '- ANYTHING THE ASSISTANT COULD LOOK UP INSTEAD: the structure, file paths, module layout, naming',
    '  conventions or internals of a repository it can open; what a function or config key does; git',
    '  history, commit hashes and who-changed-what. Reading the code is authoritative and never goes',
    '  stale — a memory about it is a snapshot that quietly rots. This does NOT cover the external',
    '  systems above: a supplier API\'s behaviour cannot be read from the repo, so it stays worth saving.',
    '- The story of a debugging session or an incident: what broke, how it was traced, what fixed it. The',
    '  fix lives in the code and the commit message. If the incident left a durable RULE, save that rule',
    '  alone as "feedback" with its Why and How to apply — one sentence, not the narrative.',
    'These exclusions apply even when the user explicitly asks you to save something.',
    '',
    'EACH `body` MUST BE:',
    '- ONE fact. Aim for under 400 characters; 800 is the hard ceiling. If it does not fit, it is not one',
    '  fact — keep the part that will still be true next month and drop the rest.',
    '- Self-contained and understandable alone: name the subject ("User …", "Project <name> …"),',
    '  no bare pronouns',
    '- In the USER\'S OWN language (match the language of the exchange)',
    '- Concrete: keep names, paths, ports, versions and commands exactly as written; resolve relative',
    '  dates ("tomorrow") to absolute dates using today\'s date',
    '- For "feedback" (how-to-work guidance): lead with the rule itself, then the user\'s reason',
    '  ("Why: …") and when the guidance kicks in ("How to apply: …") — knowing why lets a future turn',
    '  judge an edge case instead of blindly following the rule',
    '',
    'Examples (calibration only — never copy their content):',
    'User: "Hi, how are you?" / Assistant: "Great, thanks!"',
    '-> []',
    'User: "How do JWT refresh tokens work?" / Assistant: <explanation of JWT>',
    '-> []   (general knowledge, nothing about the user)',
    'User: "Fix that failing test." / Assistant: "Done, the mock was stale."',
    '-> []   (one-off debug, nothing durable)',
    'User: "My name is Filip, I prefer short answers." / Assistant: "Noted, Filip!"',
    '-> [{"action":"add","body":"User\'s name is Filip; prefers short answers.","kind":"preference","importance":4}]',
    'User: "Switch the project to pnpm, npm eats too much disk." / Assistant: "Done — project now uses pnpm."',
    '-> [{"action":"add","body":"Project uses pnpm instead of npm (user\'s decision, disk usage).","kind":"decision","importance":3}]',
    'User: "No — stop rewriting whole test files, change only the assertion that broke." / Assistant: "Understood, minimal test edits from now on."',
    '-> [{"action":"add","body":"When fixing tests, change only the failing assertion — never rewrite the whole test file. Why: user keeps existing tests as documentation of intended behavior. How to apply: any edit to an existing test.","kind":"feedback","importance":4}]',
    'User: "Perfect, exactly — reading the real callers before touching a shared type is what I want, keep doing that." / Assistant: "Will do."',
    '-> [{"action":"add","body":"Read the real callers before changing a shared type. Why: user explicitly validated this approach. How to apply: any change to a type used from more than one module.","kind":"feedback","importance":4}]   (a quiet confirmation is as durable as a correction)',
    '',
    'An empty array [] is the EXPECTED output for most exchanges. When in doubt, return [].',
    'Judge yourself by this: a memory earns its place only if a future session would get the answer WRONG',
    'without it. If most turns you work on produce one, you are writing far too much — a store full of',
    'near-misses buries the few facts that matter and the user ends up deleting them by hand.',
    '',
    `Return ONLY a JSON array, at most ${MAX_OPS_PER_TURN} operations, with no other text. Format per operation:`,
    '{"action":"add","body":"<self-contained fact, in the user\'s language>","kind":"fact|preference|decision|feedback","importance":1-5}',
    '{"action":"update","id":<id>,"body":"<new text>"}',
    '{"action":"delete","id":<id>}',
    '{"action":"merge","ids":[<id>,...],"body":"<merged fact>"}',
    ...knownBlock,
    '',
    `User: ${u}`,
    '',
    `Assistant: ${a}`,
  ].join('\n');
}

/** Parse the model's reply into ops. Tolerates a ```json fence or surrounding prose by extracting the
 *  first JSON array. Returns [] on anything unparseable — the curator degrades to "nothing to do". */
function parseOps(text: string): CuratorOp[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const ops: CuratorOp[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const action = o.action;
    if (action !== 'add' && action !== 'update' && action !== 'delete' && action !== 'merge') continue;
    ops.push({
      action,
      id: typeof o.id === 'number' ? o.id : undefined,
      ids: Array.isArray(o.ids) ? o.ids.filter((x): x is number => typeof x === 'number') : undefined,
      body: typeof o.body === 'string' ? o.body : undefined,
      kind: typeof o.kind === 'string' ? o.kind : undefined,
      importance: typeof o.importance === 'number' ? o.importance : undefined,
    });
  }
  return ops;
}

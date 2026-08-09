---
title: Memory & Embeddings
slug: memory
order: 10
eyebrow: Everyday use
group: Everyday use
---

# Memory & Embeddings

Elowen's memory is a set of durable, reusable facts the agent stores and recalls across conversations. It is not a chat log — it holds stable preferences, architectural decisions, project details, and environment topology. When the agent starts work on a project or with a user it has history with, it recalls relevant memories to pick up where it left off.

Each memory carries a vitality score that tracks how actively it is used. Unused memories decay over time and are softly moved to the trash (recoverable); the agent can also search memory again mid-turn as the work evolves beyond what the opening message described.

## Storage

Memories live in SQLite, scoped personally per user. Each memory is a short self-contained sentence or two — not a paragraph, not a conversation excerpt. Retrieval is semantic (embedding similarity) when an embedding model is configured; otherwise it falls back to keyword matching. See [Configuration](configuration) for the settings overview.

### How recall works

At the start of a turn, the agent issues a recall with a query relevant to the current task. The system returns the top matching memories ranked by a combined score:

- **Semantic similarity** (weight 0.65) — cosine similarity between the query embedding and each memory's vector.
- **Importance** (weight 0.15) — linear 1..5 → 0..1.
- **Vitality** (weight 0.2) — the memory's vitality normalized to 0..1.

Only memories whose raw semantic similarity clears the relevance floor (default 0.30, adjustable in Settings → Elowen AI → Runtime) are eligible. Unrelated memories cannot ride importance or vitality into the prompt. The operator can retune the floor; it travels as an integer per mille (300 = 0.30).

Candidates are deduplicated (cosine ≥ 0.97 treated as the same memory) and packed into a character budget. By default up to 6 memories are injected, sharing a budget of ~1500 tokens (6000 characters). Both are operator-tunable in Settings → Elowen AI → Limits.

In the keyword fallback path (no embeddings configured, or the embed call fails), ranking uses keyword match (weight 0.6) + importance (0.25) + recency (0.15).

When the agent later references a recalled memory that names a specific file or config key, it verifies that file still exists before relying on the claim.

### Vitality and retention

Every memory has a vitality score from 0 to 100. It grows with usage (`use_count`, saturating at `n / (n + 5)`) and decays exponentially with time since last use. The decay half-life depends on importance:

| Importance | Half-life (days) |
|-----------:|:-----------------|
| 1 | 15 |
| 2 | 30 |
| 3 | 60 |
| 4 | 90 |
| 5 | never |

A memory at importance 5 is pinned: it never decays and is never evicted, regardless of the retention settings below.

**Eviction.** A daily sweep soft-deletes memories that are past their grace period (default 14 days from creation) and whose vitality has fallen below the vitality floor (default 10). Deleted memories remain in the trash with their full audit trail — an operator can restore a false positive. The sweep runs once every 24 hours.

**Configuration.** Retention is on by default. All knobs live in Settings → Elowen AI → Memory retention, its own editor beside Limits and Runtime:

| Setting | Default | Range | What it does |
|---------|---------|-------|--------------|
| Master switch | on | on/off | Off = no automatic eviction |
| Grace period | 14 days | 0–365 | New memories are exempt from eviction within this window |
| Vitality floor | 10 | 0–90 | Memories below this vitality are evicted (after the grace period) |
| Half-life — importance 1 | 15 days | 0–90 | `vitality *= 0.5^(age/halfLife)` |
| Half-life — importance 2 | 30 days | 0–90 | |
| Half-life — importance 3 | 60 days | 0–90 | |
| Half-life — importance 4 | 90 days | 0–90 | |
| Importance 5 | never | — | Shown read-only; never decays, never evicted |

Setting any half-life to 0 means "never decay" for that level.

### Recall during a turn

Turn-start recall searches from the user's opening message. Once the work moves on to files, tools and errors, the original message says little about what the agent is actually doing — and may produce no hits at all. The agent can search memory again mid-turn, guided by the recent work.

This live recall runs on a budget set in Settings → Elowen AI → Limits, under "Recall while working":

| Setting | Default | Range |
|---------|---------|-------|
| Searches per turn | 10 | 0–20 |
| Memories per batch | 2 | 0–10 |
| Turn byte budget | 20,000 UTF-8 bytes | 10,000–40,000 UTF-8 bytes |

Set searches per turn to 0 to disable mid-turn recall entirely. The search cap prevents unbounded embedding requests in a changing tool loop; the byte budget limits only context actually injected into the turn.

Live recall is **non-blocking**: the agent starts an embedding search and returns immediately, so the model is never stalled on a network call. The result arrives one model call later and is injected as a frozen block after the message that triggered the search. The memories are rendered as `<memory>` elements with id, kind, importance and age.

Each user can also turn mid-turn recall off for their own conversations in Account → Memory ("Recall while working"). It is on by default.

If the user sends a new message mid-turn (steering), the recall budget resets — the redirected turn gets fresh searches against the new instruction.

## Memory operations

| Operation | Behavior |
|-----------|----------|
| Search | Semantic or keyword lookup by query |
| Add | Store one fact; near-duplicate detection prevents piling up paraphrases |
| Update | Revise an existing memory by id — correct the fact, change kind, or re-rank importance |
| Merge | Collapse several redundant memories into one consolidated fact (sources are soft-deleted) |
| Delete | Soft-delete by id (retained for audit, no longer recalled) |
| List recent | Show the most recently stored memories |

Each memory carries a `kind` (fact, preference, decision) and an `importance` rank from 1 to 5.

## Categories and project scope

Categories are user-defined buckets that organize memories. Each has:

- **name** — short unique label
- **description** — the guide the auto-classifier matches memories against (make it specific)
- **icon** — optional lucide icon name
- **project scope** — optionally bound to a specific project

The auto-classifier sorts new memories into categories on insert. `MemoryRecategorize` re-runs the classifier — by default only over uncategorized memories, or over all memories with `all: true` (useful after adding or renaming categories).

Deleting a category does not delete its memories; they simply become uncategorized.

### Project-scoped memory

A category can be bound to a project (`Project scope` in the category editor). When the agent works inside a project directory, its recall scope is computed from the working directory:

- Categories bound to that project **and** global categories (no project binding) are included.
- Categories bound to *other* projects are excluded.
- Uncategorized memories are **never** recalled — they must belong to a category to surface.

A new memory added while working in a project is auto-classified into the categories available in that project's scope, which naturally includes the project's own categories.

The global scope (used outside any project directory) includes only categories with no project binding.

The binding itself is set in the Web UI: open the category in the Memory workspace and pick a project under **Project scope**. The agent's own `MemoryCategoryCreate` takes a name, a description and an icon — it does not bind a project, so a category the agent creates starts global until you scope it.

Example — creating a category for infrastructure facts:

```
MemoryCategoryCreate({
  name: "Infrastructure",
  description: "Deployment layout, service topology, server addresses, DNS records, and hosting details. No secrets.",
  icon: "Server"
})
```

The `description` field is what the classifier reads to decide whether a new memory belongs here, so make it specific about what fits and what does not.

## Embedding configuration

Configure embeddings in Settings > Memory:

| Field | Purpose |
|-------|---------|
| `providerId` | Reuses an existing brain provider's API key. Empty = embeddings disabled. |
| `model` | Embedding model name (recommended: `text-embedding-3-small`) |
| `baseUrl` | Optional endpoint override for self-hosted or proxy setups |
| `dimensions` | Vector dimensions (must match the model's output) |

When `providerId` is empty, semantic search is unavailable and memory retrieval falls back to keyword matching.

### Categorization model

The auto-classifier can run on a separate model. Its config (`providerId`, `model`, `baseUrl`) is independent of the embedding config, so you can use a cheap model for classification while keeping a stronger one for embeddings.

## Codebase indexing

The codebase plugin reuses the same embedding model for semantic code search. Three tools expose it:

| Tool | Purpose |
|------|---------|
| `CodebaseSearch` | Find code by meaning — locates where a concept lives without knowing exact identifiers |
| `CodebaseReindex` | Rebuild the index (incremental by default; `full` rebuilds from scratch). Admin only. |
| `CodebaseStatus` | Report indexed chunk/file counts, staleness, and model info per repository |

Configuration lives under the codebase plugin settings:

| Field | Purpose |
|-------|---------|
| `includeGlobs` | File patterns to index |
| `excludeGlobs` | Patterns to skip |
| `maxFileBytes` | Skip files larger than this |
| `chunkMaxChars` | Maximum characters per indexed chunk |
| `topK` | Default result count for searches |
| `relevanceFloor` | Minimum similarity score to include a result |
| `autoReindex` | Re-index automatically on file changes |

> If you change the embedding model, existing vectors become stale. Run `CodebaseReindex` with `full: true` to rebuild against the new model.

## Memory in the web UI

The `/memory` page provides:

- A searchable list of all stored memories with category, kind, and importance
- A brain map visualization showing relationships between memories
- A retrieval debug panel that shows exactly what the agent would recall for a given query

Retention settings are in Settings → Elowen AI → Memory retention. The recall and mid-turn recall budgets are in Settings → Elowen AI → Limits, and the relevance floor is in Runtime. Each user's own switch for mid-turn recall is in Account → Memory.

See [Brain & Chat](brain-chat) for how recalled memories feed into conversations.

## Scope and privacy

Memory is personal: each user's memories are isolated and only recalled in that user's sessions. Channel conversations do not surface one user's memories to another. Project-scoped memory further narrows recall: when working in a project, only memories from that project's categories and global categories are eligible. The agent never stores secrets, tokens, or credentials — only structural and preference facts.

## Best practices

- Store architectural decisions with enough context to recall *why*, not just *what*. Include the constraint that drove the decision.
- Store preferences only when stated as standing or expressed more than once. One-time requests are not preferences.
- Store environment and access topology (deployment layout, service names) but never secrets.
- Prefer updating an existing memory over adding a paraphrase. Merge similar memories when they accumulate.
- If a stored fact is contradicted by new evidence, update it — do not leave stale and correct versions coexisting.
- Recalled memories reflect what was true when written. If one names a file, function, or config key, verify it still exists before relying on it.
- Keep each memory self-contained: a reader with no other context should understand it in one pass.
- Bind project-specific categories to their project — this keeps infrastructure facts about one deployment from leaking into the wrong context.

[Next: Usage & Costs](usage-costs)

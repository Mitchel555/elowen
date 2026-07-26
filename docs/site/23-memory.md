---
title: Memory & Embeddings
slug: memory
order: 23
eyebrow: Automation
group: Reference
---

Elowen's memory is a set of durable, reusable facts the agent stores and recalls across conversations. It is not a chat log — it holds stable preferences, architectural decisions, project details, and environment topology. When the agent starts work on a project or with a user it has history with, it recalls relevant memories to pick up where it left off.

## Storage

Memories live in SQLite, scoped personally per user. Each memory is a short self-contained sentence or two — not a paragraph, not a conversation excerpt. Retrieval is semantic (embedding similarity) when an embedding model is configured; otherwise it falls back to keyword matching. See [Configuration](configuration) for the settings overview.

### How recall works

At the start of a turn, the agent issues a `MemorySearch` with a query relevant to the current task. The system returns the top matching memories ranked by similarity (or keyword overlap). The agent then treats those as context — verifying any that name specific files or configs before relying on them. Memories are injected into the system prompt so they persist across the conversation without re-querying.

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

## Categories

Categories are user-defined buckets that organize memories. Each has:

- **name** — short unique label
- **description** — the guide the auto-classifier matches memories against (make it specific)
- **icon** — optional lucide icon name

The auto-classifier sorts new memories into categories on insert. `MemoryRecategorize` re-runs the classifier — by default only over uncategorized memories, or over all memories with `all: true` (useful after adding or renaming categories).

Deleting a category does not delete its memories; they simply become uncategorized.

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

See [Brain & Chat](brain-chat) for how recalled memories feed into conversations.

## Scope and privacy

Memory is personal: each user's memories are isolated and only recalled in that user's sessions. Channel conversations do not surface one user's memories to another. The agent never stores secrets, tokens, or credentials — only structural and preference facts.

## Best practices

- Store architectural decisions with enough context to recall *why*, not just *what*. Include the constraint that drove the decision.
- Store preferences only when stated as standing or expressed more than once. One-time requests are not preferences.
- Store environment and access topology (deployment layout, service names) but never secrets.
- Prefer updating an existing memory over adding a paraphrase. Merge similar memories when they accumulate.
- If a stored fact is contradicted by new evidence, update it — do not leave stale and correct versions coexisting.
- Recalled memories reflect what was true when written. If one names a file, function, or config key, verify it still exists before relying on it.
- Keep each memory self-contained: a reader with no other context should understand it in one pass.

[Next: Deployment](deployment)

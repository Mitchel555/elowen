import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { splitFrontmatter } from '../../../shared/frontmatter.js';
import { logger } from '../../../shared/logger.js';
import type { ElowenApp, RouteContext } from '../../context.js';
import type { PluginRoutesShared } from './shared.js';

/** ── Skills (skills plugin): bundled .md skills ship inside the plugin folder, user skills live in
 *  the plugin's writable data dir (where the CreateSkill tool writes). Both the flat `<name>.md` and
 *  the Claude Agent-Skills directory layout `<name>/SKILL.md` are supported — the plugin loader reads
 *  either, so the API must too. A successful write/delete hot-reloads the plugins so new conversations
 *  pick the change up. ── */
export function registerSkillRoutes(app: ElowenApp, ctx: RouteContext, shared: PluginRoutesShared): void {
  const { d } = ctx;
  const { notAdmin } = shared;

  const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/; // mirrors NAME_RE in plugins/skills/index.mjs
  const userSkillsDir = (): string | null => (d.pluginDataRoot ? join(d.pluginDataRoot, 'skills') : null);
  // The loader only ever loads the FIRST `skills` plugin folder across the scan roots — mirror that.
  const bundledSkillsDir = (): string | null => {
    for (const dir of d.pluginDirs ?? []) {
      const pluginDir = join(dir, 'skills');
      if (existsSync(pluginDir)) return join(pluginDir, 'skills');
    }
    return null;
  };
  // Resolve a skill name to its file in a dir, accepting both layouts. Flat wins when both exist so a
  // stray `<name>.md` keeps shadowing the folder the way the loader sees it.
  const skillFileIn = (dir: string, name: string): string | null => {
    const flat = join(dir, `${name}.md`);
    if (existsSync(flat)) return flat;
    const nested = join(dir, name, 'SKILL.md');
    return existsSync(nested) ? nested : null;
  };
  // Every skill file in a dir, from both layouts. A folder only counts when it carries a SKILL.md —
  // support dirs (references/, scripts/) never appear as skills on their own.
  const enumerateSkills = (dir: string): { name: string; file: string }[] => {
    const out: { name: string; file: string }[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) out.push({ name: entry.name.replace(/\.md$/, ''), file: join(dir, entry.name) });
      else if (entry.isDirectory() && existsSync(join(dir, entry.name, 'SKILL.md'))) out.push({ name: entry.name, file: join(dir, entry.name, 'SKILL.md') });
    }
    return out;
  };
  // Split a skill file into its YAML frontmatter (as an object) and its markdown body. Unknown
  // frontmatter fields (license, allowed-tools, compatibility, metadata…) stay in the object so a write
  // preserves them verbatim instead of silently dropping them — the old regex builder rebuilt the whole
  // block from name+description and erased everything else. The block split itself is shared
  // (src/shared/frontmatter.ts); this wrapper adds the object form and trims the body for the editor.
  const splitSkillFile = (raw: string): { front: Record<string, unknown>; body: string } => {
    const { frontmatter, body } = splitFrontmatter(raw);
    let front: Record<string, unknown> = {};
    if (frontmatter) {
      try {
        const parsed = parseYaml(frontmatter);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) front = parsed as Record<string, unknown>;
      } catch { /* malformed frontmatter → treat as absent; the body stays editable */ }
    }
    return { front, body: body.replace(/^\n+/, '').replace(/\n+$/, '') };
  };
  const skillVersion = (front: Record<string, unknown>): number | null => {
    const meta = front.metadata;
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
      const v = (meta as Record<string, unknown>).version;
      if (typeof v === 'number') return v;
    }
    return null;
  };
  const readSkillFile = (file: string): { front: Record<string, unknown>; description: string; content: string; disableModelInvocation: boolean; version: number | null } => {
    const { front, body } = splitSkillFile(readFileSync(file, 'utf-8'));
    return {
      front,
      description: typeof front.description === 'string' ? front.description : '',
      content: body,
      disableModelInvocation: front['disable-model-invocation'] === true,
      version: skillVersion(front),
    };
  };
  // Overlay the fields the editor manages onto an existing frontmatter object, leaving every other key
  // (and its order) untouched. Serializing via the YAML library — not string interpolation — keeps a
  // description with a colon-space or a leading '#' valid.
  const applyManagedFields = (existing: Record<string, unknown>, name: string, description: string, disableModelInvocation: boolean): Record<string, unknown> => {
    const fm: Record<string, unknown> = { ...existing };
    fm.name = name;
    fm.description = description.replaceAll('\n', ' ');
    if (disableModelInvocation) fm['disable-model-invocation'] = true;
    else delete fm['disable-model-invocation'];
    return fm;
  };
  // Bump metadata.version in place (absent/invalid → 1).
  const bumpVersion = (fm: Record<string, unknown>): void => {
    const meta = (fm.metadata && typeof fm.metadata === 'object' && !Array.isArray(fm.metadata)) ? { ...(fm.metadata as Record<string, unknown>) } : {};
    meta.version = (typeof meta.version === 'number' ? meta.version : 0) + 1;
    fm.metadata = meta;
  };
  const buildSkillBody = (front: Record<string, unknown>, content: string): string => {
    return `---\n${stringifyYaml(front).trimEnd()}\n---\n\n${content}\n`;
  };

  // Skills feed the brain's system prompt, so a write hot-reloads the plugins — but the reload restarts
  // live sessions and reconnects platform adapters, and waits for any running brain turn to settle, so it
  // can take tens of seconds. The HTTP response must not block on that: the disk write already happened,
  // so answer and reload in the background. reloadPlugins() is serialized + idempotent; this coalescer
  // additionally folds a burst of rapid edits into one in-flight reload plus at most one follow-up, and
  // logs a failure instead of dropping it (nothing awaits the background reload).
  let reloadInFlight: Promise<void> | null = null;
  let reloadQueued = false;
  const reloadPluginsSoon = (): void => {
    const brain = d.brain;
    if (!brain) return;
    if (reloadInFlight) { reloadQueued = true; return; }
    const run = async (): Promise<void> => {
      do {
        reloadQueued = false;
        try { await brain.reloadPlugins(); }
        catch (e) { logger('plugins').error(`skills: background plugin reload failed: ${e instanceof Error ? e.message : String(e)}`); }
      } while (reloadQueued);
    };
    reloadInFlight = run().finally(() => { reloadInFlight = null; });
  };

  app.get('/plugins/skills/list', (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const out: { name: string; description: string; source: 'bundled' | 'user'; scope: string; location: string; active: boolean; canDelete: boolean; disableModelInvocation: boolean; version: number | null; content?: string }[] = [];
    for (const { dir, source } of [
      { dir: bundledSkillsDir(), source: 'bundled' as const },
      { dir: userSkillsDir(), source: 'user' as const },
    ]) {
      if (!dir || !existsSync(dir)) continue;
      for (const { name, file } of enumerateSkills(dir)) {
        const parsed = readSkillFile(file);
        out.push({
          name,
          description: parsed.description,
          source,
          scope: source === 'bundled' ? 'bundled/system' : 'user-defined',
          location: file,
          active: d.config.get().plugins.enabled.includes('skills'),
          canDelete: source === 'user',
          disableModelInvocation: parsed.disableModelInvocation,
          version: parsed.version,
          // User skills carry their body so the web editor can prefill an edit; bundled skills are
          // read-only, so their (larger) content is left off the list payload.
          ...(source === 'user' ? { content: parsed.content } : {}),
        });
      }
    }
    return c.json(out);
  });

  // Create (or overwrite) a user skill — the same file format the plugin's CreateSkill tool writes.
  // A name shadowing a bundled skill is refused: the plugin registers both copies and the duplicate
  // would silently fight over the system prompt.
  app.post('/plugins/skills', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const userDir = userSkillsDir();
    if (!userDir) return c.json({ error: 'plugin data dir unavailable' }, 503);
    const b = (await c.req.json().catch(() => null)) as { name?: unknown; description?: unknown; content?: unknown; disableModelInvocation?: unknown } | null;
    const name = typeof b?.name === 'string' ? b.name.trim() : '';
    const description = typeof b?.description === 'string' ? b.description.trim() : '';
    const content = typeof b?.content === 'string' ? b.content : '';
    const disableModelInvocation = b?.disableModelInvocation === true;
    if (!SKILL_NAME_RE.test(name)) return c.json({ error: 'name must be kebab-case (a-z, 0-9, dashes), max 64 chars' }, 400);
    if (description === '' || content.trim() === '') return c.json({ error: 'description and content must be non-empty' }, 400);
    const bundled = bundledSkillsDir();
    if (bundled && skillFileIn(bundled, name)) return c.json({ error: `a bundled skill named "${name}" already exists` }, 400);
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, `${name}.md`), buildSkillBody(applyManagedFields({}, name, description, disableModelInvocation), content), 'utf-8');
    reloadPluginsSoon(); // skills feed the brain's system prompt — apply live, without blocking the response
    return c.json({ ok: true }, 201);
  });

  // Edit a user skill (bundled skills are read-only). Partial: any of description/content/the
  // disable-model-invocation flag may be omitted to keep its current value. The flag toggle lets an
  // operator hide a skill from progressive disclosure while leaving `/skill:name` invocation intact.
  app.patch('/plugins/skills/:name', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const name = c.req.param('name');
    if (!SKILL_NAME_RE.test(name)) return c.json({ error: 'invalid skill name' }, 400);
    const bundled = bundledSkillsDir();
    if (bundled && skillFileIn(bundled, name)) return c.json({ error: 'bundled skills cannot be edited' }, 400);
    const userDir = userSkillsDir();
    const file = userDir ? skillFileIn(userDir, name) : null;
    if (!file) return c.json({ error: 'unknown skill' }, 404);
    const b = (await c.req.json().catch(() => null)) as { description?: unknown; content?: unknown; disableModelInvocation?: unknown } | null;
    const cur = readSkillFile(file);
    const description = typeof b?.description === 'string' ? b.description.trim() : cur.description;
    const content = typeof b?.content === 'string' ? b.content : cur.content;
    const disableModelInvocation = typeof b?.disableModelInvocation === 'boolean' ? b.disableModelInvocation : cur.disableModelInvocation;
    if (description === '' || content.trim() === '') return c.json({ error: 'description and content must be non-empty' }, 400);
    const fm = applyManagedFields(cur.front, name, description, disableModelInvocation);
    // Bump the revision only when the editable content actually changed — a bare disclosure toggle is an
    // operational flag, not a new version of the skill.
    if (description !== cur.description || content !== cur.content) bumpVersion(fm);
    writeFileSync(file, buildSkillBody(fm, content), 'utf-8');
    reloadPluginsSoon();
    return c.json({ ok: true });
  });

  app.delete('/plugins/skills/:name', async (c) => {
    if (notAdmin(c)) return c.json({ error: 'forbidden' }, 403);
    const name = c.req.param('name');
    if (!SKILL_NAME_RE.test(name)) return c.json({ error: 'invalid skill name' }, 400);
    const bundled = bundledSkillsDir();
    if (bundled && skillFileIn(bundled, name)) return c.json({ error: 'bundled skills cannot be deleted' }, 400);
    const userDir = userSkillsDir();
    const file = userDir ? skillFileIn(userDir, name) : null;
    if (!file) return c.json({ error: 'unknown skill' }, 404);
    unlinkSync(file);
    // A directory-form skill leaves its folder behind; drop it if now empty, but keep it (with any
    // references/scripts support files) if something remains.
    const parent = dirname(file);
    if (userDir && parent !== userDir) { try { rmdirSync(parent); } catch { /* not empty → keep */ } }
    reloadPluginsSoon();
    return c.json({ ok: true });
  });
}

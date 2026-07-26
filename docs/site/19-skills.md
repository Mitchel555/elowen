---
title: Skills
slug: skills
order: 19
eyebrow: Extend Elowen
group: Extending
---

# Skills

Skills are reusable markdown instruction files that give the agent specialized knowledge for specific tasks. Instead of repeating the same procedure or context in every conversation, you capture it once as a skill and the agent follows it automatically whenever a matching task comes up.

## How skills work

Each skill has a short description that acts as a trigger. When the agent receives a task matching that description, it reads the skill's instructions and applies them. Skills created or updated at runtime take effect from the next message onward — they are injected into the agent's system prompt live, no restart required.

The agent does not load every skill on every turn. It scans the available descriptions and reads only the relevant one, keeping context lean.

## Skill format

A skill is a folder containing a `SKILL.md` file with markdown instructions. The file can reference other files using relative paths — these resolve against the skill's own directory, so you can bundle reference material alongside the instructions.

```
my-skill/
  SKILL.md          # instructions (required)
  templates/        # optional supporting files
    pr-template.md
```

The `SKILL.md` body is freeform markdown: step-by-step procedures, checklists, conventions, command references — whatever the agent needs to perform the task consistently.

## Bundled vs user-created skills

| Type | Location | Managed by |
|------|----------|------------|
| Bundled | `dist/plugins/skills/skills/` | Elowen ships these; updated with releases |
| User-created | Instance `plugins-data/skills/` directory | You, via tools or files |

Bundled skills cover Elowen's own operations (control-plane management, skill creation itself). User-created skills are yours to add, edit, and remove freely.

## Creating a skill

Use the `CreateSkill` tool (admin only):

- **name** — kebab-case identifier, e.g. `deploy-checklist`
- **description** — one line stating when to use the skill
- **content** — the markdown instruction body

```
CreateSkill({
  name: "deploy-checklist",
  description: "Use before deploying any service to production.",
  content: "# Deploy Checklist\n\n1. Run `npm run check` ...\n2. ..."
})
```

The skill is immediately available from the next message.

## Managing skills

| Tool | Purpose |
|------|---------|
| `ListSkills` | List all available skills (bundled + user-created) |
| `DeleteSkill` | Remove a user-created skill by name (bundled skills cannot be deleted) |

To update a skill, call `CreateSkill` again with the same name — it overwrites the existing content.

## When to create a skill

Create a skill when you notice:

- A workflow repeating across conversations (deploy steps, release process, review checklist).
- A procedure you want the agent to follow consistently without re-explaining each time.
- Domain-specific conventions (naming rules, file layouts, testing requirements) that apply to a project.

Do not create skills for one-off instructions or information that belongs in project files like `AGENTS.md`.

## Example: deploy-checklist

```markdown
# Deploy Checklist

Before deploying any service to production:

1. Ensure all tests pass: `npm test`
2. Run type checking: `npm run typecheck`
3. Verify no uncommitted changes: `git status`
4. Tag the release: `git tag v<version>`
5. Push and confirm CI is green
6. Deploy: `./scripts/deploy.sh <service>`
7. Smoke-test the health endpoint
8. Notify the team channel

> Never deploy on a Friday after 16:00 unless it is a hotfix.
```

Save this as a skill named `deploy-checklist` with the description "Use before deploying any service to production" and the agent will follow it every time a deploy comes up.

Skills are one layer of Elowen's extension system. For the broader plugin architecture that skills live within, see [Plugins](plugins).

[Next: Plugin Development](plugin-dev)

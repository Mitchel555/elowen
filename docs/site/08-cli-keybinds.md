---
title: CLI Keybinds
slug: cli-keybinds
order: 8
eyebrow: Everyday use
group: Everyday use
---

# CLI Keybinds

Every keyboard shortcut in the CLI chat is rebindable. Run `/keybinds` to open
an interactive editor where you can reassign, unbind, or reset any action —
changes persist to `cli-prefs.json` and apply immediately, no restart needed.

## The editor

`/keybinds` opens a centered overlay listing every rebindable action with its
current chord. Navigate with arrow keys:

| Key | Effect |
| --- | --- |
| `↑` `↓` | Move through actions |
| `Enter` | Capture the next keypress as the new binding |
| `x` | Unbind the selected action |
| `r` | Reset to the default chord |
| `Esc` | Close the editor |

To bind a **leader sequence**, press Enter on an action, then press the leader
chord first (default `Ctrl+X`), then the second key. The editor shows a
two-step prompt: "press the leader first for a leader sequence".

## Available actions

| Action | Default | What it does |
| --- | --- | --- |
| `leader` | `ctrl+x` | Prefix for leader sequences |
| `quit` | `ctrl+c,ctrl+z` | Interrupt or quit |
| `mode_toggle` | `shift+tab,ctrl+tab` | Switch plan/code mode |
| `reasoning_cycle` | `ctrl+r` | Cycle reasoning effort |
| `stash` | `ctrl+s` | Stash current input |
| `subagent_cycle` | `ctrl+o` | Cycle sub-agent panel |
| `subagent_background` | `ctrl+b` | Background a sub-agent |
| `telemetry_toggle` | `ctrl+p` | Show/hide the telemetry rail |
| `queue_remove` | `leader x` | Remove last queued message |
| `help` | `leader h` | Show help overlay |
| `theme_picker` | `leader t` | Open theme picker |
| `model_picker` | `leader m` | Open model picker |
| `sessions_picker` | `leader l` | Open sessions picker |

## Chord syntax

Bindings use a small spec grammar:

- **Direct chord** — modifiers plus a base key: `ctrl+r`, `alt+enter`, `f2`,
  `shift+tab`. Available modifiers: `ctrl`, `shift`, `alt`, `super`.
- **Alternatives** — comma-separated chords that all trigger the action:
  `ctrl+c,ctrl+z`.
- **Leader sequence** — the word `leader` followed by a key: `leader t`.
  Press the leader chord, release, then press the key.
- **Unbind** — the literal `none` disables the action entirely.

> A chord can only belong to one action. If you bind the same chord to two
> actions, the editor warns and the earlier action in the list wins.

## Persistence

Overrides are stored in `cli-prefs.json` (same file as theme and statusline
preferences) under the `keybinds` key:

```json
{
  "keybinds": {
    "quit": "ctrl+q",
    "model_picker": "ctrl+k"
  }
}
```

Only genuine customizations are stored — rebinding an action back to its
default removes the override. Delete the file or the `keybinds` key to reset
everything at once.

## Related

- [CLI](cli) — the full terminal chat surface
- [Web UI](web-ui) — the browser equivalent (keybinds are CLI-only)

[Next: Brain & Chat](brain-chat)

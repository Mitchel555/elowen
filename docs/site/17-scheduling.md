---
title: Scheduling
slug: scheduling
order: 16
eyebrow: Automation
group: Automation
---

# Scheduling

Elowen can run prompts on a schedule — recurring jobs that fire like clockwork and one-shot wake-ups that check back on something later. Both execute as the brain's own conversations with full owner powers, so a scheduled prompt can read files, call tools, and deliver results to any channel.

## Access

Scheduling is admin-only. Only admin sessions can create, list, or remove jobs. Regular channel users cannot manage schedules.

## Recurring jobs

Create a recurring job with `CronAdd`. Each job needs three things:

| Parameter | Purpose |
|-----------|---------|
| `name` | Short human label shown in schedules and telemetry |
| `schedule` | When it fires (see formats below) |
| `prompt` | The instruction the brain runs each tick |

### Schedule formats

Two forms are accepted and detected automatically:

**Plain form** — readable intervals:

```
every 15m
every 2h
daily 07:30
weekly sun 20:00
```

**Cron expression** — standard 5-field syntax for anything the plain form cannot express:

```
0 9 * * 1-5      # weekdays at 09:00
*/5 * * * *      # every 5 minutes
0 0 1 * *        # first of each month at midnight
```

Reach for cron only when the plain form genuinely falls short.

### Options

| Option | Effect |
|--------|--------|
| `hours` | Active-hours window `"H-H"` (e.g. `"5-21"`). Outside it the job stays quiet. |
| `enabled` | Set `false` to create the job paused. |
| `model` | Run on a specific brain model (`"provider/model"`). Empty = server default. |
| `notifyChannelId` | Deliver results to a specific channel instead of the default notification channel. |
| `plain` | `true` strips the "job name" header — useful for persona messages in a dedicated channel. |
| `check` | A cheap shell command run before the prompt (see below). |

### The check guard

The `check` option is a shell command that runs before every scheduled tick. If it prints nothing or fails, the brain turn is skipped entirely — no model call, no cost. If it prints output, the brain runs and receives that output as context.

This is how you poll for new work cheaply:

```
check: "new-emails --since-last-run"
```

The collector script prints only when there is something new. Most ticks cost nothing; the brain fires only when there is actual work.

## One-shot wake-ups

`ScheduleWakeup` fires once and removes itself. It accepts a delay or an absolute time:

```
in 30s
in 20m
in 2h
at 18:30
```

When scheduled from a user conversation, the wake-up resumes that same conversation with its full context — so the follow-up lands where it was promised.

Use wake-ups to check back on things that change over time but do not notify you: a CI run, a deploy, an external queue. Pick the delay from how fast the watched thing actually changes.

> Do not stack a wake-up on top of background work that already notifies you (a background sub-agent or command). Both would fire, and the wake-up would be redundant. If you want a safety net for work that might hang, set a long fallback like "in 30m" rather than a short poll.

## Managing jobs

| Tool | Purpose |
|------|---------|
| `CronList` | List all jobs with id, name, schedule, last run, and last result |
| `CronRemove` | Cancel a job by id — it stops firing immediately |

## Delivery

Results go to the default notification channel unless you override with `notifyChannelId`. Use `plain: true` when the channel is dedicated to that job and the header line would be noise.

## Examples

**Daily summary at 07:30:**

```
CronAdd({
  name: "morning-summary",
  schedule: "daily 07:30",
  prompt: "Summarize yesterday's completed tasks and today's calendar."
})
```

**Periodic inbox check with a guard:**

```
CronAdd({
  name: "inbox-watch",
  schedule: "every 10m",
  hours: "7-22",
  check: "himalaya envelope list --page-size 1 --folder INBOX --unread",
  prompt: "New unread emails arrived. Summarize them and flag anything urgent."
})
```

**One-shot deploy verification:**

```
ScheduleWakeup({
  name: "verify-deploy",
  when: "in 5m",
  prompt: "Check that deploy #142 finished successfully; report the outcome."
})
```

[Next: Channels](channels)

---
description: Read a person back out of Fellowship: facts, closeness, recent occasions
argument-hint: <name>
allowed-tools:
  - Read
---

Read `$ARGUMENTS` out of Fellowship and report what is actually stored.

## The tools

Live, over the bundled MCP server, with underscores for dots:
`people_resolve_person`, `people_get`, `people_insights`, `people_timeline`.
If they are not listed, the server is not running: say so and stop.

## What this command does

1. `people.resolve_person` to turn the name into an id. `ambiguous` means more
   than one person answers to it: ask with the `detail` on each candidate, and
   never pick.
2. `people.get` for the stored facts, contacts, tags, custom values, allergies
   and dislikes.
3. `people.insights` for cadence, sentiment per occasion type, trend and
   outstanding favours.
4. `people.timeline` for the recent occasions and notes.

## Reporting rules

- **Report what is stored, not an impression of it.** This command reads; it
  does not infer.
- **A thin sample reports itself as thin.** The insight tools return
  `{ value: null, count, sufficient: false }` below their thresholds, and a
  trend with no window returns `direction: "insufficient"`. Render that as "not
  enough data" and never fill it in from somewhere else, from the chat history,
  or from a guess.
- Two logged occasions are not a pattern. Say "two occasions", not "usually".
- Closeness is a derived number on a scale of -100 to 100, cached and recomputed
  from the occasions. Quote it with the occasion count behind it, so a score of
  40 off three events does not read like a score of 40 off thirty.
- Allergies and dislikes get said out loud, every time, when the question is
  anything like where to eat or what to give someone.

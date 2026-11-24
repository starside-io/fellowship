---
description: Score or refresh the personality radar for everyone with imported chats
argument-hint: "[name] (omit for everyone who is stale)"
allowed-tools:
  - Read
---

Score the personality radar from the chats, for `$ARGUMENTS` or, with no
argument, for everyone whose radar is missing or older than their messages.

## The tools

Live, over the bundled MCP server, with underscores for dots:
`people_personality_status`, `people_resolve_person`, `people_draft_context`,
`people_propose_draft`. If they are not listed, the server is not running: say
so and stop.

## What this command does

1. With a name: `people.resolve_person`, and stop to ask if it is ambiguous.
   Without one: `people.personality_status` with `onlyStale: true`, which lists
   everyone with messages whose radar is missing or behind their last message,
   busiest first.
2. For each person, one at a time:
   1. `people.draft_context` with `{ job: "personality", personId }`. It hands
      back the axes, the rules, the material (history, chat figures, notes,
      recent messages) and the JSON schema.
   2. Read it and score the axes the material supports, each with a quote or a
      count as evidence. Leave out an axis the material says nothing about.
   3. `people.propose_draft` with the same target and your answer as `draft`.
3. Report, per person, how many axes went into the queue, and any `rejected`
   reason word for word.

## Rules

- **Nothing is written by this command.** Every radar waits in Review until the
  owner confirms it there, or tells you to with `people.decide` after seeing it.
- Never put a Myers-Briggs type, a clinical label or an attachment style in the
  evidence: the draft is refused. The owner records a type on the card.
- A thin history is a reason to score fewer axes with low confidence, not to
  fill the chart.
- Work through people in order and keep going after a rejection; say at the end
  who was skipped and why.

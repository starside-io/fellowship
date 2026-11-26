---
name: fellowship
description: Work with Fellowship, the local-first tracker of the people in the user's life. Use this skill whenever the user wants to record or read a person, log an occasion they shared with someone, ask how a relationship is going, work out who they have not seen in a while, profile someone from a WhatsApp or chat export, or write a sketch of how someone is and how to spend time with them well. Trigger on "add X to my people", "log that I saw X", "what do I know about X", "who have I not seen lately", "how are things with X", "import this chat", "profile X from our messages", "write a sketch of X", or a handed-over chat export file. Also use before any write to Fellowship, because every write carries provenance rules and lands unconfirmed.
---

# Fellowship

A local-first tracker of the people in one person's life: who they are, what
they like, what to avoid, the occasions they shared, and the derived strength of
every connection. One user, one SQLite file, no network.

Read [`docs/SPEC.md`](../../docs/SPEC.md) for the whole design. This skill is
the procedure for using it.

## State

The tools are live over the bundled MCP server, where their names carry
underscores rather than dots. Fellowship is model agnostic: it never calls a
model itself. You are the model. Whatever you run on, you read the material
through the tools, do the reasoning, and hand drafts back through the same
tools every other model uses. This skill documents
the procedure and nothing in it should be simulated: do not invent storage, do
not write people into a scratch file, and do not answer a question about a
person as though a database had been read.

## The three write classes

Everything in Fellowship is one of three things, and the difference is the whole
point of the design.

| Class | Examples | Rule |
| --- | --- | --- |
| **read** | `people.resolve_person`, `people.search`, `people.get`, `people.insights`, `people.chat_insights`, `people.read_messages`, `people.graph` | Free to call. Writes nothing. |
| **write, unconfirmed** | `people.create`, `people.add_note`, `people.log_interaction`, `people.set_tags`, `people.import_chat` | Lands in the review queue carrying its provenance. The user confirms later, in the UI. |
| **needs an explicit yes** | `people.attach_socials`, `people.write_sketch`, `people.set_personality`, `people.set_picture`, `people.import`, `people.decide` | Requires `confirmedByUser: true`, which is set **only** after the user says yes in the conversation, to a specific thing they have seen in full. |
| **draft for review** | `people.draft_context`, `people.propose_draft`, `people.review` | Your drafts go to the review queue and wait. The user confirms there, in the UI, or tells you to with `people.decide`. |

Never set `confirmedByUser` because the user asked for the task. They have to
approve the actual content. Showing a sketch and asking "shall I save this" is
the gate; "write a sketch of Sam" is not.

## Order of work, always

1. **Resolve the name before anything.** `people.resolve_person` on every
   name, every time, and use the id it returns. `status: "ambiguous"` means two
   or more people answer to that name: put the candidates to the user with the
   `detail` on each, and use the id they pick. Never pick for them, and never
   fall back to the first search hit. `status: "none"` means they are not here
   yet, which is `people.create`, not a guessed id. `people.search` is for
   finding things other than a person: tags, occasions, notes, message text.
   Two records for one human is the mess that cannot be cleanly undone.
2. **Read the field keys.** `people.fields` before mapping a fact, so nothing
   invents a field.
3. **Read before writing a judgement.** `people.get` and `people.insights`
   before answering a question about someone, and before drafting a sketch.
4. **Write one thing at a time**, and report what landed.

## Logging an occasion

An occasion carries **everyone who was there**, not just the person being
discussed.

Links only exist between people who share an occasion. So an occasion logged
from a one-to-one chat with two participants can never link anyone to anyone but
the user. In the reference implementation, importing eight chats that way
produced 313 occasions and a graph where every single link touched the owner and
none joined two friends.

So: when an occasion comes out of a chat, scan that day's messages for the other
people already in the database, under **every name they go by**, nicknames
included. Add the ones the messages place in the room.

**A mention is not presence.** Texted, posted, said, called, could not come, and
is overseas all mean absent.

**Never add a bystander to a conflict.** A participant inherits the occasion's
sentiment, so a friend who merely stood there would take the negative score on
their own link to the user.

Sentiment is a coarse scale: `-2` bad, `-1` tense, `0` neutral, `+1` good, `+2`
great. Deliberately coarse so logging stays fast. When the messages do not say
how something went, leave sentiment out rather than guessing at it.

## Drafting for review

When the user wants a draft they can read later rather than approve in this
conversation, propose it instead of writing it. Four jobs: `sketch` for one
person, `senders` for the unmapped names in an imported chat, `facts` for text
the user pasted about someone, and `recap` for what happened in a chat since
the last recap.

1. `people.draft_context` with the job and its target. It returns `system`
   (how to behave), `prompt` (the material), and `schema` (the JSON shape your
   answer must fit). Read all three. The rules in `system` are enforced again
   when you hand the answer back, so following them is not optional.
2. Reason over the material yourself and write an answer that fits `schema`.
   For a sketch, `sources` is required and non-empty: name the history and
   the chats you read.
3. `people.propose_draft` with the same target and your answer as `draft`. It
   validates the shape, drops any person or field that does not exist and any
   sketch that reads as a diagnosis, and queues the rest. It tells you what
   was queued and what was dropped and why.
4. Tell the user it is waiting in Review, and what was dropped. Nothing has
   been written.
5. If the user reads a proposal in this conversation and says yes or no to it,
   `people.review` lists it and `people.decide` records their decision.
   Confirming runs the write the proposal names. Never decide on their behalf.

### Recapping a chat

Use `recap` when the user has imported or re-imported a chat and wants the
records brought up to date: "update from my chat with X", "what's new with X".

1. `people.draft_context` with `{ job: "recap", conversationId }`. It reads the
   messages after the last recap of that chat (or from `since` if you pass
   one), up to `messageLimit`, and returns the people in the chat with their
   ids, the events already logged around that window, and the interests,
   dislikes and allergies already recorded. It also returns `target`.
2. Answer with a `summary`, the `events` that happened (a mention is not
   presence; plans count only once they happened) and the new `preferences`,
   each with a quote copied from the messages.
3. `people.propose_draft` with `target` exactly as the context returned it.
   The module drops anything already logged, already proposed or already
   discarded, flags near duplicates and contradictions, and queues the rest
   under one group whose heading shows the score each link would reach if all
   of it were confirmed. The score is computed from the events; it is never
   proposed on its own.
4. If `material.remaining` is above zero, there are more messages after the
   window: offer to run the next one. Each run starts where the last stopped.

A refusal from `people.propose_draft` means your answer was the wrong shape:
fix it against `schema` and propose again, rather than dropping the field that
failed.

## Profiling from a chat export

The richest evidence available, because it is what the person actually wrote
rather than what the user remembers. In order, no step skipped:

1. `people.import_chat` with `filePath`: the host reads the WhatsApp `.txt` or
   `.zip` export off disk itself, so a year of messages never passes through the
   conversation. Pass `text` only for a short chat the user pasted. Files are read
   from Downloads, Desktop and Documents, or the folders `FELLOWSHIP_IMPORT_ROOTS`
   lists. Never split a chat into parts: a re-import of a chat with the same
   person rewrites that conversation, so each part would replace the one before.
2. `people.map_sender` binds each sender name in the export to a person record.
   Search for each sender first. Ask when a name is ambiguous. With many
   unmapped senders, draft the matches instead (`people.draft_context` with
   job `senders`) and let the user confirm them one at a time in Review.
3. `people.chat_insights` gives the numbers: volume each way, who starts after a
   six hour silence, reply latency median and p90 both ways, cadence, longest
   silence, a ninety day trend, hour and weekday rhythm. Every figure carries the
   count it came from.
4. `people.read_messages` gives the qualitative half: a capped page of the real
   text, which is what shows how someone actually talks.
5. The sketch goes in through `people.write_sketch`, with the conversation named
   in its sources.

## What a sketch may contain

Observable communication behaviour, with a quote or a number behind every single
claim: reply speed, who starts after a silence, who repairs after friction,
whether they ask questions back, how they handle plans, message length, emoji
and voice note habits, what they bring up unprompted.

**What it may never contain:** a clinical or psychological read. No attachment
styles, no diagnoses, no disorders, no inferred mental health, no personality
typing. The user has explicitly rejected Myers-Briggs style labels as useless
for deciding where to take someone to dinner.

"Slow to reply" is an observation. "Avoidant" is a diagnosis wearing an
observation's clothes. If a claim cannot carry a quote or a number, it does not
go in.

The user's own history outweighs any public profile, because what someone posts
is their curated self, not how they are with the user.

`sources` must be non-empty. A sketch with no stated sources is a horoscope.

Thin history is stated as thin, never padded. Two occasions are not a pattern.

## Thin samples

The insight tools return `{ value: null, count, sufficient: false }` when the
sample is below the threshold, and a trend with no window returns
`direction: "insufficient"`. That renders as "not enough data" and must never be
filled in from the conversation, from memory, or from a guess. A made-up number
is worse than a gap, because the gap is honest.

## Social profiles

Fellowship never fetches a social platform. Discovery is the model's job with
its own web tools.

`people.check_socials` normalizes each candidate, compares it against what is
stored, and returns a table plus a short lived token. Show the user that whole
table: platform, handle, URL, where it was found, a short quote from that page,
confidence, and what happens to any existing handle. Attach only what they
confirm, with `people.attach_socials`, which presents the token back so a set
the user never saw cannot be written.

If two accounts on one platform both look like the person, present both and let
the user pick. Do not attach both and do not pick for them.

Never scrape behind a login, reuse the user's cookies, drive a headless browser
at a platform, solve a CAPTCHA, or enumerate name variants across platforms to
see which exist. This can prove a handle is well formed and record who said it
was right and where it came from. It cannot prove an account belongs to a
person, and a confirmation means the user confirmed the row, never that a
platform verified it.

## The data is real

There is no staging copy. Real people's records are in that file.

- Never bulk delete, truncate, or run a replace-mode import against it.
- Create throwaway rows and delete them by id when done.
- A destructive confirmation names exactly what it will destroy, with counts,
  before it runs.
- Back up with `VACUUM INTO`, which is consistent on a live database. Copying a
  WAL database file while the app runs is not a backup.

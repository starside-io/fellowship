# Fellowship

Build spec for the People module as a standalone project.

**Fellowship**: a company of people bound together by a shared road. The word
carries its own meaning in English (companionship, a body of companions) and its
fantasy weight from the Fellowship of the Ring, a party held together by what
its members owe each other rather than by blood or contract. That is the thing
this app tracks. akai-ito was the red thread of fate; the fellowship is who the
thread runs between.

The name appears throughout this document. Swapping it is a find and replace
over `fellowship` and `@fellowship/`.

| | |
| --- | --- |
| Project | `fellowship` |
| Binary | `fellowship`, with `fsp` as a short alias |
| Module id in a host manifest | `people` |
| Namespaced id, if a registry needs one | `fellowship.people` |
| Packages | `@fellowship/core`, `@fellowship/ui`, `@fellowship/mini-host`, `@fellowship/connector-chat-export`, `@fellowship/graph` |
| Claude Code plugin | `fellowship`, this repo is its own marketplace |
| Reference implementation | akai-ito, a separate repo |

npm: the bare name `fellowship` is taken at 1.0.0, the `@fellowship` scope is
unused. For a local-first single-user app that may never publish, that is
cosmetic. If it ever ships, the scope is the one that matters and it is free.

akai-ito is not deprecated by this. It is the working reference: the scoring
formula, the insight thresholds, the socials registry, the WhatsApp parser and
the snapshot format are all proven there and are lifted, not reinvented.

---

## 1. What Fellowship is

A local-first tracker of the people in one person's life: who they are, what
they like, what to avoid, the occasions they shared, and the derived strength of
every connection. One user. No auth. No multi-tenancy. One SQLite file.

It runs two ways from one codebase:

| Mode | Host | Target |
| --- | --- | --- |
| Standalone app | `@fellowship/mini-host`, built here | **First and primary.** A usable app with no assistant and no host kernel. |
| Installed module | A host kernel, built elsewhere | Second. Same core, same tools, different ports behind them. |

The standalone app is the first milestone and the honest test of the contract.
If the module cannot run on the mini-host alone, the ports are wrong.

### Non-goals

- Multi-user, sharing, auth, sync, hosted deploy.
- Automated scraping. Text is pasted in or handed over as a file.
- Native mobile. Responsive web, then a desktop wrapper.
- A general CRM. This tracks personal relationships, not pipelines.

## 2. Stack, decided

| Concern | Choice | Why not the alternative |
| --- | --- | --- |
| Runtime | Node 26, pnpm 10.32.1 | Already what the machine runs. |
| Language | TypeScript, strict | |
| Database | **SQLite**, one file | No container, no port conflicts, no daemon. A personal tracker of 200 people has no business running Postgres. |
| ORM | **Prisma 6** | Continuity: the schema, the migrations, the seed and the snapshot round trip already exist and are tested. Drizzle has better SQLite ergonomics and sync access, and is the fallback if FTS5 and raw access become a running sore. Not worth the rewrite on day one. |
| UI | **Vite + React 19 + Tailwind + shadcn/ui** | Next.js is dropped on purpose. Server components read the database directly, which is exactly what the contract forbids: the UI must talk to the core only through tools. Fighting RSC to enforce that is worse than an SPA that cannot cheat. |
| Transport, UI to core | Single `POST /rpc` over Hono, in the same Node process | One tool registry, two transports (section 7). |
| Transport, assistant to core | MCP over stdio, `@modelcontextprotocol/sdk` | Already how akai-ito works. |
| Validation | zod 3.25 | Pinned to 3 to match the MCP SDK. zod 4 is a later, separate migration. |
| Rich text | Tiptap 3, stored as JSON | Unchanged. |
| Graph | react-force-graph-2d | Unchanged, own package. |
| Images | sharp | Re-encode to strip EXIF. Unchanged. |
| Tests | Vitest | The 399 existing tests port with the core. |
| Desktop packaging | Tauri, later | Not milestone one. The Hono process plus a browser tab is enough to start. |

One Node process serves the SPA, the RPC endpoint, the media routes and the MCP
stdio server, and owns the SQLite file. That process **is** the mini-host.

## 3. Storage

### The file

| | |
| --- | --- |
| Path, macOS | `~/Library/Application Support/fellowship/fellowship.db` |
| Path, Linux | `${XDG_DATA_HOME:-~/.local/share}/fellowship/fellowship.db` |
| Override | `FELLOWSHIP_DB_PATH` |
| Sidecars | `fellowship.db-wal`, `fellowship.db-shm`. All three move together or the database is corrupt. |

### Pragmas, set at boot on every connection

```sql
PRAGMA journal_mode = WAL;      -- readers do not block the writer
PRAGMA synchronous  = NORMAL;   -- WAL makes this safe enough for a local app
PRAGMA foreign_keys = ON;       -- assert it, do not assume the driver set it
PRAGMA busy_timeout = 5000;     -- wait rather than throw SQLITE_BUSY
```

Prisma does not expose pragmas, so these run as raw statements at startup, and
`foreign_keys` is asserted by reading it back. SQLite ships with foreign keys
off by default, and the entire cascade behaviour of the schema depends on them.
A boot check that reads `PRAGMA foreign_keys` and refuses to start on `0` is
cheap and catches a whole class of silent orphaning.

**Single writer.** WAL gives concurrent readers and one writer. The mini-host
serializes writes through one connection. This is a feature, not a limitation:
it structurally prevents the failure that destroyed real data in akai-ito, where
parallel agents wrote to the same live database at once.

### Postgres to SQLite, every blocker

| Blocker | Count | Where | Resolution |
| --- | --- | --- | --- |
| **Enums** | 11 | `ContactKind`, `TagKind`, `FieldType`, `FieldScope`, `EventType`, `TieType`, `ContactSource`, `ContactConfidence`, `ChatSource`, `AvatarSource`, `ProfileSource`, `FavourDirection` | Prisma does not support enums on SQLite. All become `String`, with the allowed set owned by the zod schema that already validates every tool input. The zod enum becomes the single source of truth and generates the TypeScript union. Add a `CHECK` constraint per column in a raw migration so the database refuses a bad value even if a write bypasses zod. |
| **Scalar lists** | 4 | `Person.commStyle`, `FieldDefinition.options`, `PersonProfile.sources`, `Circle` none | Not supported on SQLite. Become `Json` columns. Safe: a grep for `hasSome`, `hasEvery` and `push:` across the app returns **zero** hits, so nothing queries these by element. |
| **`mode: "insensitive"`** | 14 uses, 5 files | `actions/search.ts`, `actions/people.ts`, `actions/events.ts`, and two API routes | Not supported on SQLite. Drop the flag. SQLite's `LIKE` is already case-insensitive for ASCII, so `contains` keeps working for Latin names and silently stops working for accented ones. Fix properly with FTS5 (below) rather than relying on that. |
| **`@db.Date`** | 2 | `Person.birthday`, `Person.metOn` | No native date type. Keep as `DateTime` and normalize to midnight UTC in core, which is what the date-only intent means anyway. |
| **`Bytes`** | 1 | `Person.avatarImage` | BLOB works. Moved to its own table regardless (below). |
| **`Json`** | 4 | `Note.body`, `Event.description`, `CustomValue.value`, `PersonProfile.traits` | Stored as text. Works. |
| **Implicit many-to-many** | 5 | Person to Circle, Tag three ways, Note to Tag | Prisma generates join tables on SQLite. Works. |
| **Bulk upsert parameter limit** | 1 | `transfer/import.ts:621`, `mergeMessages` | The one piece of raw SQL in the codebase. `INSERT ... ON CONFLICT DO UPDATE` is valid SQLite and `excluded` resolves case-insensitively, so the statement itself ports. But `MESSAGE_CHUNK = 1000` across 8 columns binds 8000 parameters, against a ceiling of 32766 on modern SQLite and 999 on anything older. Drop the chunk to **500** for headroom and keep the measurement comment, which is the reason the raw SQL exists. |
| **Full text search** | 0 today | Search is `contains` | New. An FTS5 virtual table over `Person.displayName`, `firstName`, `lastName`, plus `Note` body text and `Message.body`. Prisma cannot model a virtual table, so it is created in a raw migration and queried with `$queryRaw`. This is the one place where raw SQL grows, and it buys real search over 21k messages. |

### Schema changes beyond the dialect

**Avatar bytes move out of `Person`.**

```prisma
model PersonAvatar {
  personId  String   @id
  image     Bytes
  mime      String
  source    String   // MANUAL | RESOLVER | ASSISTANT
  sourceUrl String?
  fetchedAt DateTime
  person    Person   @relation(fields: [personId], references: [id], onDelete: Cascade)
}
```

akai-ito keeps the bytes on `Person` and defends them with `omit: { avatarImage:
true }` in every single query, via a shared `personOmit`. Forgetting it breaks
the person page, and it has broken it. Splitting the table deletes the footgun
structurally: no query can select the bytes by accident because they are not in
the row. `Person` keeps `avatarColor` for the fallback and nothing else about
the image.

**`AppSetting` is dropped.** It holds only the avatar resolver list, which is
module config and belongs behind the settings port (section 8).

**`schemaVersion` starts at 1.** Fellowship's silo is its own lineage. The akai-ito
snapshot version 3 is an *import format*, not a shared schema version (section
10).

## 4. The silo

Everything in it, which is the akai-ito schema minus `AppSetting` and plus
`PersonAvatar`:

| Purpose | Tables |
| --- | --- |
| People and facts | `Person`, `PersonAvatar`, `ContactChannel`, `Tag`, `Circle`, `FieldDefinition`, `CustomValue`, `Favour` |
| Occasions | `Event`, `EventParticipant`, `Note` |
| Derived links | `Link`, `LinkStat` |
| Chat material | `Conversation`, `ConversationParticipant`, `Message` |
| Sketches | `PersonProfile` |
| Search | `person_fts`, `note_fts`, `message_fts` (FTS5 virtual, raw migration) |

Not in the silo, owned by the host: the review queue, the audit log, settings
values, and the connector cursors. The mini-host keeps those in a **second**
SQLite file, `host.db`, so a module uninstall or silo export never entangles
them. One file per owner.

## 5. The mini-host

Each port, and what the mini-host actually does for it.

| Port | Mini-host implementation |
| --- | --- |
| `storage.silo()` | A Prisma client bound to `fellowship.db`, with the pragmas asserted. The only writer. |
| `models.complete()` | **Optional.** The module never calls it: drafting goes through `people.draft_context` and `people.propose_draft`, so any model behind any assistant drafts the same way. The mini-host uses it for one built in drafter, for the standalone app with no assistant attached: HTTP to any OpenAI-compatible endpoint at `FELLOWSHIP_MODEL_URL`, default `http://localhost:11434/v1`. Left unconfigured, nothing breaks. |
| `models.embed()` | Same endpoint. Used for nothing in milestone one. Wired so FTS5 can be joined by a semantic pass later. |
| `review.propose()` | A `proposal` table in `host.db`: tool name, person ref, payload JSON, created time, state. The standalone UI renders it as one list with Confirm and Discard. |
| `bus` | An in-process emitter. Events are also appended to `host.db` so the UI can show a feed. No cross-process delivery in milestone one. |
| `connectors.pull()` | The chat-export connector only: a file the user picked, parsed, handed over as normalized items. |
| `privacy.redact()` | Pass-through, and it stays pass-through. See the `read_messages` decision in section 13. |
| `audit.log()` | Append-only `audit` table in `host.db`. Never updated, never deleted by the app. |
| `settings.get()` | `setting` table in `host.db`, defaults from `config.schema.json`, with the recompute hook in section 8. |
| `refs.resolve()` | Resolves `module://people/person/<id>` against the silo. Anything else returns `Unavailable`, because the mini-host hosts one module. |
| **`media`** (new port) | Fetch and store an image by URL, with the guard below. Returns bytes and metadata, never a URL the module then fetches itself. |

### The `media` port, and why it is a port

`lib/avatar-fetch.ts` in akai-ito is the only outbound fetch in the whole app,
and it carries: https only, no credentials in the URL, every private and
loopback notation refused (`2130706433`, `0x7f000001`, `127.1` included), DNS
answers checked rather than trusted, at most 3 redirects with the same check on
each hop, a 10 second timeout, a 5MB cap enforced while the body streams, an
image content-type allowlist, and a re-encode through sharp that drops EXIF.

That is SSRF defence. It is not people-domain logic, every module that ever
fetches anything needs exactly it, and no module should write it twice. So it
moves to the host, the code moves verbatim, and the people module declares
`"network": "none"`.

The mini-host ships it because the standalone app still needs it. Same code,
host side of the boundary.

### Media is not a tool

Tools return JSON. An avatar is 200KB of bytes. The mini-host serves them on a
plain route, `GET /media/person/:id/avatar`, which 404s when there is none, and
the UI builds the URL with a cache key from `fetchedAt` and skips the request
entirely when it is null. That is the akai-ito `personAvatarSrc` behaviour and
it stays.

## 6. Permissions the manifest declares

```json
"permissions": {
  "network": "none",
  "files": "none",
  "connectors": ["chat-export", "media"]
}
```

The people module itself reaches nothing. Its one outbound fetch and its one
disk read are both the host's, through connectors. That makes the install-time
permission summary read honestly, and a tracker of personal data that cannot
reach the network is a far easier thing to approve.

## 7. Tool surface

One registry, two transports:

```
zod schemas  ->  tool definitions  ->  registry
                                        |- POST /rpc        (the UI)
                                        '- MCP over stdio   (an assistant)
```

Both transports hit the same handlers with the same validation. The UI gets no
privileged path, which is the point: anything the UI can do, an assistant can
do, and both are audited the same way.

38 tools: 17 read, 16 write, 5 that need an explicit yes. akai-ito exposes 16
over MCP and reaches the rest through **76 server actions across 17 files,
about 2800 lines**, which the UI calls directly. None of those survive as such.
They become the handler bodies behind these tools.

**Model agnostic.** The module never calls a model. Four of the tools exist so
that whatever model is driving, behind whatever assistant, does the reasoning
and the module only supplies material and enforces rules: `draft_context` out,
`propose_draft` in, `review` and `decide` for the owner. Every model meets the
same gates because the module cannot tell them apart.

### Read, 17

| Tool | Notes |
| --- | --- |
| `people.search` | FTS5 backed. |
| `people.get` | Never returns avatar bytes. |
| `people.self` | The single `isSelf` record. |
| `people.fields` | Field definitions, so extraction cannot invent keys. |
| `people.activity` | Recent events plus people who have gone quiet. |
| `people.timeline` | One person's events and notes. |
| `people.insights` | Cadence, sentiment per event type, trend, favours. Reports null below threshold. |
| `people.chat_insights` | Volume, initiation, reply latency, cadence, rhythm, last word. |
| `people.read_messages` | Real message text, capped, newest first. Audited. |
| `people.graph` | Nodes, edges, synthesized implicit `KNOWS_OF` threads. Payload only, never written back. |
| `people.social_platforms` | The registry: handle patterns, URL shapes, the awkward hosts. |
| `people.check_socials` | Writes nothing. Issues the binding token. |
| `people.avatar_candidates` | The picture URLs the enabled resolvers would try for a person, built from their own handles. Fetches nothing. |
| `people.resolve_person` | A name to one id, or to the candidates that answer to it with the facts that tell them apart. Several matches are a question for the owner, never a pick. |
| `people.export` | The full snapshot, for the user's own backup. |
| `people.draft_context` | Material, rules and JSON schema for one drafting job: `senders`, `facts`, `sketch` or `recap`. Writes nothing. |
| `people.review` | The proposals waiting for the owner, each naming the tool it would run and the payload. |

### Write, unconfirmed, 16

`people.create`, `people.update`, `people.archive`, `people.add_note`,
`people.log_interaction`, `people.set_contacts`, `people.set_tags`,
`people.set_circles`, `people.set_custom_values`, `people.set_fields`,
`people.set_favour`, `people.set_link`, `people.import_chat`,
`people.map_sender`, `people.set_resolvers`, `people.propose_draft`

`people.propose_draft` writes only to the review queue. It validates a model's
answer against the job's schema, drops people and fields that do not exist and
sketches that read as a diagnosis, and queues what survives. A `recap` also
drops every event and preference already in the silo or already in the queue,
pending or discarded, and groups what is left under one heading carrying the
projected score of each link it touches.

Anything an assistant writes lands with its provenance and stays unconfirmed:
contacts carry `source`, `sourceUrl`, `confidence`, `verifiedAt`; sketches carry
`source`, `generatedAt`, `confirmedAt`. Only the user confirms. A manual edit
takes the row over and drops the citations, resetting a contact to `MANUAL` with
`sourceUrl`, `confidence` and `verifiedAt` cleared.

### Needs OK, 5

| Tool | Gate |
| --- | --- |
| `people.attach_socials` | `confirmedByUser: z.literal(true)` **and** an unexpired HMAC `checkToken` over the person id and the normalized candidate set, 15 minute TTL. |
| `people.write_sketch` | `confirmedByUser: z.literal(true)`, `sources` non-empty. |
| `people.set_picture` | `confirmedByUser: z.literal(true)`. Goes through the `media` port. |
| `people.import` | `confirmedByUser: z.literal(true)`. Replace mode names the row counts it will destroy. |
| `people.decide` | `confirmedByUser: z.literal(true)`. Confirming runs the tool the proposal names with the payload the owner read, and only a write that succeeded marks it confirmed. A proposal may not name `decide` or `propose_draft`. |

### Guardrails to re-enforce, not inherit

akai-ito enforces these in its 20 API route files, behind `requireApiAuth`,
`readJsonBody`, `safeParse`, `zodErrorResponse`. **Those routes do not exist in
Fellowship.** The core and the tools are one package and the host calls the handlers
directly. Every gate below has to be re-asserted in the handler, with a test,
or it silently stops existing:

1. `confirmedByUser: z.literal(true)` on all five needs-OK tools.
2. The HMAC check token, bound to the exact candidate set.
3. Search before create: `log_interaction` returns unmatched names rather than
   creating people.
4. `sources` non-empty on a sketch.
5. The single-self invariant on import.
6. `LinkStat.score` unwritable through any tool.
7. No avatar bytes in any tool response.

Keep the check token even though the mini-host review list shows the user the
set before writing. It costs one `createHmac` and it defends against a host that
renders a stale or substituted proposal, which is the failure it was written to
stop. The module should not have to trust that the host showed the truth. Note
that the key is `FELLOWSHIP_SECRET` when set and a per-process random value otherwise,
so a restart invalidates open tokens. Under a host that reloads modules this
happens more often. It is expected, not a bug: re-run `check_socials`.

## 8. Config

```json
{
  "halfLifeDays":   { "type": "number", "default": 180, "min": 30, "max": 1095 },
  "scoreScale":     { "type": "number", "default": 5,   "min": 1,  "max": 50 },
  "avatarResolvers":{ "type": "array",  "default": [] },
  "chatThresholds": { "type": "object" },
  "messageChunk":   { "type": "number", "default": 500 }
}
```

`contribution = effectiveSentiment * weight * 0.5^(daysSince / halfLifeDays)`,
then `clamp(round(scoreScale * sum), -100, 100)`. Six month half-life so an
argument two years ago barely registers. Scale 5 rather than 20 so a dense
friendship lands on the scale instead of pinning to the ceiling.

**`LinkStat.score` is a cache.** Change `halfLifeDays` or `scoreScale` in a
settings form and every cached score in the silo is wrong, silently, until the
next event mutation touches that pair. A pair with no new events never recovers.

So those two keys get a hook: a change triggers a full recompute of every link,
inside one transaction, **before** the new value counts as applied. At 200 people
that is milliseconds and should just block the save. The hook is part of the
config contract, not an afterthought in the UI.

## 9. Events

| Event | When |
| --- | --- |
| `people.interaction.logged` | `log_interaction` commits |
| `people.closeness.changed` | A recompute moves a score past a threshold |
| `people.person.created` | A new `Person` row |
| `people.sketch.written` | A sketch lands unconfirmed |
| `connector.chat.imported` | Listened to. Triggers sender-mapping suggestions. |

Recompute runs synchronously inside the mutation, as `recomputeForPeople` does
today: transaction, then recompute, then emit. Emitting before the commit lands
is the obvious bug to avoid, and with a single SQLite writer it is also the
easiest one to write by accident.

A pair that no longer shares an event loses its link unless a human curated it:
pinned, a tie other than `ACQUAINTANCE`, a `manualScore`, or notes. That rule
moves unchanged.

## 10. Getting the real data in

There is live personal data in akai-ito's Postgres. The bridge is the snapshot,
not a database migration.

1. Export from akai-ito Settings. That is `SNAPSHOT_VERSION = 3`, which round
   trips every table including avatar bytes as base64, contact provenance,
   sketches, favours, chats and messages.
2. `people.import` in Fellowship reads versions 1, 2 and 3, treating an absent column
   as "this file knows nothing about it" rather than defaulting to null.
3. The importer maps the 11 enums to validated strings, the 4 scalar lists to
   JSON, and the avatar bytes into `PersonAvatar`.

This is also the regression test: export from akai-ito, import into Fellowship, export
from Fellowship, diff. Anything that does not survive that round trip is a bug in the
transfer layer, which is precisely where this project has already been bitten
twice. Version 1 dropped sketches, favours, contact provenance, avatars and
settings while replace-mode deleted them first. Then the chat tables shipped
without the transfer layer at all, and because `Message.personId` is `SetNull` a
replace import would not have deleted 21,000 messages, it would have severed
every one of them from its person with no way back.

**The rule, carried over and made a gate:** add a table or a column, and it goes
into the snapshot schema, the exporter and the importer in the same commit. The
contract test in section 12 is what makes that stick this time.

## 11. UI

| Screen | Shape |
| --- | --- |
| Dashboard | Cards, table and graph switch, Cmd+K palette, filter bar, side rail with counts and recent events |
| Person | Header with contacts, tabs for Profile, Timeline, Connections, allergies and dislikes pinned in a warning box |
| Events | List with filters, calendar month view, create form with participant multi-select and sentiment capture |
| Graph | Force directed, nodes sized by closeness, edges coloured by score, date-range replay, circle isolation |
| Review | The host's proposal list: everything unconfirmed, one place |
| Settings | Form generated from the config schema, plus export and import |

The whole UI talks to the core through `POST /rpc` and nothing else. No direct
database access, no server actions, no privileged read path. The graph ships as
`@fellowship/graph`, its own package consuming `people.graph`, because it is the one
view that would be genuinely useful over a different data module later and it
already consumes a clean payload rather than the schema.

Design tokens and the `ds/` primitive layer port from akai-ito as is. Never
hardcode a palette colour.

## 12. Eval gates

Behavioural, run against the mini-host and later against a host kernel. Every
one corresponds to something that has already gone wrong or been explicitly
ruled out.

| Gate | Checks |
| --- | --- |
| Confirmation enforced | Each needs-OK tool refuses without `confirmedByUser: true`. No other path writes a sketch, a handle or a picture. |
| Token binding | `attach_socials` refuses a token issued for a different candidate set, and one over 15 minutes old. |
| No invented people | `log_interaction` returns unmatched names instead of creating rows. |
| Sketch discipline | A fixture set of diagnosis-shaped drafts (attachment styles, Myers-Briggs, "avoidant", inferred mental health) is rejected. `sources` non-empty. |
| Thin samples | Below-threshold input returns `{ value: null, count, sufficient: false }`, and a no-window trend returns `direction: "insufficient"`. Never a number. |
| Scoring fixtures | Known event sets produce known scores, decay included. `LinkStat.score` is unwritable through any tool. |
| Snapshot round trip | Every table and column survives export then import, avatar bytes included. Versions 1 and 2 still load. |
| Silo isolation | No read or write outside the silo. No network. No file access. |
| Pragmas | `foreign_keys` reads back as 1. WAL is on. |
| Migrations | Apply and roll back cleanly. |
| Optional deps missing | Everything works with no Memory module. Refs render as Locked. |
| Config recompute | Changing `halfLifeDays` leaves no stale cached score. |
| Avatar payload | No tool response contains image bytes. |
| Single writer | Two concurrent writes serialize rather than throwing `SQLITE_BUSY`. |

The 399 Vitest tests port with the core and stay unit tests. These gates are
separate and coarser, and a failing gate disables the module.

## 13. Decisions, settled

Previously open. Now answered, with the reason, so they do not get relitigated.

**`isSelf` stays in the people silo.** Exactly one `Person` has it. The graph
centres on it, closeness is defined against it, insights compare to it. A host
identity service was the alternative, and it loses: the self record carries
ordinary person facts (birthday, location, contacts) that no identity service
should be storing. Exposed as `people.self`. The single-self invariant is
enforced in the module, on import, as it is today. Archiving or deleting it is
refused.

**Messages live in the people silo.** The chat-export connector owns the parser,
the file read and the cursor. It hands over normalized rows. `Conversation`,
`ConversationParticipant` and `Message` are people tables. `computeReplyLatency`,
`countInitiations` and `computeRhythm` all need message-level reads joined
against `personId`, and doing that across a module boundary per query is slow,
needs a grant, and buys nothing.

**`read_messages` is not redacted.** It returns real message text because the
qualitative half of a sketch is how someone actually writes, and redaction
defeats the entire point. Instead: it is the one tool that requires an explicit
read grant even for a first-party specialist, and every call is audited with the
person id and the number of messages returned. The privacy port stays
pass-through so that nobody mistakes it for protection that is not there.

**The image fetch guard is a host service.** Not a module concern, not
reimplemented per module. Section 5.

**Drafting does three things, with any model.** Sender-name matching
suggestions, fact extraction from pasted text, and drafting a sketch. The
module does not run a model for any of them: `people.draft_context` hands the
material and a JSON schema to whichever model is driving, and
`people.propose_draft` checks the answer against the same schema. The schema
forces the sketch shape with a non-empty `sources` array, because "a sketch
with no stated sources is a horoscope" is already the rule and a schema
enforces what a prompt only requests. The model proposes; it never confirms.
Everything it writes goes through the review port. `people-lora` is optional:
a fine tune for a small local model behind the built in drafter, never a
requirement.

**The snapshot stays a module feature.** A host silo export is an opaque backup.
`people.export` and `people.import` are the user-facing "my data in a file I can
read" feature and the akai-ito bridge. Both are kept.

**What a sketch may contain.** Observable behaviour, with a quote or a number
behind every claim: reply speed, who starts after a silence, who repairs after
friction, whether they ask questions back, how they handle plans, message
length, emoji habits, what they bring up unprompted. No diagnosis, no attachment
styles, no inferred mental health, no personality typing. The owner rejected
Myers-Briggs style labels explicitly, as useless for deciding where to take
someone to dinner. "Slow to reply" is an observation; "avoidant" is a diagnosis
wearing an observation's clothes. Thin history is stated as thin, never padded,
and two events are never a pattern.

**Events from a chat carry everyone who was there.** Not just the two people in
the export. Links only exist between people who share an event, so events logged
from one-to-one exports can never link anyone to anyone but the owner: in
akai-ito that produced 313 events and a graph where every link touched the owner
and none joined two friends. When an event comes out of a chat, that day's
messages are scanned for other known people under every name they go by, and the
ones the messages place in the room are added. A mention is not presence: texted,
posted, said, could not come and is overseas all mean absent. Never add a
bystander to a `CONFLICT`, because a participant inherits the event's sentiment
and a friend who merely stood there would take the `-2` on their own link.

## 14. Repo layout

```
fellowship/
  package.json              pnpm workspace, packageManager pnpm@10.32.1
  packages/
    core/                   @fellowship/core
      src/
        schemas/            zod. The contract. Generates tools and types.
        tools/              one file per tool, 33 of them
        domain/
          scoring.ts        from lib/scoring, unchanged
          link-engine.ts
          insights.ts
          chat-insights.ts
          socials.ts        registry, normalization
          socials-check.ts  HMAC binding
          transfer/         snapshot, export, import
        storage/
          schema.prisma     SQLite
          migrations/
          fts.sql           FTS5 virtual tables, raw
        ports.ts            HostPorts, the only thing core knows about a host
        activate.ts         activate(ports) -> ModuleApi
      tests/                the 399, ported
      evals/                gates and fixtures
    mini-host/              @fellowship/mini-host
      src/
        ports/              storage, models, review, bus, audit, settings, media, refs
        rpc.ts              POST /rpc, Hono
        media.ts            GET /media/person/:id/avatar
        mcp.ts              stdio MCP server
        host.db             review queue, audit, settings, cursors
    ui/                     @fellowship/ui
      src/
        panel/              the web component, for a host
        app/                the standalone shell: dashboard, person, events, review, settings
        ds/                 design system primitives
        client.ts           the only thing that talks to /rpc
    graph/                  @fellowship/graph
    connector-chat-export/  @fellowship/connector-chat-export
      src/parse.ts          from lib/whatsapp/parse.ts
  adapters/
    people-lora/            weights
    grammars/               sketch shape, sender matching
  module.json               the host-contract manifest
  config.schema.json
  apps/
    fellowship/             the standalone binary: mini-host + ui, one process
  .claude-plugin/
    plugin.json             the Claude Code plugin manifest
    marketplace.json        this repo is also its own marketplace
  commands/                 /fellowship:add, /fellowship:open, /fellowship:who
  skills/fellowship/        SKILL.md, the people-tracking procedure
  .mcp.json.example         becomes .mcp.json at M3, when the server exists
  docs/SPEC.md              this document
```

`core/` imports no UI and no host. `ui/` imports no database. The dependency
arrow points one way, always.

### Two manifests, on purpose

`module.json` and `.claude-plugin/plugin.json` describe the same project to two
different hosts and neither can stand in for the other.

| | `module.json` | `.claude-plugin/plugin.json` |
| --- | --- | --- |
| Read by | The assistant's host kernel | Claude Code |
| Declares | Ports, silo, tools, events, permissions, adapters | Commands, skills, hooks, bundled MCP servers |
| Needed for | Installing Fellowship as a data module | Driving Fellowship from a Claude Code session |

They agree on one thing and must keep agreeing: the tool names. A command or
skill that calls a tool `module.json` does not list is a bug in whichever file
is behind.

## 15. The Claude Code plugin

This repo is a Claude Code plugin **and** a single-plugin marketplace, so it
installs from a local path with no registry in between:

```bash
claude plugin marketplace add ~/Personal/fellowship
```

Then `/plugin install fellowship@fellowship`. To add it to a marketplace file
you already maintain instead, the entry is in the README.

### Surfaces

| Surface | What it is | State |
| --- | --- | --- |
| `/fellowship:add` | Add a person, or add facts to one. The fast path: one line in, a person record out. | Scaffold |
| `/fellowship:open` | Start the mini-host and open the UI. | Scaffold |
| `/fellowship:who` | Read a person back: facts, closeness, recent occasions. | Scaffold |
| `skills/fellowship` | The procedure for the slower work: profiling from a chat export, writing a sketch, cross-referencing who was in the room. | Scaffold |
| `.mcp.json` | The bundled stdio MCP server, so the 38 tools appear in any session with the plugin enabled. | Example only until M3 |

The commands are deliberately thin. They collect the user's intent and call
tools. They do not contain domain logic, do not build SQL, and do not touch the
database file, because anything they could do that way an assistant could do
without the plugin, unaudited and ungated. Every write still lands unconfirmed
and still goes through the review queue.

**Why `.mcp.json.example` and not `.mcp.json`.** A plugin that declares an MCP
server which cannot start fails loudly on every session start. The server does
not exist until M3. Rename the file then, in the same commit that makes
`fellowship mcp` runnable, and not before.

## 16. Build order

| # | Milestone | Done when |
| --- | --- | --- |
| M0 | Workspace, SQLite schema, pragmas, migrations | `fellowship.db` exists, `PRAGMA foreign_keys` reads 1, Prisma client generates |
| M1 | Core extracted: scoring, link engine, both insight modules, socials, parser, snapshot. Tests ported | `pnpm test` green, zero imports of UI or host |
| M2 | The 33 tools over the storage port, with every gate from section 7 re-asserted | Eval gates green against a throwaway silo |
| M3 | Mini-host: ports, `/rpc`, media route, stdio MCP | An assistant can drive Fellowship with no UI at all |
| M4 | Import a real akai-ito v3 snapshot, round trip it back out and diff | No data loss, self invariant intact, 21k messages still attached to their people |
| M5 | Standalone UI: dashboard, person, events, review, settings | Daily use without touching SQL |
| M6 | Graph and connector split into their own packages | Graph renders from `people.graph` alone |
| M7 | FTS5 search, replacing `contains` | Accented names and message bodies are searchable |
| M8 | Model adapter: sender matching, fact extraction, sketch drafting, grammar constrained | A draft sketch appears in the review queue and nothing writes without a confirm |
| M9 | Tauri packaging | Double-clickable |

M0 to M5 is a working standalone app with no host kernel, no model and no
assistant required. Ship that before anything about a marketplace.

## 17. Operational notes

- **Backup**: `VACUUM INTO '<path>'` gives a consistent copy of a live
  database with no downtime. The standalone app runs it on a Settings click and
  before every import. `cp` of a WAL database while the app is running is not a
  backup.
- **Reset**: delete the three files. There is no `migrate reset` to run against
  a shared server, because there is no shared server.
- **Never bulk delete against the live file.** Real people's records are in it,
  and there is no staging copy. Create throwaway rows, delete them by id.
  Replace-mode import names the row counts it will destroy before it runs.
- **Prisma client caching**: the dev server holds its client. After a migration,
  restart it, or every route touching the new table fails with an unknown-model
  error. Same trap as akai-ito, same fix.
- **Em-dashes and en-dashes are banned** everywhere: code, comments, UI copy,
  docs, commit messages. Comma, period, parentheses or colon.
- UI copy is plain and professional. A destructive confirmation names exactly
  what it will destroy.

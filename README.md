# Fellowship

A local-first tracker of the people in your life: who they are, what they like,
what to avoid, the occasions you shared, and the derived strength of every
connection.

One user. No auth. No network. One SQLite file on your machine.

A company of people bound together by a shared road, which is the thing this
tracks. Successor to akai-ito, the red thread of fate, rebuilt as a module that
runs standalone or inside an assistant host.

**Status: M9 of M9.** The silo, the domain, the 38 tools, the standalone host
and the UI are built. Daily use needs no SQL and no assistant, and an assistant
can drive the same tools through the bundled MCP server.

It is model agnostic. The library never calls a model: whatever model is
driving, behind whatever assistant, reads the material through
`people.draft_context`, reasons, and proposes back through
`people.propose_draft`, and every draft waits in Review for a person to
confirm. A local model can do the same for the standalone app when no
assistant is attached, and is entirely optional. The full build spec is
[`docs/SPEC.md`](docs/SPEC.md), and the design system is
[`docs/DESIGN.md`](docs/DESIGN.md).

| Milestone | |
| --- | --- |
| M0 workspace, schema, pragmas, migrations | done |
| M1 the domain, 324 reference tests ported | done |
| M2 the 32 tools over the ports, gates green | done |
| M3 the mini-host: ports, `/rpc`, media, stdio MCP | done |
| M4 import a real akai-ito snapshot, round trip it, diff | done |
| M5 the standalone UI: dashboard, person, occasions, review, settings | done |
| M6 graph and connector in their own packages | done |
| M7 FTS5 search, replacing contains | done |
| M8 drafting with any model: senders, facts, sketches, all through review | done |
| M9 Tauri packaging: double clickable | done |

## Running it

```bash
pnpm install
pnpm build
pnpm start serve        # http://localhost:4319, or FELLOWSHIP_PORT
```

That one process is the whole app: the SQLite file, the tools, the HTTP
surface and the UI. It listens on 127.0.0.1 only: there is no auth in a single
user app, so an interface it listens on is an interface your records are
readable from. `FELLOWSHIP_HOST` widens it, deliberately. `pnpm dev` runs the
UI from Vite instead, on 4320, proxying to a host you started separately.

### As a desktop app

```bash
pnpm desktop
```

Builds `Fellowship.app` under `apps/desktop/src-tauri/target/release/bundle/macos/`.
It is a Tauri window over the same host `fellowship serve` runs, with Node
bundled beside it: double click it and it starts the host, opens the window,
and stops the host on quit. If a host is already answering on 4319 it reuses
that one instead of starting a second writer on the same file. The host's log
is `host.log` in the app's log folder.

`pnpm start status` prints where the two files are and what is in them, and
`pnpm start tools` lists the surface. Both files are created and migrated on
first run: there is no database server to start and no schema step to remember.

To check a snapshot before it goes anywhere near the real file:

```bash
pnpm start verify <snapshot.json>
```

It imports into a throwaway silo, exports back out, and diffs the two row by
row: what was lost, what was normalized and why, and whether the single self
invariant and the message attachments held. Then, to read one in or write one
out:

```bash
pnpm start import <snapshot.json>
```

```bash
pnpm start export <snapshot.json>
```

Merge is the default: the file wins row by row and nothing else is touched.
`--replace` wipes first, names the row counts it will destroy, and refuses
without `--yes`. Either way the cached closeness scores are rebuilt from the
events afterwards, because the ones in a file were computed by whatever wrote
it, at its own idea of now.

## What it does

- Structured facts about 50 to 200 people: contacts, interests, allergies,
  dislikes, custom fields, tags, circles.
- Notes and a timeline of occasions. One occasion holds many people.
- A force graph of not just your links to people, but the links between them,
  with a score per link that moves as occasions are logged and decays over time.
- Chat export import, so a profile can be written from what someone actually
  said rather than what you remember.
- 33 typed tools, so an assistant reads and writes the same data as the UI,
  through the same validation and the same gates.

## Install as a Claude Code plugin

This repo is both a plugin and a single-plugin marketplace, so it installs from
a local path:

```bash
claude plugin marketplace add ~/Personal/fellowship
```

Then install it:

```bash
/plugin install fellowship@fellowship
```

### Adding it to a marketplace file you already maintain

Paste this into that marketplace's `plugins` array and point `source` at
wherever this repo lives:

```json
{
  "name": "fellowship",
  "description": "Add people, log occasions, read closeness and insights, profile someone from a chat export.",
  "source": "/path/to/fellowship",
  "category": "productivity"
}
```

`source` takes a local path, or a git URL once this is pushed somewhere.

## What the plugin gives you

| Surface | Does |
| --- | --- |
| `/fellowship:add <name> [facts]` | Add a person, or add facts to one |
| `/fellowship:who <name>` | Read someone back: facts, closeness, recent occasions |
| `/fellowship:open [name]` | Start the host and report where it is. The UI lands at M5 |
| `skills/fellowship` | The procedure for the slower work: chat imports, sketches, who was in the room |
| `.mcp.json` | The bundled stdio MCP server: all 38 tools in any session with the plugin enabled |

The commands are thin on purpose. They collect intent and call tools. They hold
no domain logic and never touch the database file directly, because anything
they could do that way an assistant could do without the plugin, unaudited and
ungated.

## Design rules that are not obvious

- **Link scores are derived, never written by hand.**
  `contribution = effectiveSentiment * weight * 0.5^(daysSince / 180)`, then
  `clamp(round(5 * sum), -100, 100)`. Six month half-life, so an argument two
  years ago barely registers. The result is cached and recomputed on every
  occasion mutation.
- **An occasion carries everyone who was there**, not just the people in the
  chat it came from. Links only exist between people who share an occasion.
- **Anything an assistant writes lands unconfirmed**, carrying its provenance.
  Only the user confirms, and only on content they have seen in full.
- **Thin samples report null, not a number.** Below the threshold, an insight
  returns `{ value: null, count, sufficient: false }` and the UI says "not
  enough data".
- **Sketches describe observable behaviour with a quote or a number behind every
  claim.** No diagnoses, no attachment styles, no personality typing.
- **No em-dashes or en-dashes anywhere**: code, comments, UI copy, docs, commit
  messages.

## Layout

```
packages/core/         the module: schemas, domain, the 38 tools, the silo schema
packages/mini-host/    the host: ports, /rpc, the media route, the stdio MCP server
packages/ui/           the standalone shell and the design system
packages/graph/        the force directed view, from the people.graph payload alone
packages/connector-chat-export/   the export parser
apps/fellowship/       the binary: fellowship serve | mcp | status | tools
apps/desktop/          the Tauri shell: Fellowship.app
.claude-plugin/        plugin.json and marketplace.json
commands/              /fellowship:add, :who, :open
skills/fellowship/     SKILL.md
module.json            the host-contract manifest
config.schema.json     the config the host stores
docs/SPEC.md           the build spec, M0 to M9
.mcp.json              the bundled MCP server
```

## The two files

| | |
| --- | --- |
| Silo | `~/Library/Application Support/fellowship/fellowship.db`, or `FELLOWSHIP_DB_PATH` |
| Host | `host.db` beside it, or `FELLOWSHIP_HOST_DB_PATH` |

The silo holds the people. The host file holds the review queue, the audit log,
the settings and the connector cursors, so a module uninstall or a silo export
never entangles them. Both are WAL, and all three files of each move together
or the database is corrupt.

## License

MIT.

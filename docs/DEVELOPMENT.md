# Developing Fellowship

How the repo is put together, how to run every part of it, and the rules that
are not obvious from the code. The README covers what Fellowship does; this
covers how. The full build spec is [`SPEC.md`](SPEC.md) and the design system
is [`DESIGN.md`](DESIGN.md).

## Prerequisites

- Node 22 or later, and pnpm 10 (`corepack enable` gives you the pinned one).
- For the desktop app: Rust (stable) and the Tauri CLI (`cargo install tauri-cli`).
  The app is built and tested on macOS.

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

### One host at a time

The silo has one writer. `fellowship serve` takes `host.lock` beside `host.db`
and refuses to start while another live host holds it, naming the one that
does. The lock records how the host was started, which is what lets

```bash
pnpm start restart
```

stop it and start it again the same way, on the code as it is now. A host
started by the desktop app exits when the app does, crash included.

`/health` reports the host's pid and a surface fingerprint: a hash of every
tool's input schema and every migration checksum. Two hosts with the same
fingerprint answer the same calls against the same schema.

### As a desktop app

```bash
pnpm desktop
```

Builds `Fellowship.app` under `apps/desktop/src-tauri/target/release/bundle/macos/`.
It is a Tauri window over the same host `fellowship serve` runs, with Node
bundled beside it: double click it and it starts the host, opens the window,
and stops the host on quit. If a host is already answering on 4319 with the
same fingerprint it reuses that one; a host running other code is stopped and
replaced. The host's log is `host.log` in the app's log folder.

`.githooks/post-commit` rebuilds the app after any commit that changes app
code, then quits and reopens a running Fellowship.app and restarts a running
`fellowship serve`. Point git at it once with
`git config core.hooksPath .githooks`. The log is `.git/rebuild-app.log`.

### The CLI

| Command | Does |
| --- | --- |
| `serve [--port <n>]` | Start the host: `POST /rpc`, `/media`, `/host`, and the UI |
| `restart` | Stop the running host and start it again on this code |
| `mcp` | Start the stdio MCP server for an assistant |
| `whoami [--hook]` | Whether your own record is set up; `--hook` is what the plugin's SessionStart hook runs |
| `status` | Where the files are, and what is in them |
| `tools` | The tool surface, one line each |
| `paths` | The silo and host.db paths |
| `verify <file> [--keep]` | Import a snapshot into a throwaway silo, export it back, diff the two |
| `import <file> [--replace --yes]` | Read a snapshot into the live silo. Merge by default |
| `export <file>` | Write the whole silo to a snapshot file |
| `reindex` | Rebuild the three search indexes |

All run as `pnpm start <command>` from the repo root.

`verify` touches no live file. It reports what was lost, what was normalized
and why, and whether the single self invariant and the message attachments
held. `import` merges by default: the file wins row by row and nothing else is
touched. `--replace` wipes first, names the row counts it will destroy, and
refuses without `--yes`. Either way the cached closeness scores are rebuilt
from the events afterwards.

## Tests and checks

```bash
pnpm test         # every package
pnpm typecheck
pnpm db:check     # open the silo and prove the pragmas and enum checks took
```

The gate tests in `packages/core/tests/gates/` are the contract: confirmation,
isolation, no invented people, thin samples, sketch discipline, token binding,
and the tool surface itself. A change that needs a gate test edited is a change
to the contract, and says so in its commit.

Test data is invented: Jane Doe, John Doe, Sam Rivera and friends, in invented
places. Nothing copied from a real silo goes into a fixture, a comment or a doc.

## Schema changes

```bash
pnpm db:new <name>   # write a migration from the schema diff, enum checks injected
pnpm db:generate     # regenerate the Prisma client
```

Migrations are written with `prisma migrate diff` and applied by the host on
open, never with `migrate dev`: the enum CHECK constraints and the FTS5 tables
are raw SQL a Prisma schema cannot express, and `migrate dev` would offer to
reset a file that holds real personal data. An applied migration is frozen; its
checksum is recorded in every silo that ran it.

## Layout

```
packages/core/         the module: schemas, domain, the 42 tools, the silo schema
packages/mini-host/    the host: ports, /rpc, the media route, the lock, the stdio MCP server
packages/ui/           the standalone shell and the design system
packages/graph/        the force directed view, from the people.graph payload alone
packages/connector-chat-export/   the WhatsApp export parser
apps/fellowship/       the binary: fellowship serve | restart | mcp | status | tools | ...
apps/desktop/          the Tauri shell: Fellowship.app
.claude-plugin/        plugin.json and marketplace.json
commands/              /fellowship:setup, :add, :who, :open, :personalities
skills/                fellowship (the procedure) and setup (your own record)
hooks/hooks.json       SessionStart: offers /fellowship:setup while your own record is empty
module.json            the host contract manifest
config.schema.json     the config the host stores
docs/                  SPEC, DESIGN, this file, brand assets
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
or the database is corrupt. Both are created and migrated on first run.

`people.import_chat` with `filePath` has the host read a WhatsApp `.txt` or
`.zip` export off disk, from `~/Downloads`, `~/Desktop`, `~/Documents` and the
inbox only, or from the folders `FELLOWSHIP_IMPORT_ROOTS` lists (colon
separated). The path is resolved through symlinks before that check.

## The tool surface

42 tools in four classes, listed in `module.json` and by `pnpm start tools`.

| Class | Rule |
| --- | --- |
| read | Free to call. Writes nothing. |
| write | Writes directly, validated and audited. |
| needs-ok | Requires `confirmedByUser: true`, set only after the owner said yes to that exact content. |
| drafting | `draft_context` hands any model the material, the rules and a JSON schema; `propose_draft` validates the answer and queues it for review. |

The UI has no privileged path: `POST /rpc` and the MCP server go through the
same registry, the same validation and the same audit line.

## Design rules that are not obvious

- **The library never calls a model.** Whatever model drives an assistant reads
  the material through the drafting tools and proposes back through them.
- **Link scores are derived, never written by hand.**
  `contribution = effectiveSentiment * weight * 0.5^(daysSince / 180)`, then
  `clamp(round(5 * sum), -100, 100)`. Six month half-life. Cached and
  recomputed on every occasion mutation.
- **An occasion carries everyone who was there.** Links only exist between
  people who share an occasion.
- **Anything an assistant drafts lands in Review.** Only the owner confirms,
  and only on content they have seen in full.
- **Thin samples report null, not a number.** Below the threshold an insight
  returns `{ value: null, count, sufficient: false }`.
- **Sketches and personality evidence describe observable behaviour.** No
  diagnoses, no attachment styles, no type labels; a draft carrying one is
  refused. A Myers-Briggs type is the owner's to record by hand.
- **A birthday with no known year is stored in 1604** and exported with
  `X-APPLE-OMIT-YEAR`, which is how Contacts reads "no year".
- **No em-dashes or en-dashes anywhere**: code, comments, UI copy, docs, commit
  messages.
- **Commits use gitmoji and conventional commits**: `✨ feat(ui): subject`.

## How a plugin install runs

A plugin installed from a marketplace is a checkout with no `node_modules` and
no build output. `.mcp.json` and the SessionStart hook therefore run
`scripts/plugin-bootstrap.mjs` rather than the built files. It has no
dependencies of its own, and the first time it finds the build missing it runs
`pnpm install --frozen-lockfile`, `db:generate` and `pnpm build` through
corepack, logging to `.plugin-build.log`. The hook starts that build in the
background; the MCP server waits for it. In a checkout that is already built it
does nothing but hand over.

## The npm package

```bash
node scripts/pack-npm.mjs
```

Builds everything and assembles `@starside/fellowship` in `.npm-package/`,
then packs it. The CLI is the package's `fellowship` bin, so once published:

```bash
npx @starside/fellowship serve     # the app
npx @starside/fellowship mcp       # the MCP server, for any client
```

The workspace packages are not on npm, so they ride inside it as bundled
dependencies with their compiled `dist`. Their npm dependencies are ordinary
dependencies of the package, so native ones such as `sharp` install for the
machine that installs it. The Prisma client is generated by `postinstall`
against the schema core ships, for the same reason.

Publishing is a deliberate step, not part of the script:

```bash
npm publish .npm-package --access public
```

Once it is published, the plugin can drop the first run build and point
`.mcp.json` at `npx -y @starside/fellowship mcp`, the way neurowire does.

## Releases and the update check

The update check is off until the owner turns it on in Settings. When it is
on, the host asks GitHub for the newest release of `starside-io/fellowship` at
most once a day, caches the answer in `update-check.json` beside `host.db`, and
compares the release tag with the plugin version Claude Code recorded in
`~/.claude/plugins/installed_plugins.json`. A newer release shows an update
button in the app's rail, and the SessionStart hook offers it once per
session. The button runs `claude plugin marketplace update` and then
`claude plugin update`, then removes the older copies Claude Code keeps in its
plugin cache, and the new version loads when Claude Code restarts.

To ship one: bump `version` in `.claude-plugin/plugin.json` and `package.json`,
push, then publish a GitHub release tagged `v<version>`. Prereleases and
drafts are never offered.

## Install the plugin from a checkout

This repo is both a Claude Code plugin and a single plugin marketplace:

```bash
claude plugin marketplace add /path/to/fellowship
```

```bash
/plugin install fellowship@fellowship
```

To list it in a marketplace file you already maintain, add this to its
`plugins` array, with `source` pointing at a checkout or a git URL:

```json
{
  "name": "fellowship",
  "description": "Add people, log occasions, read closeness and insights, profile someone from a chat export.",
  "source": "/path/to/fellowship",
  "category": "productivity"
}
```

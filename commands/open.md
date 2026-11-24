---
description: Start the Fellowship mini-host and open the UI
argument-hint: [person name to open directly]
allowed-tools:
  - Read
  - Bash
---

Start Fellowship and open it in the browser. With `$ARGUMENTS`, open that
person's page directly.

## State

The mini-host is live. The UI is not: it arrives at **M5** in
[`docs/SPEC.md`](../docs/SPEC.md). Until then this command starts the host and
reports where it is, and there is no dashboard to open. Say that in one line
rather than opening a browser at a page that does not exist.

## What this command does

1. Check whether the host is already up before starting a second one:
   `curl -s localhost:4319/health`. If it answers, reuse it.
2. Otherwise start it from the repo root: `pnpm build && pnpm start serve`,
   or `node apps/fellowship/dist/cli.js serve` once built. It listens on 4319
   unless `FELLOWSHIP_PORT` says otherwise.
3. Report the URL, both file paths and the tool count, which `/health` returns.
4. With `$ARGUMENTS`, resolve the name with `people_search` and report what is
   stored rather than opening a page.

## Port and process rules

- The port is 4319, or `FELLOWSHIP_PORT`. Never 3000, and never a guess.
- To free a port, kill **only** the process LISTENing on it:
  `lsof -ti:PORT -sTCP:LISTEN | xargs kill`. Plain `lsof -ti:PORT` returns every
  PID with any connection to that port, browser tabs included, and piping that
  into `kill -9` takes the user's browser down with the server.
- Confirm what is about to be killed first:
  `lsof -iTCP:PORT -sTCP:LISTEN -n -P`. If it is not the Fellowship dev server,
  do not kill it, say what is there.
- One mini-host at a time. It is the single writer to `fellowship.db`, and two
  of them pointed at one SQLite file is how a local-first app corrupts itself.

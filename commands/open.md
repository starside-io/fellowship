---
description: Open Fellowship, in its desktop app or in the browser
argument-hint: [person name to open directly]
allowed-tools:
  - Read
  - Bash
---

Open Fellowship for the user. With `$ARGUMENTS`, find that person too.

The CLI is `node "${CLAUDE_PLUGIN_ROOT}/apps/fellowship/dist/cli.js"`, called
`fellowship` below.

## What this command does

1. `fellowship app status`.
   - **The app is installed:** `fellowship app open`. It starts its own host,
     or reuses one already running on the same code.
   - **Not installed, on an Apple Silicon Mac:** say in one line that the
     desktop app is a download of about 110 MB from the Fellowship release on
     GitHub, and ask whether to install it. On yes: `fellowship app install`,
     then `fellowship app open`. On no, go to step 2.
   - **Not available** (any other machine), or the install failed: step 2.
2. The browser. Check for a host first: `curl -s localhost:4319/health`. If it
   answers, reuse it. Otherwise start one in the background with
   `fellowship serve`, then open http://localhost:4319.
3. With `$ARGUMENTS`, resolve the name with `people_search` and say what is
   stored, so the user knows which page to look at.

Never install the app without the user's yes in this conversation: it is a
download, and the only one this command makes.

## Port and process rules

- The port is 4319, or `FELLOWSHIP_PORT`. Never 3000, and never a guess.
- To free a port, kill **only** the process LISTENing on it:
  `lsof -ti:PORT -sTCP:LISTEN | xargs kill`. Plain `lsof -ti:PORT` returns every
  PID with any connection to that port, browser tabs included, and piping that
  into `kill -9` takes the user's browser down with the server.
- Confirm what is about to be killed first:
  `lsof -iTCP:PORT -sTCP:LISTEN -n -P`. If it is not the Fellowship host, do
  not kill it, say what is there.
- One host at a time. It is the single writer to `fellowship.db`, and two of
  them pointed at one SQLite file is how a local-first app corrupts itself.

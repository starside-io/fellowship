<p align="center">
  <img src="docs/logo.svg" alt="Fellowship" width="520" />
</p>

# Fellowship

[![GitHub](https://img.shields.io/badge/GitHub-starside--io%2Ffellowship-181717?logo=github)](https://github.com/starside-io/fellowship)
[![Status](https://img.shields.io/badge/status-active-brightgreen)](https://github.com/starside-io/fellowship)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-22%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![SQLite](https://img.shields.io/badge/powered%20by-SQLite-003B57?logo=sqlite)](https://sqlite.org)
[![MCP](https://img.shields.io/badge/works%20with-MCP-000000)](https://modelcontextprotocol.io)

**The people in your life, on your own machine.**

Built by [starside.io](https://starside.io). A local-first record of the people
you care about: who they are, what they like, what to steer clear of, the
moments you shared, and how close you really are.

---

### Why *Fellowship*?

A fellowship is a company of people bound together by a shared road. You
already know who matters to you; what slips is the detail. The friend who is
allergic to shellfish, the birthday that is next week, the person you have not
seen since spring, the way someone likes to be asked out (with a plan, never a
maybe).

Fellowship keeps that detail in one SQLite file on your machine. Nothing is sent
anywhere. It works on its own as a desktop app, and any AI assistant can read
and draft into the same records through MCP, with every draft waiting for your
yes before it is written.

## Features

| | |
| --- | --- |
| **People** | Names, birthdays (with or without the year), where they live, how you met, contacts and socials, circles, custom fields, Myers-Briggs type. |
| **Likes and dislikes** | Interests, dislikes and allergies per person, searchable. Allergies always sit at the top of the page, because getting dinner wrong can hurt someone. |
| **Occasions** | A timeline of what you did together: meals, trips, calls, parties, favours, conflicts. One occasion holds everyone who was there. Filter by person, kind or how it went. |
| **Closeness** | A score per connection, derived from the occasions you logged and decaying over time, with the count behind every figure. A force graph shows not just your links but the links between your people. |
| **Home** | Birthdays and "years since you met" coming up, occasions and messages per month, what you did most, who you saw most, circle sizes. |
| **Chat import** | Bring in a WhatsApp export. Reply speed, who starts conversations, message volume, and the raw material for everything below. |
| **Drafts from any AI** | An assistant recaps a chat into occasions and preferences, pulls facts out of pasted text, sketches how someone is and how to spend time with them well. Every draft lands in Review. |
| **Personality radar** | Eight behavioural axes scored from the chats, with the evidence for each score. Compare up to three people side by side and see who is most alike. |
| **Pictures** | Profile pictures from the handles a person already has (LinkedIn, TikTok, YouTube, GitHub, Gravatar), stored locally so viewing someone pings nobody. |
| **Contact cards** | Export one person or everyone as a vCard file your phone imports: names, birthday, numbers, socials, photo. |
| **Search** | One search box over people, notes, occasions and messages, forgiving of accents and case. |
| **Backups** | Export and import the whole record as a snapshot, verified round trip before it touches the real file. |

## Use cases

| You want to | Fellowship gives you |
| --- | --- |
| Pick a restaurant for a group | Every allergy and dislike for the people coming, in one place |
| Remember a birthday before it happens | The Home page, two months ahead, and a vCard for your phone |
| Reconnect with people you have drifted from | Who you have not seen in 30 days, and when you last did |
| Prepare to see someone | Their sketch, what lands, what to avoid, a good opener, the last few occasions |
| Turn a long chat into a record | An assistant recaps it into occasions and preferences, you confirm what is true |
| Understand a relationship over time | Sentiment per occasion, the trend, and a closeness score with its sample size |

> **Privacy:** Fellowship listens on 127.0.0.1 only and makes no network calls
> of its own. The one exception is fetching a profile picture you asked for,
> from an address the host checks first. It never calls an AI model: an
> assistant you choose does the reasoning, and nothing it drafts is written
> until you confirm it. Your records are personal data about other people;
> keep the file somewhere you trust.

## Use it from an AI assistant

Fellowship ships as a Claude Code plugin with a bundled MCP server, and the
same tools work over MCP from any assistant and any model.

Fellowship is in the [starside plugin marketplace](https://github.com/starside-io/claude-plugins):

```bash
/plugin marketplace add starside-io/claude-plugins
```

```bash
/plugin install fellowship@starside
```

The first session after installing builds Fellowship in the background, which
takes a minute or two and needs Node 22 or later. The tools appear once it is
done; `/mcp` reconnects them without starting a new session.

| Command | Does |
| --- | --- |
| `/fellowship:setup` | Set up your own record: name, birthday, where you live, how to reach you |
| `/fellowship:add <name> [facts]` | Add a person, or add facts to one |
| `/fellowship:who <name>` | Read someone back: facts, closeness, recent occasions |
| `/fellowship:personalities [name]` | Score or refresh personality radars from the chats |
| `/fellowship:open [name]` | Start Fellowship and say where it is |

The assistant gets 42 typed tools: reading and searching people, logging
occasions, importing chats, and drafting. Three rules hold whatever model is
driving:

- **Your yes is required.** Drafts go to Review; writing a sketch, a picture or
  a personality radar needs your explicit confirmation of that exact content.
- **No invented people.** A draft that names someone who is not in your records
  is refused.
- **Observations, not diagnoses.** A sketch or radar that labels someone
  clinically is refused. Say what they do, with the quote or count behind it.

## Installation

### 1. Prerequisites

```bash
# Node 22 or later, and pnpm
corepack enable
```

For the desktop app you also need Rust and the Tauri CLI:

```bash
# macOS
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo install tauri-cli
```

### 2. Fellowship

```bash
git clone https://github.com/starside-io/fellowship.git
cd fellowship
pnpm install
pnpm build
```

### 3. The desktop app (optional)

```bash
pnpm desktop
```

This builds `Fellowship.app` under `apps/desktop/src-tauri/target/release/bundle/macos/`.
Move it to Applications and open it like any other app.

## Quick start

```bash
# Start Fellowship in the browser at http://localhost:4319
pnpm start serve

# Or open the desktop app you built
open apps/desktop/src-tauri/target/release/bundle/macos/Fellowship.app

# See where your records live and what is in them
pnpm start status
```

Then:

1. **Tell it who you are.** With an assistant, run `/fellowship:setup`. It asks
   a few questions and fills in the card at the bottom left of the app.
2. **Add the people who matter.** "Add a person" on the People page, or tell
   your assistant `/fellowship:add Jane Doe, allergic to peanuts, met at work`.
3. **Import a chat.** Settings, then "Import a chat export", with the `.txt`
   WhatsApp gives you from Export Chat (without media).
4. **Let an assistant draft.** Ask it to recap the chat or score personalities
   (`/fellowship:personalities`), then confirm what is true in Review.

## Before you rely on it

1. **One person, one machine.** There are no accounts and no sync. Copy the
   file yourself if you want it elsewhere.
2. **The desktop app is built and tested on macOS.** The browser version runs
   wherever Node does.
3. **Chat import reads WhatsApp exports.** Other apps are not parsed yet.
4. **Scores are only as good as what you log.** A closeness score from three
   occasions says so, and a thin sample shows as "not enough data".
5. **Personality radars are drafts.** They describe how someone comes across in
   your messages, not who they are.
6. **Keep backups.** `pnpm start export` writes the whole record to a file.

## Documentation

| | |
| --- | --- |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | Running every part, the CLI, tests, schema changes, layout, design rules |
| [`docs/SPEC.md`](docs/SPEC.md) | The full build spec |
| [`docs/DESIGN.md`](docs/DESIGN.md) | The design system: palette, tokens, primitives |

## Contributing

Contributions are welcome. [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) covers
setting up, running the tests and the conventions a change is held to. Commits
use [gitmoji](https://gitmoji.dev) with [conventional commits](https://www.conventionalcommits.org),
for example `✨ feat(ui): compare personalities`. Test data is always invented.

## License

Apache 2.0. See [LICENSE](LICENSE).

---

Made with ❤ by [starside.io](https://starside.io) · [github.com/starside-io/fellowship](https://github.com/starside-io/fellowship)

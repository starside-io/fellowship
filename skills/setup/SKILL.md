---
name: setup
description: Set up the Fellowship owner's own record, the profile shown at the bottom left of the app that closeness and the graph are measured against. Use when the user runs /fellowship:setup, says they just installed Fellowship, asks to set up or fill in their own profile, or when a session start note says their record is missing or empty. Asks a few short questions, then writes through the Fellowship tools.
---

# Set up your own record

Fellowship measures closeness, the graph and the insights against one record:
the owner's. This fills it in. Keep it short: a few questions, then write. More
arrives on its own later, as chats are imported and occasions are logged.

The tools are live over the bundled MCP server, with underscores for dots:
`people_self`, `people_create`, `people_update`, `people_set_contacts`. If they
are not listed, the server is not running: say so and stop.

## Steps

1. **Read what is there.** `people.self`. If it returns a person, this is an
   update: say what is already filled in and only ask for what is missing.
2. **Ask, in one message**, and say every answer is optional except the name:
   - What should the app call you? (display name)
   - First and last name
   - Birthday: day and month, and the year if they want
   - Where they live: a city is enough
   - How people reach them, if they want it on their own card: phone, email,
     or a handle (Instagram, LinkedIn, GitHub and so on)
3. **Write it.**
   - No record yet: `people.create` with `isSelf: true` and the fields given.
   - A record already: `people.update` with `personId` from `people.self` and
     only the fields that changed.
   - Contacts: `people.set_contacts` on that person id, one channel per thing
     they gave (`kind` PHONE, EMAIL or SOCIAL with its `platform`).
   - Dates are `YYYY-MM-DD`. A birthday with no year uses the year 1604, which
     Fellowship reads as "year unknown". Never guess a year.
4. **Confirm in one line** what was saved, and mention that importing a
   WhatsApp chat (Settings, "Import a chat export") is how the rest gets
   filled in over time: who they talk to, and what happened.

## Rules

- Ask once. If the user skips a question, leave that field empty: never fill it
  from a guess, a chat, or an earlier conversation.
- These are the owner's own details. Do not ask about anyone else here; adding
  other people is `/fellowship:add`.
- Do not set a Myers-Briggs type unless the user states theirs.

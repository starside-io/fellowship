---
description: Set up your own Fellowship record, the profile at the bottom left of the app
allowed-tools:
  - Read
---

Set up the owner's own record in Fellowship.

Follow the `setup` skill in this plugin (`skills/setup/SKILL.md`): read
`people.self`, ask the few questions it lists in one message, write the answers
through `people.create` with `isSelf: true` or `people.update`, add any
contact channels with `people.set_contacts`, and confirm in one line.

Every answer except a name is optional. Never fill a field from a guess.

---
description: Add a person to Fellowship, or add facts to someone already in it
argument-hint: <name> [facts in plain language]
allowed-tools:
  - Read
  - Bash
---

Add or update a person in Fellowship from `$ARGUMENTS`.

## The tools

They are live, over the bundled MCP server. In a session the names carry
underscores rather than dots: `people_search`, `people_create`,
`people_set_tags`. If they are not listed, the plugin's MCP server is not
running: say so and stop rather than writing anywhere else. A half-written
people record in a scratch file is worse than no record.

## What this command does

1. **Resolve the name first, always.** `people.resolve_person` on the name.
   Never assume a person is new. `ambiguous` means several people answer to it:
   put the candidates to the user with the `detail` on each and use the id they
   pick, rather than choosing or creating a second record. `none` means nobody
   does, and only then is this a `people.create`.
2. **Read the real field keys.** `people.fields` before mapping any fact, so
   extraction cannot invent a field that does not exist.
3. **Split the input.** From `$ARGUMENTS`, separate:
   - the display name, and first and last name if both are given
   - facts that map to a known field (location, birthday, how we met)
   - interests, allergies and dislikes, which are tags, not free text
   - contact details, which are channels with a kind and a platform. An
     email, a phone number and a social handle are validated on the way in
     and the profile link is derived from the handle, so pass what you were
     given rather than a URL you assembled
   - anything that maps to no field, which becomes a note rather than being
     dropped or forced into the nearest field
4. **Write.** `people.create` or `people.update`, then `people.set_tags`,
   `people.set_contacts`, `people.set_custom_values` as needed. One person per
   call. Set who they are to the user: `relationship` on `people.create`
   (FAMILY, PARTNER, CLOSE_FRIEND, FRIEND, COLLEAGUE or ACQUAINTANCE), or
   `people.set_link` with the user's own id for someone already here. It
   decides how long time together keeps counting toward closeness. Ask when it
   is not plain from what the user said.
5. **Report what landed and what did not.** Name every fact that went in, and
   every one that had nowhere to go.

## Rules

- Everything written here lands **unconfirmed**, carrying its provenance. The
  user confirms in the UI or the review queue. This command never confirms on
  the user's behalf and never passes `confirmedByUser`.
- An allergy is not an interest. Getting that wrong puts someone in a restaurant
  that can hurt them, which is the reason allergies and dislikes are pinned in a
  warning box on the person page.
- No guessing at a birthday from an age, a location from a phone prefix, or a
  surname from an email address. A fact with no source is not a fact.
- To log an occasion rather than a fact, that is `people.log_interaction`, and
  the occasion carries everyone who was there. See the skill.

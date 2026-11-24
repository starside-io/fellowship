# Design system

The palette is built on four huemint anchors (charcoal, sand, coral, crimson),
with every surface, semantic token, and chart colour derived from them. The
token file also carries a block of `@custom-variant`
declarations at the top of the token file, which the shadcn primitives need and
which used to arrive with the shadcn CLI's own stylesheet.

Tokens live in `packages/ui/src/styles/tokens.css`. Primitives live in
`packages/ui/src/ds/` and are exported from `packages/ui/src/ds/index.ts`. Feature code should consume tokens
through Tailwind utilities and never hardcode a palette colour.

## Palette anchors

| Name      | Hex       | oklch                        | Role |
| --------- | --------- | ---------------------------- | ---- |
| Charcoal  | `#2a2b2e` | `oklch(0.2892 0.0056 271.22)` | Ink in light, page in dark. The dark neutral ramp derives from it. |
| Sand      | `#ecc59a` | `oklch(0.8469 0.0720 69.35)`  | Warm paper. The light neutral ramp and soft cautions derive from it. |
| Coral     | `#dc7465` | `oklch(0.6741 0.1327 29.53)`  | Accent. Carries the brand on dark surfaces, and the focus ring. |
| Crimson   | `#b3162f` | `oklch(0.4930 0.1867 20.88)`  | Brand. Primary actions, the app mark, links that carry weight. |

Positive is a sage teal at hue 175, the one colour outside the four, picked
opposite coral so good and bad never read alike.

Neutrals are not pure grey. Light neutrals carry sand's warm hue (70), dark
neutrals carry charcoal's cool hue (271), so each theme sits on one axis.

## Semantic tokens

Each pair is defined per theme in `:root` and `.dark`, then exposed as a
Tailwind colour through the `@theme inline` block. Availability follows the
usual utilities: `bg-*`, `text-*`, `border-*`, `ring-*`, plus opacity
modifiers such as `bg-positive/10`.

| Token | Utility | Light | Dark | Use for |
| ----- | ------- | ----- | ---- | ------- |
| `--thread` | `thread` | `oklch(0.493 0.1867 20.88)` | `oklch(0.72 0.13 29.53)` | Brand colour as text or a small mark. Crimson in light, a lifted coral in dark so it stays legible on charcoal. `--primary` holds crimson as a fill. |
| `--positive` | `positive` | `oklch(0.5 0.08 175)` | `oklch(0.76 0.08 175)` | Good sentiment, positive scores, high confidence. Sage teal, replacing the old emerald and green classes. |
| `--negative` | `negative` | `oklch(0.5 0.18 22)` | `oklch(0.72 0.13 26)` | Bad sentiment, negative scores, low confidence. Crimson in light, toward coral in dark. |
| `--warning` | `warning` | `oklch(0.54 0.105 62)` | `oklch(0.8469 0.072 69.35)` | Medium confidence and other soft cautions. A deepened sand in light, sand itself in dark. |
| `--destructive` | `destructive` | `oklch(0.493 0.1867 20.88)` | `oklch(0.6741 0.1327 29.53)` | Destructive controls. Crimson in light, coral in dark. |

Every token above has a `-foreground` companion for text placed on top of it,
for example `bg-positive text-positive-foreground`.

Charts run `--chart-1` through `--chart-5`: crimson, coral, sand, sage, and
charcoal. Dark theme lifts each one so it reads on the charcoal page.

## Light theme

- Page is warm paper at `oklch(0.955 0.013 75)`. Cards and popovers are near
  white `oklch(0.99 0.005 75)`, so they lift off the page without a shadow.
- Foreground is charcoal at `oklch(0.255 0.0056 271.22)`, muted text sits at
  `oklch(0.47 0.012 60)`.
- `secondary`, `muted`, and `accent` are sand to charcoal mixes
  (`oklch(0.925 0.016 72)`, `oklch(0.935 0.013 72)`, `oklch(0.905 0.022 70)`).
- Borders and inputs are warm tinted rather than grey
  (`oklch(0.885 0.018 72)` and `oklch(0.86 0.02 72)`), the ring is a soft
  coral at `oklch(0.67 0.11 29.5)`.
- `--primary` is crimson at its palette value with near white text on top.
- The sidebar is brighter than the page at `oklch(0.975 0.009 75)`.

## Dark theme

- Page is a step under `#2a2b2e` at `oklch(0.255 0.0056 271.22)`, cards a step
  over at `oklch(0.305 0.0065 271.22)`, popovers at `oklch(0.32 0.007 271.22)`.
  The sidebar sits between page and cards at `oklch(0.275 0.006 271.22)`.
- Foreground is warm paper at `oklch(0.95 0.014 75)`, muted text sits at
  `oklch(0.76 0.018 70)`. Borders and inputs stay translucent white
  (`oklch(1 0 0 / 11%)` and `/ 17%`) so they follow whatever surface they sit on.
- `--primary` is crimson lifted a touch to `oklch(0.53 0.19 21)` so it reads on
  charcoal, with near white text on top. The ring and the sidebar's primary are
  coral.
- Semantic colours are lifted versions of their light counterparts, leaning
  from crimson toward coral.

## Primitives

| Primitive | Usage |
| --------- | ----- |
| `scoreTone(score)` | Maps a -100 to 100 score to one of three tones, negative, neutral, or positive. Pair it with `TONE_TEXT`, `TONE_SURFACE`, or `TONE_FILL` instead of hand rolling class ramps. |
| `sentimentTone(value)`, `sentimentLabel(value)` | Same mapping for the -2 to 2 sentiment scale, plus its Bad, Tense, Neutral, Good, Great labels. |
| `SentimentChip` | `<SentimentChip sentiment={1} size="sm" />` renders the sentiment pill in the matching tone. |
| `ScoreBar` | `<ScoreBar score={42} showValue />` draws the centre anchored strength bar, filling right in sage teal and left in crimson. |
| `ScoreDot` | `<ScoreDot score={-12} />` for dense rows where a bar does not fit. |
| `InitialsAvatar` | `<InitialsAvatar name={person.displayName} color={person.avatarColor} size="md" />`. T-shirt steps `xs` `sm` `md` `lg` `xl` run 20px to 64px, and the numeric steps `8` and `10` name the raw Tailwind box for layouts that must match an exact size. `color` is optional and falls back to a neutral tone. Pass `src` to show a real picture, cropped to the circle. The picture is painted as a background layer over the initials rather than as an `img`, so a URL that 404s or errors simply leaves the initials showing: no broken image glyph, no client component, and nothing to go wrong between the server HTML and hydration. That matters because the avatar route answers 404 for everyone who has no stored picture. |
| `AvatarStack` | `<AvatarStack people={[{ id, name, color, src }]} max={4} ringClassName="ring-card" />` overlaps avatars and caps with a `+N` counter. `src` is optional per person and follows the same fallback. |
| `TagChip` | `<TagChip label={tag.name} colour={tag.colour} variant="soft" />`; the colour tints a translucent background wash, the border, and the text. `variant="solid"` fills harder and adds a dot for a membership such as a circle, `soft` is the default for free form tags. Pass `onRemove` for an editable chip, which requires a client parent, and `disabled` while a mutation is pending. |
| `readable(colour)` | Used by `TagChip` and `InitialsAvatar` for their text. Text in a stored colour is mixed 58% toward `--foreground`, so it keeps its hue and reads in both themes. |
| `StatCard` | `<StatCard label="People" value={42} hint="Excluding archived" />`, the dashboard count card. |
| `StatRow` | `<StatRow label="Seen this month" value={7} hint="People at an event since the 1st." />`, the label left value right row for stacked stats in a rail or card. |
| `EmptyState` | `<EmptyState icon={<Share2 className="size-6" />} title="No connections yet" description="..." action={<Button />} />`; `size="sm"` fits narrow cards. |
| `SectionCard` | `<SectionCard title="Circles" description="..." action={<Badge />} footer={<Button />}>{children}</SectionCard>`, the card with a titled header and an optional footer for actions. |
| `KbdChip` | `<KbdChip>Cmd</KbdChip>` for keyboard hints and the shortcut overlay. |
| `RadarChart` | `<RadarChart axes={[{ key, label, value }]} active={key} onHover={setKey} />` draws a spider chart, 0 at the centre and 100 at the rim. `value` is 0 to 100 or `null`; a null axis is drawn as a dashed spoke with no point, so it reads as unknown rather than zero. The shape joins scored axes only. `active` and `onHover` are optional and emphasise an axis. |
| `readCanvasTokens`, `rgba` | `readCanvasTokens({ positive: "--positive" })` resolves custom properties to sRGB triples for canvas painting, then `rgba(triple, 0.5)` formats a fill or stroke. Returns null off the document or when a token cannot be parsed, so callers can read again after a theme flip. |

## Categorical colours

People and circles draw from a twelve colour palette, `AVATAR_PALETTE` in
`packages/core/src/domain/avatar-colour.ts`, built around the brand four.
`avatarColorFor(name)` picks one by a stable hash of the name. In order:

1. `#b3162f` crimson
2. `#dc7465` coral
3. `#c8955a` ochre, sand deepened to carry text
4. `#6f9a7e` sage
5. `#4f8f8b` teal
6. `#5b82a6` steel blue
7. `#5f6aa0` slate indigo
8. `#8a6a9e` plum
9. `#a8617f` mauve
10. `#d0828f` rose
11. `#6b6d75` charcoal grey
12. `#8d9a52` olive

New tags take a default by kind (`DEFAULT_TAG_COLOURS` in
`packages/core/src/tools/write.ts`): interest is sage `#6f9a7e`, allergy is
crimson `#b3162f`, dislike is ochre `#c8955a`.

The palette migration (`20261124035327_personality_mbti_palette`) remapped
stored person, circle, and tag colours from the old twelve to the new twelve by
index, so a stored colour lands where a fresh pick for the same name would.
Tags on an old per kind default moved to the new one. A colour picked by hand
that is not one of the old twelve was left alone.

## Conventions

- Positive is sage teal (hue 175), not green. Feature files still carrying `emerald-*`,
  `green-*`, `red-500`, or `amber-*` classes are pending migration onto these
  primitives.
- Primitives are server components. Only pass a handler prop, such as
  `TagChip`'s `onRemove`, from a client component.
- Person pictures come from `/api/people/[id]/avatar`, which answers 404 when
  there is none. Build the URL with `personAvatarSrc` from
  `components/people/person-avatar` rather than by hand: it takes the person's
  `avatarFetchedAt`, skips the request when that is `null`, and uses the
  timestamp as the cache key so a newly fetched picture is not read from a stale
  browser cache. Never select `avatarImage` in a list query, it is bytes.
- `components/ui/*` stays upstream shaped. The `ds/` layer composes those
  primitives or plain elements, it does not edit them.

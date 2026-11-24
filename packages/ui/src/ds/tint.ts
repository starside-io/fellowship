/**
 * Translucent versions of an arbitrary CSS colour, used by the primitives that
 * paint a person or tag colour into a surface.
 */

const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

/**
 * Alpha suffix for six digit hex, colour-mix for anything else, so a token
 * such as var(--muted-foreground) tints the same way a stored hex does.
 */
export function tint(colour: string, hexAlpha: string, percent: number): string {
  if (HEX_PATTERN.test(colour)) return `${colour}${hexAlpha}`;
  return `color-mix(in oklab, ${colour} ${percent}%, transparent)`;
}

/**
 * A colour pulled toward the theme's foreground, for text drawn in a stored
 * colour. A mid tone hex is unreadable as text on one theme or the other; the
 * mix keeps its hue and borrows its contrast from the foreground, which flips
 * with the theme.
 */
export function readable(colour: string): string {
  return `color-mix(in oklab, ${colour} 58%, var(--foreground))`;
}

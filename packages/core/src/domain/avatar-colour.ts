/**
 * Twelve mid tones built around the brand four (charcoal, sand, coral,
 * crimson), each with a hue of its own so two people rarely share one. Same
 * order and length as the palette they replaced, so a stored colour maps to
 * its successor by index (see the palette migration).
 */
const AVATAR_PALETTE = [
  "#b3162f", // crimson
  "#dc7465", // coral
  "#c8955a", // ochre, sand deepened to carry text
  "#6f9a7e", // sage
  "#4f8f8b", // teal
  "#5b82a6", // steel blue
  "#5f6aa0", // slate indigo
  "#8a6a9e", // plum
  "#a8617f", // mauve
  "#d0828f", // rose
  "#6b6d75", // charcoal grey
  "#8d9a52", // olive
];

/** Deterministic hex colour for a person, stable across runs for the same name. */
export function avatarColorFor(name: string): string {
  const seed = name.trim().toLowerCase();
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

export { AVATAR_PALETTE };

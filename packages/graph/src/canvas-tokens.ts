/**
 * Moved out of the design system with the graph, which is the only thing that
 * paints to a canvas. A class cannot reach a canvas, so the tokens are read
 * off the document instead.
 */

/**
 * Canvas drawing cannot use Tailwind classes, and the theme tokens are
 * authored in oklch, which no arithmetic in a renderer understands. These
 * helpers resolve custom properties off the document into plain sRGB so a
 * canvas can paint with the same tokens the rest of the UI uses.
 */

export type Rgb = [number, number, number];

/**
 * A one pixel canvas does the colour conversion, so any value the browser can
 * parse works, whatever colour space it is authored in.
 */
function toRgb(value: string, ctx: CanvasRenderingContext2D): Rgb | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  ctx.clearRect(0, 0, 1, 1);
  // An unparseable value leaves the transparent fill in place, so the alpha
  // channel doubles as the parse check.
  ctx.fillStyle = "transparent";
  ctx.fillStyle = trimmed;
  ctx.fillRect(0, 0, 1, 1);
  const data = ctx.getImageData(0, 0, 1, 1).data;
  if (data[3] === 0) return null;
  return [data[0], data[1], data[2]];
}

/**
 * Resolves a map of names to custom properties into a map of the same names to
 * sRGB triples, read off the root element. Returns null when the document is
 * not available or any property fails to resolve, so callers can wait and read
 * again, for example after a theme class flip.
 */
export function readCanvasTokens<K extends string>(
  tokens: Record<K, string>,
): Record<K, Rgb> | null {
  if (typeof document === "undefined") return null;

  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  const styles = getComputedStyle(document.documentElement);
  const resolved: Partial<Record<K, Rgb>> = {};

  for (const [name, property] of Object.entries(tokens) as [K, string][]) {
    const rgb = toRgb(styles.getPropertyValue(property), ctx);
    if (!rgb) return null;
    resolved[name] = rgb;
  }

  return resolved as Record<K, Rgb>;
}

/** Formats a resolved triple as a canvas fill or stroke style. */
export function rgba(colour: Rgb, alpha: number): string {
  return `rgba(${colour[0]}, ${colour[1]}, ${colour[2]}, ${alpha})`;
}

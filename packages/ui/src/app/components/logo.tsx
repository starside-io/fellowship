/**
 * The Fellowship mark: a flame with people seated around it. Drawn from
 * docs/brand/option-2-hearth-mark.svg, which is the source of truth; the colours
 * are the brand four, fixed, so the mark reads the same in both themes.
 */
export function HearthMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true" focusable="false">
      <g transform="translate(32 27.5) scale(0.72) translate(-32 -32)"><path d="M 32 5 C 41 15, 50 24, 49.5 37.5 C 49 50, 41 58.5, 32 58.5 C 22.5 58.5, 14.5 50.5, 14.5 40 C 14.5 31, 19.5 24.5, 25.5 19 C 25 26, 27 30.5, 31 31.5 C 33.5 23.5, 34 14, 32 5 Z" fill="#b3162f"/>
<path d="M 33.5 24.5 C 40 31.5, 43.5 37.5, 42.5 45 C 41.5 52, 37 55.5, 32 55.5 C 26.5 55.5, 21.5 51.5, 21.5 45.5 C 21.5 40, 24.5 36.5, 28 33.5 C 28 37.5, 30 40.5, 33 40.5 C 35.5 36.5, 35.5 30.5, 33.5 24.5 Z" fill="#dc7465"/>
<path d="M 32 39.5 C 35.5 43, 37.5 46.5, 36.5 49.5 C 35.5 52.5, 33.8 53.5, 32 53.5 C 29.8 53.5, 27.5 52, 27.5 49 C 27.5 45.5, 29.8 42.5, 32 39.5 Z" fill="#ecc59a"/></g><circle cx="8.33" cy="39.34" r="3.6" fill="#c8955a"/><circle cx="17.09" cy="52.44" r="3.6" fill="#dc7465"/><circle cx="32.00" cy="57.50" r="3.6" fill="#b3162f"/><circle cx="46.91" cy="52.44" r="3.6" fill="#dc7465"/><circle cx="55.67" cy="39.34" r="3.6" fill="#c8955a"/>
    </svg>
  );
}

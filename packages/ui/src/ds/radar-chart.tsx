/**
 * A spider chart for scores on a fixed set of axes, 0 at the centre and 100
 * at the rim. Axes with no score are drawn as dashed spokes with no point, so
 * a missing axis reads as unknown rather than as zero.
 *
 * One series by default, from the values on the axes. Pass `series` to
 * overlay several (people compared on the same axes); each keeps its colour
 * wherever it appears, and a gap in one series stays a gap in that series.
 */

export interface RadarAxis {
  key: string;
  label: string;
  /** 0 to 100, or null when nothing supports a score. Ignored when series is set. */
  value?: number | null;
}

export interface RadarSeries {
  key: string;
  label: string;
  /** Any CSS colour. */
  colour: string;
  /** Axis key to 0..100. A missing key is unknown. */
  values: Record<string, number | null | undefined>;
}

export interface RadarChartProps {
  axes: RadarAxis[];
  series?: RadarSeries[];
  /** Pixel size of the square drawing. */
  size?: number;
  /** Fires with an axis key when its label or point is hovered, null on leave. */
  onHover?: (key: string | null) => void;
  /** The axis to emphasise. */
  active?: string | null;
  className?: string;
}

const RINGS = [25, 50, 75, 100];

export function RadarChart({
  axes,
  series,
  size = 230,
  onHover,
  active,
  className,
}: RadarChartProps) {
  // Room for the labels outside the rim. The drawing scales to its box, so
  // the label size is set against this viewBox, not in screen pixels.
  const pad = 74;
  const box = size + pad * 2;
  const centre = box / 2;
  const radius = size / 2;
  const count = axes.length;

  const drawn: RadarSeries[] = series ?? [
    {
      key: "only",
      label: "",
      colour: "var(--chart-1)",
      values: Object.fromEntries(axes.map((axis) => [axis.key, axis.value ?? null])),
    },
  ];
  const single = drawn.length === 1;

  const point = (index: number, value: number) => {
    // First axis straight up, then clockwise.
    const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
    const r = (radius * value) / 100;
    return { x: centre + r * Math.cos(angle), y: centre + r * Math.sin(angle), angle };
  };

  const ring = (value: number) =>
    axes
      .map((_, index) => {
        const p = point(index, value);
        return `${p.x},${p.y}`;
      })
      .join(" ");

  const scoredBy = (entry: RadarSeries) =>
    axes
      .map((axis, index) => ({ axis, index, value: entry.values[axis.key] }))
      .filter((item): item is { axis: RadarAxis; index: number; value: number } =>
        typeof item.value === "number",
      );

  // An axis is drawn dashed when no series scored it.
  const anyScore = new Set(drawn.flatMap((entry) => scoredBy(entry).map((item) => item.axis.key)));

  return (
    <svg
      viewBox={`0 0 ${box} ${box}`}
      className={className}
      role="img"
      aria-label={drawn
        .map(
          (entry) =>
            `${entry.label ? `${entry.label}: ` : ""}${axes
              .map((axis) => {
                const value = entry.values[axis.key];
                return `${axis.label} ${typeof value === "number" ? value : "unknown"}`;
              })
              .join(", ")}`,
        )
        .join("; ")}
    >
      {RINGS.map((value) => (
        <polygon
          key={value}
          points={ring(value)}
          fill={value === 100 ? "var(--muted)" : "none"}
          fillOpacity={value === 100 ? 0.5 : undefined}
          stroke="var(--border)"
          strokeWidth={1}
        />
      ))}

      {axes.map((axis, index) => {
        const rim = point(index, 100);
        return (
          <line
            key={axis.key}
            x1={centre}
            y1={centre}
            x2={rim.x}
            y2={rim.y}
            stroke="var(--border)"
            strokeWidth={1}
            strokeDasharray={anyScore.has(axis.key) ? undefined : "3 3"}
          />
        );
      })}

      {drawn.map((entry) => {
        const scored = scoredBy(entry);
        if (scored.length < 3) return null;
        return (
          <polygon
            key={`shape:${entry.key}`}
            // The shape joins the scored axes only, in order, so a gap stays
            // a gap in the data and is not drawn as a dip to zero.
            points={scored
              .map((item) => {
                const p = point(item.index, item.value);
                return `${p.x},${p.y}`;
              })
              .join(" ")}
            fill={single ? "var(--chart-2)" : entry.colour}
            fillOpacity={single ? 0.22 : 0.12}
            stroke={entry.colour}
            strokeWidth={2}
            strokeLinejoin="round"
          />
        );
      })}

      {drawn.flatMap((entry) =>
        scoredBy(entry).map((item) => {
          const p = point(item.index, item.value);
          const isActive = active === item.axis.key;
          return (
            <circle
              key={`dot:${entry.key}:${item.axis.key}`}
              cx={p.x}
              cy={p.y}
              r={isActive ? 5.5 : 4}
              fill={entry.colour}
              stroke="var(--card)"
              strokeWidth={2}
              onMouseEnter={() => onHover?.(item.axis.key)}
              onMouseLeave={() => onHover?.(null)}
            />
          );
        }),
      )}

      {axes.map((axis, index) => {
        const p = point(index, 100);
        const cos = Math.cos(p.angle);
        const sin = Math.sin(p.angle);
        const x = centre + (radius + 14) * cos;
        const y = centre + (radius + 14) * sin;
        const anchor = Math.abs(cos) < 0.2 ? "middle" : cos > 0 ? "start" : "end";
        const isActive = active === axis.key;
        return (
          <text
            key={axis.key}
            x={x}
            y={y + (sin > 0.5 ? 10 : sin < -0.5 ? -4 : 4)}
            textAnchor={anchor}
            fontSize={15}
            fontWeight={isActive ? 600 : 500}
            fill={anyScore.has(axis.key) ? "var(--foreground)" : "var(--muted-foreground)"}
            onMouseEnter={() => onHover?.(axis.key)}
            onMouseLeave={() => onHover?.(null)}
          >
            {axis.label}
          </text>
        );
      })}
    </svg>
  );
}

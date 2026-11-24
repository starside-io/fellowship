import { cn } from "@/lib/cn";
import {
  TONE_FILL,
  TONE_TEXT,
  clampScore,
  scoreTone,
} from "@/ds/tone";

export type ScoreBarProps = {
  /** -100 through 100. Values outside the range are clamped. */
  score: number;
  /** Prints the rounded score next to the track, in the matching tone. */
  showValue?: boolean;
  className?: string;
};

/**
 * Centre anchored connection strength. Negative fills left in red, positive
 * fills right in teal, with a hairline marking zero.
 */
export function ScoreBar({ score, showValue, className }: ScoreBarProps) {
  const clamped = clampScore(score);
  const tone = scoreTone(clamped);
  // Half the magnitude, because the track holds 200 points across its width.
  const half = Math.abs(clamped) / 2;

  const track = (
    <span
      className="relative block h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-muted"
      aria-hidden="true"
    >
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border" />
      <span
        className={cn("absolute inset-y-0 rounded-full", TONE_FILL[tone])}
        style={{
          left: clamped < 0 ? `${50 - half}%` : "50%",
          width: `${half}%`,
        }}
      />
    </span>
  );

  if (!showValue) {
    return (
      <span className={cn("inline-flex", className)} role="img" aria-label={`Score ${Math.round(clamped)}`}>
        {track}
      </span>
    );
  }

  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      {track}
      <span
        className={cn(
          "w-9 shrink-0 text-right text-sm font-medium tabular-nums",
          TONE_TEXT[tone],
        )}
      >
        {Math.round(clamped)}
      </span>
    </span>
  );
}

const DOT_SIZES = {
  sm: "size-1.5",
  md: "size-2.5",
} as const;

export type ScoreDotProps = {
  score: number;
  size?: keyof typeof DOT_SIZES;
  className?: string;
};

/** A single tone dot, for dense rows where a full bar would not fit. */
export function ScoreDot({ score, size = "sm", className }: ScoreDotProps) {
  const tone = scoreTone(score);

  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block shrink-0 rounded-full",
        DOT_SIZES[size],
        TONE_FILL[tone],
        className,
      )}
    />
  );
}

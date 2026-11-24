import { cn } from "@/lib/cn";
import {
  TONE_SURFACE,
  sentimentLabel,
  sentimentTone,
} from "@/ds/tone";

const SIZES = {
  sm: "h-5 px-2 text-[0.7rem]",
  md: "h-6 px-2.5 text-xs",
} as const;

export type SentimentChipProps = {
  /** -2 through 2. Null renders the neutral chip. */
  sentiment: number | null;
  size?: keyof typeof SIZES;
  /** Short word placed before the label, for example a participant name. */
  prefix?: string;
  className?: string;
};

/** The canonical sentiment pill: Bad, Tense, Neutral, Good, Great. */
export function SentimentChip({
  sentiment,
  size = "sm",
  prefix,
  className,
}: SentimentChipProps) {
  const tone = sentimentTone(sentiment);

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border font-medium",
        SIZES[size],
        TONE_SURFACE[tone],
        className,
      )}
    >
      {prefix ? `${prefix} ` : ""}
      {sentimentLabel(sentiment)}
    </span>
  );
}

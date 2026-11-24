import { X } from "lucide-react";

import { cn } from "@/lib/cn";
import { readable, tint } from "@/ds/tint";

/**
 * `solid` carries more fill, a heavier border, a dot, and medium weight. Use
 * it for a membership the person belongs to, such as a circle. `soft` is the
 * quieter wash for free form tags, so the two read apart in one glance.
 */
export type TagChipVariant = "solid" | "soft";

export type TagChipProps = {
  label: string;
  /**
   * Any CSS colour. Tints the background wash, the border and the dot. The
   * text takes it mixed toward the foreground, so it reads in both themes.
   */
  colour?: string | null;
  variant?: TagChipVariant;
  /**
   * Renders a remove button. Passing this makes the chip interactive, so it
   * must be rendered from a client component.
   */
  onRemove?: () => void;
  /** Disables the remove button while a mutation is pending. */
  disabled?: boolean;
  className?: string;
};

/** Hex alpha and colour-mix percentage per layer, per variant. */
const TINTS = {
  solid: { fill: ["2e", 18] as const, border: ["66", 40] as const },
  soft: { fill: ["1a", 10] as const, border: ["3d", 24] as const },
};

const VARIANT_CLASSES: Record<TagChipVariant, string> = {
  solid: "font-medium",
  soft: "",
};

const PLAIN_CLASSES: Record<TagChipVariant, string> = {
  solid: "border-border bg-muted font-medium text-foreground",
  soft: "border-border bg-muted/40 text-muted-foreground",
};

/** A tinted pill for a tag, circle, or any other small labelled value. */
export function TagChip({
  label,
  colour,
  variant = "soft",
  onRemove,
  disabled,
  className,
}: TagChipProps) {
  const tints = TINTS[variant];
  const tinted = colour
    ? {
        backgroundColor: tint(colour, tints.fill[0], tints.fill[1]),
        borderColor: tint(colour, tints.border[0], tints.border[1]),
        color: readable(colour),
      }
    : undefined;

  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs",
        colour ? VARIANT_CLASSES[variant] : PLAIN_CLASSES[variant],
        className,
      )}
      style={tinted}
    >
      {colour && variant === "solid" ? (
        <span
          className="size-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: colour }}
          aria-hidden="true"
        />
      ) : null}
      <span className="truncate">{label}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          aria-label={`Remove ${label}`}
          className="-mr-0.5 shrink-0 rounded-full opacity-60 transition-opacity hover:opacity-100 disabled:pointer-events-none disabled:opacity-30"
        >
          <X className="size-3" aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
}

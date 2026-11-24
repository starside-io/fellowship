import type * as React from "react";

import { cn } from "@/lib/cn";

export type StatRowProps = {
  label: string;
  value: React.ReactNode;
  /** One short line under the label, for context the number needs. */
  hint?: string;
  className?: string;
};

/** Label on the left, value on the right, for stacked stats in a rail or card. */
export function StatRow({ label, value, hint, className }: StatRowProps) {
  return (
    <div
      className={cn("flex items-baseline justify-between gap-3", className)}
    >
      <div className="min-w-0">
        <p className="text-sm">{label}</p>
        {hint ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
        ) : null}
      </div>
      <p className="shrink-0 text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

import type * as React from "react";

import { cn } from "@/lib/cn";

export type KbdChipProps = {
  children: React.ReactNode;
  className?: string;
};

/** One keyboard key, as used in the dashboard hint and the shortcut overlay. */
export function KbdChip({ children, className }: KbdChipProps) {
  return (
    <kbd
      className={cn(
        "rounded border bg-muted px-1.5 py-0.5 font-sans text-[0.7rem] font-medium text-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

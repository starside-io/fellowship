import type * as React from "react";

import { Card, CardContent, CardDescription } from "@/ui/card";

export type StatCardProps = {
  label: string;
  value: React.ReactNode;
  /** One short line under the label, for context the number needs. */
  hint?: string;
  className?: string;
};

/** The dashboard count card: a big number over its label. */
export function StatCard({ label, value, hint, className }: StatCardProps) {
  return (
    <Card className={className}>
      <CardContent>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        <CardDescription>{label}</CardDescription>
        {hint ? (
          <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

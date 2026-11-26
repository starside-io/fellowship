import { CalendarDays, House, Inbox, Radar, Settings, Users } from "lucide-react";

import { avatarUrl, host, type ProposalRow } from "@/client";
import { InitialsAvatar, KbdChip } from "@/ds/index";
import { cn } from "@/lib/cn";
import { hrefOf, useLinkHandler, type Route } from "@/lib/router";
import { useRpc } from "@/lib/use-rpc";
import { Badge } from "@/ui/badge";
import { ThemeToggle } from "@/app/theme";
import { HearthMark } from "@/app/components/logo";
import { UpdateButton } from "@/app/components/updates";
import { useEffect, useState } from "react";

/**
 * The side rail: where you are, what is waiting, and the owner's own record at
 * the bottom because closeness is defined against it.
 */

interface GraphPayload {
  people: Array<{ id: string; displayName: string; avatarColor: string; isSelf: boolean }>;
  events: unknown[];
}

const LINKS: Array<{ route: Route; label: string; icon: typeof Users }> = [
  { route: { name: "dashboard" }, label: "Home", icon: House },
  { route: { name: "people" }, label: "People", icon: Users },
  { route: { name: "personalities" }, label: "Personalities", icon: Radar },
  { route: { name: "events" }, label: "Occasions", icon: CalendarDays },
  { route: { name: "review" }, label: "Review", icon: Inbox },
  { route: { name: "settings" }, label: "Settings", icon: Settings },
];

export function Rail({ current, onSearch }: { current: Route; onSearch: () => void }) {
  const onLink = useLinkHandler();
  const graph = useRpc<GraphPayload>("people.graph");
  const [pending, setPending] = useState<ProposalRow[]>([]);

  useEffect(() => {
    let live = true;
    host
      .review("pending")
      .then((answer) => {
        if (live) setPending(answer.proposals);
      })
      .catch(() => {
        if (live) setPending([]);
      });
    return () => {
      live = false;
    };
  }, [current.name]);

  const people = graph.data?.people ?? [];
  const self = people.find((person) => person.isSelf);
  const counts: Record<string, number> = {
    People: people.filter((person) => !person.isSelf).length,
    Occasions: graph.data?.events.length ?? 0,
    Review: pending.length,
  };

  return (
    <nav className="bg-sidebar border-sidebar-border flex w-56 shrink-0 flex-col border-r">
      <a
        href="/"
        onClick={onLink}
        className="flex items-center gap-2 px-4 py-4 text-sidebar-foreground"
      >
        <HearthMark className="size-7 shrink-0" />
        <span className="font-heading text-base font-semibold tracking-tight">Fellowship</span>
      </a>

      <button
        type="button"
        onClick={onSearch}
        className="text-muted-foreground hover:bg-sidebar-accent mx-3 mb-3 flex items-center justify-between rounded-md border border-sidebar-border px-2.5 py-1.5 text-sm"
      >
        <span>Search</span>
        <span className="flex gap-1">
          <KbdChip>Cmd</KbdChip>
          <KbdChip>K</KbdChip>
        </span>
      </button>

      <ul className="space-y-0.5 px-2">
        {LINKS.map((link) => {
          const href = hrefOf(link.route);
          const active =
            current.name === link.route.name ||
            (link.route.name === "people" && current.name === "person");
          const count = counts[link.label];

          return (
            <li key={link.label}>
              <a
                href={href}
                onClick={onLink}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    : "text-muted-foreground hover:bg-sidebar-accent/60",
                )}
              >
                <link.icon className="size-4" aria-hidden />
                <span className="flex-1">{link.label}</span>
                {count !== undefined && count > 0 ? (
                  <Badge variant={link.label === "Review" ? "default" : "secondary"}>
                    {count}
                  </Badge>
                ) : null}
              </a>
            </li>
          );
        })}
      </ul>

      <div className="mt-auto space-y-2 p-3">
        <UpdateButton />
        {self ? (
          <a
            href={hrefOf({ name: "person", personId: self.id })}
            onClick={onLink}
            className="hover:bg-sidebar-accent/60 flex items-center gap-2 rounded-md p-2"
          >
            <InitialsAvatar
              name={self.displayName}
              color={self.avatarColor}
              size="sm"
              src={avatarUrl(self.id)}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{self.displayName}</span>
              <span className="text-muted-foreground block text-xs">You</span>
            </span>
          </a>
        ) : null}
        <div className="flex items-center justify-between px-1">
          <span className="text-muted-foreground text-xs">Local only</span>
          <ThemeToggle />
        </div>
      </div>
    </nav>
  );
}

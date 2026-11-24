import { useMemo, useState } from "react";
import { Download, Network, Table2, UserPlus, Users } from "lucide-react";
import type { GraphPayload } from "@fellowship/graph";

import { avatarUrl } from "@/client";
import {
  EmptyState,
  InitialsAvatar,
  ScoreBar,
  SectionCard,
  SentimentChip,
  StatCard,
  StatRow,
  TagChip,
} from "@/ds/index";
import { downloadVCards } from "@/lib/download";
import { navigate, useLinkHandler } from "@/lib/router";
import { useRpc } from "@/lib/use-rpc";
import { Failure, Loading } from "@/app/components/states";
import { GraphPanel } from "@/app/components/graph-panel";
import { PersonForm } from "@/app/components/person-form";
import { Input } from "@/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/ui/table";
import { Button } from "@/ui/button";

/**
 * Who is in the fellowship, how close, and what happened lately.
 *
 * The roster comes from people.graph, which is the payload the graph view will
 * read at M6: people, their circles and the closeness of each one to the self
 * record, in one round trip. The table and the graph are two readings of the
 * same thing, so they take the same tool.
 */

interface Activity {
  since: string;
  events: Array<{
    id: string;
    title: string;
    type: string;
    occurredAt: string;
    sentiment: number;
    participants: Array<{ id: string; displayName: string }>;
  }>;
  quietPeople: Array<{ id: string; displayName: string; lastEventAt: string | null }>;
}

export function People() {
  const graph = useRpc<GraphPayload>("people.graph");
  const activity = useRpc<Activity>("people.activity", { days: 30, limit: 12 });
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"table" | "graph">("table");
  const [adding, setAdding] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const onLink = useLinkHandler();

  async function exportContacts() {
    setExporting(true);
    setExportNote(null);
    try {
      const count = await downloadVCards();
      setExportNote(`${count} contact ${count === 1 ? "card" : "cards"} saved. Open the .vcf on your phone to import.`);
    } catch (caught) {
      setExportNote(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setExporting(false);
    }
  }

  const people = useMemo(() => {
    const rows = (graph.data?.people ?? []).filter((person) => !person.isSelf);
    const term = query.trim().toLowerCase();
    const matched = term
      ? rows.filter((person) => person.displayName.toLowerCase().includes(term))
      : rows;
    return [...matched].sort((a, b) => b.closeness - a.closeness);
  }, [graph.data, query]);

  const eventCountById = useMemo(() => {
    const counts = new Map<string, number>();
    for (const link of graph.data?.links ?? []) {
      if (link.implicit) continue;
      counts.set(link.aPersonId, (counts.get(link.aPersonId) ?? 0) + link.eventCount);
      counts.set(link.bPersonId, (counts.get(link.bPersonId) ?? 0) + link.eventCount);
    }
    return counts;
  }, [graph.data]);

  if (graph.error) return <Failure error={graph.error} />;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">People</h1>
          <p className="text-muted-foreground text-sm">
            Everyone in the fellowship, strongest connection first.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="border-border flex rounded-md border p-0.5">
            <Button
              size="sm"
              variant={view === "table" ? "secondary" : "ghost"}
              onClick={() => setView("table")}
            >
              <Table2 className="size-3.5" aria-hidden />
              Table
            </Button>
            <Button
              size="sm"
              variant={view === "graph" ? "secondary" : "ghost"}
              onClick={() => setView("graph")}
            >
              <Network className="size-3.5" aria-hidden />
              Graph
            </Button>
          </div>
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by name"
            className="w-56"
            disabled={view === "graph"}
          />
          <Button
            variant="outline"
            disabled={exporting}
            onClick={() => void exportContacts()}
            title="Every contact card in one .vcf, for your phone or Contacts"
          >
            <Download className="size-3.5" aria-hidden />
            {exporting ? "Exporting" : "Export contacts"}
          </Button>
          <Button onClick={() => setAdding((open) => !open)}>
            <UserPlus className="size-3.5" aria-hidden />
            Add a person
          </Button>
        </div>
      </header>

      {exportNote ? <p className="text-muted-foreground text-sm">{exportNote}</p> : null}

      {adding ? (
        <PersonForm
          onDone={(personId) => {
            setAdding(false);
            navigate(`/people/${personId}`);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          label="People"
          value={people.length}
          hint="Not counting your own record"
        />
        <StatCard
          label="Occasions"
          value={graph.data?.events.length ?? 0}
          hint={`${activity.data?.events.length ?? 0} in the last 30 days`}
        />
        <StatCard
          label="Connections"
          value={(graph.data?.links ?? []).filter((link) => !link.implicit).length}
          hint="Pairs who share an occasion"
        />
      </div>

      {view === "graph" ? (
        <SectionCard
          title="The fellowship"
          description="Everyone, and the threads between them. Drawn from people.graph alone."
        >
          {graph.loading ? <Loading lines={8} /> : <GraphPanel payload={graph.data} />}
        </SectionCard>
      ) : null}

      <div
        className={`grid gap-6 lg:grid-cols-[1fr_20rem] ${view === "graph" ? "hidden" : ""}`}
      >
        <SectionCard
          title="The fellowship"
          description="Closeness is derived from the occasions you logged, with the count behind it."
        >
          {graph.loading ? <Loading lines={6} /> : null}

          {!graph.loading && people.length === 0 ? (
            <EmptyState
              icon={<Users className="size-6" />}
              title={query ? `Nobody matches "${query}"` : "Nobody here yet"}
              description={
                query
                  ? "Try a shorter name."
                  : "Add someone, or import an export from Settings."
              }
            />
          ) : null}

          {people.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Person</TableHead>
                  <TableHead className="w-32">Closeness</TableHead>
                  <TableHead className="w-20 text-right">Occasions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {people.map((person) => (
                  <TableRow key={person.id}>
                    <TableCell>
                      <a
                        href={`/people/${person.id}`}
                        onClick={onLink}
                        className="flex items-center gap-2.5"
                      >
                        <InitialsAvatar
                          name={person.displayName}
                          color={person.avatarColor}
                          size="sm"
                          src={avatarUrl(person.id)}
                        />
                        <span className="min-w-0">
                          <span className="block truncate font-medium">
                            {person.displayName}
                          </span>
                          {person.circles.length > 0 ? (
                            <span className="mt-0.5 flex flex-wrap gap-1">
                              {person.circles.slice(0, 2).map((circle) => (
                                <TagChip
                                  key={circle.id}
                                  label={circle.name}
                                  colour={circle.colour}
                                  variant="solid"
                                />
                              ))}
                            </span>
                          ) : null}
                        </span>
                      </a>
                    </TableCell>
                    <TableCell>
                      <ScoreBar score={person.closeness} showValue />
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right text-sm">
                      {eventCountById.get(person.id) ?? 0}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
        </SectionCard>

        <div className="space-y-6">
          <SectionCard title="Lately" description="The last 30 days.">
            {activity.loading ? <Loading lines={4} /> : null}
            {activity.data?.events.length === 0 ? (
              <p className="text-muted-foreground text-sm">Nothing logged in the last month.</p>
            ) : null}
            <ul className="space-y-3">
              {(activity.data?.events ?? []).slice(0, 6).map((event) => (
                <li key={event.id} className="space-y-1">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium">{event.title}</span>
                    <SentimentChip sentiment={event.sentiment} size="sm" />
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {new Date(event.occurredAt).toLocaleDateString()} with{" "}
                    {event.participants
                      .map((participant) => participant.displayName)
                      .slice(0, 3)
                      .join(", ") || "nobody recorded"}
                  </p>
                </li>
              ))}
            </ul>
          </SectionCard>

          <SectionCard
            title="Gone quiet"
            description="Nothing logged with them in the last 30 days."
            footer={
              <Button variant="ghost" size="sm" asChild>
                <a href="/events" onClick={onLink}>
                  Log an occasion
                </a>
              </Button>
            }
          >
            {(activity.data?.quietPeople ?? []).length === 0 ? (
              <p className="text-muted-foreground text-sm">Nobody. Good month.</p>
            ) : null}
            <div className="space-y-1">
              {(activity.data?.quietPeople ?? []).slice(0, 8).map((person) => (
                <StatRow
                  key={person.id}
                  label={person.displayName}
                  value={
                    person.lastEventAt
                      ? new Date(person.lastEventAt).toLocaleDateString()
                      : "never"
                  }
                />
              ))}
            </div>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

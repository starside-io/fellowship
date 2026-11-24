import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Inbox, X } from "lucide-react";

import { host, type AuditRow, type EventRow, type ProposalRow } from "@/client";
import { EmptyState, SectionCard } from "@/ds/index";
import { Loading } from "@/app/components/states";
import { invalidate } from "@/lib/use-rpc";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";

/**
 * Everything unconfirmed, in one place.
 *
 * The queue is the host's, not the module's: a proposal is a write an
 * assistant wants, waiting for a person to say yes. The audit log and the
 * event feed sit beside it, because "what has this thing been doing" is the
 * same question.
 */

export function Review() {
  const [proposals, setProposals] = useState<ProposalRow[] | null>(null);
  const [audit, setAudit] = useState<AuditRow[] | null>(null);
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refusals, setRefusals] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    void host.review("pending").then((answer) => setProposals(answer.proposals));
    void host.audit(60).then((answer) => setAudit(answer.entries));
    void host.events(30).then((answer) => setEvents(answer.events));
  }, []);

  useEffect(load, [load]);

  /** One decision, without reloading. True when it went through. */
  async function decideOne(id: string, decision: "confirm" | "discard"): Promise<boolean> {
    const outcome = await host.decide(id, decision);

    if (!outcome.ok) {
      // Confirming runs the tool, and a tool can refuse. The proposal stays
      // where it was, with the reason beside it.
      setRefusals((current) => ({ ...current, [id]: outcome.message ?? "Refused" }));
      return false;
    }

    setRefusals((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    return true;
  }

  async function decide(id: string, decision: "confirm" | "discard") {
    setBusy(id);
    const ok = await decideOne(id, decision);
    setBusy(null);
    if (!ok) return;
    // A confirmed proposal is a write, and every open screen should see it.
    invalidate();
    load();
  }

  /**
   * Several at once, one after another. Each is still its own decision: one
   * that is refused stays pending with its reason, and the rest go ahead.
   */
  async function decideMany(ids: string[], decision: "confirm" | "discard") {
    setBusy("group");
    for (const id of ids) await decideOne(id, decision);
    setBusy(null);
    invalidate();
    load();
  }

  // Proposals drafted together sit under one heading, in the order they
  // were drafted. The queue lists newest first, so a group is read backwards.
  const sections = useMemo(() => {
    const result: Array<{ group: ProposalRow["group"]; proposals: ProposalRow[] }> = [];
    const byGroup = new Map<string, (typeof result)[number]>();
    for (const proposal of proposals ?? []) {
      const group = proposal.group;
      if (!group) {
        const last = result.at(-1);
        if (last && last.group === null) last.proposals.push(proposal);
        else result.push({ group: null, proposals: [proposal] });
        continue;
      }
      const existing = byGroup.get(group.id);
      if (existing) existing.proposals.unshift(proposal);
      else {
        const section = { group, proposals: [proposal] };
        byGroup.set(group.id, section);
        result.push(section);
      }
    }
    return result;
  }, [proposals]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Review</h1>
        <p className="text-muted-foreground text-sm">
          What an assistant proposed, and what has been happening. Nothing here is confirmed
          until you say so.
        </p>
      </header>

      <Tabs defaultValue="queue">
        <TabsList>
          <TabsTrigger value="queue">
            Waiting
            {proposals && proposals.length > 0 ? (
              <Badge className="ml-1.5">{proposals.length}</Badge>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="events">Feed</TabsTrigger>
          <TabsTrigger value="audit">Audit</TabsTrigger>
        </TabsList>

        <TabsContent value="queue" className="pt-4">
          <SectionCard
            title="Proposals"
            description="Each one names the tool that would run and what it would write. Confirming runs it; discarding runs nothing."
          >
            {proposals === null ? <Loading lines={3} /> : null}
            {proposals?.length === 0 ? (
              <EmptyState
                icon={<Inbox className="size-6" />}
                title="Nothing waiting"
                description="A write an assistant wants confirmed shows up here."
              />
            ) : null}

            <div className="space-y-4">
              {sections.map((section) =>
                section.group ? (
                  <RecapGroup
                    key={section.group.id}
                    title={section.group.title}
                    detail={section.group.detail ?? null}
                    proposals={section.proposals}
                    busy={busy}
                    refusals={refusals}
                    onDecide={decide}
                    onDecideMany={decideMany}
                  />
                ) : (
                  <ul key={section.proposals[0]?.id} className="divide-border divide-y">
                    {section.proposals.map((proposal) => (
                      <ProposalItem
                        key={proposal.id}
                        proposal={proposal}
                        busy={busy === proposal.id}
                        refusal={refusals[proposal.id] ?? null}
                        onDecide={decide}
                      />
                    ))}
                  </ul>
                ),
              )}
            </div>
          </SectionCard>
        </TabsContent>

        <TabsContent value="events" className="pt-4">
          <SectionCard title="Feed" description="What the module announced, after it landed.">
            {events === null ? <Loading lines={3} /> : null}
            {events?.length === 0 ? (
              <p className="text-muted-foreground text-sm">Nothing yet.</p>
            ) : null}
            <ul className="divide-border divide-y text-sm">
              {(events ?? []).map((event) => (
                <li key={event.id} className="flex items-baseline justify-between gap-3 py-2">
                  <span className="font-mono text-xs">{event.name}</span>
                  <span className="text-muted-foreground text-xs">
                    {new Date(event.at).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          </SectionCard>
        </TabsContent>

        <TabsContent value="audit" className="pt-4">
          <SectionCard
            title="Audit"
            description="Every tool call, refusals included. Append only: nothing here is edited."
          >
            {audit === null ? <Loading lines={3} /> : null}
            <ul className="divide-border divide-y text-sm">
              {(audit ?? []).map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-baseline gap-2 py-2">
                  <Badge variant="outline" className="text-xs">
                    {entry.kind}
                  </Badge>
                  <span className="font-mono text-xs">{entry.tool}</span>
                  {entry.detail ? (
                    <span className="text-muted-foreground text-xs">
                      {Object.entries(entry.detail)
                        .map(([key, value]) => `${key} ${String(value)}`)
                        .join(", ")}
                    </span>
                  ) : null}
                  <span className="text-muted-foreground ml-auto text-xs">
                    {new Date(entry.at).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          </SectionCard>
        </TabsContent>
      </Tabs>
    </div>
  );
}

interface ProposalItemProps {
  proposal: ProposalRow;
  busy: boolean;
  refusal: string | null;
  onDecide: (id: string, decision: "confirm" | "discard") => Promise<void>;
  /** In a group, the tick that says this one is part of the next group decision. */
  selection?: { checked: boolean; onChange: (checked: boolean) => void };
}

function ProposalItem({ proposal, busy, refusal, onDecide, selection }: ProposalItemProps) {
  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2.5">
          {selection ? (
            <Checkbox
              className="mt-0.5"
              checked={selection.checked}
              onCheckedChange={(value) => selection.onChange(value === true)}
              aria-label="Include in the group decision"
            />
          ) : null}
          <div className="min-w-0">
            <p className="text-sm font-medium">{proposal.summary ?? proposal.tool}</p>
            <p className="text-muted-foreground text-xs">
              {proposal.tool} · {new Date(proposal.createdAt).toLocaleString()}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" disabled={busy} onClick={() => void onDecide(proposal.id, "confirm")}>
            <Check className="size-3.5" aria-hidden /> Confirm
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void onDecide(proposal.id, "discard")}
          >
            <X className="size-3.5" aria-hidden /> Discard
          </Button>
        </div>
      </div>
      {refusal ? <p className="text-negative text-sm">Not written: {refusal}</p> : null}
      <details>
        <summary className="text-muted-foreground cursor-pointer text-xs">
          What would be written
        </summary>
        <pre className="bg-muted mt-1 max-h-64 overflow-auto rounded-md p-2 text-xs">
          {JSON.stringify(proposal.payload, null, 2)}
        </pre>
      </details>
    </li>
  );
}

interface RecapGroupProps {
  title: string;
  detail: string | null;
  proposals: ProposalRow[];
  busy: string | null;
  refusals: Record<string, string>;
  onDecide: (id: string, decision: "confirm" | "discard") => Promise<void>;
  onDecideMany: (ids: string[], decision: "confirm" | "discard") => Promise<void>;
}

/**
 * A recap and everything it found, under one heading with the score each
 * link would reach if all of it were confirmed. Every row starts ticked; the
 * group buttons act on the ticked rows only.
 */
function RecapGroup({
  title,
  detail,
  proposals,
  busy,
  refusals,
  onDecide,
  onDecideMany,
}: RecapGroupProps) {
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const ticked = proposals.filter((proposal) => !unticked.has(proposal.id)).map((row) => row.id);
  const working = busy !== null;

  return (
    <section className="border-border rounded-lg border">
      <header className="border-border flex flex-wrap items-start justify-between gap-3 border-b p-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{title}</p>
          {detail ? <p className="text-muted-foreground text-sm">{detail}</p> : null}
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={working || ticked.length === 0}
            onClick={() => void onDecideMany(ticked, "confirm")}
          >
            <Check className="size-3.5" aria-hidden /> Confirm ticked ({ticked.length})
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={working || ticked.length === 0}
            onClick={() => void onDecideMany(ticked, "discard")}
          >
            <X className="size-3.5" aria-hidden /> Discard ticked
          </Button>
        </div>
      </header>
      <ul className="divide-border divide-y px-3">
        {proposals.map((proposal) => (
          <ProposalItem
            key={proposal.id}
            proposal={proposal}
            busy={working}
            refusal={refusals[proposal.id] ?? null}
            onDecide={onDecide}
            selection={{
              checked: !unticked.has(proposal.id),
              onChange: (checked) =>
                setUnticked((current) => {
                  const next = new Set(current);
                  if (checked) next.delete(proposal.id);
                  else next.add(proposal.id);
                  return next;
                }),
            }}
          />
        ))}
      </ul>
    </section>
  );
}

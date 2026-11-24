import { useMemo, useState } from "react";
import { CalendarDays, Check, X } from "lucide-react";

import { avatarUrl } from "@/client";
import {
  AvatarStack,
  EmptyState,
  SectionCard,
  SentimentChip,
  TagChip,
  sentimentLabel,
} from "@/ds/index";
import { useRpc, useWrite } from "@/lib/use-rpc";
import { Failure, Loading } from "@/app/components/states";
import { RichText, toDoc } from "@/app/components/rich-text";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { Textarea } from "@/ui/textarea";

/**
 * Occasions: what happened, with whom, and how it went.
 *
 * The form writes through people.log_interaction, which will not invent a
 * person for a name it does not know. So the participant picker only offers
 * people who exist, and a name typed in free text is not a way around that.
 */

const TYPES = [
  "HANGOUT",
  "MEAL",
  "CALL",
  "TRIP",
  "PARTY",
  "WORK",
  "FAVOUR",
  "CONFLICT",
  "MILESTONE",
  "OTHER",
] as const;

const SENTIMENTS = [-2, -1, 0, 1, 2] as const;

interface GraphPayload {
  people: Array<{ id: string; displayName: string; avatarColor: string; isSelf: boolean }>;
  events: Array<{
    id: string;
    occurredAt: string;
    type: string;
    sentiment: number;
    weight: number;
    participants: Array<{ personId: string; sentiment: number | null }>;
  }>;
}

interface SearchPayload {
  events: Array<{ id: string; title: string; type: string; occurredAt: string }>;
}

/** ?person=<id> opens the list filtered to one person, from their page. */
function personFromUrl(): string {
  const value = new URLSearchParams(window.location.search).get("person") ?? "";
  return /^[0-9a-fA-F-]{36}$/.test(value) ? value : "";
}

export function Events() {
  const graph = useRpc<GraphPayload>("people.graph");
  const [personId, setPersonId] = useState<string>(personFromUrl);
  const activity = useRpc<{
    events: Array<{
      id: string;
      title: string;
      type: string;
      occurredAt: string;
      sentiment: number;
      participants: Array<{ id: string; displayName: string }>;
    }>;
  }>(
    "people.activity",
    // One person's whole history fits; everyone's is the newest hundred.
    personId ? { days: 3650, limit: 500, personId } : { days: 3650, limit: 100 },
  );

  function choosePerson(next: string) {
    setPersonId(next);
    // Kept in the address, so the filtered list survives a reload.
    const url = next ? `/events?person=${next}` : "/events";
    window.history.replaceState({}, "", url);
  }

  const [type, setType] = useState<string>("");
  const [sentiment, setSentiment] = useState<string>("");

  const people = graph.data?.people ?? [];
  const pickable = [...people]
    .filter((person) => !person.isSelf)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  const chosen = people.find((person) => person.id === personId);
  const colourById = new Map(people.map((person) => [person.id, person.avatarColor]));

  const rows = useMemo(() => {
    let list = activity.data?.events ?? [];
    if (type) list = list.filter((event) => event.type === type);
    if (sentiment) list = list.filter((event) => String(event.sentiment) === sentiment);
    return list;
  }, [activity.data, type, sentiment]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Occasions</h1>
        <p className="text-muted-foreground text-sm">
          Everything logged, newest first. An occasion carries everyone who was there.
        </p>
      </header>

      <LogOccasion people={people} />

      <SectionCard
        title="Logged"
        description={
          chosen
            ? `With ${chosen.displayName}: ${activity.data?.events.length ?? 0} occasions.`
            : "The newest hundred. Filter by person, kind or how it went."
        }
        action={
          <div className="flex flex-wrap gap-2">
            <select
              value={personId}
              onChange={(event) => choosePerson(event.target.value)}
              aria-label="Filter by person"
              className="border-input bg-background h-8 max-w-44 rounded-md border px-2 text-sm"
            >
              <option value="">Anyone</option>
              {pickable.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.displayName}
                </option>
              ))}
            </select>
            <select
              value={type}
              onChange={(event) => setType(event.target.value)}
              aria-label="Filter by kind"
              className="border-input bg-background h-8 rounded-md border px-2 text-sm"
            >
              <option value="">Any kind</option>
              {TYPES.map((option) => (
                <option key={option} value={option}>
                  {option.toLowerCase()}
                </option>
              ))}
            </select>
            <select
              value={sentiment}
              onChange={(event) => setSentiment(event.target.value)}
              aria-label="Filter by sentiment"
              className="border-input bg-background h-8 rounded-md border px-2 text-sm"
            >
              <option value="">Any sentiment</option>
              {SENTIMENTS.map((option) => (
                <option key={option} value={String(option)}>
                  {sentimentLabel(option)}
                </option>
              ))}
            </select>
          </div>
        }
      >
        {activity.error ? <Failure error={activity.error} /> : null}
        {activity.loading ? <Loading lines={6} /> : null}

        {!activity.loading && rows.length === 0 ? (
          <EmptyState
            icon={<CalendarDays className="size-6" />}
            title="Nothing matches"
            description={
              (activity.data?.events.length ?? 0) === 0
                ? "Log the first occasion above."
                : "Clear the filters to see everything."
            }
          />
        ) : null}

        <ol className="divide-border divide-y">
          {rows.map((event) => (
            <li key={event.id} className="flex flex-wrap items-center gap-3 py-3">
              <span className="text-muted-foreground w-24 shrink-0 text-xs">
                {new Date(event.occurredAt).toLocaleDateString()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{event.title}</span>
                <span className="text-muted-foreground text-xs">
                  {event.participants.map((person) => person.displayName).join(", ") ||
                    "nobody recorded"}
                </span>
              </span>
              <AvatarStack
                people={event.participants.map((person) => ({
                  id: person.id,
                  name: person.displayName,
                  color: colourById.get(person.id) ?? "#6b6d75",
                  src: avatarUrl(person.id),
                }))}
                max={4}
              />
              <Badge variant="outline">{event.type.toLowerCase()}</Badge>
              <SentimentChip sentiment={event.sentiment} size="sm" />
            </li>
          ))}
        </ol>
      </SectionCard>
    </div>
  );
}

function LogOccasion({
  people,
}: {
  people: Array<{ id: string; displayName: string; avatarColor: string; isSelf: boolean }>;
}) {
  const write = useWrite<{
    written: boolean;
    unmatched?: Array<{ name: string; candidates: Array<{ displayName: string }> }>;
  }>("people.log_interaction");

  const [title, setTitle] = useState("");
  const [type, setType] = useState<string>("HANGOUT");
  const [when, setWhen] = useState(() => new Date().toISOString().slice(0, 10));
  const [location, setLocation] = useState("");
  const [sentiment, setSentiment] = useState(1);
  const [weight, setWeight] = useState(1);
  const [chosen, setChosen] = useState<string[]>([]);
  const [description, setDescription] = useState("");
  const [open, setOpen] = useState(false);

  const self = people.find((person) => person.isSelf);

  function toggle(personId: string) {
    setChosen((current) =>
      current.includes(personId)
        ? current.filter((id) => id !== personId)
        : [...current, personId],
    );
  }

  async function submit() {
    const participants = [
      ...(self && !chosen.includes(self.id) ? [{ personId: self.id }] : []),
      ...chosen.map((personId) => ({ personId })),
    ];

    const saved = await write.run({
      title,
      type,
      occurredAt: when,
      location: location.trim() === "" ? null : location,
      sentiment,
      weight,
      participants,
      ...(description.trim() === "" ? {} : { description: toDoc(description) }),
    });

    if (saved?.written) {
      setTitle("");
      setLocation("");
      setDescription("");
      setChosen([]);
      setOpen(false);
    }
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)}>
        <CalendarDays className="size-4" aria-hidden />
        Log an occasion
      </Button>
    );
  }

  return (
    <SectionCard
      title="Log an occasion"
      description="You are included automatically. Closeness moves as soon as this lands."
      action={
        <Button variant="ghost" size="icon" onClick={() => setOpen(false)} aria-label="Close">
          <X className="size-4" />
        </Button>
      }
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={write.pending || title.trim().length === 0} onClick={submit}>
            {write.pending ? "Saving" : "Save"}
          </Button>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          {write.result?.written ? (
            <span className="text-positive flex items-center gap-1 text-sm">
              <Check className="size-3.5" aria-hidden /> Logged.
            </span>
          ) : null}
        </div>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="occasion-title">What happened</Label>
          <Input
            id="occasion-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Dinner at Kanji"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="occasion-type">Kind</Label>
          <select
            id="occasion-type"
            value={type}
            onChange={(event) => setType(event.target.value)}
            className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
          >
            {TYPES.map((option) => (
              <option key={option} value={option}>
                {option.toLowerCase()}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="occasion-when">When</Label>
          <Input
            id="occasion-when"
            type="date"
            value={when}
            onChange={(event) => setWhen(event.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="occasion-where">Where</Label>
          <Input
            id="occasion-where"
            value={location}
            onChange={(event) => setLocation(event.target.value)}
            placeholder="Optional"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="occasion-weight">Weight</Label>
          <select
            id="occasion-weight"
            value={weight}
            onChange={(event) => setWeight(Number(event.target.value))}
            className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
          >
            <option value={1}>1, ordinary</option>
            <option value={2}>2, notable</option>
            <option value={3}>3, a big one</option>
          </select>
        </div>

        <div className="space-y-1.5 sm:col-span-2">
          <Label>How it went</Label>
          <div className="flex flex-wrap gap-2">
            {SENTIMENTS.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setSentiment(value)}
                aria-pressed={sentiment === value}
                className={
                  sentiment === value
                    ? "ring-ring rounded-full ring-2"
                    : "rounded-full opacity-60"
                }
              >
                <SentimentChip sentiment={value} />
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5 sm:col-span-2">
          <Label>Who was there</Label>
          <p className="text-muted-foreground text-xs">
            Only people already here. A name this app does not know is not a person it will
            invent.
          </p>
          <div className="flex flex-wrap gap-1.5 pt-1">
            {people
              .filter((person) => !person.isSelf)
              .map((person) => (
                <button key={person.id} type="button" onClick={() => toggle(person.id)}>
                  <TagChip
                    label={person.displayName}
                    colour={person.avatarColor}
                    variant={chosen.includes(person.id) ? "solid" : "soft"}
                  />
                </button>
              ))}
          </div>
        </div>

        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="occasion-notes">Anything to remember</Label>
          <Textarea
            id="occasion-notes"
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
      </div>

      {write.error ? <Failure error={write.error} /> : null}

      {write.result && write.result.written === false ? (
        <div className="border-warning/40 bg-warning/10 mt-3 rounded-md border p-3 text-sm">
          <p className="font-medium">Nothing was written.</p>
          <ul className="list-disc pl-4">
            {(write.result.unmatched ?? []).map((entry) => (
              <li key={entry.name}>
                No person called "{entry.name}"
                {entry.candidates.length > 0
                  ? `. Did you mean ${entry.candidates
                      .map((candidate) => candidate.displayName)
                      .join(", ")}?`
                  : "."}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </SectionCard>
  );
}

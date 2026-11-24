import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Contact,
  Download,
  ImagePlus,
  Pencil,
  Search,
} from "lucide-react";

import { avatarUrl } from "@/client";
import {
  EmptyState,
  InitialsAvatar,
  RadarChart,
  ScoreBar,
  SectionCard,
  SentimentChip,
  StatRow,
  TagChip,
  sentimentLabel,
} from "@/ds/index";
import { formatDay } from "@/lib/dates";
import { downloadVCards } from "@/lib/download";
import { cn } from "@/lib/cn";
import { useLinkHandler } from "@/lib/router";
import { useRpc, useWrite } from "@/lib/use-rpc";
import { Failure, Loading, Thin } from "@/app/components/states";
import { RichText, toDoc } from "@/app/components/rich-text";
import { DraftFacts, DraftSketch } from "@/app/components/draft";
import { AvatarPicker } from "@/app/components/avatar-picker";
import { ContactsEditor } from "@/app/components/contacts-editor";
import { PersonForm } from "@/app/components/person-form";
import { ContactIcon } from "@/app/components/social-icon";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";
import { Textarea } from "@/ui/textarea";

/**
 * One person: the facts, the sketch, the personality radar, what they like
 * and avoid, what happened, and who they know.
 *
 * Allergies sit in a warning box at the top, always, because the question
 * this app gets asked most is where to take someone to dinner and getting
 * that wrong can hurt them. Dislikes can run to dozens, so the box only
 * counts them and the full list lives in its own searchable tab.
 */

interface Tag {
  id: string;
  name: string;
  colour: string;
}

interface PersonPayload {
  person: {
    id: string;
    displayName: string;
    firstName: string | null;
    lastName: string | null;
    isSelf: boolean;
    avatarColor: string;
    location: string | null;
    howWeMet: string | null;
    birthday: string | null;
    metOn: string | null;
    mbti: string | null;
    commStyle: unknown;
    archived: boolean;
    contacts: Array<{
      id: string;
      kind: string;
      platform: string | null;
      value: string;
      url: string | null;
      isPrimary: boolean;
      label: string | null;
      source: string;
      verifiedAt: string | null;
    }>;
    circles: Tag[];
    interests: Tag[];
    allergies: Tag[];
    dislikes: Tag[];
    customValues: Array<{
      id: string;
      value: unknown;
      fieldDefinition: { key: string; label: string };
    }>;
    avatar: { mime: string; source: string; fetchedAt: string } | null;
  };
  profile: {
    summary: string | null;
    whatLands: string | null;
    whatToAvoid: string | null;
    opener: string | null;
    traits: unknown;
    personality: unknown;
    personalityAt: string | null;
    sources: unknown;
    source: string;
    confirmedAt: string | null;
  } | null;
  favours: Array<{
    id: string;
    direction: string;
    description: string;
    settledAt: string | null;
  }>;
  personalityAxes: PersonalityAxis[];
}

interface PersonalityAxis {
  key: string;
  label: string;
  left: string;
  right: string;
  hint: string;
}

interface PersonalityScore {
  key: string;
  value: number;
  evidence: string;
  confidence: "high" | "medium" | "low";
}

interface Insights {
  displayName: string;
  cadence: {
    totalEvents: number;
    lastEventAt: string | null;
    daysSinceLastEvent: number | null;
    eventsLastYear: number;
    eventsPerMonthLastYear: number;
  };
  sentiment: {
    count: number;
    mean: number;
    decayedMean: number;
    trend: { direction: string; delta: number | null; windowDays: number };
  };
  eventTypes: Array<{ type: string; count: number; meanSentiment: number }>;
  closeness: {
    linked: boolean;
    score: number | null;
    tie: string | null;
    sharedEventCount: number;
  } | null;
}

interface Timeline {
  entries: Array<
    | { kind: "note"; note: { id: string; body: unknown; occurredAt: string; pinned: boolean } }
    | {
        kind: "event";
        event: {
          id: string;
          title: string;
          type: string;
          occurredAt: string;
          sentiment: number;
          description: unknown;
          participants: Array<{ person: { id: string; displayName: string } }>;
        };
      }
  >;
}

export function Person({ personId }: { personId: string }) {
  const onLink = useLinkHandler();
  const detail = useRpc<PersonPayload>("people.get", { personId });
  const insights = useRpc<Insights>("people.insights", { personId });
  const timeline = useRpc<Timeline>("people.timeline", { personId });
  // The registry, for the glyph a platform uses. Core holds the icon name.
  const platforms = useRpc<{ platforms: Array<{ key: string; label: string; icon: string }> }>(
    "people.social_platforms",
  );
  const [editing, setEditing] = useState<"facts" | "contacts" | "picture" | null>(null);
  const [tab, setTab] = useState("overview");
  const [exporting, setExporting] = useState(false);

  if (detail.error) return <Failure error={detail.error} />;
  if (detail.loading || !detail.data) return <Loading lines={8} />;

  const { person, profile, favours } = detail.data;
  const platformByKey = new Map(
    (platforms.data?.platforms ?? []).map((entry) => [entry.key, entry]),
  );
  const openFavours = favours.filter((favour) => favour.settledAt === null);

  return (
    <div className="space-y-6">
      <a
        href="/people"
        onClick={onLink}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Everyone
      </a>

      <header className="flex flex-wrap items-start gap-4">
        <InitialsAvatar
          name={person.displayName}
          color={person.avatarColor}
          size="xl"
          // Stamped with when the picture was fetched. The route is the same
          // URL whatever is behind it, so without this the browser keeps the
          // 404 it got before a picture was stored and the circle stays blank.
          src={
            person.avatar
              ? `${avatarUrl(person.id)}?v=${new Date(person.avatar.fetchedAt).getTime()}`
              : avatarUrl(person.id)
          }
        />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-heading text-2xl font-semibold tracking-tight">
              {person.displayName}
            </h1>
            {person.isSelf ? <Badge variant="secondary">You</Badge> : null}
            {person.mbti ? (
              <Badge variant="outline" title="Myers-Briggs type, as you recorded it">
                {person.mbti}
              </Badge>
            ) : null}
            {person.archived ? <Badge variant="outline">Archived</Badge> : null}
          </div>
          <p className="text-muted-foreground text-sm">
            {[person.location, person.howWeMet].filter(Boolean).join(" · ") ||
              "No location or meeting story recorded."}
          </p>
          {person.contacts.length > 0 ? (
            <ul className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-sm">
              {person.contacts.map((contact) => {
                const platform = contact.platform
                  ? platformByKey.get(contact.platform)
                  : undefined;
                return (
                  <li key={contact.id} className="flex items-center gap-1.5">
                    <ContactIcon
                      kind={contact.kind}
                      iconName={platform?.icon}
                      className="text-muted-foreground size-3.5"
                    />
                    {contact.url ? (
                      <a
                        href={contact.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="hover:underline"
                      >
                        {contact.value}
                      </a>
                    ) : (
                      <span>{contact.value}</span>
                    )}
                    {(platform?.label ?? contact.platform) !== null &&
                    (platform?.label ?? contact.platform) !== undefined ? (
                      <span className="text-muted-foreground text-xs">
                        {platform?.label ?? contact.platform}
                      </span>
                    ) : null}
                    {contact.label ? (
                      <span className="text-muted-foreground text-xs">{contact.label}</span>
                    ) : null}
                    {contact.isPrimary ? (
                      <Badge variant="secondary" className="text-xs">
                        default
                      </Badge>
                    ) : null}
                    {contact.source !== "MANUAL" && contact.verifiedAt === null ? (
                      <Badge variant="outline" className="text-xs">
                        unconfirmed
                      </Badge>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setEditing(editing === "facts" ? null : "facts")}
          >
            <Pencil className="size-3.5" aria-hidden />
            Edit facts
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setEditing(editing === "contacts" ? null : "contacts")}
          >
            <Contact className="size-3.5" aria-hidden />
            Contact card
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setEditing(editing === "picture" ? null : "picture")}
          >
            <ImagePlus className="size-3.5" aria-hidden />
            Picture
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={exporting}
            title="A .vcf contact card for your phone or Contacts"
            onClick={async () => {
              setExporting(true);
              try {
                await downloadVCards([person.id]);
              } finally {
                setExporting(false);
              }
            }}
          >
            <Download className="size-3.5" aria-hidden />
            {exporting ? "Exporting" : "vCard"}
          </Button>
        </div>
      </header>

      {editing === "picture" ? (
        <AvatarPicker
          personId={person.id}
          onDone={() => setEditing(null)}
          onCancel={() => setEditing(null)}
        />
      ) : null}

      {editing === "facts" ? (
        <PersonForm
          person={person}
          onDone={() => setEditing(null)}
          onCancel={() => setEditing(null)}
        />
      ) : null}

      {editing === "contacts" ? (
        <ContactsEditor
          personId={person.id}
          contacts={person.contacts}
          onDone={() => setEditing(null)}
          onCancel={() => setEditing(null)}
        />
      ) : null}

      {person.allergies.length > 0 ? (
        <div className="border-negative/40 bg-negative/10 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2">
          <p className="text-negative flex items-center gap-1.5 text-sm font-medium">
            <AlertTriangle className="size-4" aria-hidden />
            Allergic to
          </p>
          <div className="flex flex-wrap gap-1.5">
            {person.allergies.map((tag) => (
              <TagChip key={tag.id} label={tag.name} colour={tag.colour} variant="solid" />
            ))}
          </div>
          {person.dislikes.length > 0 ? (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground ml-auto text-xs underline-offset-2 hover:underline"
              onClick={() => setTab("preferences")}
            >
              and {person.dislikes.length} {person.dislikes.length === 1 ? "dislike" : "dislikes"}
            </button>
          ) : null}
        </div>
      ) : null}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="personality">Personality</TabsTrigger>
          <TabsTrigger value="preferences">
            Likes and dislikes
            <span className="text-muted-foreground text-xs tabular-nums">
              {person.interests.length + person.dislikes.length + person.allergies.length}
            </span>
          </TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="connections">Connections</TabsTrigger>
        </TabsList>

        <TabsContent value="personality" className="space-y-6 pt-4">
          <PersonalityCard
            axes={detail.data.personalityAxes}
            scores={profile?.personality}
            writtenAt={profile?.personalityAt ?? null}
            mbti={person.mbti}
            onEditMbti={() => {
              setEditing("facts");
              document.querySelector("main")?.scrollTo({ top: 0, behavior: "smooth" });
            }}
          />
        </TabsContent>

        <TabsContent value="preferences" className="pt-4">
          <Preferences
            interests={person.interests}
            dislikes={person.dislikes}
            allergies={person.allergies}
          />
        </TabsContent>

        <TabsContent value="overview" className="space-y-6 pt-4">
          <div className="grid gap-6 lg:grid-cols-2">
            <SectionCard
              title="The sketch"
              description="Written from the history and the pages it names. Yours to confirm."
              action={
                profile ? (
                  <Badge variant={profile.confirmedAt ? "secondary" : "outline"}>
                    {profile.confirmedAt ? "confirmed" : "unconfirmed"}
                  </Badge>
                ) : null
              }
            >
              {profile ? (
                <dl className="space-y-3 text-sm">
                  {profile.summary ? <p>{profile.summary}</p> : null}
                  {profile.whatLands ? (
                    <div>
                      <dt className="text-muted-foreground text-xs uppercase">What lands</dt>
                      <dd>{profile.whatLands}</dd>
                    </div>
                  ) : null}
                  {profile.whatToAvoid ? (
                    <div>
                      <dt className="text-muted-foreground text-xs uppercase">What to avoid</dt>
                      <dd>{profile.whatToAvoid}</dd>
                    </div>
                  ) : null}
                  {profile.opener ? (
                    <div>
                      <dt className="text-muted-foreground text-xs uppercase">An opener</dt>
                      <dd>{profile.opener}</dd>
                    </div>
                  ) : null}
                </dl>
              ) : (
                <EmptyState
                  size="sm"
                  title="No sketch yet"
                  description="An assistant can draft one from the history and the chats. It lands here unconfirmed."
                />
              )}
            </SectionCard>

            <SectionCard title="Facts" description="Everything stored about them.">
              <div className="space-y-1">
                {person.birthday ? (
                  <StatRow label="Birthday" value={formatDay(person.birthday)} />
                ) : null}
                {person.metOn ? <StatRow label="Met on" value={formatDay(person.metOn)} /> : null}
                {person.mbti ? <StatRow label="Myers-Briggs" value={person.mbti} /> : null}
                {person.customValues.map((value) => (
                  <StatRow
                    key={value.id}
                    label={value.fieldDefinition.label}
                    value={String(value.value ?? "")}
                  />
                ))}
                {openFavours.length > 0 ? (
                  <StatRow
                    label="Open favours"
                    value={openFavours.length}
                    hint={openFavours
                      .map(
                        (favour) =>
                          `${favour.direction === "I_OWE_THEM" ? "you owe" : "they owe"}: ${
                            favour.description
                          }`,
                      )
                      .join(" · ")}
                  />
                ) : null}
              </div>

              {person.interests.length > 0 ? (
                <div className="pt-3">
                  <p className="text-muted-foreground pb-1.5 text-xs uppercase">Likes</p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {person.interests.slice(0, 10).map((tag) => (
                      <TagChip key={tag.id} label={tag.name} colour={tag.colour} />
                    ))}
                    {person.interests.length > 10 ? (
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline"
                        onClick={() => setTab("preferences")}
                      >
                        {person.interests.length - 10} more
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {person.circles.length > 0 ? (
                <div className="pt-3">
                  <p className="text-muted-foreground pb-1.5 text-xs uppercase">Circles</p>
                  <div className="flex flex-wrap gap-1.5">
                    {person.circles.map((circle) => (
                      <TagChip
                        key={circle.id}
                        label={circle.name}
                        colour={circle.colour}
                        variant="solid"
                      />
                    ))}
                  </div>
                </div>
              ) : null}
            </SectionCard>
          </div>

          <InsightsCard state={insights} />

          <div className="grid gap-6 lg:grid-cols-2">
            <DraftSketch personId={person.id} />
            <DraftFacts personId={person.id} />
          </div>
        </TabsContent>

        <TabsContent value="timeline" className="space-y-6 pt-4">
          <AddNote personId={person.id} />
          <SectionCard
            title="What happened"
            description="Occasions and notes, newest first."
            action={
              <Button variant="ghost" size="sm" asChild>
                <a href={`/events?person=${person.id}`} onClick={onLink}>
                  All occasions
                </a>
              </Button>
            }
          >
            {timeline.loading ? <Loading lines={5} /> : null}
            {timeline.data?.entries.length === 0 ? (
              <EmptyState
                size="sm"
                title="Nothing logged yet"
                description="Log an occasion from the Occasions screen, or write a note above."
              />
            ) : null}
            <ol className="space-y-4">
              {(timeline.data?.entries ?? []).map((entry) =>
                entry.kind === "event" ? (
                  <li key={entry.event.id} className="border-border border-l-2 pl-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium">{entry.event.title}</span>
                      <SentimentChip sentiment={entry.event.sentiment} size="sm" />
                    </div>
                    <p className="text-muted-foreground text-xs">
                      {new Date(entry.event.occurredAt).toLocaleDateString()} ·{" "}
                      {entry.event.type.toLowerCase()} ·{" "}
                      {entry.event.participants
                        .map((participant) => participant.person.displayName)
                        .join(", ")}
                    </p>
                    {entry.event.description ? (
                      <RichText doc={entry.event.description} className="pt-1" empty="" />
                    ) : null}
                  </li>
                ) : (
                  <li key={entry.note.id} className="border-thread/40 border-l-2 pl-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground text-xs">
                        {new Date(entry.note.occurredAt).toLocaleDateString()} · note
                      </span>
                      {entry.note.pinned ? <Badge variant="outline">pinned</Badge> : null}
                    </div>
                    <RichText doc={entry.note.body} className="pt-1" />
                  </li>
                ),
              )}
            </ol>
          </SectionCard>
        </TabsContent>

        <TabsContent value="connections" className="pt-4">
          <Connections personId={person.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function InsightsCard({ state }: { state: ReturnType<typeof useRpc<Insights>> }) {
  if (state.error) return <Failure error={state.error} />;
  if (state.loading || !state.data) return <Loading lines={3} />;

  const { cadence, sentiment, eventTypes, closeness } = state.data;

  return (
    <SectionCard
      title="What the history says"
      description="Figures with the count behind them. A thin sample says so."
    >
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="space-y-1">
          <StatRow label="Occasions" value={cadence.totalEvents} />
          <StatRow
            label="Last one"
            value={
              cadence.daysSinceLastEvent === null
                ? "never"
                : `${cadence.daysSinceLastEvent} days ago`
            }
          />
          <StatRow
            label="Per month, last year"
            value={cadence.eventsPerMonthLastYear}
            hint={`${cadence.eventsLastYear} in the last 12 months`}
          />
          <StatRow
            label="Mean sentiment"
            value={
              sentiment.count === 0 ? (
                <Thin count={0} />
              ) : (
                `${sentiment.mean} (${sentimentLabel(Math.round(sentiment.mean))})`
              )
            }
            hint={`decayed ${sentiment.decayedMean}, over ${sentiment.count} occasions`}
          />
          <StatRow
            label={`Trend, ${sentiment.trend.windowDays} days`}
            value={
              sentiment.trend.direction === "insufficient" ? (
                <Thin count={sentiment.count} />
              ) : (
                `${sentiment.trend.direction} ${
                  sentiment.trend.delta === null ? "" : `(${sentiment.trend.delta})`
                }`
              )
            }
          />
        </div>

        <div className="space-y-3">
          {closeness ? (
            <div>
              <p className="text-muted-foreground pb-1 text-xs uppercase">Closeness to you</p>
              <ScoreBar score={closeness.score ?? 0} showValue />
              <p className="text-muted-foreground pt-1 text-xs">
                {closeness.sharedEventCount} shared{" "}
                {closeness.sharedEventCount === 1 ? "occasion" : "occasions"}
                {closeness.tie ? ` · ${closeness.tie.toLowerCase().replace("_", " ")}` : ""}
              </p>
            </div>
          ) : null}

          {eventTypes.length > 0 ? (
            <div>
              <p className="text-muted-foreground pb-1 text-xs uppercase">By kind</p>
              <div className="space-y-1">
                {eventTypes.slice(0, 5).map((type) => (
                  <StatRow
                    key={type.type}
                    label={type.type.toLowerCase()}
                    value={type.count}
                    hint={`mean ${type.meanSentiment}`}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </SectionCard>
  );
}

function AddNote({ personId }: { personId: string }) {
  const [text, setText] = useState("");
  const write = useWrite<unknown>("people.add_note");

  return (
    <SectionCard
      title="Write a note"
      description="Blank lines split paragraphs. Stored as a document, not a string."
      footer={
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={write.pending || text.trim().length === 0}
            onClick={async () => {
              const saved = await write.run({ personId, body: toDoc(text) });
              if (saved) setText("");
            }}
          >
            {write.pending ? "Saving" : "Save note"}
          </Button>
          {write.result ? (
            <span className="text-positive text-sm">Saved.</span>
          ) : null}
        </div>
      }
    >
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={3}
        placeholder="What happened, what they said, what to remember."
      />
      {write.error ? <Failure error={write.error} /> : null}
    </SectionCard>
  );
}

function Connections({ personId }: { personId: string }) {
  const onLink = useLinkHandler();
  const graph = useRpc<{
    people: Array<{ id: string; displayName: string; avatarColor: string }>;
    links: Array<{
      aPersonId: string;
      bPersonId: string;
      tie: string;
      score: number;
      eventCount: number;
      manualScore: number | null;
      implicit: boolean;
    }>;
  }>("people.graph");

  if (graph.error) return <Failure error={graph.error} />;
  if (graph.loading || !graph.data) return <Loading lines={4} />;

  const byId = new Map(graph.data.people.map((person) => [person.id, person]));
  const rows = graph.data.links
    .filter(
      (link) =>
        !link.implicit && (link.aPersonId === personId || link.bPersonId === personId),
    )
    .map((link) => {
      const otherId = link.aPersonId === personId ? link.bPersonId : link.aPersonId;
      return {
        other: byId.get(otherId),
        score: link.manualScore ?? link.score,
        eventCount: link.eventCount,
        tie: link.tie,
      };
    })
    .filter((row) => row.other !== undefined)
    .sort((a, b) => b.score - a.score);

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No connections yet"
        description="A connection appears when two people share a logged occasion."
      />
    );
  }

  return (
    <SectionCard
      title="Who they know"
      description="Derived from shared occasions. A pair with none loses its link unless you curated it."
    >
      <div className="space-y-3">
        {rows.map((row) => (
          <div key={row.other!.id} className="flex items-center gap-3">
            <a
              href={`/people/${row.other!.id}`}
              onClick={onLink}
              className="flex min-w-0 flex-1 items-center gap-2"
            >
              <InitialsAvatar
                name={row.other!.displayName}
                color={row.other!.avatarColor}
                size="sm"
                src={avatarUrl(row.other!.id)}
              />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {row.other!.displayName}
                </span>
                <span className="text-muted-foreground text-xs">
                  {row.tie.toLowerCase().replace("_", " ")} · {row.eventCount}{" "}
                  {row.eventCount === 1 ? "occasion" : "occasions"}
                </span>
              </span>
            </a>
            <div className="w-32">
              <ScoreBar score={row.score} showValue />
            </div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

type PreferenceKind = "all" | "interests" | "dislikes" | "allergies";

const KIND_LABEL: Record<Exclude<PreferenceKind, "all">, string> = {
  interests: "Likes",
  dislikes: "Dislikes",
  allergies: "Allergies",
};

/**
 * Everything they like and avoid, searchable. Three lists rather than one
 * box, because a list of fifty dislikes is only useful if the one you are
 * wondering about can be found.
 */
function Preferences({
  interests,
  dislikes,
  allergies,
}: {
  interests: Tag[];
  dislikes: Tag[];
  allergies: Tag[];
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<PreferenceKind>("all");
  const term = query.trim().toLowerCase();

  const groups = useMemo(() => {
    const all = { allergies, dislikes, interests } as const;
    return (Object.keys(all) as Array<keyof typeof all>)
      .filter((key) => kind === "all" || kind === key)
      .map((key) => ({
        key,
        total: all[key].length,
        tags: term ? all[key].filter((tag) => tag.name.toLowerCase().includes(term)) : all[key],
      }));
  }, [allergies, dislikes, interests, kind, term]);

  const total = interests.length + dislikes.length + allergies.length;
  if (total === 0) {
    return (
      <EmptyState
        title="Nothing recorded yet"
        description="A chat recap or the facts draft proposes likes, dislikes and allergies for review."
      />
    );
  }

  const matches = groups.reduce((sum, group) => sum + group.tags.length, 0);

  return (
    <SectionCard
      title="Likes and dislikes"
      description="What lands, what to steer clear of, and what can hurt them."
    >
      <div className="flex flex-wrap items-center gap-2 pb-4">
        <div className="relative min-w-48 flex-1">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${total} entries`}
            className="pl-8"
          />
        </div>
        <div className="border-border flex rounded-md border p-0.5">
          {(["all", "interests", "dislikes", "allergies"] as const).map((value) => {
            const count =
              value === "all"
                ? total
                : { interests, dislikes, allergies }[value].length;
            return (
              <Button
                key={value}
                size="sm"
                variant={kind === value ? "secondary" : "ghost"}
                onClick={() => setKind(value)}
              >
                {value === "all" ? "All" : KIND_LABEL[value]}
                <span className="text-muted-foreground text-xs tabular-nums">{count}</span>
              </Button>
            );
          })}
        </div>
      </div>

      {matches === 0 ? (
        <p className="text-muted-foreground py-6 text-center text-sm">
          Nothing matches "{query}".
        </p>
      ) : (
        <div
          className={cn(
            "grid gap-6",
            groups.length > 1 ? "md:grid-cols-3" : "grid-cols-1",
          )}
        >
          {groups.map((group) => (
            <section key={group.key} className="min-w-0">
              <h3
                className={cn(
                  "flex items-center justify-between pb-2 text-xs font-medium uppercase",
                  group.key === "allergies" ? "text-negative" : "text-muted-foreground",
                )}
              >
                {KIND_LABEL[group.key]}
                <span className="tabular-nums">
                  {term ? `${group.tags.length} of ${group.total}` : group.total}
                </span>
              </h3>
              {group.tags.length === 0 ? (
                <p className="text-muted-foreground text-sm">None.</p>
              ) : (
                <ul
                  className={cn(
                    groups.length > 1
                      ? "divide-border max-h-96 divide-y overflow-y-auto pr-1"
                      : "flex flex-wrap gap-1.5",
                  )}
                >
                  {group.tags.map((tag) =>
                    groups.length > 1 ? (
                      <li key={tag.id} className="flex items-center gap-2 py-1.5 text-sm">
                        <span
                          className="size-2 shrink-0 rounded-full"
                          style={{ backgroundColor: tag.colour }}
                          aria-hidden
                        />
                        <span className="min-w-0 break-words">{tag.name}</span>
                      </li>
                    ) : (
                      <li key={tag.id}>
                        <TagChip label={tag.name} colour={tag.colour} />
                      </li>
                    ),
                  )}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

const CONFIDENCE_LABEL: Record<PersonalityScore["confidence"], string> = {
  high: "solid",
  medium: "fair",
  low: "thin",
};

/**
 * The radar and the evidence behind each point. Axes the material said
 * nothing about stay on the chart as dashed spokes, so unknown never reads
 * as zero.
 */
function PersonalityCard({
  axes,
  scores: raw,
  writtenAt,
  mbti,
  onEditMbti,
}: {
  axes: PersonalityAxis[];
  scores: unknown;
  writtenAt: string | null;
  mbti: string | null;
  onEditMbti: () => void;
}) {
  const [active, setActive] = useState<string | null>(null);
  const scores = new Map(
    (Array.isArray(raw) ? (raw as PersonalityScore[]) : []).map((score) => [score.key, score]),
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <SectionCard
        title="Personality"
        description={
          writtenAt
            ? `Scored from the chats and the history on ${formatDay(writtenAt)}.`
            : "Scored from the chats and the history by an assistant, then confirmed by you in review."
        }
        action={
          <Button variant="ghost" size="sm" onClick={onEditMbti}>
            {mbti ? mbti : "Add MBTI"}
          </Button>
        }
      >
        {scores.size === 0 ? (
          <EmptyState
            size="sm"
            title="No radar yet"
            description="Ask an assistant connected to Fellowship to update personalities from the chats. It reads people.personality_status, drafts each one with people.draft_context job personality, and the result waits in Review."
          />
        ) : (
          <RadarChart
            className="mx-auto w-full max-w-sm"
            axes={axes.map((axis) => ({
              key: axis.key,
              label: axis.label,
              value: scores.get(axis.key)?.value ?? null,
            }))}
            active={active}
            onHover={setActive}
          />
        )}
      </SectionCard>

      <SectionCard title="Why each score" description="The evidence the draft gave, axis by axis.">
        <ul className="space-y-3">
          {axes.map((axis) => {
            const score = scores.get(axis.key);
            return (
              <li
                key={axis.key}
                className={cn(
                  "-mx-2 rounded-md px-2 py-1 transition-colors",
                  active === axis.key ? "bg-accent/60" : "",
                )}
                onMouseEnter={() => setActive(axis.key)}
                onMouseLeave={() => setActive(null)}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">{axis.label}</span>
                  <span className="text-muted-foreground text-xs">
                    {score
                      ? `${score.value} · ${CONFIDENCE_LABEL[score.confidence]} evidence`
                      : "not scored"}
                  </span>
                </div>
                <div className="text-muted-foreground flex items-center gap-2 pt-1 text-xs">
                  <span className="w-20 shrink-0">{axis.left}</span>
                  <span className="bg-muted relative h-1.5 flex-1 rounded-full">
                    {score ? (
                      <span
                        className="bg-chart-1 absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
                        style={{ left: `${score.value}%` }}
                      />
                    ) : null}
                  </span>
                  <span className="w-20 shrink-0 text-right">{axis.right}</span>
                </div>
                <p className="text-muted-foreground pt-1 text-xs">
                  {score ? score.evidence : axis.hint}
                </p>
              </li>
            );
          })}
        </ul>
      </SectionCard>
    </div>
  );
}

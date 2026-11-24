import { useState } from "react";
import { Cake, CalendarDays, HeartHandshake, Users } from "lucide-react";

import { avatarUrl } from "@/client";
import { EmptyState, InitialsAvatar, SectionCard, StatCard, TagChip } from "@/ds/index";
import { formatDay } from "@/lib/dates";
import { cn } from "@/lib/cn";
import { useLinkHandler } from "@/lib/router";
import { useRpc } from "@/lib/use-rpc";
import { Failure, Loading } from "@/app/components/states";
import { Badge } from "@/ui/badge";

/**
 * The landing page: what is coming up, then how the last year went.
 *
 * Everything on it comes from people.dashboard in one call, plus the review
 * count the rail already shows. Each chart is one measure on one axis: the
 * occasions and the messages are different scales, so they get a chart each
 * rather than sharing one.
 */

interface DashboardPayload {
  upcoming: Array<{
    kind: "birthday" | "met";
    personId: string;
    displayName: string;
    avatarColor: string;
    date: string;
    daysAway: number;
    years: number | null;
  }>;
  missingBirthdays: number;
  months: Array<{
    month: string;
    occasions: number;
    people: number;
    messages: number;
    meanSentiment: number | null;
  }>;
  types: Array<{ type: string; count: number }>;
  topPeople: Array<{
    personId: string;
    displayName: string;
    avatarColor: string;
    occasions: number;
  }>;
  circles: Array<{ name: string; colour: string; people: number }>;
  totals: {
    people: number;
    occasions: number;
    messages: number;
    conversations: number;
    occasionsLast30: number;
  };
}

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthLabel(key: string): string {
  return MONTH_SHORT[Number(key.slice(5, 7)) - 1] ?? key;
}

function whenLabel(daysAway: number): string {
  if (daysAway === 0) return "Today";
  if (daysAway === 1) return "Tomorrow";
  if (daysAway < 7) return `In ${daysAway} days`;
  if (daysAway < 14) return "Next week";
  return `In ${Math.round(daysAway / 7)} weeks`;
}

function number(value: number): string {
  return new Intl.NumberFormat().format(value);
}

export function Home() {
  const dashboard = useRpc<DashboardPayload>("people.dashboard", { horizonDays: 60 });

  if (dashboard.error) return <Failure error={dashboard.error} />;
  if (dashboard.loading || !dashboard.data) return <Loading lines={10} />;

  const data = dashboard.data;
  const yearOccasions = data.months.reduce((sum, month) => sum + month.occasions, 0);
  const yearMessages = data.months.reduce((sum, month) => sum + month.messages, 0);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Home</h1>
        <p className="text-muted-foreground text-sm">
          What is coming up, and how the last twelve months went.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="People" value={number(data.totals.people)} hint="Not counting you" />
        <StatCard
          label="Occasions"
          value={number(data.totals.occasions)}
          hint={`${data.totals.occasionsLast30} in the last 30 days`}
        />
        <StatCard
          label="Messages"
          value={number(data.totals.messages)}
          hint={`Across ${data.totals.conversations} imported ${
            data.totals.conversations === 1 ? "chat" : "chats"
          }`}
        />
        <StatCard
          label="Coming up"
          value={data.upcoming.length}
          hint="Birthdays and anniversaries, next 60 days"
        />
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[22rem_1fr]">
        <Upcoming data={data} />

        <div className="space-y-6">
          <SectionCard
            title="Occasions per month"
            description={`${yearOccasions} logged over the last twelve months.`}
          >
            <MonthBars
              months={data.months}
              value={(month) => month.occasions}
              tooltip={(month) =>
                `${month.occasions} ${month.occasions === 1 ? "occasion" : "occasions"}, ${
                  month.people
                } ${month.people === 1 ? "person" : "people"}${
                  month.meanSentiment === null ? "" : `, mean sentiment ${month.meanSentiment}`
                }`
              }
              colour="var(--chart-1)"
            />
          </SectionCard>

          <SectionCard
            title="Messages per month"
            description={`${number(yearMessages)} in the imported chats over the same months.`}
          >
            <MonthBars
              months={data.months}
              value={(month) => month.messages}
              tooltip={(month) => `${number(month.messages)} messages`}
              colour="var(--chart-2)"
            />
          </SectionCard>
        </div>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-3">
        <TopPeople data={data} />
        <Kinds data={data} />
        <SectionCard title="Circles" description="How many people sit in each.">
          {data.circles.length === 0 ? (
            <p className="text-muted-foreground text-sm">No circles yet.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {data.circles.map((circle) => (
                <TagChip
                  key={circle.name}
                  label={`${circle.name} · ${circle.people}`}
                  colour={circle.colour}
                  variant="solid"
                />
              ))}
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}

function Upcoming({ data }: { data: DashboardPayload }) {
  const onLink = useLinkHandler();

  return (
    <SectionCard
      title="Coming up"
      description="The next 60 days."
      footer={
        data.missingBirthdays > 0 ? (
          <p className="text-muted-foreground text-xs">
            {data.missingBirthdays} {data.missingBirthdays === 1 ? "person has" : "people have"} no
            birthday recorded.
          </p>
        ) : null
      }
    >
      {data.upcoming.length === 0 ? (
        <EmptyState
          size="sm"
          icon={<Cake className="size-6" />}
          title="Nothing in the next 60 days"
          description="Add birthdays from a person's facts and they show up here."
        />
      ) : (
        <ul className="space-y-1">
          {data.upcoming.map((entry) => (
            <li key={`${entry.kind}:${entry.personId}`}>
              <a
                href={`/people/${entry.personId}`}
                onClick={onLink}
                className="hover:bg-accent/60 -mx-2 flex items-center gap-3 rounded-md px-2 py-1.5"
              >
                <InitialsAvatar
                  name={entry.displayName}
                  color={entry.avatarColor}
                  size="md"
                  src={avatarUrl(entry.personId)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{entry.displayName}</span>
                  <span className="text-muted-foreground flex items-center gap-1 text-xs">
                    {entry.kind === "birthday" ? (
                      <Cake className="size-3" aria-hidden />
                    ) : (
                      <HeartHandshake className="size-3" aria-hidden />
                    )}
                    {entry.kind === "birthday"
                      ? entry.years
                        ? `Turns ${entry.years}`
                        : "Birthday"
                      : `${entry.years} ${entry.years === 1 ? "year" : "years"} since you met`}
                    {" · "}
                    {formatDay(`${entry.date}T00:00:00.000Z`, { short: true })}
                  </span>
                </span>
                <Badge
                  variant={entry.daysAway <= 7 ? "default" : "secondary"}
                  className="shrink-0"
                >
                  {whenLabel(entry.daysAway)}
                </Badge>
              </a>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/**
 * Twelve bars, one measure. The tallest bar sets the scale; a month with
 * nothing still gets a hairline so the gap reads as zero, not as missing.
 */
function MonthBars({
  months,
  value,
  tooltip,
  colour,
}: {
  months: DashboardPayload["months"];
  value: (month: DashboardPayload["months"][number]) => number;
  tooltip: (month: DashboardPayload["months"][number]) => string;
  colour: string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const max = Math.max(1, ...months.map(value));
  const hovered = months.find((month) => month.month === hover);

  return (
    <div>
      <div className="text-muted-foreground flex h-5 items-center text-xs" aria-live="polite">
        {hovered ? (
          <span>
            <span className="text-foreground font-medium">
              {monthLabel(hovered.month)} {hovered.month.slice(0, 4)}
            </span>
            {": "}
            {tooltip(hovered)}
          </span>
        ) : (
          <span>Peak {number(max)} in a month. Hover a bar for the detail.</span>
        )}
      </div>
      <div className="border-border mt-2 flex h-36 items-end gap-0.5 border-b">
        {months.map((month) => {
          const amount = value(month);
          const height = amount === 0 ? 0 : Math.max(3, (amount / max) * 100);
          return (
            <div
              key={month.month}
              className="flex h-full flex-1 items-end"
              onMouseEnter={() => setHover(month.month)}
              onMouseLeave={() => setHover(null)}
              role="img"
              aria-label={`${monthLabel(month.month)}: ${tooltip(month)}`}
            >
              <div
                className={cn(
                  "w-full rounded-t transition-opacity",
                  hover && hover !== month.month ? "opacity-45" : "opacity-100",
                )}
                style={{ height: `${height}%`, backgroundColor: colour }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex gap-0.5">
        {months.map((month) => (
          <span
            key={month.month}
            className={cn(
              "flex-1 text-center text-[0.65rem]",
              hover === month.month ? "text-foreground font-medium" : "text-muted-foreground",
            )}
          >
            {monthLabel(month.month)}
          </span>
        ))}
      </div>
    </div>
  );
}

function TopPeople({ data }: { data: DashboardPayload }) {
  const onLink = useLinkHandler();
  const max = Math.max(1, ...data.topPeople.map((person) => person.occasions));

  return (
    <SectionCard title="Seen most" description="Shared occasions, last 90 days.">
      {data.topPeople.length === 0 ? (
        <EmptyState
          size="sm"
          icon={<Users className="size-6" />}
          title="Nobody in the last 90 days"
          description="Log an occasion and it counts here."
        />
      ) : (
        <ul className="space-y-2">
          {data.topPeople.map((person) => (
            <li key={person.personId}>
              <a
                href={`/people/${person.personId}`}
                onClick={onLink}
                className="flex items-center gap-2.5"
                title={`${person.occasions} shared ${person.occasions === 1 ? "occasion" : "occasions"}`}
              >
                <InitialsAvatar
                  name={person.displayName}
                  color={person.avatarColor}
                  size="sm"
                  src={avatarUrl(person.personId)}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm">{person.displayName}</span>
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {person.occasions}
                    </span>
                  </span>
                  <span className="bg-muted mt-1 block h-1.5 overflow-hidden rounded-full">
                    <span
                      className="block h-full rounded-full"
                      style={{
                        width: `${(person.occasions / max) * 100}%`,
                        backgroundColor: "var(--chart-1)",
                      }}
                    />
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function Kinds({ data }: { data: DashboardPayload }) {
  const total = data.types.reduce((sum, type) => sum + type.count, 0);
  const max = Math.max(1, ...data.types.map((type) => type.count));

  return (
    <SectionCard title="What you did" description="Occasions by kind, last twelve months.">
      {data.types.length === 0 ? (
        <EmptyState
          size="sm"
          icon={<CalendarDays className="size-6" />}
          title="No occasions yet"
          description="Log one from the Occasions screen."
        />
      ) : (
        <ul className="space-y-2">
          {data.types.map((type) => (
            <li
              key={type.type}
              className="flex items-center gap-2.5"
              title={`${type.count} of ${total}, ${Math.round((type.count / total) * 100)}%`}
            >
              <span className="w-20 text-sm capitalize">{type.type.toLowerCase()}</span>
              <span className="bg-muted h-2 flex-1 overflow-hidden rounded-full">
                <span
                  className="block h-full rounded-full"
                  style={{
                    width: `${(type.count / max) * 100}%`,
                    backgroundColor: "var(--chart-2)",
                  }}
                />
              </span>
              <span className="text-muted-foreground w-8 text-right text-xs tabular-nums">
                {type.count}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

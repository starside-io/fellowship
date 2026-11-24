import { useEffect, useMemo, useState } from "react";
import { Radar } from "lucide-react";

import { avatarUrl } from "@/client";
import { EmptyState, InitialsAvatar, RadarChart, SectionCard } from "@/ds/index";
import { cn } from "@/lib/cn";
import { useLinkHandler } from "@/lib/router";
import { useRpc } from "@/lib/use-rpc";
import { Failure, Loading } from "@/app/components/states";
import { Badge } from "@/ui/badge";

/**
 * Everyone on the same eight axes, side by side.
 *
 * Up to three people overlay on one radar, each in a colour of its own that
 * follows the person, not their position in the selection. Below it, the pairs
 * who score most alike and least alike, counted only over the axes both have
 * a score on, with the number of shared axes beside each figure.
 */

interface Axis {
  key: string;
  label: string;
  left: string;
  right: string;
}

interface Row {
  personId: string;
  displayName: string;
  avatarColor: string;
  mbti: string | null;
  scores: Array<{ key: string; value: number; confidence: string }>;
  personalityAt: string | null;
  stale: boolean;
}

interface StatusPayload {
  axes: Axis[];
  people: Row[];
  stale: number;
}

/** Validated as a categorical set per theme, see --compare-* in tokens.css. */
const SLOTS = ["var(--compare-1)", "var(--compare-2)", "var(--compare-3)"];

/** Below this many shared axes, a likeness figure says too little to show. */
const MIN_SHARED = 4;

interface Pair {
  a: Row;
  b: Row;
  shared: number;
  /** 100 minus the mean gap over the shared axes. */
  likeness: number;
}

function likeness(a: Row, b: Row): { shared: number; likeness: number } | null {
  const bByKey = new Map(b.scores.map((score) => [score.key, score.value]));
  const gaps = a.scores.flatMap((score) => {
    const other = bByKey.get(score.key);
    return other === undefined ? [] : [Math.abs(score.value - other)];
  });
  if (gaps.length < MIN_SHARED) return null;
  const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  return { shared: gaps.length, likeness: Math.round(100 - mean) };
}

export function Personalities() {
  const status = useRpc<StatusPayload>("people.personality_status");
  const [selected, setSelected] = useState<string[]>([]);
  // A colour belongs to a person for as long as they stay selected.
  const [slotOf, setSlotOf] = useState<Record<string, number>>({});
  const [active, setActive] = useState<string | null>(null);

  const scored = useMemo(
    () => (status.data?.people ?? []).filter((row) => row.scores.length > 0),
    [status.data],
  );
  const unscored = useMemo(
    () => (status.data?.people ?? []).filter((row) => row.scores.length === 0),
    [status.data],
  );

  // Start with the two people the owner talks to most, when there are two.
  useEffect(() => {
    if (selected.length > 0 || scored.length === 0) return;
    const first = scored.slice(0, 2).map((row) => row.personId);
    setSelected(first);
    setSlotOf(Object.fromEntries(first.map((id, index) => [id, index])));
  }, [scored, selected.length]);

  const pairs = useMemo(() => {
    const list: Pair[] = [];
    for (let i = 0; i < scored.length; i += 1) {
      for (let j = i + 1; j < scored.length; j += 1) {
        const a = scored[i] as Row;
        const b = scored[j] as Row;
        const result = likeness(a, b);
        if (result) list.push({ a, b, ...result });
      }
    }
    return list.sort((x, y) => y.likeness - x.likeness);
  }, [scored]);

  if (status.error) return <Failure error={status.error} />;
  if (status.loading || !status.data) return <Loading lines={8} />;

  const axes = status.data.axes;
  const byId = new Map(scored.map((row) => [row.personId, row]));
  const chosen = selected.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });

  function toggle(personId: string) {
    if (selected.includes(personId)) {
      setSelected(selected.filter((id) => id !== personId));
      setSlotOf(({ [personId]: _, ...rest }) => rest);
      return;
    }
    const used = new Set(Object.values(slotOf));
    const free = SLOTS.findIndex((_, index) => !used.has(index));
    if (free === -1) return;
    setSelected([...selected, personId]);
    setSlotOf({ ...slotOf, [personId]: free });
  }

  function choosePair(pair: Pair) {
    setSelected([pair.a.personId, pair.b.personId]);
    setSlotOf({ [pair.a.personId]: 0, [pair.b.personId]: 1 });
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Personalities</h1>
        <p className="text-muted-foreground text-sm">
          Everyone on the same eight axes, scored from the chats. Pick up to three to compare.
        </p>
      </header>

      {scored.length === 0 ? (
        <EmptyState
          icon={<Radar className="size-6" />}
          title="No radars yet"
          description="Ask an assistant connected to Fellowship to run /personalities. Each radar waits in Review until you confirm it."
        />
      ) : (
        <>
          <SectionCard title="Who to compare" description={`${scored.length} people have a radar.`}>
            <div className="flex flex-wrap gap-2">
              {scored.map((row) => {
                const slot = slotOf[row.personId];
                const on = selected.includes(row.personId);
                const full = !on && selected.length >= SLOTS.length;
                return (
                  <button
                    key={row.personId}
                    type="button"
                    disabled={full}
                    aria-pressed={on}
                    onClick={() => toggle(row.personId)}
                    className={cn(
                      "flex items-center gap-2 rounded-full border py-1 pr-3 pl-1 text-sm transition-colors",
                      on ? "bg-accent border-transparent" : "border-border hover:bg-accent/60",
                      full && "opacity-40",
                    )}
                    style={on && slot !== undefined ? { borderColor: SLOTS[slot] } : undefined}
                  >
                    <InitialsAvatar
                      name={row.displayName}
                      color={row.avatarColor}
                      size="sm"
                      src={avatarUrl(row.personId)}
                    />
                    {on && slot !== undefined ? (
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: SLOTS[slot] }}
                        aria-hidden
                      />
                    ) : null}
                    <span>{row.displayName}</span>
                    {row.mbti ? (
                      <span className="text-muted-foreground text-xs">{row.mbti}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </SectionCard>

          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <SectionCard title="Overlaid" description="Dashed spokes: nobody selected has a score there.">
              {chosen.length === 0 ? (
                <p className="text-muted-foreground text-sm">Pick someone above.</p>
              ) : (
                <>
                  <RadarChart
                    className="mx-auto w-full max-w-md"
                    axes={axes.map((axis) => ({ key: axis.key, label: axis.label }))}
                    series={chosen.map((row) => ({
                      key: row.personId,
                      label: row.displayName,
                      colour: SLOTS[slotOf[row.personId] ?? 0] as string,
                      values: Object.fromEntries(
                        row.scores.map((score) => [score.key, score.value]),
                      ),
                    }))}
                    active={active}
                    onHover={setActive}
                  />
                  <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1 pt-2 text-sm">
                    {chosen.map((row) => (
                      <li key={row.personId} className="flex items-center gap-1.5">
                        <span
                          className="size-2.5 rounded-full"
                          style={{ backgroundColor: SLOTS[slotOf[row.personId] ?? 0] }}
                          aria-hidden
                        />
                        {row.displayName}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </SectionCard>

            <SectionCard title="Axis by axis" description="0 is the left end, 100 the right.">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground text-xs">
                    <th className="pb-2 text-left font-normal">Axis</th>
                    {chosen.map((row) => (
                      <th key={row.personId} className="pb-2 text-right font-normal">
                        <span className="inline-flex items-center gap-1">
                          <span
                            className="size-2 rounded-full"
                            style={{ backgroundColor: SLOTS[slotOf[row.personId] ?? 0] }}
                            aria-hidden
                          />
                          {row.displayName.split(" ")[0]}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {axes.map((axis) => (
                    <tr
                      key={axis.key}
                      className={cn(
                        "border-border border-t",
                        active === axis.key && "bg-accent/60",
                      )}
                      onMouseEnter={() => setActive(axis.key)}
                      onMouseLeave={() => setActive(null)}
                    >
                      <td className="py-1.5">
                        <span className="font-medium">{axis.label}</span>
                        <span className="text-muted-foreground block text-xs">
                          {axis.left} to {axis.right}
                        </span>
                      </td>
                      {chosen.map((row) => {
                        const score = row.scores.find((entry) => entry.key === axis.key);
                        return (
                          <td
                            key={row.personId}
                            className="text-right tabular-nums"
                            title={score ? `${score.confidence} evidence` : "not scored"}
                          >
                            {score ? score.value : <span className="text-muted-foreground">-</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </SectionCard>
          </div>

          <div className="grid items-start gap-6 lg:grid-cols-2">
            <PairList
              title="Most alike"
              description={`Over the axes both share, at least ${MIN_SHARED}. Click to compare.`}
              pairs={pairs.slice(0, 6)}
              onPick={choosePair}
            />
            <PairList
              title="Least alike"
              description="The same measure, from the other end."
              // Only pairs not already in the list beside it, so a handful of
              // radars does not show the same pairs twice in reverse.
              pairs={pairs.slice(6).reverse().slice(0, 6)}
              onPick={choosePair}
            />
          </div>
        </>
      )}

      {unscored.length > 0 ? (
        <SectionCard
          title="Not scored yet"
          description="They have chats but no confirmed radar. Drafts may be waiting in Review."
        >
          <NameList rows={unscored} />
        </SectionCard>
      ) : null}
    </div>
  );
}

function PairList({
  title,
  description,
  pairs,
  onPick,
}: {
  title: string;
  description: string;
  pairs: Pair[];
  onPick: (pair: Pair) => void;
}) {
  return (
    <SectionCard title={title} description={description}>
      {pairs.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Not enough radars with shared axes yet.
        </p>
      ) : (
        <ul className="space-y-1">
          {pairs.map((pair) => (
            <li key={`${pair.a.personId}:${pair.b.personId}`}>
              <button
                type="button"
                onClick={() => onPick(pair)}
                className="hover:bg-accent/60 -mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
              >
                <InitialsAvatar
                  name={pair.a.displayName}
                  color={pair.a.avatarColor}
                  size="sm"
                  src={avatarUrl(pair.a.personId)}
                />
                <InitialsAvatar
                  name={pair.b.displayName}
                  color={pair.b.avatarColor}
                  size="sm"
                  src={avatarUrl(pair.b.personId)}
                  className="-ml-3"
                />
                <span className="min-w-0 flex-1 truncate">
                  {pair.a.displayName} and {pair.b.displayName}
                </span>
                <span className="text-muted-foreground text-xs">{pair.shared} axes</span>
                <Badge variant="secondary" className="tabular-nums">
                  {pair.likeness}%
                </Badge>
              </button>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function NameList({ rows }: { rows: Row[] }) {
  const onLink = useLinkHandler();
  return (
    <div className="flex flex-wrap gap-2">
      {rows.map((row) => (
        <a
          key={row.personId}
          href={`/people/${row.personId}`}
          onClick={onLink}
          className="border-border hover:bg-accent/60 flex items-center gap-2 rounded-full border py-1 pr-3 pl-1 text-sm"
        >
          <InitialsAvatar
            name={row.displayName}
            color={row.avatarColor}
            size="sm"
            src={avatarUrl(row.personId)}
          />
          {row.displayName}
        </a>
      ))}
    </div>
  );
}

import { useCallback, useMemo, useState } from "react";
import { Network, RotateCcw } from "lucide-react";
import {
  Graph,
  buildScene,
  defaultSettings,
  formatLastEvent,
  formatReplayDate,
  tieLabel,
  type GraphPayload,
  type SceneSettings,
} from "@fellowship/graph";

import { avatarUrl } from "@/client";
import { EmptyState, InitialsAvatar, ScoreBar, SectionCard } from "@/ds/index";
import { navigate } from "@/lib/router";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Label } from "@/ui/label";

/**
 * The graph, and the controls around it.
 *
 * The package draws from the payload alone, so everything here is chrome: a
 * replay slider, a circle to isolate, which kinds of occasion count, and a
 * panel for whoever is selected. Moving any of them rebuilds the scene and
 * nothing else: no tool call, no refetch.
 */

export function GraphPanel({ payload }: { payload: GraphPayload | null | undefined }) {
  const base = useMemo(() => defaultSettings(payload), [payload]);
  const [settings, setSettings] = useState<SceneSettings>(base);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // A new payload moves the replay bounds, so the controls follow it.
  const [seenRange, setSeenRange] = useState(base.cutoff);
  if (seenRange !== base.cutoff) {
    setSeenRange(base.cutoff);
    setSettings(base);
  }

  const scene = useMemo(() => buildScene(payload, settings), [payload, settings]);
  const patch = useCallback(
    (next: Partial<SceneSettings>) => setSettings((current) => ({ ...current, ...next })),
    [],
  );

  const people = payload?.people ?? [];
  const selected = people.find((person) => person.id === selectedId) ?? null;

  const connections = useMemo(() => {
    if (!selectedId) return [];
    return scene.connections
      .filter((edge) => edge.aId === selectedId || edge.bId === selectedId)
      .map((edge) => {
        const otherId = edge.aId === selectedId ? edge.bId : edge.aId;
        return { edge, other: people.find((person) => person.id === otherId) };
      })
      .filter((row) => row.other !== undefined)
      .sort((a, b) => b.edge.effectiveScore - a.edge.effectiveScore);
  }, [scene.connections, selectedId, people]);

  if (people.length <= 1) {
    return (
      <EmptyState
        icon={<Network className="size-6" />}
        title="Nobody to draw yet"
        description={
          people.length === 1
            ? "You are the only person here. Add someone and a thread appears straight away."
            : "Add a few people and the graph starts drawing."
        }
      />
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_17rem]">
      <div className="space-y-3">
        <div className="bg-card border-border flex flex-wrap items-end gap-4 rounded-lg border p-3">
          <div className="min-w-56 flex-1 space-y-1">
            <Label htmlFor="graph-replay" className="text-xs">
              Replay to {formatReplayDate(settings.cutoff)}
            </Label>
            <input
              id="graph-replay"
              type="range"
              min={scene.range.min}
              max={scene.range.max}
              step={scene.range.step}
              value={settings.cutoff}
              onChange={(event) => patch({ cutoff: Number(event.target.value) })}
              className="accent-primary w-full"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="graph-circle" className="text-xs">
              Isolate a circle
            </Label>
            <select
              id="graph-circle"
              value={settings.circleId}
              onChange={(event) => patch({ circleId: event.target.value })}
              className="border-input bg-background h-8 rounded-md border px-2 text-sm"
            >
              <option value="">Everyone</option>
              {scene.circles.map((circle) => (
                <option key={circle.id} value={circle.id}>
                  {circle.name}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="graph-min" className="text-xs">
              At least
            </Label>
            <select
              id="graph-min"
              value={settings.minEvents}
              onChange={(event) => patch({ minEvents: Number(event.target.value) })}
              className="border-input bg-background h-8 rounded-md border px-2 text-sm"
            >
              {[0, 1, 2, 3, 5, 10].map((value) => (
                <option key={value} value={value}>
                  {value === 0 ? "any occasion" : `${value} occasions`}
                </option>
              ))}
            </select>
          </div>

          <label className="flex items-center gap-1.5 pb-1 text-sm">
            <input
              type="checkbox"
              checked={settings.showImplicit}
              onChange={(event) => patch({ showImplicit: event.target.checked })}
              className="size-3.5"
            />
            Knows-them threads
          </label>

          <label className="flex items-center gap-1.5 pb-1 text-sm">
            <input
              type="checkbox"
              checked={settings.showSelf}
              onChange={(event) => patch({ showSelf: event.target.checked })}
              className="size-3.5"
            />
            You
          </label>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSettings(base);
              setSelectedId(null);
            }}
          >
            <RotateCcw className="size-3.5" aria-hidden />
            Reset
          </Button>
        </div>

        <div className="bg-card border-border h-[32rem] overflow-hidden rounded-lg border">
          <Graph
            payload={payload}
            settings={settings}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onOpen={(personId) => navigate(`/people/${personId}`)}
            className="h-full w-full"
          />
        </div>

        <p className="text-muted-foreground text-xs">
          Thickness is how strongly a pair feels, colour is which way, dashed means nothing
          felt on record. Click a node to read it, double click to open the person.
        </p>
      </div>

      <SectionCard
        title={selected ? selected.displayName : "Nobody selected"}
        description={
          selected
            ? "Their connections at this point in the replay."
            : "Click a node to see who they are connected to."
        }
      >
        {selected ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <InitialsAvatar
                name={selected.displayName}
                color={selected.avatarColor}
                size="md"
                src={avatarUrl(selected.id)}
              />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{selected.displayName}</p>
                <p className="text-muted-foreground text-xs">
                  {connections.length}{" "}
                  {connections.length === 1 ? "connection" : "connections"}
                </p>
              </div>
            </div>

            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={() => navigate(`/people/${selected.id}`)}
            >
              Open their page
            </Button>

            <ul className="space-y-2">
              {connections.slice(0, 8).map(({ edge, other }) => (
                <li key={edge.key} className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm">{other!.displayName}</span>
                    <Badge variant="outline" className="text-xs">
                      {tieLabel(edge.tie)}
                    </Badge>
                  </div>
                  <ScoreBar score={edge.effectiveScore} showValue />
                  <p className="text-muted-foreground text-xs">
                    {edge.implicit
                      ? "No occasions together yet"
                      : `${edge.eventCount} together · ${formatLastEvent(edge.lastEventAt)}`}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </SectionCard>
    </div>
  );
}

import {
  buildEdges,
  buildPairIndex,
  circleOptions,
  eventTypeOptions,
  normalisePayload,
  radiusForCloseness,
  replayCloseness,
  replayPairScores,
  replayRange,
  type CircleOption,
  type EdgeDatum,
  type ReplayRange,
} from "./utils.js";
import type { GraphPayload } from "./payload.js";

/**
 * Turning a payload and a set of filters into a scene: nodes, edges, and what
 * each one should look like.
 *
 * This is pure on purpose. In the reference implementation the same work sat
 * inside a component as a dozen memos, where the only way to check that a
 * filter did what it said was to look at the picture. Here it is a function
 * with a return value, and the component is the thin part.
 */

export interface SceneSettings {
  /** The replay point, in milliseconds. Events after it do not count. */
  cutoff: number;
  /** Occasion kinds to keep. An empty list means every kind. */
  types: string[];
  /** Dims everyone outside this circle. Empty means nobody is dimmed. */
  circleId: string;
  /** Drops a pair with fewer shared occasions than this. */
  minEvents: number;
  showSelf: boolean;
  /** Keeps the synthesized "knows them" threads. */
  showImplicit: boolean;
}

export interface SceneNode {
  id: string;
  name: string;
  initials: string;
  colour: string;
  isSelf: boolean;
  /** Seeded start position, so the layout does not begin on a saddle. */
  x: number;
  y: number;
}

export interface SceneEdge {
  key: string;
  source: string;
  target: string;
  aId: string;
  bId: string;
}

export interface NodeVisual {
  radius: number;
  dimmed: boolean;
  hidden: boolean;
  closeness: number;
}

export interface EdgeVisual {
  score: number;
  eventCount: number;
  tie: string;
  dimmed: boolean;
  pinned: boolean;
  implicit: boolean;
}

export interface Scene {
  nodes: SceneNode[];
  edges: SceneEdge[];
  nodeVisuals: Map<string, NodeVisual>;
  edgeVisuals: Map<string, EdgeVisual>;
  selfId: string | null;
  /** What the controls can offer, read off the payload rather than guessed. */
  circles: CircleOption[];
  typeOptions: string[];
  range: ReplayRange;
  /** The edges the filters kept, for a side panel that lists connections. */
  connections: EdgeDatum[];
}

export function defaultSettings(payload: GraphPayload | null | undefined): SceneSettings {
  const { events } = normalisePayload(payload);
  return {
    cutoff: replayRange(events).max,
    types: [],
    circleId: "",
    minEvents: 0,
    showSelf: true,
    showImplicit: true,
  };
}

/** The same initials rule the avatars use, kept here so this package stands alone. */
export function initialsOf(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0] as string).slice(0, 2).toUpperCase();
  return `${(parts[0] as string)[0] ?? ""}${(parts[parts.length - 1] as string)[0] ?? ""}`.toUpperCase();
}

export function buildScene(
  payload: GraphPayload | null | undefined,
  settings: SceneSettings,
): Scene {
  const { people, events, links } = normalisePayload(payload);
  const peopleIds = new Set(people.map((person) => person.id));
  const selfId = people.find((person) => person.isSelf)?.id ?? null;

  const typeOptions = eventTypeOptions(events);
  const types =
    settings.types.length === 0 || settings.types.length === typeOptions.length
      ? null
      : new Set(settings.types);

  const replay = replayPairScores(buildPairIndex(events, peopleIds), {
    cutoff: new Date(settings.cutoff),
    types,
  });

  const closenessById = replayCloseness(people, selfId, replay, links);
  const edges = buildEdges({
    links,
    replay,
    people: peopleIds,
    minEvents: settings.minEvents,
    showImplicit: settings.showImplicit,
  });

  const hidden = new Set<string>();
  if (selfId && !settings.showSelf) hidden.add(selfId);

  const dimmed = new Set<string>();
  if (settings.circleId) {
    for (const person of people) {
      const member = (person.circles ?? []).some(
        (circle) => circle.id === settings.circleId,
      );
      if (!member && person.id !== selfId) dimmed.add(person.id);
    }
  }

  const visible = edges.filter((edge) => !hidden.has(edge.aId) && !hidden.has(edge.bId));

  const nodeVisuals = new Map<string, NodeVisual>();
  for (const person of people) {
    const closeness = closenessById.get(person.id) ?? 0;
    nodeVisuals.set(person.id, {
      radius: radiusForCloseness(closeness),
      dimmed: dimmed.has(person.id),
      hidden: hidden.has(person.id),
      closeness,
    });
  }

  const edgeVisuals = new Map<string, EdgeVisual>();
  for (const edge of visible) {
    edgeVisuals.set(edge.key, {
      score: edge.effectiveScore,
      eventCount: edge.eventCount,
      tie: edge.tie,
      dimmed: dimmed.has(edge.aId) || dimmed.has(edge.bId),
      pinned: edge.pinned,
      implicit: edge.implicit,
    });
  }

  return {
    nodes: seedPositions(people, links),
    edges: visible.map((edge) => ({
      key: edge.key,
      source: edge.aId,
      target: edge.bId,
      aId: edge.aId,
      bId: edge.bId,
    })),
    nodeVisuals,
    edgeVisuals,
    selfId,
    circles: circleOptions(people),
    typeOptions,
    range: replayRange(events),
    connections: visible,
  };
}

/**
 * Starting angles, grouped so people who share an occasion begin on the same
 * side of the centre. Nearly antipodal starts leave the simulation on a saddle
 * where the pull between two linked people points straight through the self
 * node, and it can sit there for a long time.
 */
function seedPositions(
  people: GraphPayload["people"],
  links: GraphPayload["links"],
): SceneNode[] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const up = parent.get(id);
    if (!up || up === id) {
      parent.set(id, id);
      return id;
    }
    const root = find(up);
    parent.set(id, root);
    return root;
  };

  for (const link of links) {
    if (!link.implicit && link.eventCount > 0) {
      parent.set(find(link.aPersonId), find(link.bPersonId));
    }
  }

  const centreId = people.find((person) => person.isSelf)?.id ?? null;
  const groups = new Map<string, string[]>();
  for (const person of people) {
    if (person.id === centreId) continue;
    const root = find(person.id);
    const members = groups.get(root) ?? [];
    members.push(person.id);
    groups.set(root, members);
  }

  const angleById = new Map<string, number>();
  const total = Math.max(1, people.length - (centreId ? 1 : 0));
  let slot = 0;
  for (const members of [...groups.values()].sort((a, b) => b.length - a.length)) {
    for (const id of members) {
      angleById.set(id, (2 * Math.PI * slot) / total);
      slot += 1;
    }
  }

  return people.map((person) => {
    const angle = angleById.get(person.id);
    const seeded = !person.isSelf && angle !== undefined;
    return {
      id: person.id,
      name: person.displayName,
      initials: initialsOf(person.displayName),
      // Empty falls back to the neutral token once the canvas resolves it.
      colour: person.circles?.[0]?.colour || person.avatarColor || "",
      isSelf: person.isSelf,
      x: seeded ? Math.cos(angle) * 130 : 0,
      y: seeded ? Math.sin(angle) * 130 : 0,
    };
  });
}

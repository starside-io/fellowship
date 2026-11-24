/**
 * The canvas. Everything it draws comes from the scene it is handed, and the
 * scene comes from the payload: no fetching, no tools, no host.
 *
 * Ported from akai-ito with the Next dynamic import swapped for React.lazy,
 * which keeps the force engine out of the first bundle the same way without
 * needing a framework.
 *
 * What the picture means, which is the part worth keeping:
 *   thickness  how strongly the pair feels, from the replayed score
 *   colour     which way that feeling goes
 *   dashed     nothing felt on record, or a synthesized knows-them thread
 *   length     close pairs sit nearer
 *   radius     closeness to the self node
 */

import * as React from "react";
import type { ForceGraphProps, LinkObject, NodeObject } from "react-force-graph-2d";

import {
  distanceForScore,
  readGraphPalette,
  rgba,
  strengthForScore,
  scoreColour,
  widthForScore,
  isFeelingless,
  HAIRLINE_WIDTH,
  withAlpha,
  type GraphPalette,
} from "./utils.js";
import type { EdgeVisual, NodeVisual } from "./scene.js";

export type { EdgeVisual, NodeVisual };

// Object type aliases, not interfaces: the force graph datum types carry a
// string index signature and only aliases pick one up implicitly.
export type CanvasNode = {
  id: string;
  name: string;
  initials: string;
  colour: string;
  isSelf: boolean;
  x?: number;
  y?: number;
};

export type CanvasEdge = {
  key: string;
  source: string;
  target: string;
  aId: string;
  bId: string;
};

interface ForceGraphHandle {
  zoomToFit(durationMs?: number, padding?: number): unknown;
  d3ReheatSimulation(): unknown;
  d3Force(forceName: string): unknown;
  centerAt(x?: number, y?: number, durationMs?: number): unknown;
}

/** The slice of the d3 link force this component drives. */
type LinkForce = {
  distance(accessor: (link: LinkObject<CanvasNode, CanvasEdge>) => number): unknown;
  strength(accessor: (link: LinkObject<CanvasNode, CanvasEdge>) => number): unknown;
};

/** The slice of the d3 many body force this component drives. */
type ChargeForce = {
  strength(accessor: (node: NodeObject<CanvasNode>) => number): unknown;
  distanceMax?(value: number): unknown;
};

type ForceGraphComponentProps = ForceGraphProps<CanvasNode, CanvasEdge> & {
  ref?: React.Ref<ForceGraphHandle>;
};

const ForceGraph2D = React.lazy(async () => {
  const module_ = await import("react-force-graph-2d");
  return {
    default: module_.default as unknown as React.ComponentType<ForceGraphComponentProps>,
  };
});

const DEFAULT_NODE_VISUAL: NodeVisual = {
  radius: 4,
  dimmed: false,
  hidden: false,
  closeness: 0,
};

const DEFAULT_EDGE_VISUAL: EdgeVisual = {
  score: 0,
  eventCount: 0,
  tie: "",
  dimmed: false,
  pinned: false,
  implicit: false,
};

/**
 * The tone tokens as sRGB, re-read whenever the theme class on the root
 * element flips so the canvas recolours without a reload.
 */
function useGraphPalette(): GraphPalette | null {
  const [palette, setPalette] = React.useState<GraphPalette | null>(null);

  React.useEffect(() => {
    const read = () => setPalette(readGraphPalette());
    read();

    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  return palette;
}

export function GraphCanvas({
  nodes,
  edges,
  nodeVisuals,
  edgeVisuals,
  selfId,
  pinSelf,
  hoveredId,
  selectedId,
  onHover,
  onSelect,
  onOpen,
}: {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  nodeVisuals: Map<string, NodeVisual>;
  edgeVisuals: Map<string, EdgeVisual>;
  selfId: string | null;
  pinSelf: boolean;
  hoveredId: string | null;
  selectedId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string | null) => void;
  onOpen: (id: string) => void;
}) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const graphRef = React.useRef<ForceGraphHandle | null>(null);
  const palette = useGraphPalette();
  const lastClickRef = React.useRef<{ id: string; at: number } | null>(null);
  const [size, setSize] = React.useState({ width: 0, height: 0 });
  // The force graph loads dynamically, so the physics effect has to wait for
  // the instance rather than run on the first render.
  const [graphEpoch, setGraphEpoch] = React.useState(0);

  const attachGraph = React.useCallback((instance: ForceGraphHandle | null) => {
    graphRef.current = instance;
    if (instance) setGraphEpoch((epoch) => epoch + 1);
  }, []);

  React.useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setSize({
        width: Math.max(0, Math.floor(entry.contentRect.width)),
        height: Math.max(0, Math.floor(entry.contentRect.height)),
      });
    });
    observer.observe(element);
    setSize({
      width: Math.max(0, Math.floor(element.clientWidth)),
      height: Math.max(0, Math.floor(element.clientHeight)),
    });
    return () => observer.disconnect();
  }, []);

  const graphData = React.useMemo(() => ({ nodes, links: edges }), [nodes, edges]);

  // Pinning the self node is a mutation on the datum the force engine owns.
  React.useEffect(() => {
    const self = nodes.find((node) => node.id === selfId) as
      | (CanvasNode & { fx?: number; fy?: number; x?: number; y?: number })
      | undefined;
    if (!self) return;
    if (pinSelf) {
      self.fx = 0;
      self.fy = 0;
    } else {
      delete self.fx;
      delete self.fy;
    }
    graphRef.current?.d3ReheatSimulation();
  }, [nodes, selfId, pinSelf]);

  // Edge length encodes the relationship, so the link force is reconfigured
  // whenever the replay or the filters move the scores.
  React.useEffect(() => {
    const graph = graphRef.current;
    if (!graph || typeof graph.d3Force !== "function") return;
    const force = graph.d3Force("link") as LinkForce | undefined;
    if (!force || typeof force.distance !== "function") return;

    const visualFor = (link: LinkObject<CanvasNode, CanvasEdge>) =>
      edgeVisuals.get(String(link.key)) ?? DEFAULT_EDGE_VISUAL;

    force.distance((link) => distanceForScore(visualFor(link).score));
    force.strength((link) => strengthForScore(visualFor(link).score));

    // Repulsion scales with the node, so a big node clears room for its label
    // instead of sitting on top of its neighbour.
    const charge = graph.d3Force("charge") as ChargeForce | undefined;
    if (charge && typeof charge.strength === "function") {
      charge.strength((node) => {
        const visual = nodeVisuals.get(String(node.id)) ?? DEFAULT_NODE_VISUAL;
        return -(90 + visual.radius * 14);
      });
      if (typeof charge.distanceMax === "function") charge.distanceMax(520);
    }

    graph.d3ReheatSimulation();

    // Reheating moves everything, and onEngineStop only fires for the first
    // settle. Without this a filter change leaves nodes parked outside the
    // canvas: one clipped off the top, another off the right edge.
    const refit = window.setTimeout(() => {
      graphRef.current?.zoomToFit(400, 70);
    }, 900);
    return () => window.clearTimeout(refit);
  }, [edgeVisuals, nodeVisuals, graphData, graphEpoch]);

  const highlighted = React.useMemo(() => {
    const focus = hoveredId ?? selectedId;
    if (!focus) return { focus: null as string | null, neighbours: new Set<string>() };
    const neighbours = new Set<string>([focus]);
    for (const edge of edges) {
      if (edge.aId === focus) neighbours.add(edge.bId);
      if (edge.bId === focus) neighbours.add(edge.aId);
    }
    return { focus, neighbours };
  }, [hoveredId, selectedId, edges]);

  const nodeVisibility = React.useCallback(
    (node: NodeObject<CanvasNode>) =>
      !(nodeVisuals.get(String(node.id)) ?? DEFAULT_NODE_VISUAL).hidden,
    [nodeVisuals],
  );

  const nodeLabel = React.useCallback(
    (node: NodeObject<CanvasNode>) => {
      const visual = nodeVisuals.get(String(node.id)) ?? DEFAULT_NODE_VISUAL;
      return `${node.name} (closeness ${Math.round(visual.closeness)})`;
    },
    [nodeVisuals],
  );

  const drawNode = React.useCallback(
    (
      node: NodeObject<CanvasNode>,
      ctx: CanvasRenderingContext2D,
      globalScale: number,
    ) => {
      if (!palette) return;
      const visual = nodeVisuals.get(String(node.id)) ?? DEFAULT_NODE_VISUAL;
      if (visual.hidden) return;
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const radius = visual.radius;

      const focus = highlighted.focus;
      const isFocus = focus === node.id;
      const isNeighbour = focus ? highlighted.neighbours.has(String(node.id)) : true;
      const baseAlpha = visual.dimmed ? 0.12 : isNeighbour ? 1 : 0.2;

      // The payload already carries a colour per person, their first circle
      // falling back to their avatar colour. Using it is what tells two nodes
      // apart at a glance.
      // The fill is deliberately washed out and the ring solid: a person colour
      // is identity, not tone, and it must not compete with the link colours
      // that do mean strained or strong.
      const fillStyle = node.isSelf
        ? rgba(palette.thread, baseAlpha * 0.9)
        : withAlpha(node.colour, baseAlpha * 0.45, palette.neutral);
      const strokeStyle = node.isSelf
        ? rgba(palette.thread, baseAlpha)
        : withAlpha(node.colour, baseAlpha * 0.95, palette.neutral);

      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = fillStyle;
      ctx.fill();
      ctx.lineWidth = 1.75 / globalScale;
      ctx.strokeStyle = strokeStyle;
      ctx.stroke();

      if (node.isSelf) {
        ctx.beginPath();
        ctx.arc(x, y, radius + 3, 0, Math.PI * 2);
        ctx.lineWidth = 1.5 / globalScale;
        ctx.strokeStyle = rgba(palette.thread, baseAlpha * 0.9);
        ctx.stroke();
      }

      if (isFocus || String(node.id) === selectedId) {
        ctx.beginPath();
        ctx.arc(x, y, radius + 5, 0, Math.PI * 2);
        ctx.lineWidth = 1.5 / globalScale;
        ctx.strokeStyle = rgba(palette.foreground, baseAlpha * 0.8);
        ctx.stroke();
      }

      // Initials come off at 6 screen pixels rather than 9: below that they are
      // mush, above it every node should be labelled, including the small ones.
      const screenRadius = radius * globalScale;
      if (screenRadius >= 6) {
        const fontSize = radius * 0.95;
        ctx.font = `600 ${fontSize}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        // White reads on the solid self node, but not on a washed out fill.
        ctx.fillStyle = node.isSelf
          ? rgba(palette.onNode, Math.min(1, baseAlpha + 0.1))
          : rgba(palette.foreground, Math.min(1, baseAlpha));
        ctx.fillText(node.initials, x, y);
      }

      if (globalScale >= 1.6 && !visual.dimmed && isNeighbour) {
        const fontSize = 10 / globalScale;
        ctx.font = `${fontSize}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";

        // A translucent plate keeps the name readable where it crosses a link.
        const top = y + radius + 2 / globalScale;
        const padX = 3 / globalScale;
        const padY = 1.5 / globalScale;
        const textWidth = ctx.measureText(node.name).width;
        const plateHeight = fontSize + padY * 2;
        const plateRadius = plateHeight / 2;
        ctx.beginPath();
        ctx.roundRect(
          x - textWidth / 2 - padX,
          top - padY,
          textWidth + padX * 2,
          plateHeight,
          plateRadius,
        );
        ctx.fillStyle = rgba(palette.surface, baseAlpha * 0.5);
        ctx.fill();

        ctx.fillStyle = rgba(palette.foreground, baseAlpha * 0.85);
        ctx.fillText(node.name, x, top);
      }
    },
    [nodeVisuals, highlighted, selectedId, palette],
  );

  const paintNodePointerArea = React.useCallback(
    (
      node: NodeObject<CanvasNode>,
      colour: string,
      ctx: CanvasRenderingContext2D,
    ) => {
      const visual = nodeVisuals.get(String(node.id)) ?? DEFAULT_NODE_VISUAL;
      if (visual.hidden) return;
      ctx.beginPath();
      ctx.arc(node.x ?? 0, node.y ?? 0, visual.radius + 3, 0, Math.PI * 2);
      ctx.fillStyle = colour;
      ctx.fill();
    },
    [nodeVisuals],
  );

  const linkColour = React.useCallback(
    (link: LinkObject<CanvasNode, CanvasEdge>) => {
      if (!palette) return "transparent";
      const visual = edgeVisuals.get(String(link.key)) ?? DEFAULT_EDGE_VISUAL;
      const focus = highlighted.focus;
      const touchesFocus =
        !focus || link.aId === focus || link.bId === focus;
      const alpha = visual.dimmed ? 0.06 : touchesFocus ? 0.85 : 0.14;
      return scoreColour(visual.score, palette, alpha);
    },
    [edgeVisuals, highlighted, palette],
  );

  // Thickness carries how strongly the pair feels, colour carries which way.
  // Sharing a room is not a relationship, so a pair the events say nothing
  // about stays a hairline no matter how many nights they both turned up to.
  const linkWidth = React.useCallback(
    (link: LinkObject<CanvasNode, CanvasEdge>) => {
      const visual = edgeVisuals.get(String(link.key)) ?? DEFAULT_EDGE_VISUAL;
      const focus = highlighted.focus;
      const touchesFocus = focus && (link.aId === focus || link.bId === focus);
      const base =
        visual.implicit || isFeelingless(visual.score, visual.eventCount)
          ? HAIRLINE_WIDTH
          : widthForScore(visual.score);
      return base * (touchesFocus ? 1.6 : 1);
    },
    [edgeVisuals, highlighted],
  );

  // Dashed means "nothing felt on record": either a synthesized knows-of
  // thread, or a pair who were in the same room with no sentiment either way.
  const linkLineDash = React.useCallback(
    (link: LinkObject<CanvasNode, CanvasEdge>) => {
      const visual = edgeVisuals.get(String(link.key)) ?? DEFAULT_EDGE_VISUAL;
      const noFeeling =
        visual.implicit || isFeelingless(visual.score, visual.eventCount);
      return noFeeling ? [2, 4] : null;
    },
    [edgeVisuals],
  );

  const linkLabel = React.useCallback(
    (link: LinkObject<CanvasNode, CanvasEdge>) => {
      const visual = edgeVisuals.get(String(link.key)) ?? DEFAULT_EDGE_VISUAL;
      if (visual.implicit) return "No events yet";
      const events = visual.eventCount === 1 ? "1 event" : `${visual.eventCount} events`;
      return `Score ${Math.round(visual.score)} from ${events}`;
    },
    [edgeVisuals],
  );

  const handleNodeClick = React.useCallback(
    (node: NodeObject<CanvasNode>) => {
      const id = String(node.id);
      const now = Date.now();
      const last = lastClickRef.current;
      if (last && last.id === id && now - last.at < 350) {
        lastClickRef.current = null;
        onOpen(id);
        return;
      }
      lastClickRef.current = { id, at: now };
      onSelect(id);
    },
    [onOpen, onSelect],
  );

  const handleNodeHover = React.useCallback(
    (node: NodeObject<CanvasNode> | null) => {
      onHover(node ? String(node.id) : null);
    },
    [onHover],
  );

  const handleEngineStop = React.useCallback(() => {
    graphRef.current?.zoomToFit(400, 60);
  }, []);

  return (
    <div ref={containerRef} className="h-full w-full">
      {palette && size.width > 0 && size.height > 0 ? (
        <React.Suspense
          fallback={
            <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
              Drawing
            </div>
          }
        >
          <ForceGraph2D
            ref={attachGraph}
            graphData={graphData}
            width={size.width}
            height={size.height}
            backgroundColor="transparent"
            nodeId="id"
            nodeRelSize={4}
            nodeLabel={nodeLabel}
            nodeVisibility={nodeVisibility}
            nodeCanvasObject={drawNode}
            nodePointerAreaPaint={paintNodePointerArea}
            linkColor={linkColour}
            linkWidth={linkWidth}
            linkLineDash={linkLineDash}
            linkLabel={linkLabel}
            linkHoverPrecision={6}
            cooldownTicks={400}
            d3VelocityDecay={0.35}
            onEngineStop={handleEngineStop}
            onNodeClick={handleNodeClick}
            onNodeHover={handleNodeHover}
            onBackgroundClick={() => onSelect(null)}
          />
        </React.Suspense>
      ) : null}
    </div>
  );
}

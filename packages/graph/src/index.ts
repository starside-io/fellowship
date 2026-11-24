/**
 * @fellowship/graph
 *
 * The force directed view, and the arithmetic behind it. It consumes the
 * people.graph payload and nothing else: no tool call, no host, no database.
 * That is what makes it the one view that would still work pointed at a
 * different data module.
 */
export { Graph, type GraphProps } from "./graph.js";
export { GraphCanvas, type CanvasEdge, type CanvasNode } from "./canvas.js";
export {
  buildScene,
  defaultSettings,
  initialsOf,
  type EdgeVisual,
  type NodeVisual,
  type Scene,
  type SceneEdge,
  type SceneNode,
  type SceneSettings,
} from "./scene.js";
export * from "./payload.js";
export {
  distanceForScore,
  eventTypeLabel,
  formatLastEvent,
  formatReplayDate,
  isFeelingless,
  radiusForCloseness,
  readGraphPalette,
  replayRange,
  rgba,
  scoreColour,
  tieLabel,
  widthForScore,
  type CircleOption,
  type EdgeDatum,
  type GraphPalette,
  type ReplayRange,
  type Rgb,
} from "./utils.js";

import * as React from "react";

import { GraphCanvas } from "./canvas.js";
import { buildScene, defaultSettings, type Scene, type SceneSettings } from "./scene.js";
import type { GraphPayload } from "./payload.js";

/**
 * The graph, from a payload and nothing else.
 *
 * Hand it `people.graph` and it draws. Selection and hover are state it keeps,
 * the filters are state the caller keeps, and opening a person is the caller's
 * business because this package knows nothing about routes.
 */

export interface GraphProps {
  payload: GraphPayload | null | undefined;
  settings?: SceneSettings;
  /** Called with the scene each render, for a side panel that lists what is drawn. */
  onScene?: (scene: Scene) => void;
  selectedId?: string | null;
  onSelect?: (personId: string | null) => void;
  onOpen?: (personId: string) => void;
  /** Keeps the owner's own node at the centre. */
  pinSelf?: boolean;
  className?: string;
}

export function Graph({
  payload,
  settings,
  onScene,
  selectedId,
  onSelect,
  onOpen,
  pinSelf = true,
  className,
}: GraphProps) {
  const [hoveredId, setHoveredId] = React.useState<string | null>(null);
  const [innerSelected, setInnerSelected] = React.useState<string | null>(null);

  const effectiveSettings = React.useMemo(
    () => settings ?? defaultSettings(payload),
    [settings, payload],
  );

  const scene = React.useMemo(
    () => buildScene(payload, effectiveSettings),
    [payload, effectiveSettings],
  );

  React.useEffect(() => {
    onScene?.(scene);
  }, [scene, onScene]);

  const selected = selectedId === undefined ? innerSelected : selectedId;

  const select = React.useCallback(
    (personId: string | null) => {
      setInnerSelected(personId);
      onSelect?.(personId);
    },
    [onSelect],
  );

  const open = React.useCallback(
    (personId: string) => {
      onOpen?.(personId);
    },
    [onOpen],
  );

  return (
    <div className={className}>
      <GraphCanvas
        nodes={scene.nodes}
        edges={scene.edges}
        nodeVisuals={scene.nodeVisuals}
        edgeVisuals={scene.edgeVisuals}
        selfId={scene.selfId}
        pinSelf={pinSelf}
        hoveredId={hoveredId}
        selectedId={selected}
        onHover={setHoveredId}
        onSelect={select}
        onOpen={open}
      />
    </div>
  );
}

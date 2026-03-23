/**
 * RoomPolygon — SVG rendering of a single room polygon.
 *
 * Renders:
 *  - Room fill and stroke
 *  - Per-wall hit areas (wide transparent lines for easy selection)
 *  - Selected wall highlight
 *  - Dimension labels on each edge (clickable to edit)
 *  - Door / window / opening visuals on walls
 *  - Vertex drag handles
 *  - Room name and floor area at centroid
 */

import type { Room, RoomOpening, Point } from "@roybal/shared";
import {
  toSVGPath,
  feetToPixels,
  distanceBetween,
  formatFeet,
  polygonCentroid,
} from "../../utils/geometry";

interface Props {
  room: Room;
  openings: RoomOpening[];
  selected: boolean;
  zoom: number;
  showDimensions: boolean;
  /** Wall index that is currently selected (shows highlight + drag handle) */
  selectedWallIndex?: number | undefined;
  onSelect: () => void;
  onVertexMouseDown: (vertexIndex: number) => void;
  /** Called when user mousedowns on a wall segment (for wall drag / selection) */
  onWallMouseDown?: (wallIndex: number, e: React.MouseEvent<SVGLineElement>) => void;
  /** Called when user clicks a dimension label (to enter exact measurement) */
  onDimensionClick?: (wallIndex: number) => void;
  /** Called when user mousedowns on an opening drag handle */
  onOpeningMouseDown?: (openingId: string, wallIndex: number, e: React.MouseEvent<SVGCircleElement>) => void;
}

export default function RoomPolygon({
  room,
  openings,
  selected,
  zoom,
  showDimensions,
  selectedWallIndex,
  onSelect,
  onVertexMouseDown,
  onWallMouseDown,
  onDimensionClick,
  onOpeningMouseDown,
}: Props) {
  const points = (room.polygon_points ?? []) as Point[];
  if (points.length < 3) return null;

  const path = toSVGPath(points);
  const centroid = polygonCentroid(points);
  const cx = feetToPixels(centroid.x);
  const cy = feetToPixels(centroid.y);

  // Scale-independent sizes
  const strokeW = selected ? 2 / zoom : 1.5 / zoom;
  const vertexR = 7 / zoom;        // larger for touch
  const hitAreaW = 16 / zoom;      // wide transparent hit area on walls
  const fontSize = Math.max(10 / zoom, 9);
  const dimFontSize = Math.max(9 / zoom, 7);
  const dimOffset = 14 / zoom;     // pixels to offset label from wall edge

  const fillColor = room.color ?? "#1e3a5f";
  const strokeColor = selected ? "#C9A84C" : "#4a6080";

  const roomOpenings = openings.filter((o) => o.room_id === room.id);

  return (
    <g style={{ cursor: "pointer" }}>
      {/* ── Room fill — click to select ── */}
      <path
        d={path}
        fill={fillColor}
        fillOpacity={selected ? 0.55 : 0.4}
        stroke={strokeColor}
        strokeWidth={strokeW}
        strokeLinejoin="round"
        onClick={(e) => { e.stopPropagation(); onSelect(); }}
      />

      {/* ── Per-wall elements ── */}
      {points.map((p, i) => {
        const j = (i + 1) % points.length;
        const q = points[j]!;
        const len = distanceBetween(p, q);

        const px1 = feetToPixels(p.x);
        const py1 = feetToPixels(p.y);
        const px2 = feetToPixels(q.x);
        const py2 = feetToPixels(q.y);
        const mx = (px1 + px2) / 2;
        const my = (py1 + py2) / 2;

        // Perpendicular outward offset for dimension label
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const edgeLen = Math.sqrt(dx * dx + dy * dy);
        const nx = -dy / edgeLen;
        const ny = dx / edgeLen;
        const toCx = centroid.x - (p.x + q.x) / 2;
        const toCy = centroid.y - (p.y + q.y) / 2;
        const sign = nx * toCx + ny * toCy > 0 ? -1 : 1;
        const lx = mx + sign * nx * dimOffset;
        const ly = my + sign * ny * dimOffset;

        const isSelectedWall = selected && selectedWallIndex === i;

        return (
          <g key={i}>
            {/* Selected wall highlight — rendered before hit area so it's below handles */}
            {isSelectedWall && (
              <line
                x1={px1} y1={py1} x2={px2} y2={py2}
                stroke="#C9A84C"
                strokeWidth={3 / zoom}
                strokeLinecap="round"
                style={{ pointerEvents: "none" }}
              />
            )}

            {/* Wall hit area — wide transparent line for easy mouse/touch targeting */}
            <line
              x1={px1} y1={py1} x2={px2} y2={py2}
              stroke="transparent"
              strokeWidth={hitAreaW}
              strokeLinecap="butt"
              style={{ cursor: "pointer" }}
              onMouseDown={(e) => {
                e.stopPropagation();
                onWallMouseDown?.(i, e);
              }}
            />

            {/* Wall drag handle — center circle on selected wall */}
            {isSelectedWall && (
              <circle
                cx={mx} cy={my}
                r={8 / zoom}
                fill="#C9A84C"
                stroke="#080500"
                strokeWidth={1.5 / zoom}
                style={{ cursor: "grab" }}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  onWallMouseDown?.(i, e as unknown as React.MouseEvent<SVGLineElement>);
                }}
              />
            )}

            {/* Dimension label — clickable */}
            {showDimensions && len >= 0.5 && (
              <text
                x={lx}
                y={ly}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize={dimFontSize}
                fill={isSelectedWall ? "#C9A84C" : selected ? "#C9A84C" : "#94a3b8"}
                fontFamily="monospace"
                style={{
                  userSelect: "none",
                  cursor: onDimensionClick ? "text" : "default",
                  pointerEvents: onDimensionClick ? "all" : "none",
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  onDimensionClick?.(i);
                }}
              >
                {formatFeet(len)}
              </text>
            )}
          </g>
        );
      })}

      {/* ── Openings on walls ── */}
      {roomOpenings.map((opening) => renderOpening(opening, points, zoom, onOpeningMouseDown))}

      {/* ── Room name and area label ── */}
      <text
        x={cx}
        y={cy - (room.floor_area ? 8 / zoom : 0)}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={fontSize}
        fontWeight="600"
        fill="#e2e8f0"
        style={{ pointerEvents: "none", userSelect: "none" }}
      >
        {room.name}
      </text>
      {room.floor_area != null && room.floor_area > 0 && (
        <text
          x={cx}
          y={cy + fontSize * 1.3}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={dimFontSize}
          fill="#94a3b8"
          style={{ pointerEvents: "none", userSelect: "none" }}
        >
          {room.floor_area.toFixed(1)} sf
        </text>
      )}

      {/* ── Vertex drag handles (visible when selected) ── */}
      {selected && points.map((p, i) => (
        <circle
          key={i}
          cx={feetToPixels(p.x)}
          cy={feetToPixels(p.y)}
          r={vertexR}
          fill="#C9A84C"
          stroke="#080500"
          strokeWidth={1.5 / zoom}
          style={{ cursor: "grab" }}
          onMouseDown={(e) => {
            e.stopPropagation();
            onVertexMouseDown(i);
          }}
          onTouchStart={(e) => {
            e.stopPropagation();
            onVertexMouseDown(i);
          }}
        />
      ))}
    </g>
  );
}

// ── Opening rendering ─────────────────────────────────────────────────────────

function renderOpening(
  opening: RoomOpening,
  points: Point[],
  zoom: number,
  onOpeningMouseDown?: (openingId: string, wallIndex: number, e: React.MouseEvent<SVGCircleElement>) => void
): React.ReactNode {
  const i = opening.wall_index;
  if (i >= points.length) return null;
  const j = (i + 1) % points.length;
  const p = points[i]!;
  const q = points[j]!;

  const wallLen = distanceBetween(p, q);
  if (wallLen < 0.1) return null;

  // Clamp position and compute opening extent
  const t = Math.max(0, Math.min(1, opening.position));
  const halfW = (opening.width / 2) / wallLen;
  const tStart = Math.max(0, t - halfW);
  const tEnd = Math.min(1, t + halfW);

  // Start, end, and midpoint of opening in SVG pixels
  const sx = feetToPixels(p.x + tStart * (q.x - p.x));
  const sy = feetToPixels(p.y + tStart * (q.y - p.y));
  const ex = feetToPixels(p.x + tEnd * (q.x - p.x));
  const ey = feetToPixels(p.y + tEnd * (q.y - p.y));
  const mx = (sx + ex) / 2;
  const my = (sy + ey) / 2;

  // Wall direction unit vector (in pixels)
  const wdx = ex - sx;
  const wdy = ey - sy;
  const wLen = Math.sqrt(wdx * wdx + wdy * wdy);
  const ux = wLen > 0 ? wdx / wLen : 1;
  const uy = wLen > 0 ? wdy / wLen : 0;
  // Perpendicular (left-hand of direction = into room for CCW polygon)
  const perpX = -uy;
  const perpY = ux;

  const sw = 2 / zoom;
  const handleR = 8 / zoom;
  const openingPx = feetToPixels(opening.width);

  const handle = (
    <circle
      key={`${opening.id}-handle`}
      cx={mx}
      cy={my}
      r={handleR}
      fill={opening.type === "door" ? "#F97316" : opening.type === "window" ? "#38bdf8" : "#a78bfa"}
      fillOpacity={0.85}
      stroke="#080500"
      strokeWidth={1 / zoom}
      style={{ cursor: "grab" }}
      onMouseDown={(e) => {
        e.stopPropagation();
        onOpeningMouseDown?.(opening.id, i, e);
      }}
      onTouchStart={(e) => {
        e.stopPropagation();
        // Convert touch to mouse-like event for the handler
        onOpeningMouseDown?.(opening.id, i, e as unknown as React.MouseEvent<SVGCircleElement>);
      }}
    >
      <title>{`${opening.type}: ${formatFeet(opening.width)} × ${formatFeet(opening.height)}`}</title>
    </circle>
  );

  if (opening.type === "door") {
    // Door symbol: panel line (perpendicular to wall) + quarter-arc for swing
    const panelEndX = sx + perpX * openingPx;
    const panelEndY = sy + perpY * openingPx;
    return (
      <g key={opening.id}>
        {/* Door panel */}
        <line
          x1={sx} y1={sy} x2={panelEndX} y2={panelEndY}
          stroke="#F97316" strokeWidth={sw} strokeLinecap="round"
        />
        {/* Swing arc from panel tip to door end on wall */}
        <path
          d={`M ${panelEndX} ${panelEndY} A ${openingPx} ${openingPx} 0 0 1 ${ex} ${ey}`}
          fill="none"
          stroke="#F97316"
          strokeWidth={sw * 0.6}
          strokeDasharray={`${5 / zoom},${3 / zoom}`}
          style={{ pointerEvents: "none" }}
        />
        {/* Hinge dot */}
        <circle cx={sx} cy={sy} r={2 / zoom} fill="#F97316" style={{ pointerEvents: "none" }} />
        {handle}
      </g>
    );
  }

  if (opening.type === "window") {
    // Window symbol: thick line + parallel inner line (frame effect)
    const frameDepth = feetToPixels(0.3);
    return (
      <g key={opening.id}>
        <line x1={sx} y1={sy} x2={ex} y2={ey}
              stroke="#38bdf8" strokeWidth={sw * 2} strokeLinecap="square"
              style={{ pointerEvents: "none" }} />
        <line
          x1={sx + perpX * frameDepth} y1={sy + perpY * frameDepth}
          x2={ex + perpX * frameDepth} y2={ey + perpY * frameDepth}
          stroke="#38bdf8" strokeWidth={sw} strokeLinecap="square" opacity={0.5}
          style={{ pointerEvents: "none" }}
        />
        {handle}
      </g>
    );
  }

  // Generic opening — dashed gap marker
  return (
    <g key={opening.id}>
      <line x1={sx} y1={sy} x2={ex} y2={ey}
            stroke="#a78bfa" strokeWidth={sw * 2}
            strokeDasharray={`${5 / zoom},${3 / zoom}`} strokeLinecap="round"
            style={{ pointerEvents: "none" }} />
      {handle}
    </g>
  );
}

// React import for JSX and types
import type React from "react";

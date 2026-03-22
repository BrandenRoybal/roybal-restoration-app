/**
 * RoomPolygon — SVG rendering of a single room polygon.
 * Renders fill, stroke, dimension labels, vertex handles, and room name.
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
  onSelect: () => void;
  onVertexMouseDown: (vertexIndex: number) => void;
  showDimensions: boolean;
}

export default function RoomPolygon({
  room,
  openings,
  selected,
  zoom,
  onSelect,
  onVertexMouseDown,
  showDimensions,
}: Props) {
  const points = (room.polygon_points ?? []) as Point[];
  if (points.length < 3) return null;

  const path = toSVGPath(points);
  const centroid = polygonCentroid(points);
  const cx = feetToPixels(centroid.x);
  const cy = feetToPixels(centroid.y);

  // Stroke width and vertex radius scale inversely with zoom so they look consistent
  const strokeW = selected ? 2 / zoom : 1.5 / zoom;
  const vertexR = 5 / zoom;
  const fontSize = Math.max(10 / zoom, 9);
  const dimFontSize = Math.max(9 / zoom, 7);

  const fillColor = room.color ?? "#1e3a5f";
  const strokeColor = selected ? "#C9A84C" : "#4a6080";

  return (
    <g onClick={(e) => { e.stopPropagation(); onSelect(); }} style={{ cursor: "pointer" }}>
      {/* Room fill */}
      <path
        d={path}
        fill={fillColor}
        fillOpacity={selected ? 0.55 : 0.4}
        stroke={strokeColor}
        strokeWidth={strokeW}
        strokeLinejoin="round"
      />

      {/* Dimension labels on each edge */}
      {showDimensions && points.map((p, i) => {
        const j = (i + 1) % points.length;
        const q = points[j]!;
        const mx = feetToPixels((p.x + q.x) / 2);
        const my = feetToPixels((p.y + q.y) / 2);
        const len = distanceBetween(p, q);
        if (len < 0.5) return null;

        // Offset the label perpendicular to the edge, outward from centroid
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const edgeLen = Math.sqrt(dx * dx + dy * dy);
        const nx = -dy / edgeLen;  // normal
        const ny = dx / edgeLen;
        // Determine if normal points away from centroid
        const toCx = centroid.x - (p.x + q.x) / 2;
        const toCy = centroid.y - (p.y + q.y) / 2;
        const dot = nx * toCx + ny * toCy;
        const sign = dot > 0 ? -1 : 1;
        const offsetPx = 12 / zoom;
        const lx = mx + sign * nx * feetToPixels(1) * offsetPx / feetToPixels(1);
        const ly = my + sign * ny * feetToPixels(1) * offsetPx / feetToPixels(1);

        // Opening subtraction indicator for this wall
        const wallOpenings = openings.filter((o) => o.room_id === room.id && o.wall_index === i);

        return (
          <g key={i}>
            <text
              x={lx}
              y={ly}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={dimFontSize}
              fill={selected ? "#C9A84C" : "#94a3b8"}
              fontFamily="monospace"
              style={{ pointerEvents: "none", userSelect: "none" }}
            >
              {formatFeet(len)}
              {wallOpenings.length > 0 ? ` (${wallOpenings.length} opening)` : ""}
            </text>
          </g>
        );
      })}

      {/* Room name label */}
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

      {/* Vertex handles (visible when selected) */}
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
        />
      ))}

      {/* Opening markers on walls */}
      {openings
        .filter((o) => o.room_id === room.id)
        .map((opening) => {
          const i = opening.wall_index;
          const j = (i + 1) % points.length;
          if (i >= points.length) return null;
          const p = points[i]!;
          const q = points[j]!;
          const t = opening.position;
          const ox = feetToPixels(p.x + (q.x - p.x) * t);
          const oy = feetToPixels(p.y + (q.y - p.y) * t);
          const color = opening.type === "door" ? "#F97316" : opening.type === "window" ? "#38bdf8" : "#a78bfa";
          return (
            <circle
              key={opening.id}
              cx={ox}
              cy={oy}
              r={4 / zoom}
              fill={color}
              stroke="#080500"
              strokeWidth={1 / zoom}
            >
              <title>{`${opening.type} (${opening.width}' × ${opening.height}')`}</title>
            </circle>
          );
        })}
    </g>
  );
}

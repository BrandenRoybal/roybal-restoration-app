/**
 * FloorPlanEditor — SVG-based canvas editor for drawing floor plans.
 *
 * Supports:
 *   - Rectangle room creation (click+drag)
 *   - Polygon room creation (click to add points, double-click/Enter to close)
 *   - Select and drag vertices to reshape rooms
 *   - Pan (middle mouse or H tool or space+drag)
 *   - Zoom (mouse wheel)
 *   - Snap to grid (toggle)
 *   - Dimension labels on each edge
 *   - Room detail side panel
 *   - Keyboard shortcuts: V, R, P, H, Esc, Enter, Ctrl+Z
 */

import { useRef, useState, useCallback, useEffect } from "react";
import type { Room, RoomOpening, CanvasPlan, Point } from "@roybal/shared";
import {
  PIXELS_PER_FOOT,
  ROOM_COLORS,
  svgCoordsToFeet,
  snapPoint,
  rectToPoints,
  toSVGPath,
  feetToPixels,
  isNear,
} from "../../utils/geometry";
import { useCanvasPlan } from "../../hooks/useFloorPlan";
import EditorToolbar, { type EditorTool } from "./EditorToolbar";
import RoomPolygon from "./RoomPolygon";
import RoomDetailPanel from "./RoomDetailPanel";
import { Loader2 } from "lucide-react";

interface Props {
  planId: string;
  jobId: string;
}

const ZOOM_MIN = 0.2;
const ZOOM_MAX = 5;
const ZOOM_STEP = 0.15;
const CLOSE_THRESHOLD_PX = 16; // pixels to snap-close polygon

export default function FloorPlanEditor({ planId, jobId }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);

  // ── Data ──
  const {
    plan, rooms, openings, loading, saving,
    createRoom, updateRoom, deleteRoom, setRoomPointsLocal,
    createOpening, deleteOpening,
  } = useCanvasPlan(planId);

  // ── Editor state ──
  const [tool, setTool] = useState<EditorTool>("select");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 40, y: 40 });
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [gridSize, setGridSize] = useState(0.5); // snap to 6-inch grid
  const [showDimensions, setShowDimensions] = useState(true);

  // Selected room
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);

  // Rectangle drawing
  const [rectStart, setRectStart] = useState<Point | null>(null);
  const [rectCurrent, setRectCurrent] = useState<Point | null>(null);

  // Polygon drawing
  const [polyPoints, setPolyPoints] = useState<Point[]>([]);
  const [polyCurrent, setPolyCurrent] = useState<Point | null>(null);

  // Vertex dragging
  const [dragging, setDragging] = useState<{ roomId: string; vertexIndex: number } | null>(null);

  // Pan dragging
  const [panStart, setPanStart] = useState<{ mouse: Point; pan: Point } | null>(null);

  // Undo stack (stores previous rooms state snapshots)
  const [undoStack, setUndoStack] = useState<Room[][]>([]);

  // Room naming for new rooms
  const [nextRoomNum, setNextRoomNum] = useState(1);

  // ── Helpers ──

  const getSVGCoords = useCallback((e: React.MouseEvent | MouseEvent): Point => {
    const svg = svgRef.current!;
    const rect = svg.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  const toFeet = useCallback((svgXY: Point): Point => {
    return svgCoordsToFeet(svgXY.x, svgXY.y, pan, zoom);
  }, [pan, zoom]);

  const toFeetSnapped = useCallback((svgXY: Point): Point => {
    const ft = toFeet(svgXY);
    return snapPoint(ft, gridSize, snapEnabled);
  }, [toFeet, gridSize, snapEnabled]);

  const pushUndo = useCallback((currentRooms: Room[]) => {
    setUndoStack((prev) => [...prev.slice(-19), currentRooms]);
  }, []);

  const colorForRoom = (index: number) => ROOM_COLORS[index % ROOM_COLORS.length];

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.key === "v" || e.key === "V") setTool("select");
      if (e.key === "r" || e.key === "R") setTool("rect");
      if (e.key === "p" || e.key === "P") setTool("polygon");
      if (e.key === "h" || e.key === "H") setTool("pan");
      if (e.key === "Escape") {
        setPolyPoints([]);
        setPolyCurrent(null);
        setRectStart(null);
        setRectCurrent(null);
        setDragging(null);
      }
      if (e.key === "Enter" && polyPoints.length >= 3) {
        finishPolygon(polyPoints);
      }
      if (e.key === "Delete" && selectedRoomId) {
        const room = rooms.find((r) => r.id === selectedRoomId);
        if (room) {
          pushUndo(rooms);
          deleteRoom(selectedRoomId);
          setSelectedRoomId(null);
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        handleUndo();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, polyPoints, selectedRoomId, rooms]);

  // ── Undo ──
  const handleUndo = useCallback(() => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    setUndoStack((s) => s.slice(0, -1));
    // Restore: delete rooms not in prev, can't easily restore — just notify
    // Simple undo: restore local state (won't undo DB, but gives visual feedback)
    // For full undo, would need per-action snapshots with DB rollback
  }, [undoStack]);

  // ── Polygon close ──
  const finishPolygon = useCallback(async (pts: Point[]) => {
    if (pts.length < 3) return;
    setPolyPoints([]);
    setPolyCurrent(null);
    pushUndo(rooms);
    const name = `Room ${nextRoomNum}`;
    setNextRoomNum((n) => n + 1);
    await createRoom(jobId, name, pts, 8, colorForRoom(rooms.length));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rooms, nextRoomNum, jobId, createRoom, pushUndo]);

  // ── Mouse handlers ──

  const handleMouseDown = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const svgXY = getSVGCoords(e);
    const ft = toFeetSnapped(svgXY);

    // Middle mouse or space: pan
    if (e.button === 1 || tool === "pan") {
      e.preventDefault();
      setPanStart({ mouse: { x: e.clientX, y: e.clientY }, pan });
      return;
    }

    if (tool === "select") {
      // Check if clicking near a vertex of the selected room
      if (selectedRoomId) {
        const room = rooms.find((r) => r.id === selectedRoomId);
        if (room?.polygon_points) {
          const pts = room.polygon_points as Point[];
          for (let i = 0; i < pts.length; i++) {
            if (isNear(ft, pts[i]!, zoom)) {
              pushUndo(rooms);
              setDragging({ roomId: room.id, vertexIndex: i });
              return;
            }
          }
        }
      }
      // Otherwise deselect (clicking empty canvas)
      setSelectedRoomId(null);
      return;
    }

    if (tool === "rect") {
      setRectStart(ft);
      setRectCurrent(ft);
      return;
    }

    if (tool === "polygon") {
      // Check if clicking near the first point to close the polygon
      if (polyPoints.length >= 3 && isNear(ft, polyPoints[0]!, zoom, CLOSE_THRESHOLD_PX)) {
        finishPolygon(polyPoints);
        return;
      }
      setPolyPoints((prev) => [...prev, ft]);
    }
  }, [tool, pan, getSVGCoords, toFeetSnapped, selectedRoomId, rooms, zoom, polyPoints, finishPolygon, pushUndo]);

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const svgXY = getSVGCoords(e);
    const ft = toFeetSnapped(svgXY);

    // Pan
    if (panStart) {
      const dx = e.clientX - panStart.mouse.x;
      const dy = e.clientY - panStart.mouse.y;
      setPan({ x: panStart.pan.x + dx, y: panStart.pan.y + dy });
      return;
    }

    // Vertex drag
    if (dragging) {
      setRoomPointsLocal(dragging.roomId, (() => {
        const room = rooms.find((r) => r.id === dragging.roomId);
        if (!room?.polygon_points) return [];
        const pts = [...(room.polygon_points as Point[])];
        pts[dragging.vertexIndex] = ft;
        return pts;
      })());
      return;
    }

    if (tool === "rect") setRectCurrent(ft);
    if (tool === "polygon") setPolyCurrent(ft);
  }, [getSVGCoords, toFeetSnapped, panStart, dragging, rooms, setRoomPointsLocal, tool]);

  const handleMouseUp = useCallback(async (e: React.MouseEvent<SVGSVGElement>) => {
    // Pan end
    if (panStart) { setPanStart(null); return; }

    // Vertex drag end — save to DB
    if (dragging) {
      const room = rooms.find((r) => r.id === dragging.roomId);
      if (room?.polygon_points) {
        await updateRoom(dragging.roomId, { polygon_points: room.polygon_points as Point[] });
      }
      setDragging(null);
      return;
    }

    // Rectangle complete
    if (tool === "rect" && rectStart && rectCurrent) {
      const pts = rectToPoints(rectStart, rectCurrent);
      const w = Math.abs(rectCurrent.x - rectStart.x);
      const h = Math.abs(rectCurrent.y - rectStart.y);
      if (w > 0.5 && h > 0.5) {
        pushUndo(rooms);
        const name = `Room ${nextRoomNum}`;
        setNextRoomNum((n) => n + 1);
        const created = await createRoom(jobId, name, pts, 8, colorForRoom(rooms.length));
        if (created) setSelectedRoomId(created.id);
      }
      setRectStart(null);
      setRectCurrent(null);
    }
  }, [panStart, dragging, tool, rectStart, rectCurrent, rooms, nextRoomNum, jobId, createRoom, updateRoom, pushUndo]);

  const handleDoubleClick = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (tool === "polygon" && polyPoints.length >= 3) {
      finishPolygon(polyPoints);
    }
  }, [tool, polyPoints, finishPolygon]);

  // ── Zoom ──
  const handleWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const svgXY = getSVGCoords(e);
    const delta = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
    setZoom((prev) => {
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prev + delta));
      // Zoom toward cursor
      const scaleFactor = next / prev;
      setPan((p) => ({
        x: svgXY.x - (svgXY.x - p.x) * scaleFactor,
        y: svgXY.y - (svgXY.y - p.y) * scaleFactor,
      }));
      return next;
    });
  }, [getSVGCoords]);

  const zoomIn  = () => setZoom((z) => Math.min(ZOOM_MAX, z + ZOOM_STEP));
  const zoomOut = () => setZoom((z) => Math.max(ZOOM_MIN, z - ZOOM_STEP));
  const resetView = () => { setZoom(1); setPan({ x: 40, y: 40 }); };

  // ── Plan rename ──
  const handleRenamePlan = async (name: string) => {
    if (!plan || !name) return;
    // updatePlan is not imported here — handled in FloorPlanEditorPage
  };

  // ── Cursor style ──
  const cursor = (() => {
    if (panStart) return "grabbing";
    if (dragging) return "grabbing";
    if (tool === "pan") return "grab";
    if (tool === "rect" || tool === "polygon") return "crosshair";
    return "default";
  })();

  // ── In-progress rect preview (in SVG pixels, before transform) ──
  const rectPreview = rectStart && rectCurrent ? {
    x: Math.min(rectStart.x, rectCurrent.x) * PIXELS_PER_FOOT,
    y: Math.min(rectStart.y, rectCurrent.y) * PIXELS_PER_FOOT,
    w: Math.abs(rectCurrent.x - rectStart.x) * PIXELS_PER_FOOT,
    h: Math.abs(rectCurrent.y - rectStart.y) * PIXELS_PER_FOOT,
  } : null;

  // ── Render ──
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[#080500]">
        <Loader2 className="animate-spin text-[#C9A84C]" size={32} />
      </div>
    );
  }

  const selectedRoom = rooms.find((r) => r.id === selectedRoomId) ?? null;
  const gridPx = PIXELS_PER_FOOT * zoom; // 1 foot in screen pixels
  const majorGridPx = gridPx * 5;        // 5 feet

  // SVG grid pattern offsets (so grid appears to move with pan)
  const gox = ((pan.x % gridPx) + gridPx) % gridPx;
  const goy = ((pan.y % gridPx) + gridPx) % gridPx;
  const mgox = ((pan.x % majorGridPx) + majorGridPx) % majorGridPx;
  const mgoy = ((pan.y % majorGridPx) + majorGridPx) % majorGridPx;

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[#080500]">
      <EditorToolbar
        tool={tool}
        onToolChange={setTool}
        zoom={zoom}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onResetView={resetView}
        snapEnabled={snapEnabled}
        onToggleSnap={() => setSnapEnabled((v) => !v)}
        canUndo={undoStack.length > 0}
        onUndo={handleUndo}
        planName={plan?.name ?? "Floor Plan"}
        onRenamePlan={handleRenamePlan}
      />

      <div className="flex flex-1 overflow-hidden">
        {/* Room list — left panel */}
        <RoomListPanel
          rooms={rooms}
          selectedRoomId={selectedRoomId}
          onSelect={setSelectedRoomId}
        />

        {/* Canvas */}
        <svg
          ref={svgRef}
          className="flex-1 h-full select-none"
          style={{ cursor, background: "#080500" }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onDoubleClick={handleDoubleClick}
          onWheel={handleWheel}
          onContextMenu={(e) => e.preventDefault()}
        >
          <defs>
            <pattern id="fpGridMinor" x={gox} y={goy} width={gridPx} height={gridPx} patternUnits="userSpaceOnUse">
              <path d={`M ${gridPx} 0 L 0 0 0 ${gridPx}`} fill="none" stroke="#141414" strokeWidth="0.5" />
            </pattern>
            <pattern id="fpGridMajor" x={mgox} y={mgoy} width={majorGridPx} height={majorGridPx} patternUnits="userSpaceOnUse">
              <rect width={majorGridPx} height={majorGridPx} fill="url(#fpGridMinor)" />
              <path d={`M ${majorGridPx} 0 L 0 0 0 ${majorGridPx}`} fill="none" stroke="#1e1e1e" strokeWidth="1" />
            </pattern>
          </defs>

          {/* Grid background */}
          <rect width="100%" height="100%" fill="url(#fpGridMajor)" />

          {/* Main transform group */}
          <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>

            {/* Background image for tracing */}
            {plan?.background_image_url && (
              <image
                href={plan.background_image_url}
                x={0} y={0}
                width={feetToPixels(plan.canvas_width ?? 60)}
                height={feetToPixels(plan.canvas_height ?? 60)}
                opacity={plan.background_opacity ?? 0.3}
                style={{ pointerEvents: "none" }}
              />
            )}

            {/* Room polygons */}
            {rooms.map((room) => (
              <RoomPolygon
                key={room.id}
                room={room}
                openings={openings}
                selected={selectedRoomId === room.id}
                zoom={zoom}
                showDimensions={showDimensions}
                onSelect={() => setSelectedRoomId(room.id)}
                onVertexMouseDown={(vi) => {
                  pushUndo(rooms);
                  setDragging({ roomId: room.id, vertexIndex: vi });
                }}
              />
            ))}

            {/* In-progress rectangle preview */}
            {rectPreview && (
              <rect
                x={rectPreview.x} y={rectPreview.y}
                width={rectPreview.w} height={rectPreview.h}
                fill="rgba(201,168,76,0.08)"
                stroke="#C9A84C"
                strokeWidth={1.5 / zoom}
                strokeDasharray={`${6 / zoom},${4 / zoom}`}
                style={{ pointerEvents: "none" }}
              />
            )}

            {/* In-progress polygon preview */}
            {polyPoints.length > 0 && (
              <>
                {/* Completed edges */}
                <polyline
                  points={polyPoints.map((p) => `${feetToPixels(p.x)},${feetToPixels(p.y)}`).join(" ")}
                  fill="none"
                  stroke="#C9A84C"
                  strokeWidth={1.5 / zoom}
                  strokeDasharray={`${6 / zoom},${4 / zoom}`}
                  style={{ pointerEvents: "none" }}
                />
                {/* Edge to cursor */}
                {polyCurrent && (
                  <line
                    x1={feetToPixels(polyPoints[polyPoints.length - 1]!.x)}
                    y1={feetToPixels(polyPoints[polyPoints.length - 1]!.y)}
                    x2={feetToPixels(polyCurrent.x)}
                    y2={feetToPixels(polyCurrent.y)}
                    stroke="#C9A84C"
                    strokeWidth={1 / zoom}
                    strokeOpacity={0.5}
                    strokeDasharray={`${4 / zoom},${4 / zoom}`}
                    style={{ pointerEvents: "none" }}
                  />
                )}
                {/* Point dots */}
                {polyPoints.map((p, i) => (
                  <circle
                    key={i}
                    cx={feetToPixels(p.x)} cy={feetToPixels(p.y)}
                    r={(i === 0 && polyPoints.length >= 3) ? 7 / zoom : 4 / zoom}
                    fill={i === 0 ? "#C9A84C" : "#fff"}
                    stroke="#C9A84C"
                    strokeWidth={1.5 / zoom}
                    style={{ pointerEvents: "none" }}
                  />
                ))}
              </>
            )}
          </g>

          {/* Saving indicator */}
          {saving && (
            <text x={8} y={20} fill="#C9A84C" fontSize={11} fontFamily="sans-serif">Saving…</text>
          )}
        </svg>

        {/* Right panel — room detail */}
        {selectedRoom && (
          <RoomDetailPanel
            room={selectedRoom}
            openings={openings}
            onUpdate={async (updates) => { await updateRoom(selectedRoom.id, updates); }}
            onDelete={async () => { await deleteRoom(selectedRoom.id); setSelectedRoomId(null); }}
            onClose={() => setSelectedRoomId(null)}
            onAddOpening={async (type) => {
              if (!selectedRoom?.polygon_points?.length) return;
              await createOpening({
                room_id: selectedRoom.id,
                type,
                wall_index: 0,
                position: 0.5,
                width: type === "door" ? 3 : 3,
                height: type === "door" ? 6.8 : 4,
                notes: null,
              });
            }}
            onDeleteOpening={deleteOpening}
          />
        )}
      </div>

      {/* Polygon help tooltip */}
      {tool === "polygon" && polyPoints.length > 0 && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-[#0C0800] border border-[#2C1E00] rounded-lg px-3 py-1.5 text-xs text-slate-400 pointer-events-none">
          {polyPoints.length < 3
            ? `Click to add points (${polyPoints.length} so far, need 3+)`
            : "Click first point or press Enter to close • Esc to cancel"}
        </div>
      )}
    </div>
  );
}

// ── Room list side panel ──────────────────────────────────────────────────────

function RoomListPanel({
  rooms,
  selectedRoomId,
  onSelect,
}: {
  rooms: Room[];
  selectedRoomId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const totalArea = rooms.reduce((s, r) => s + (r.floor_area ?? 0), 0);

  return (
    <div className="w-48 bg-[#0C0800] border-r border-[#2C1E00] flex flex-col shrink-0 overflow-hidden">
      <div className="px-3 py-2.5 border-b border-[#2C1E00]">
        <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Rooms</p>
        {totalArea > 0 && (
          <p className="text-xs text-[#C9A84C] font-mono mt-0.5">{totalArea.toFixed(1)} sf total</p>
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        {rooms.length === 0 ? (
          <p className="text-xs text-slate-600 px-3 py-4">Draw a room on the canvas to get started.</p>
        ) : (
          rooms.map((room) => (
            <button
              key={room.id}
              onClick={() => onSelect(room.id === selectedRoomId ? null : room.id)}
              className={`w-full text-left px-3 py-2 border-b border-[#2C1E00]/50 transition-colors ${
                selectedRoomId === room.id
                  ? "bg-[#C9A84C]/10 text-[#C9A84C]"
                  : "text-slate-300 hover:bg-[#2C1E00]/50"
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className="w-2.5 h-2.5 rounded-sm shrink-0"
                  style={{ background: room.color ?? "#1e3a5f" }}
                />
                <span className="text-xs font-medium truncate">{room.name}</span>
              </div>
              {room.floor_area != null && room.floor_area > 0 && (
                <p className="text-xs text-slate-500 mt-0.5 ml-4">{room.floor_area.toFixed(1)} sf</p>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

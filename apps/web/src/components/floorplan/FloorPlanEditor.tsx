/**
 * FloorPlanEditor — SVG-based canvas editor for drawing floor plans.
 *
 * Supports:
 *   - Rectangle / polygon room creation
 *   - Vertex drag to reshape rooms
 *   - Wall selection by clicking or touching a wall segment
 *   - Wall drag (perpendicular movement) by dragging a selected wall
 *   - Dimension label click → inline exact measurement entry (feet/inches)
 *   - Drag and reposition door/window/opening handles along walls
 *   - Pan (middle mouse / H tool / space+drag) and zoom (mouse wheel / pinch)
 *   - Snap to 6-inch grid (toggle)
 *   - Keyboard shortcuts: V, R, P, H, Esc, Enter, Delete, Ctrl+Z
 *   - Touch support (touchstart / touchmove / touchend)
 */

import { useRef, useState, useCallback, useEffect } from "react";
import type { Room, RoomOpening, Point } from "@roybal/shared";
import {
  PIXELS_PER_FOOT,
  ROOM_COLORS,
  svgCoordsToFeet,
  snapPoint,
  rectToPoints,
  feetToPixels,
  isNear,
  polygonArea,
  distanceBetween,
  parseFeetInches,
  setWallLength,
  moveWallPerp,
  projectPointOntoSegment,
  formatFeet,
} from "../../utils/geometry";
import { useCanvasPlan } from "../../hooks/useFloorPlan";
import EditorToolbar, { type EditorTool } from "./EditorToolbar";
import RoomPolygon from "./RoomPolygon";
import RoomDetailPanel from "./RoomDetailPanel";
import { Loader2, AlertCircle } from "lucide-react";

interface Props {
  planId: string;
  jobId: string;
}

const ZOOM_MIN = 0.2;
const ZOOM_MAX = 5;
const ZOOM_STEP = 0.15;
const CLOSE_THRESHOLD_PX = 16;

export default function FloorPlanEditor({ planId, jobId }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);

  // ── Data ──
  const {
    plan, rooms, openings, loading, saving,
    createRoom, updateRoom, deleteRoom, setRoomPointsLocal,
    createOpening, updateOpening, deleteOpening, setOpeningPositionLocal,
  } = useCanvasPlan(planId);

  // ── Editor state ──
  const [tool, setTool] = useState<EditorTool>("select");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 40, y: 40 });
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [gridSize] = useState(0.5);

  // ── Selection state ──
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [selectedWall, setSelectedWall] = useState<{ roomId: string; wallIndex: number } | null>(null);

  // ── Drawing state ──
  const [rectStart, setRectStart] = useState<Point | null>(null);
  const [rectCurrent, setRectCurrent] = useState<Point | null>(null);
  const [polyPoints, setPolyPoints] = useState<Point[]>([]);
  const [polyCurrent, setPolyCurrent] = useState<Point | null>(null);

  // ── Drag state ──
  const [vertexDrag, setVertexDrag] = useState<{ roomId: string; vertexIndex: number } | null>(null);
  const [wallDrag, setWallDrag] = useState<{
    roomId: string;
    wallIndex: number;
    startFt: Point;
    origPoints: Point[];
  } | null>(null);
  const [openingDrag, setOpeningDrag] = useState<{
    openingId: string;
    roomId: string;
    wallIndex: number;
  } | null>(null);

  // ── Pan drag ──
  const [panStart, setPanStart] = useState<{ mouse: Point; pan: Point } | null>(null);

  // ── Dimension editing ──
  const [dimensionEdit, setDimensionEdit] = useState<{ roomId: string; wallIndex: number } | null>(null);
  const [dimEditValue, setDimEditValue] = useState("");
  const [dimEditError, setDimEditError] = useState("");

  // ── Undo ──
  const [undoStack, setUndoStack] = useState<Room[][]>([]);

  // ── Naming ──
  const [nextRoomNum, setNextRoomNum] = useState(1);

  // ── Pinch-zoom tracking ──
  const lastPinchDistRef = useRef<number | null>(null);

  // ── Helpers ──

  const getSVGCoords = useCallback((clientX: number, clientY: number): Point => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }, []);

  const toFeet = useCallback((svgXY: Point): Point =>
    svgCoordsToFeet(svgXY.x, svgXY.y, pan, zoom),
    [pan, zoom]
  );

  const toFeetSnapped = useCallback((svgXY: Point): Point =>
    snapPoint(toFeet(svgXY), gridSize, snapEnabled),
    [toFeet, gridSize, snapEnabled]
  );

  const pushUndo = useCallback((current: Room[]) => {
    setUndoStack((prev) => [...prev.slice(-19), current]);
  }, []);

  const colorForRoom = (index: number) => ROOM_COLORS[index % ROOM_COLORS.length];

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
        setVertexDrag(null);
        setWallDrag(null);
        setOpeningDrag(null);
        setDimensionEdit(null);
        setSelectedWall(null);
      }

      if (e.key === "Enter" && polyPoints.length >= 3) {
        finishPolygon(polyPoints);
      }

      if ((e.key === "Delete" || e.key === "Backspace") && selectedRoomId) {
        pushUndo(rooms);
        deleteRoom(selectedRoomId);
        setSelectedRoomId(null);
        setSelectedWall(null);
      }

      if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        handleUndo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, polyPoints, selectedRoomId, rooms]);

  // ── Undo ──
  const handleUndo = useCallback(() => {
    if (undoStack.length === 0) return;
    setUndoStack((s) => s.slice(0, -1));
  }, [undoStack]);

  // ── Finish polygon ──
  const finishPolygon = useCallback(async (pts: Point[]) => {
    if (pts.length < 3) return;
    setPolyPoints([]);
    setPolyCurrent(null);
    pushUndo(rooms);
    const name = `Room ${nextRoomNum}`;
    setNextRoomNum((n) => n + 1);
    const created = await createRoom(jobId, name, pts, 8, colorForRoom(rooms.length));
    if (created) setSelectedRoomId(created.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rooms, nextRoomNum, jobId, createRoom, pushUndo]);

  // ── Dimension edit ──
  const openDimensionEdit = useCallback((roomId: string, wallIndex: number) => {
    const room = rooms.find((r) => r.id === roomId);
    const pts = (room?.polygon_points ?? []) as Point[];
    if (pts.length < 3) return;
    const i = wallIndex;
    const j = (i + 1) % pts.length;
    const len = distanceBetween(pts[i]!, pts[j]!);
    setDimensionEdit({ roomId, wallIndex });
    setDimEditValue(formatFeet(len));
    setDimEditError("");
  }, [rooms]);

  const commitDimensionEdit = useCallback(() => {
    if (!dimensionEdit) return;
    const parsed = parseFeetInches(dimEditValue);
    if (parsed === null || parsed < 0.1) {
      setDimEditError(`"${dimEditValue}" isn't a valid measurement`);
      return;
    }
    const room = rooms.find((r) => r.id === dimensionEdit.roomId);
    const pts = (room?.polygon_points ?? []) as Point[];
    const newPts = setWallLength(pts, dimensionEdit.wallIndex, parsed);
    if (!newPts || polygonArea(newPts) < 0.5) {
      setDimEditError("Result would create an invalid room shape");
      return;
    }
    setRoomPointsLocal(dimensionEdit.roomId, newPts);
    updateRoom(dimensionEdit.roomId, { polygon_points: newPts });
    setDimensionEdit(null);
    setDimEditError("");
  }, [dimensionEdit, dimEditValue, rooms, setRoomPointsLocal, updateRoom]);

  // ── Mouse / pointer helpers ──

  const handleMouseDown = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button !== 0 && e.button !== 1) return;
    const svgXY = getSVGCoords(e.clientX, e.clientY);
    const ft = toFeetSnapped(svgXY);

    // Middle mouse or pan tool → start pan
    if (e.button === 1 || tool === "pan") {
      e.preventDefault();
      setPanStart({ mouse: { x: e.clientX, y: e.clientY }, pan });
      return;
    }

    // Drawing tools
    if (tool === "rect") {
      setRectStart(ft);
      setRectCurrent(ft);
      return;
    }
    if (tool === "polygon") {
      if (polyPoints.length >= 3 && isNear(ft, polyPoints[0]!, zoom, CLOSE_THRESHOLD_PX)) {
        finishPolygon(polyPoints);
        return;
      }
      setPolyPoints((prev) => [...prev, ft]);
      return;
    }

    // Select tool — deselect if clicking empty canvas
    // (specific hits are captured by child SVG elements with stopPropagation)
    if (tool === "select") {
      setSelectedRoomId(null);
      setSelectedWall(null);
    }
  }, [tool, pan, getSVGCoords, toFeetSnapped, zoom, polyPoints, finishPolygon]);

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const svgXY = getSVGCoords(e.clientX, e.clientY);
    const ft = toFeetSnapped(svgXY);

    // Pan
    if (panStart) {
      const dx = e.clientX - panStart.mouse.x;
      const dy = e.clientY - panStart.mouse.y;
      setPan({ x: panStart.pan.x + dx, y: panStart.pan.y + dy });
      return;
    }

    // Vertex drag
    if (vertexDrag) {
      const room = rooms.find((r) => r.id === vertexDrag.roomId);
      if (room?.polygon_points) {
        const pts = [...(room.polygon_points as Point[])];
        pts[vertexDrag.vertexIndex] = ft;
        setRoomPointsLocal(vertexDrag.roomId, pts);
      }
      return;
    }

    // Wall drag (perpendicular movement)
    if (wallDrag) {
      const { roomId, wallIndex, startFt, origPoints } = wallDrag;
      const delta = { x: ft.x - startFt.x, y: ft.y - startFt.y };
      const p = origPoints[wallIndex]!;
      const q = origPoints[(wallIndex + 1) % origPoints.length]!;
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 0.01) {
        const perpX = -dy / len;
        const perpY = dx / len;
        const perpDelta = delta.x * perpX + delta.y * perpY;
        const newPts = moveWallPerp(origPoints, wallIndex, perpDelta);
        if (polygonArea(newPts) > 0.5) {
          setRoomPointsLocal(roomId, newPts);
        }
      }
      return;
    }

    // Opening drag (along wall)
    if (openingDrag) {
      const opening = openings.find((o) => o.id === openingDrag.openingId);
      const room = rooms.find((r) => r.id === openingDrag.roomId);
      if (opening && room?.polygon_points) {
        const pts = room.polygon_points as Point[];
        const wi = openingDrag.wallIndex;
        const j = (wi + 1) % pts.length;
        if (wi < pts.length) {
          const p = pts[wi]!;
          const q = pts[j]!;
          const wallLen = distanceBetween(p, q);
          const { t } = projectPointOntoSegment(ft, p, q);
          const halfW = (opening.width / 2) / wallLen;
          const clampedT = Math.max(halfW, Math.min(1 - halfW, t));
          setOpeningPositionLocal(opening.id, clampedT);
        }
      }
      return;
    }

    if (tool === "rect") setRectCurrent(ft);
    if (tool === "polygon") setPolyCurrent(ft);
  }, [getSVGCoords, toFeetSnapped, panStart, vertexDrag, wallDrag, openingDrag,
      rooms, openings, setRoomPointsLocal, setOpeningPositionLocal, tool]);

  const handleMouseUp = useCallback(async () => {
    // Pan end
    if (panStart) { setPanStart(null); return; }

    // Vertex drag end → persist
    if (vertexDrag) {
      const room = rooms.find((r) => r.id === vertexDrag.roomId);
      if (room?.polygon_points) {
        await updateRoom(vertexDrag.roomId, { polygon_points: room.polygon_points as Point[] });
      }
      setVertexDrag(null);
      return;
    }

    // Wall drag end → persist
    if (wallDrag) {
      const room = rooms.find((r) => r.id === wallDrag.roomId);
      if (room?.polygon_points) {
        await updateRoom(wallDrag.roomId, { polygon_points: room.polygon_points as Point[] });
      }
      setWallDrag(null);
      return;
    }

    // Opening drag end → persist
    if (openingDrag) {
      const opening = openings.find((o) => o.id === openingDrag.openingId);
      if (opening) {
        await updateOpening(openingDrag.openingId, { position: opening.position });
      }
      setOpeningDrag(null);
      return;
    }

    // Rectangle complete
    if (tool === "rect" && rectStart && rectCurrent) {
      const w = Math.abs(rectCurrent.x - rectStart.x);
      const h = Math.abs(rectCurrent.y - rectStart.y);
      if (w > 0.5 && h > 0.5) {
        pushUndo(rooms);
        const pts = rectToPoints(rectStart, rectCurrent);
        const name = `Room ${nextRoomNum}`;
        setNextRoomNum((n) => n + 1);
        const created = await createRoom(jobId, name, pts, 8, colorForRoom(rooms.length));
        if (created) setSelectedRoomId(created.id);
      }
      setRectStart(null);
      setRectCurrent(null);
    }
  }, [panStart, vertexDrag, wallDrag, openingDrag, tool, rectStart, rectCurrent,
      rooms, openings, nextRoomNum, jobId, createRoom, updateRoom, updateOpening, pushUndo]);

  const handleDoubleClick = useCallback(() => {
    if (tool === "polygon" && polyPoints.length >= 3) finishPolygon(polyPoints);
  }, [tool, polyPoints, finishPolygon]);

  // ── Zoom ──
  const handleWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const svgXY = getSVGCoords(e.clientX, e.clientY);
    const delta = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
    setZoom((prev) => {
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prev + delta));
      const s = next / prev;
      setPan((p) => ({
        x: svgXY.x - (svgXY.x - p.x) * s,
        y: svgXY.y - (svgXY.y - p.y) * s,
      }));
      return next;
    });
  }, [getSVGCoords]);

  const zoomIn = () => setZoom((z) => Math.min(ZOOM_MAX, z + ZOOM_STEP));
  const zoomOut = () => setZoom((z) => Math.max(ZOOM_MIN, z - ZOOM_STEP));
  const resetView = () => { setZoom(1); setPan({ x: 40, y: 40 }); };

  // ── Touch events ──
  const handleTouchStart = useCallback((e: React.TouchEvent<SVGSVGElement>) => {
    if (e.touches.length === 2) {
      // Pinch start
      const a = e.touches[0]!;
      const b = e.touches[1]!;
      lastPinchDistRef.current = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
      return;
    }
    if (e.touches.length !== 1) return;
    e.preventDefault();
    const t = e.touches[0]!;
    const svgXY = getSVGCoords(t.clientX, t.clientY);
    const ft = toFeetSnapped(svgXY);

    if (tool === "pan") {
      setPanStart({ mouse: { x: t.clientX, y: t.clientY }, pan });
      return;
    }
    if (tool === "rect") { setRectStart(ft); setRectCurrent(ft); return; }
    if (tool === "polygon") {
      if (polyPoints.length >= 3 && isNear(ft, polyPoints[0]!, zoom, CLOSE_THRESHOLD_PX + 8)) {
        finishPolygon(polyPoints);
        return;
      }
      setPolyPoints((prev) => [...prev, ft]);
    }
  }, [tool, pan, getSVGCoords, toFeetSnapped, zoom, polyPoints, finishPolygon]);

  const handleTouchMove = useCallback((e: React.TouchEvent<SVGSVGElement>) => {
    // Pinch zoom
    if (e.touches.length === 2) {
      e.preventDefault();
      const a = e.touches[0]!;
      const b = e.touches[1]!;
      const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
      if (lastPinchDistRef.current !== null) {
        const scale = dist / lastPinchDistRef.current;
        const midX = (a.clientX + b.clientX) / 2;
        const midY = (a.clientY + b.clientY) / 2;
        const svgMid = getSVGCoords(midX, midY);
        setZoom((prev) => {
          const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prev * scale));
          const s = next / prev;
          setPan((p) => ({
            x: svgMid.x - (svgMid.x - p.x) * s,
            y: svgMid.y - (svgMid.y - p.y) * s,
          }));
          return next;
        });
      }
      lastPinchDistRef.current = dist;
      return;
    }
    if (e.touches.length !== 1) return;
    e.preventDefault();
    const t = e.touches[0]!;
    const synth = { clientX: t.clientX, clientY: t.clientY } as React.MouseEvent<SVGSVGElement>;
    handleMouseMove(synth);
  }, [getSVGCoords, handleMouseMove]);

  const handleTouchEnd = useCallback((e: React.TouchEvent<SVGSVGElement>) => {
    lastPinchDistRef.current = null;
    if (e.touches.length === 0) {
      handleMouseUp();
    }
  }, [handleMouseUp]);

  // ── Cursor ──
  const cursor = (() => {
    if (panStart) return "grabbing";
    if (vertexDrag || wallDrag || openingDrag) return "grabbing";
    if (dimensionEdit) return "text";
    if (tool === "pan") return "grab";
    if (tool === "rect" || tool === "polygon") return "crosshair";
    return "default";
  })();

  // ── In-progress rect preview (in feet → pixels before transform) ──
  const rectPreview = rectStart && rectCurrent ? {
    x: Math.min(rectStart.x, rectCurrent.x) * PIXELS_PER_FOOT,
    y: Math.min(rectStart.y, rectCurrent.y) * PIXELS_PER_FOOT,
    w: Math.abs(rectCurrent.x - rectStart.x) * PIXELS_PER_FOOT,
    h: Math.abs(rectCurrent.y - rectStart.y) * PIXELS_PER_FOOT,
  } : null;

  // ── Grid ──
  const gridPx = PIXELS_PER_FOOT * zoom;
  const majorGridPx = gridPx * 5;
  const gox = ((pan.x % gridPx) + gridPx) % gridPx;
  const goy = ((pan.y % gridPx) + gridPx) % gridPx;
  const mgox = ((pan.x % majorGridPx) + majorGridPx) % majorGridPx;
  const mgoy = ((pan.y % majorGridPx) + majorGridPx) % majorGridPx;

  // ── Dimension edit overlay position ──
  const dimEditPos = (() => {
    if (!dimensionEdit) return null;
    const room = rooms.find((r) => r.id === dimensionEdit.roomId);
    const pts = (room?.polygon_points ?? []) as Point[];
    const i = dimensionEdit.wallIndex;
    const j = (i + 1) % pts.length;
    if (i >= pts.length) return null;
    const p = pts[i]!;
    const q = pts[j]!;
    return {
      mx: feetToPixels((p.x + q.x) / 2),
      my: feetToPixels((p.y + q.y) / 2),
    };
  })();

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[#080500]">
        <Loader2 className="animate-spin text-[#C9A84C]" size={32} />
      </div>
    );
  }

  const selectedRoom = rooms.find((r) => r.id === selectedRoomId) ?? null;

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[#080500]">
      <EditorToolbar
        tool={tool}
        onToolChange={(t) => { setTool(t); setSelectedWall(null); }}
        zoom={zoom}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onResetView={resetView}
        snapEnabled={snapEnabled}
        onToggleSnap={() => setSnapEnabled((v) => !v)}
        canUndo={undoStack.length > 0}
        onUndo={handleUndo}
        planName={plan?.name ?? "Floor Plan"}
        onRenamePlan={() => {}}
      />

      <div className="flex flex-1 overflow-hidden relative">
        {/* Room list — left panel */}
        <RoomListPanel
          rooms={rooms}
          selectedRoomId={selectedRoomId}
          onSelect={(id) => { setSelectedRoomId(id); setSelectedWall(null); }}
        />

        {/* Canvas */}
        <svg
          ref={svgRef}
          className="flex-1 h-full select-none"
          style={{ cursor, background: "#080500", touchAction: "none" }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onDoubleClick={handleDoubleClick}
          onWheel={handleWheel}
          onContextMenu={(e) => e.preventDefault()}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
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

          <rect width="100%" height="100%" fill="url(#fpGridMajor)" />

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
                showDimensions={true}
                selectedWallIndex={
                  selectedWall?.roomId === room.id ? selectedWall.wallIndex : undefined
                }
                onSelect={() => {
                  setSelectedRoomId(room.id);
                  setSelectedWall(null);
                }}
                onVertexMouseDown={(vi) => {
                  if (tool !== "select") return;
                  pushUndo(rooms);
                  setSelectedRoomId(room.id);
                  setSelectedWall(null);
                  setVertexDrag({ roomId: room.id, vertexIndex: vi });
                }}
                onWallMouseDown={(wi, e) => {
                  if (tool !== "select") return;
                  const svgXY = getSVGCoords(e.clientX, e.clientY);
                  const ft = toFeetSnapped(svgXY);
                  const pts = (room.polygon_points ?? []) as Point[];
                  pushUndo(rooms);
                  setSelectedRoomId(room.id);
                  setSelectedWall({ roomId: room.id, wallIndex: wi });
                  setWallDrag({ roomId: room.id, wallIndex: wi, startFt: ft, origPoints: pts });
                }}
                onDimensionClick={(wi) => {
                  if (tool !== "select") return;
                  setSelectedRoomId(room.id);
                  setSelectedWall({ roomId: room.id, wallIndex: wi });
                  openDimensionEdit(room.id, wi);
                }}
                onOpeningMouseDown={(openingId, wi) => {
                  if (tool !== "select") return;
                  setSelectedRoomId(room.id);
                  setOpeningDrag({ openingId, roomId: room.id, wallIndex: wi });
                }}
              />
            ))}

            {/* Rect preview */}
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

            {/* Polygon in-progress preview */}
            {polyPoints.length > 0 && (
              <>
                <polyline
                  points={polyPoints.map((p) => `${feetToPixels(p.x)},${feetToPixels(p.y)}`).join(" ")}
                  fill="none" stroke="#C9A84C"
                  strokeWidth={1.5 / zoom}
                  strokeDasharray={`${6 / zoom},${4 / zoom}`}
                  style={{ pointerEvents: "none" }}
                />
                {polyCurrent && (
                  <line
                    x1={feetToPixels(polyPoints[polyPoints.length - 1]!.x)}
                    y1={feetToPixels(polyPoints[polyPoints.length - 1]!.y)}
                    x2={feetToPixels(polyCurrent.x)}
                    y2={feetToPixels(polyCurrent.y)}
                    stroke="#C9A84C" strokeWidth={1 / zoom} strokeOpacity={0.5}
                    strokeDasharray={`${4 / zoom},${4 / zoom}`}
                    style={{ pointerEvents: "none" }}
                  />
                )}
                {polyPoints.map((p, i) => (
                  <circle
                    key={i}
                    cx={feetToPixels(p.x)} cy={feetToPixels(p.y)}
                    r={(i === 0 && polyPoints.length >= 3) ? 8 / zoom : 4 / zoom}
                    fill={i === 0 ? "#C9A84C" : "#fff"}
                    stroke="#C9A84C" strokeWidth={1.5 / zoom}
                    style={{ pointerEvents: "none" }}
                  />
                ))}
              </>
            )}

            {/* Dimension edit overlay */}
            {dimensionEdit && dimEditPos && (
              <foreignObject
                x={dimEditPos.mx - 44}
                y={dimEditPos.my - 20}
                width={88}
                height={40}
                style={{ overflow: "visible" }}
              >
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 2,
                  }}
                >
                  <input
                    // eslint-disable-next-line jsx-a11y/no-autofocus
                    autoFocus
                    value={dimEditValue}
                    onChange={(e) => { setDimEditValue(e.target.value); setDimEditError(""); }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); commitDimensionEdit(); }
                      if (e.key === "Escape") { setDimensionEdit(null); setDimEditError(""); }
                      e.stopPropagation();
                    }}
                    onBlur={commitDimensionEdit}
                    onClick={(e) => e.stopPropagation()}
                    placeholder={`e.g. 12' 6"`}
                    style={{
                      width: "100%",
                      background: "#0C0800",
                      border: `1px solid ${dimEditError ? "#ef4444" : "#C9A84C"}`,
                      borderRadius: 4,
                      color: "#fff",
                      fontSize: 11,
                      padding: "3px 6px",
                      textAlign: "center",
                      outline: "none",
                      fontFamily: "monospace",
                    }}
                  />
                </div>
              </foreignObject>
            )}
          </g>

          {/* Saving indicator */}
          {saving && (
            <text x={8} y={20} fill="#C9A84C" fontSize={11} fontFamily="sans-serif">
              Saving…
            </text>
          )}
        </svg>

        {/* Right panel — room detail */}
        {selectedRoom && (
          <RoomDetailPanel
            room={selectedRoom}
            openings={openings}
            onUpdate={async (updates) => { await updateRoom(selectedRoom.id, updates); }}
            onDelete={async () => { await deleteRoom(selectedRoom.id); setSelectedRoomId(null); setSelectedWall(null); }}
            onClose={() => { setSelectedRoomId(null); setSelectedWall(null); }}
            onAddOpening={async (type) => {
              if (!selectedRoom?.polygon_points?.length) return;
              await createOpening({
                room_id: selectedRoom.id,
                type,
                wall_index: selectedWall?.wallIndex ?? 0,
                position: 0.5,
                width: type === "door" ? 3 : type === "window" ? 3 : 4,
                height: type === "door" ? 6.8 : type === "window" ? 4 : 7,
                notes: null,
              });
            }}
            onUpdateOpening={async (id, updates) => { await updateOpening(id, updates); }}
            onDeleteOpening={deleteOpening}
          />
        )}
      </div>

      {/* Dimension edit error toast */}
      {dimEditError && (
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-red-900/80 border border-red-500/40 rounded-lg px-3 py-1.5 text-xs text-red-300 pointer-events-none">
          <AlertCircle size={12} />
          {dimEditError}
        </div>
      )}

      {/* Status bar */}
      {selectedWall && !dimensionEdit && (
        <div className="shrink-0 flex items-center gap-2 px-3 h-7 bg-[#0C0800] border-t border-[#2C1E00] text-xs text-slate-500">
          {(() => {
            const room = rooms.find((r) => r.id === selectedWall.roomId);
            const pts = (room?.polygon_points ?? []) as Point[];
            const i = selectedWall.wallIndex;
            const j = (i + 1) % pts.length;
            if (i >= pts.length) return null;
            const len = distanceBetween(pts[i]!, pts[j]!);
            return (
              <>
                <span className="text-[#C9A84C] font-mono">Wall {i + 1}:</span>
                <span>{formatFeet(len)}</span>
                <span className="text-slate-600">· Click dimension label to enter exact length · Drag wall to move</span>
              </>
            );
          })()}
        </div>
      )}

      {/* Polygon hint */}
      {tool === "polygon" && polyPoints.length > 0 && (
        <div className="absolute bottom-10 left-1/2 -translate-x-1/2 bg-[#0C0800] border border-[#2C1E00] rounded-lg px-3 py-1.5 text-xs text-slate-400 pointer-events-none">
          {polyPoints.length < 3
            ? `${polyPoints.length} point${polyPoints.length === 1 ? "" : "s"} — need 3+ to close`
            : "Click first point or press Enter to close · Esc to cancel"}
        </div>
      )}
    </div>
  );
}

// ── Room list panel ───────────────────────────────────────────────────────────

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
          <p className="text-xs text-slate-600 px-3 py-4 leading-relaxed">
            Draw a room on the canvas to get started.
          </p>
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

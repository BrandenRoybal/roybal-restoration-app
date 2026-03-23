import React, { useRef, useCallback, useEffect, useState } from 'react';
import type { FPPoint, FPRoom, FPOpening } from '@roybal/shared';
import {
  worldToScreen, screenToWorld,
  wallEndpoints, wallMidpoint, wallLength,
  hitTestVertex, hitTestWall, hitTestRoom,
  moveVertex, moveWall, snapToGrid, snapToAngle,
  openingEndpoints, openingCenterPoint, wallNormal,
  projectOntoSegment, dist,
} from './geometry';
import { formatDimensionLabel } from './dimensions';

export type EditorMode = 'select' | 'draw' | 'opening';
export type OpeningPlacementType = 'door' | 'window' | 'opening';

export interface Selection {
  type: 'room' | 'wall' | 'vertex' | 'opening';
  roomId: string;
  wallIndex?: number;
  vertexIndex?: number;
  openingId?: string | undefined;
}

interface Props {
  rooms: FPRoom[];
  openings: FPOpening[];
  mode: EditorMode;
  openingType: OpeningPlacementType;
  selection: Selection | null;
  snapGrid: boolean;
  gridFt: number;
  scale: number;       // px per foot
  pan: FPPoint;
  onPanChange: (pan: FPPoint) => void;
  onScaleChange: (scale: number) => void;
  onSelectionChange: (sel: Selection | null) => void;
  onRoomsChange: (rooms: FPRoom[]) => void;
  onOpeningsChange: (openings: FPOpening[]) => void;
  onAddRoom: (points: FPPoint[]) => void;
  onAddOpening: (roomId: string, wallIndex: number, offset: number, type: OpeningPlacementType) => void;
  onDimensionLabelClick: (roomId: string, wallIndex: number) => void;
}

const GRID_COLOR = '#1E293B';
const ROOM_FILL = 'rgba(249,115,22,0.08)';
const ROOM_FILL_SELECTED = 'rgba(249,115,22,0.18)';
const WALL_COLOR = '#64748B';
const WALL_COLOR_SELECTED = '#F97316';
const VERTEX_RADIUS = 6;
const VERTEX_RADIUS_TOUCH = 14;
const DOOR_COLOR = '#22C55E';
const WINDOW_COLOR = '#3B82F6';
const OPENING_COLOR = '#A855F7';
const DIM_LABEL_COLOR = '#94A3B8';
const DIM_LABEL_SELECTED = '#F97316';

function isTouchDevice() {
  return 'ontouchstart' in window;
}

export default function EditorCanvas({
  rooms, openings, mode, openingType, selection,
  snapGrid, gridFt, scale, pan,
  onPanChange, onScaleChange, onSelectionChange,
  onRoomsChange, onOpeningsChange, onAddRoom, onAddOpening,
  onDimensionLabelClick,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });

  // Draw mode state
  const [drawPoints, setDrawPoints] = useState<FPPoint[]>([]);
  const [cursorWorld, setCursorWorld] = useState<FPPoint | null>(null);

  // Drag state
  const dragRef = useRef<{
    type: 'vertex' | 'wall' | 'room' | 'pan' | 'opening';
    roomId?: string;
    wallIndex?: number;
    vertexIndex?: number;
    openingId?: string;
    startWorld: FPPoint;
    startScreen: { x: number; y: number };
    originalPoints?: FPPoint[];
    originalPan?: FPPoint;
    originalOpening?: FPOpening;
  } | null>(null);

  // Track touch for pinch zoom
  const touchesRef = useRef<React.Touch[]>([]);
  const lastPinchDist = useRef<number | null>(null);

  // Resize observer
  useEffect(() => {
    const el = svgRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (e) setSize({ w: e.contentRect.width, h: e.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Coordinate helpers ───────────────────────────────────────

  const toWorld = useCallback((clientX: number, clientY: number): FPPoint => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return screenToWorld({ x: clientX - rect.left, y: clientY - rect.top }, scale, pan);
  }, [scale, pan]);

  const applySnap = useCallback((p: FPPoint, anchor?: FPPoint): FPPoint => {
    let pt = p;
    if (snapGrid) pt = snapToGrid(pt, gridFt);
    if (anchor && mode === 'draw') pt = snapToAngle(anchor, pt);
    return pt;
  }, [snapGrid, gridFt, mode]);

  // ── Pointer helpers ──────────────────────────────────────────

  const getEventPos = (e: React.MouseEvent | React.TouchEvent): { x: number; y: number } => {
    if ('touches' in e) {
      const t = e.touches[0] ?? e.changedTouches[0]!;
      return { x: t!.clientX, y: t!.clientY };
    }
    return { x: (e as React.MouseEvent).clientX, y: (e as React.MouseEvent).clientY };
  };

  // ── Mouse/Touch down ─────────────────────────────────────────

  const handlePointerDown = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    if ('touches' in e && e.touches.length === 2) return; // pinch handled separately
    e.preventDefault();
    const pos = getEventPos(e);
    const world = toWorld(pos.x, pos.y);

    if (mode === 'draw') {
      // Close polygon on double-click or clicking near first point
      if (drawPoints.length >= 3) {
        const firstScreen = worldToScreen(drawPoints[0]!, scale, pan);
        const dx = pos.x - (svgRef.current?.getBoundingClientRect().left ?? 0) - firstScreen.x;
        const dy = pos.y - (svgRef.current?.getBoundingClientRect().top ?? 0) - firstScreen.y;
        if (Math.sqrt(dx * dx + dy * dy) < 16) {
          onAddRoom(drawPoints);
          setDrawPoints([]);
          return;
        }
      }
      const snapped = applySnap(world, drawPoints[drawPoints.length - 1]);
      setDrawPoints((prev) => [...prev, snapped]);
      return;
    }

    if (mode === 'opening') {
      // Find wall under cursor
      for (const room of rooms) {
        const wi = hitTestWall(room, world);
        if (wi !== -1) {
          const [a] = wallEndpoints(room, wi);
          const wLen = dist(a, wallEndpoints(room, wi)[1]);
          const { t } = projectOntoSegment(world, a, wallEndpoints(room, wi)[1]);
          const defaultWidth = openingType === 'window' ? 3 : 3;
          const offset = Math.max(0, Math.min(wLen - defaultWidth, t * wLen - defaultWidth / 2));
          onAddOpening(room.id, wi, offset, openingType);
          onSelectionChange({ type: 'opening', roomId: room.id, wallIndex: wi });
          return;
        }
      }
      return;
    }

    // select mode — hit test
    // 1. Check openings
    for (const op of openings) {
      const room = rooms.find((r) => r.id === op.room_id);
      if (!room) continue;
      const ctr = openingCenterPoint(room, op);
      if (dist(ctr, world) < 0.6) {
        onSelectionChange({ type: 'opening', roomId: room.id, wallIndex: op.wall_index, openingId: op.id });
        dragRef.current = {
          type: 'opening', roomId: room.id, openingId: op.id,
          startWorld: world, startScreen: pos, originalOpening: { ...op },
        };
        return;
      }
    }

    // 2. Check vertices
    for (const room of rooms) {
      const vi = hitTestVertex(room.points, world);
      if (vi !== -1) {
        onSelectionChange({ type: 'vertex', roomId: room.id, vertexIndex: vi });
        dragRef.current = {
          type: 'vertex', roomId: room.id, vertexIndex: vi,
          startWorld: world, startScreen: pos, originalPoints: [...room.points],
        };
        return;
      }
    }

    // 3. Check walls
    for (const room of rooms) {
      const wi = hitTestWall(room, world);
      if (wi !== -1) {
        onSelectionChange({ type: 'wall', roomId: room.id, wallIndex: wi });
        dragRef.current = {
          type: 'wall', roomId: room.id, wallIndex: wi,
          startWorld: world, startScreen: pos, originalPoints: [...room.points],
        };
        return;
      }
    }

    // 4. Check rooms
    const room = hitTestRoom(rooms, world);
    if (room) {
      onSelectionChange({ type: 'room', roomId: room.id });
      dragRef.current = {
        type: 'room', roomId: room.id,
        startWorld: world, startScreen: pos, originalPoints: [...room.points],
      };
      return;
    }

    // 5. Pan
    onSelectionChange(null);
    dragRef.current = {
      type: 'pan', startWorld: world, startScreen: pos, originalPan: { ...pan },
    };
  }, [mode, drawPoints, rooms, openings, openingType, scale, pan, applySnap, toWorld,
    onAddRoom, onAddOpening, onSelectionChange]);

  // ── Mouse/Touch move ─────────────────────────────────────────

  const handlePointerMove = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    if ('touches' in e && e.touches.length === 2) return;
    const pos = getEventPos(e);
    const world = toWorld(pos.x, pos.y);
    setCursorWorld(world);

    const drag = dragRef.current;
    if (!drag) return;

    const dx = world.x - drag.startWorld.x;
    const dy = world.y - drag.startWorld.y;

    if (drag.type === 'pan') {
      if (!drag.originalPan) return;
      onPanChange({
        x: drag.originalPan.x + (pos.x - drag.startScreen.x),
        y: drag.originalPan.y + (pos.y - drag.startScreen.y),
      });
      return;
    }

    if (drag.type === 'vertex' && drag.roomId !== undefined && drag.vertexIndex !== undefined) {
      const room = rooms.find((r) => r.id === drag.roomId);
      if (!room || !drag.originalPoints) return;
      const orig = drag.originalPoints[drag.vertexIndex] ?? { x: 0, y: 0 };
      const newPt = applySnap({ x: orig.x + dx, y: orig.y + dy });
      const newPoints = moveVertex(drag.originalPoints, drag.vertexIndex, newPt);
      onRoomsChange(rooms.map((r) => r.id === drag.roomId ? { ...r, points: newPoints } : r));
      return;
    }

    if (drag.type === 'wall' && drag.roomId !== undefined && drag.wallIndex !== undefined) {
      if (!drag.originalPoints) return;
      const snapped = applySnap({ x: dx, y: dy });
      const newPoints = moveWall(drag.originalPoints, drag.wallIndex, snapped);
      onRoomsChange(rooms.map((r) => r.id === drag.roomId ? { ...r, points: newPoints } : r));
      return;
    }

    if (drag.type === 'room' && drag.roomId !== undefined) {
      if (!drag.originalPoints) return;
      const snapped = applySnap({ x: dx, y: dy });
      const newPoints = drag.originalPoints.map((p) => ({
        x: p.x + snapped.x, y: p.y + snapped.y,
      }));
      onRoomsChange(rooms.map((r) => r.id === drag.roomId ? { ...r, points: newPoints } : r));
      return;
    }

    if (drag.type === 'opening' && drag.openingId) {
      const op = openings.find((o) => o.id === drag.openingId);
      const room = rooms.find((r) => r.id === drag.roomId);
      if (!op || !room || !drag.originalOpening) return;
      const [a, b] = wallEndpoints(room, op.wall_index);
      const { t } = projectOntoSegment(world, a, b);
      const wLen = dist(a, b);
      const newOffset = Math.max(0, Math.min(wLen - op.width, t * wLen - op.width / 2));
      onOpeningsChange(openings.map((o) => o.id === op.id ? { ...o, offset_from_start: newOffset } : o));
    }
  }, [rooms, openings, scale, pan, applySnap, toWorld, onPanChange, onRoomsChange, onOpeningsChange]);

  // ── Mouse/Touch up ───────────────────────────────────────────

  const handlePointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  // ── Double-click to close polygon ────────────────────────────

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    if (mode === 'draw' && drawPoints.length >= 3) {
      onAddRoom(drawPoints);
      setDrawPoints([]);
      e.preventDefault();
    }
  }, [mode, drawPoints, onAddRoom]);

  // ── Keyboard ─────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDrawPoints([]);
        onSelectionChange(null);
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selection) {
        if (selection.type === 'room') {
          onRoomsChange(rooms.filter((r) => r.id !== selection.roomId));
          onOpeningsChange(openings.filter((o) => o.room_id !== selection.roomId));
          onSelectionChange(null);
        }
        if (selection.type === 'opening' && selection.openingId) {
          onOpeningsChange(openings.filter((o) => o.id !== selection.openingId));
          onSelectionChange(null);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selection, rooms, openings, onRoomsChange, onOpeningsChange, onSelectionChange]);

  // ── Pinch zoom ───────────────────────────────────────────────

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchesRef.current = Array.from(e.touches);
    if (e.touches.length === 2) {
      const t = e.touches;
      lastPinchDist.current = Math.hypot((t[0]?.clientX ?? 0) - (t[1]?.clientX ?? 0), (t[0]?.clientY ?? 0) - (t[1]?.clientY ?? 0));
      return;
    }
    handlePointerDown(e);
  }, [handlePointerDown]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2 && lastPinchDist.current !== null) {
      const t = e.touches;
      const newDist = Math.hypot((t[0]?.clientX ?? 0) - (t[1]?.clientX ?? 0), (t[0]?.clientY ?? 0) - (t[1]?.clientY ?? 0));
      const ratio = newDist / lastPinchDist.current;
      const newScale = Math.max(20, Math.min(200, scale * ratio));
      onScaleChange(newScale);
      lastPinchDist.current = newDist;
      return;
    }
    handlePointerMove(e);
  }, [scale, handlePointerMove, onScaleChange]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    lastPinchDist.current = null;
    handlePointerUp();
    if (e.touches.length === 0 && mode === 'draw') {
      // single tap already handled in touchstart
    }
  }, [handlePointerUp, mode]);

  // ── Wheel zoom ───────────────────────────────────────────────

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.max(20, Math.min(200, scale * factor));
    // Zoom toward cursor
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    onPanChange({
      x: cx - (cx - pan.x) * (newScale / scale),
      y: cy - (cy - pan.y) * (newScale / scale),
    });
    onScaleChange(newScale);
  }, [scale, pan, onScaleChange, onPanChange]);

  // ── Render helpers ───────────────────────────────────────────

  const touchR = isTouchDevice() ? VERTEX_RADIUS_TOUCH : VERTEX_RADIUS;

  const renderGrid = () => {
    if (!snapGrid) return null;
    const lines: React.ReactNode[] = [];
    const worldLeft = (0 - pan.x) / scale;
    const worldTop = (0 - pan.y) / scale;
    const worldRight = (size.w - pan.x) / scale;
    const worldBottom = (size.h - pan.y) / scale;
    const startX = Math.floor(worldLeft / gridFt) * gridFt;
    const startY = Math.floor(worldTop / gridFt) * gridFt;
    for (let x = startX; x <= worldRight; x += gridFt) {
      const sx = x * scale + pan.x;
      lines.push(<line key={`gx${x}`} x1={sx} y1={0} x2={sx} y2={size.h} stroke={GRID_COLOR} strokeWidth={0.5} />);
    }
    for (let y = startY; y <= worldBottom; y += gridFt) {
      const sy = y * scale + pan.y;
      lines.push(<line key={`gy${y}`} x1={0} y1={sy} x2={size.w} y2={sy} stroke={GRID_COLOR} strokeWidth={0.5} />);
    }
    return <g>{lines}</g>;
  };

  const renderRoom = (room: FPRoom) => {
    const isSelected = selection?.roomId === room.id;
    const pts = room.points.map((p) => worldToScreen(p, scale, pan));
    const polygon = pts.map((p) => `${p.x},${p.y}`).join(' ');
    const roomOpenings = openings.filter((o) => o.room_id === room.id);

    return (
      <g key={room.id}>
        {/* Room fill */}
        <polygon
          points={polygon}
          fill={isSelected && selection?.type === 'room' ? ROOM_FILL_SELECTED : ROOM_FILL}
          stroke="none"
        />

        {/* Walls */}
        {room.points.map((_, wi) => {
          const [a, b] = wallEndpoints(room, wi);
          const sa = worldToScreen(a, scale, pan);
          const sb = worldToScreen(b, scale, pan);
          const isWallSel = isSelected && selection?.type === 'wall' && selection.wallIndex === wi;
          const color = isWallSel ? WALL_COLOR_SELECTED : WALL_COLOR;
          const strokeW = isWallSel ? 2.5 : 2;

          // Dimension label
          const mid = wallMidpoint(room, wi);
          const smid = worldToScreen(mid, scale, pan);
          const wLen = wallLength(room, wi);
          const label = formatDimensionLabel(wLen);
          const [wa, wb] = [a, b];
          const angle = Math.atan2(wb.y - wa.y, wb.x - wa.x) * (180 / Math.PI);
          const norm = wallNormal(room, wi);
          const labelOffset = 18;
          const labelX = smid.x + norm.x * labelOffset;
          const labelY = smid.y + norm.y * labelOffset;
          const labelColor = isWallSel ? DIM_LABEL_SELECTED : DIM_LABEL_COLOR;
          const showLabel = wLen * scale > 30; // only show if wall is wide enough on screen

          return (
            <g key={wi}>
              <line x1={sa.x} y1={sa.y} x2={sb.x} y2={sb.y} stroke={color} strokeWidth={strokeW} strokeLinecap="round" />
              {/* Invisible fat hit target */}
              <line x1={sa.x} y1={sa.y} x2={sb.x} y2={sb.y} stroke="transparent" strokeWidth={Math.max(touchR, 12)} />
              {/* Dimension label */}
              {showLabel && (
                <text
                  x={labelX} y={labelY}
                  textAnchor="middle" dominantBaseline="middle"
                  fontSize={11}
                  fill={labelColor}
                  style={{ cursor: 'pointer', userSelect: 'none' }}
                  transform={`rotate(${angle > 90 || angle < -90 ? angle + 180 : angle}, ${labelX}, ${labelY})`}
                  onClick={(e) => { e.stopPropagation(); onDimensionLabelClick(room.id, wi); }}
                >
                  {label}
                </text>
              )}
            </g>
          );
        })}

        {/* Openings on this room */}
        {roomOpenings.map((op) => renderOpening(room, op))}

        {/* Vertices */}
        {room.points.map((p, vi) => {
          const sp = worldToScreen(p, scale, pan);
          const isVSel = isSelected && selection?.type === 'vertex' && selection.vertexIndex === vi;
          return (
            <circle
              key={vi}
              cx={sp.x} cy={sp.y} r={isVSel ? touchR + 2 : touchR}
              fill={isVSel ? '#F97316' : '#1E293B'}
              stroke={isVSel ? '#F97316' : '#64748B'}
              strokeWidth={2}
              style={{ cursor: 'grab' }}
            />
          );
        })}

        {/* Room name label */}
        {(() => {
          const centroid = room.points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
          const cx = centroid.x / room.points.length;
          const cy = centroid.y / room.points.length;
          const sc = worldToScreen({ x: cx, y: cy }, scale, pan);
          return (
            <text x={sc.x} y={sc.y} textAnchor="middle" dominantBaseline="middle"
              fontSize={12} fontWeight="600" fill="rgba(249,115,22,0.7)"
              style={{ userSelect: 'none', pointerEvents: 'none' }}>
              {room.name}
            </text>
          );
        })()}
      </g>
    );
  };

  const renderOpening = (room: FPRoom, op: FPOpening) => {
    const [start, end] = openingEndpoints(room, op);
    const ss = worldToScreen(start, scale, pan);
    const se = worldToScreen(end, scale, pan);
    const isSel = selection?.type === 'opening' && selection.openingId === op.id;
    const color = op.type === 'door' ? DOOR_COLOR : op.type === 'window' ? WINDOW_COLOR : OPENING_COLOR;

    // Wall normal for offset
    const norm = wallNormal(room, op.wall_index);
    const offset = 4; // px inset

    return (
      <g key={op.id}>
        {/* Opening gap line (thicker, colored) */}
        <line
          x1={ss.x + norm.x * offset} y1={ss.y + norm.y * offset}
          x2={se.x + norm.x * offset} y2={se.y + norm.y * offset}
          stroke={color} strokeWidth={isSel ? 4 : 3} strokeLinecap="round"
        />
        {/* Type indicator: small perpendicular ticks */}
        {[ss, se].map((pt, i) => (
          <line key={i}
            x1={pt.x + norm.x * (offset - 6)} y1={pt.y + norm.y * (offset - 6)}
            x2={pt.x + norm.x * (offset + 6)} y2={pt.y + norm.y * (offset + 6)}
            stroke={color} strokeWidth={2}
          />
        ))}
        {/* Hit target */}
        <line
          x1={ss.x + norm.x * offset} y1={ss.y + norm.y * offset}
          x2={se.x + norm.x * offset} y2={se.y + norm.y * offset}
          stroke="transparent" strokeWidth={Math.max(touchR, 16)}
          style={{ cursor: 'pointer' }}
        />
        {/* Label */}
        {isSel && (() => {
          const mid = worldToScreen(openingCenterPoint(room, op), scale, pan);
          return (
            <text x={mid.x + norm.x * 20} y={mid.y + norm.y * 20}
              textAnchor="middle" dominantBaseline="middle"
              fontSize={10} fill={color} fontWeight="600"
              style={{ userSelect: 'none', pointerEvents: 'none' }}>
              {op.type} {formatDimensionLabel(op.width)}×{formatDimensionLabel(op.height)}
            </text>
          );
        })()}
      </g>
    );
  };

  const renderDrawPreview = () => {
    if (mode !== 'draw' || drawPoints.length === 0) return null;
    const lastPt = drawPoints[drawPoints.length - 1]!;
    const cursor = cursorWorld ?? lastPt;
    const snapped = applySnap(cursor, lastPt);
    const allPts = [...drawPoints, snapped];
    const screenPts = allPts.map((p) => worldToScreen(p, scale, pan));

    return (
      <g>
        <polyline
          points={screenPts.map((p) => `${p.x},${p.y}`).join(' ')}
          fill="none" stroke="#F97316" strokeWidth={2} strokeDasharray="6 4"
        />
        {drawPoints.map((p, i) => {
          const sp = worldToScreen(p, scale, pan);
          return <circle key={i} cx={sp.x} cy={sp.y} r={5} fill={i === 0 ? '#F97316' : '#64748B'} />;
        })}
        {/* Close polygon hint */}
        {drawPoints.length >= 3 && (() => {
          const first = worldToScreen(drawPoints[0]!, scale, pan);
          return (
            <circle cx={first.x} cy={first.y} r={12}
              fill="rgba(249,115,22,0.2)" stroke="#F97316" strokeWidth={1.5} strokeDasharray="3 2" />
          );
        })()}
      </g>
    );
  };

  const cursor = mode === 'draw' ? 'crosshair' : mode === 'opening' ? 'cell' : dragRef.current?.type === 'pan' ? 'grabbing' : 'default';

  return (
    <svg
      ref={svgRef}
      width={size.w}
      height={size.h}
      style={{ display: 'block', width: '100%', height: '100%', cursor, touchAction: 'none' }}
      onMouseDown={(e) => handlePointerDown(e)}
      onMouseMove={(e) => handlePointerMove(e)}
      onMouseUp={handlePointerUp}
      onMouseLeave={handlePointerUp}
      onDoubleClick={handleDoubleClick}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onWheel={handleWheel}
    >
      {renderGrid()}
      {rooms.map(renderRoom)}
      {renderDrawPreview()}
    </svg>
  );
}

/**
 * FloorPlanEditor — full manual floor plan editor for web.
 * Handles state, undo/redo, persistence via Supabase, and layout.
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import type { FPRoom, FPOpening, FPPoint, ManualFloorPlan } from '@roybal/shared';
import { supabase } from '../../lib/supabase';
import EditorCanvas, { type EditorMode, type OpeningPlacementType, type Selection } from './EditorCanvas';
import Inspector from './Inspector';
import DimensionInput from './DimensionInput';
import { wallLength, wallEndpoints, isValidPolygon, dist } from './geometry';
import { formatFeetInches } from './dimensions';
import {
  MousePointer2, Pencil, DoorOpen, Move, Grid3x3, Undo2, Redo2,
  Save, ZoomIn, ZoomOut, PanelRightOpen, PanelRightClose, Rows3,
} from 'lucide-react';

const DEFAULT_SCALE = 50; // px per foot
const DEFAULT_GRID = 0.5;  // ft

interface UndoSnapshot {
  rooms: FPRoom[];
  openings: FPOpening[];
}

interface Props {
  jobId: string;
}

export default function FloorPlanEditor({ jobId }: Props) {
  const [plan, setPlan] = useState<ManualFloorPlan | null>(null);
  const [rooms, setRoomsState] = useState<FPRoom[]>([]);
  const [openings, setOpeningsState] = useState<FPOpening[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Editor state
  const [mode, setMode] = useState<EditorMode>('select');
  const [openingType, setOpeningType] = useState<OpeningPlacementType>('door');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [snapGrid, setSnapGrid] = useState(true);
  const [gridFt] = useState(DEFAULT_GRID);
  const [scale, setScale] = useState(DEFAULT_SCALE);
  const [pan, setPan] = useState<FPPoint>({ x: 40, y: 40 });
  const [showInspector, setShowInspector] = useState(true);

  // Dimension edit modal
  const [dimEdit, setDimEdit] = useState<{ roomId: string; wallIndex: number } | null>(null);

  // Undo/redo stacks
  const undoStack = useRef<UndoSnapshot[]>([]);
  const redoStack = useRef<UndoSnapshot[]>([]);
  const skipSnapshot = useRef(false);

  // Auto-save debounce
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Load data ────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      // Fetch or create plan record
      let { data: planData } = await supabase
        .from('manual_floor_plans')
        .select('*')
        .eq('job_id', jobId)
        .maybeSingle();

      if (!planData) {
        const { data: created } = await supabase
          .from('manual_floor_plans')
          .insert({ job_id: jobId, name: 'Floor Plan', scale: DEFAULT_SCALE })
          .select()
          .single();
        planData = created;
      }

      if (!planData || cancelled) return;
      setPlan(planData);

      const { data: roomData } = await supabase
        .from('floor_plan_rooms')
        .select('*')
        .eq('plan_id', planData.id)
        .order('created_at');

      const { data: openingData } = await supabase
        .from('floor_plan_openings')
        .select('*')
        .eq('plan_id', planData.id)
        .order('created_at');

      if (cancelled) return;

      const parsedRooms: FPRoom[] = (roomData ?? []).map((r: any) => ({
        ...r,
        points: Array.isArray(r.points) ? r.points : JSON.parse(r.points ?? '[]'),
      }));
      const parsedOpenings: FPOpening[] = openingData ?? [];

      skipSnapshot.current = true;
      setRoomsState(parsedRooms);
      setOpeningsState(parsedOpenings);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [jobId]);

  // ── Snapshot for undo ────────────────────────────────────────

  const snapshot = useCallback((r: FPRoom[], o: FPOpening[]) => {
    if (skipSnapshot.current) { skipSnapshot.current = false; return; }
    undoStack.current = [...undoStack.current.slice(-49), { rooms: r, openings: o }];
    redoStack.current = [];
  }, []);

  const setRooms = useCallback((next: FPRoom[]) => {
    setRoomsState((prev) => { snapshot(prev, []); return next; });
    scheduleAutosave();
  }, [snapshot]);

  const setOpenings = useCallback((next: FPOpening[]) => {
    setOpeningsState((prev) => { snapshot(rooms, prev); return next; });
    scheduleAutosave();
  }, [snapshot, rooms]);

  const undo = useCallback(() => {
    const snap = undoStack.current.pop();
    if (!snap) return;
    redoStack.current = [...redoStack.current, { rooms, openings }];
    skipSnapshot.current = true;
    setRoomsState(snap.rooms);
    setOpeningsState(snap.openings);
    scheduleAutosave();
  }, [rooms, openings]);

  const redo = useCallback(() => {
    const snap = redoStack.current.pop();
    if (!snap) return;
    undoStack.current = [...undoStack.current, { rooms, openings }];
    skipSnapshot.current = true;
    setRoomsState(snap.rooms);
    setOpeningsState(snap.openings);
    scheduleAutosave();
  }, [rooms, openings]);

  // ── Keyboard shortcuts ───────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      if (meta && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
      if (meta && e.key === 's') { e.preventDefault(); saveNow(); }
      if (e.key === 'v') setMode('select');
      if (e.key === 'p') setMode('draw');
      if (e.key === 'o') setMode('opening');
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undo, redo]);

  // ── Auto-save ────────────────────────────────────────────────

  const scheduleAutosave = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(saveNow, 1500);
  };

  const saveNow = useCallback(async () => {
    if (!plan) return;
    setSaving(true);
    setSaveError(null);
    try {
      // Upsert rooms
      for (const room of rooms) {
        const { id, plan_id, created_at, updated_at, ...fields } = room;
        await supabase.from('floor_plan_rooms').upsert({ id, plan_id, ...fields });
      }
      // Delete removed rooms
      const { data: existingRooms } = await supabase.from('floor_plan_rooms').select('id').eq('plan_id', plan.id);
      const currentIds = new Set(rooms.map((r) => r.id));
      const toDelete = (existingRooms ?? []).filter((r: { id: string }) => !currentIds.has(r.id)).map((r: { id: string }) => r.id);
      if (toDelete.length) await supabase.from('floor_plan_rooms').delete().in('id', toDelete);

      // Upsert openings
      for (const op of openings) {
        const { id, room_id, plan_id, created_at, updated_at, ...fields } = op;
        await supabase.from('floor_plan_openings').upsert({ id, room_id, plan_id, ...fields });
      }
      // Delete removed openings
      const { data: existingOps } = await supabase.from('floor_plan_openings').select('id').eq('plan_id', plan.id);
      const currentOpIds = new Set(openings.map((o) => o.id));
      const toDeleteOps = (existingOps ?? []).filter((o: { id: string }) => !currentOpIds.has(o.id)).map((o: { id: string }) => o.id);
      if (toDeleteOps.length) await supabase.from('floor_plan_openings').delete().in('id', toDeleteOps);

    } catch (err: any) {
      setSaveError(err.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [plan, rooms, openings]);

  // ── Room operations ──────────────────────────────────────────

  const handleAddRoom = useCallback((points: FPPoint[]) => {
    if (!plan || !isValidPolygon(points)) return;
    const newRoom: FPRoom = {
      id: crypto.randomUUID(),
      plan_id: plan.id,
      name: `Room ${rooms.length + 1}`,
      points,
      height: 8,
      color: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    setRooms([...rooms, newRoom]);
    setSelection({ type: 'room', roomId: newRoom.id });
    setMode('select');
  }, [plan, rooms, setRooms]);

  // ── Opening operations ───────────────────────────────────────

  const handleAddOpening = useCallback((roomId: string, wallIndex: number, offset: number, type: OpeningPlacementType) => {
    if (!plan) return;
    const defaults = { door: { w: 3, h: 6.83 }, window: { w: 3, h: 4 }, opening: { w: 3, h: 7 } };
    const { w, h } = defaults[type];
    const newOp: FPOpening = {
      id: crypto.randomUUID(),
      room_id: roomId,
      plan_id: plan.id,
      wall_index: wallIndex,
      type,
      width: w,
      height: h,
      offset_from_start: offset,
      swing: type === 'door' ? 'left' : null,
      label: null,
      metadata: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    setOpenings([...openings, newOp]);
    setSelection({ type: 'opening', roomId, wallIndex, openingId: newOp.id });
    setMode('select');
  }, [plan, openings, setOpenings]);

  // ── Wall dimension edit ──────────────────────────────────────

  const handleWallDimensionSave = useCallback((feet: number) => {
    if (!dimEdit) return;
    const { roomId, wallIndex } = dimEdit;
    const room = rooms.find((r) => r.id === roomId);
    if (!room) return;

    const pts = [...room.points];
    const [a, b] = wallEndpoints(room, wallIndex);
    const currentLen = dist(a, b);
    if (currentLen === 0) return;

    // Scale the end vertex outward from start
    const ratio = feet / currentLen;
    const newB: FPPoint = {
      x: a.x + (b.x - a.x) * ratio,
      y: a.y + (b.y - a.y) * ratio,
    };
    pts[(wallIndex + 1) % pts.length] = newB;

    // Reattach: the next wall starts at newB — adjust its far vertex to maintain its length
    const nextEndIdx = (wallIndex + 2) % pts.length;
    const oldC = room.points[nextEndIdx];
    if (oldC) {
      const oldNextLen = dist(b, oldC);
      if (oldNextLen > 0) {
        const dx = oldC.x - b.x;
        const dy = oldC.y - b.y;
        pts[nextEndIdx] = { x: newB.x + dx, y: newB.y + dy };
      }
    }

    if (!isValidPolygon(pts)) {
      alert('This dimension would create an invalid room shape.');
      return;
    }
    setRooms(rooms.map((r) => r.id === roomId ? { ...r, points: pts } : r));
    setDimEdit(null);
  }, [dimEdit, rooms, setRooms]);

  // ── Zoom controls ────────────────────────────────────────────

  const zoom = (factor: number) => setScale((s) => Math.max(20, Math.min(200, s * factor)));

  // ── Render ───────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-500 text-sm">
        Loading floor plan…
      </div>
    );
  }

  const canUndo = undoStack.current.length > 0;
  const canRedo = redoStack.current.length > 0;

  return (
    <div className="flex flex-col h-full rounded-2xl overflow-hidden border border-[#1E293B] bg-[#060E1A]" style={{ minHeight: 520 }}>
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-3 py-2 bg-[#0A1628] border-b border-[#1E293B] flex-wrap">
        {/* Mode buttons */}
        <ToolGroup>
          <ToolBtn active={mode === 'select'} onClick={() => setMode('select')} title="Select (V)">
            <MousePointer2 size={15} />
          </ToolBtn>
          <ToolBtn active={mode === 'draw'} onClick={() => setMode('draw')} title="Draw Room (P)">
            <Pencil size={15} />
          </ToolBtn>
          <ToolBtn active={mode === 'opening'} onClick={() => setMode('opening')} title="Place Opening (O)">
            <DoorOpen size={15} />
          </ToolBtn>
        </ToolGroup>

        {/* Opening type sub-selector */}
        {mode === 'opening' && (
          <ToolGroup>
            {(['door', 'window', 'opening'] as OpeningPlacementType[]).map((t) => (
              <button key={t}
                onClick={() => setOpeningType(t)}
                className={`h-7 px-2.5 text-xs font-bold rounded-lg capitalize transition-colors ${openingType === t ? 'bg-[#F97316] text-[#0F172A]' : 'text-slate-400 hover:text-slate-200 hover:bg-[#1E293B]'}`}
              >
                {t}
              </button>
            ))}
          </ToolGroup>
        )}

        <div className="flex-1" />

        {/* Snap grid */}
        <ToolGroup>
          <ToolBtn active={snapGrid} onClick={() => setSnapGrid((v) => !v)} title="Snap to Grid">
            <Grid3x3 size={15} />
          </ToolBtn>
        </ToolGroup>

        {/* Undo/redo */}
        <ToolGroup>
          <ToolBtn active={false} onClick={undo} disabled={!canUndo} title="Undo (⌘Z)">
            <Undo2 size={15} />
          </ToolBtn>
          <ToolBtn active={false} onClick={redo} disabled={!canRedo} title="Redo (⌘Y)">
            <Redo2 size={15} />
          </ToolBtn>
        </ToolGroup>

        {/* Zoom */}
        <ToolGroup>
          <ToolBtn active={false} onClick={() => zoom(0.8)} title="Zoom Out">
            <ZoomOut size={15} />
          </ToolBtn>
          <span className="text-xs text-slate-500 w-10 text-center">{Math.round(scale / DEFAULT_SCALE * 100)}%</span>
          <ToolBtn active={false} onClick={() => zoom(1.25)} title="Zoom In">
            <ZoomIn size={15} />
          </ToolBtn>
        </ToolGroup>

        {/* Save */}
        <button
          onClick={saveNow}
          disabled={saving}
          className="flex items-center gap-1.5 h-7 px-3 text-xs font-bold bg-[#F97316]/10 border border-[#F97316]/30 text-[#F97316] rounded-lg hover:bg-[#F97316]/20 disabled:opacity-50 transition-colors"
          title="Save (⌘S)"
        >
          <Save size={13} className={saving ? 'animate-pulse' : ''} />
          {saving ? 'Saving…' : 'Save'}
        </button>

        {/* Inspector toggle */}
        <ToolBtn active={showInspector} onClick={() => setShowInspector((v) => !v)} title="Inspector">
          {showInspector ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
        </ToolBtn>
      </div>

      {/* Mode hint */}
      <div className="px-4 py-1.5 bg-[#0A1628] border-b border-[#1E293B] flex items-center justify-between">
        <p className="text-xs text-slate-600">
          {mode === 'draw' && 'Click to place corners · Double-click or click first point to close room · Esc to cancel'}
          {mode === 'select' && 'Click to select · Drag walls/corners/rooms · Click dimension label to edit · Delete key removes selection'}
          {mode === 'opening' && `Click on a wall to place a ${openingType} · Drag to reposition · Resize in inspector`}
        </p>
        {saveError && <p className="text-xs text-red-400">{saveError}</p>}
      </div>

      {/* Canvas + Inspector */}
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 min-w-0">
          <EditorCanvas
            rooms={rooms}
            openings={openings}
            mode={mode}
            openingType={openingType}
            selection={selection}
            snapGrid={snapGrid}
            gridFt={gridFt}
            scale={scale}
            pan={pan}
            onPanChange={setPan}
            onScaleChange={setScale}
            onSelectionChange={setSelection}
            onRoomsChange={setRooms}
            onOpeningsChange={setOpenings}
            onAddRoom={handleAddRoom}
            onAddOpening={handleAddOpening}
            onDimensionLabelClick={(roomId, wallIndex) => setDimEdit({ roomId, wallIndex })}
          />
        </div>

        {/* Inspector panel */}
        {showInspector && (
          <div className="w-56 border-l border-[#1E293B] bg-[#0A1628] flex-shrink-0 overflow-y-auto">
            <Inspector
              selection={selection}
              rooms={rooms}
              openings={openings}
              onRoomsChange={setRooms}
              onOpeningsChange={setOpenings}
              onWallDimensionEdit={(roomId, wallIndex) => setDimEdit({ roomId, wallIndex })}
            />
          </div>
        )}
      </div>

      {/* Dimension edit modal */}
      {dimEdit && (() => {
        const room = rooms.find((r) => r.id === dimEdit.roomId);
        if (!room) return null;
        const current = wallLength(room, dimEdit.wallIndex);
        return (
          <DimensionInput
            label={`Wall ${dimEdit.wallIndex + 1} length — ${room.name}`}
            currentFeet={current}
            onSave={handleWallDimensionSave}
            onCancel={() => setDimEdit(null)}
            minFt={0.5}
            maxFt={200}
          />
        );
      })()}
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────

function ToolGroup({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-0.5 bg-[#0F172A] rounded-lg p-0.5">{children}</div>;
}

function ToolBtn({ active, onClick, children, title, disabled }: {
  active: boolean; onClick: () => void; children: React.ReactNode; title?: string; disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`h-7 w-7 flex items-center justify-center rounded-md transition-colors disabled:opacity-30 ${
        active ? 'bg-[#F97316] text-[#0F172A]' : 'text-slate-400 hover:text-slate-200 hover:bg-[#1E293B]'
      }`}
    >
      {children}
    </button>
  );
}

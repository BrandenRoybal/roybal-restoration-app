import React, { useState } from 'react';
import type { FPRoom, FPOpening, OpeningType, DoorSwing } from '@roybal/shared';
import { formatFeetInches, formatSqFt, parseFeetInches } from './dimensions';
import { wallLength, computeRoomCalcs } from './geometry';
import type { Selection } from './EditorCanvas';

interface Props {
  selection: Selection | null;
  rooms: FPRoom[];
  openings: FPOpening[];
  onRoomsChange: (rooms: FPRoom[]) => void;
  onOpeningsChange: (openings: FPOpening[]) => void;
  onWallDimensionEdit: (roomId: string, wallIndex: number) => void;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">{label}</label>
      {children}
    </div>
  );
}

function TextInput({ value, onChange, suffix }: { value: string; onChange: (v: string) => void; suffix?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 bg-[#0F172A] border border-[#1E293B] rounded-lg px-3 h-8 text-sm text-slate-200 font-mono focus:outline-none focus:border-[#F97316] transition-colors"
      />
      {suffix && <span className="text-xs text-slate-500">{suffix}</span>}
    </div>
  );
}

function DimInput({ feet, onSave, label }: { feet: number; onSave: (v: number) => void; label: string }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');

  const start = () => { setVal(formatFeetInches(feet)); setEditing(true); };
  const commit = () => {
    const parsed = parseFeetInches(val);
    if (parsed !== null && parsed > 0) { onSave(parsed); setEditing(false); }
  };

  if (!editing) {
    return (
      <button
        onClick={start}
        className="w-full text-left bg-[#0F172A] border border-[#1E293B] hover:border-[#F97316]/50 rounded-lg px-3 h-8 text-sm text-[#F97316] font-mono transition-colors"
      >
        {formatFeetInches(feet)}
      </button>
    );
  }

  return (
    <div className="flex gap-1.5">
      <input
        autoFocus
        type="text"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
        className="flex-1 bg-[#0F172A] border border-[#F97316] rounded-lg px-3 h-8 text-sm text-slate-200 font-mono focus:outline-none"
        placeholder={label}
      />
      <button onClick={commit} className="px-2 h-8 text-xs font-bold bg-[#F97316] text-[#0F172A] rounded-lg">OK</button>
      <button onClick={() => setEditing(false)} className="px-2 h-8 text-xs text-slate-400 bg-[#1E293B] rounded-lg">✕</button>
    </div>
  );
}

export default function Inspector({ selection, rooms, openings, onRoomsChange, onOpeningsChange, onWallDimensionEdit }: Props) {
  if (!selection) {
    return (
      <div className="p-4 text-center text-slate-600 text-sm">
        <p>Select a room, wall, or opening</p>
        <p className="text-xs mt-1">Click to select · Drag to move</p>
      </div>
    );
  }

  const room = rooms.find((r) => r.id === selection.roomId);
  if (!room) return null;

  const updateRoom = (patch: Partial<FPRoom>) =>
    onRoomsChange(rooms.map((r) => r.id === room.id ? { ...r, ...patch } : r));

  // ── Room inspector ───────────────────────────────────────────

  if (selection.type === 'room') {
    const calcs = computeRoomCalcs(room, openings);
    return (
      <div className="p-4 space-y-4 overflow-y-auto">
        <h3 className="text-xs font-bold text-[#F97316] uppercase tracking-wider">Room</h3>
        <Field label="Name">
          <TextInput
            value={room.name}
            onChange={(v) => updateRoom({ name: v })}
          />
        </Field>
        <Field label="Ceiling Height">
          <DimInput feet={room.height} onSave={(v) => updateRoom({ height: v })} label="height" />
        </Field>
        <div className="border-t border-[#1E293B] pt-3 space-y-1.5">
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Calculations</p>
          <Stat label="Floor Area" value={formatSqFt(calcs.floor_area)} />
          <Stat label="Perimeter" value={formatFeetInches(calcs.perimeter)} />
          <Stat label="Gross Wall Area" value={formatSqFt(calcs.gross_wall_area)} />
          <Stat label="Net Wall Area" value={formatSqFt(calcs.net_wall_area)} />
        </div>
        <div className="border-t border-[#1E293B] pt-3">
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Walls</p>
          <div className="space-y-1">
            {room.points.map((_, wi) => (
              <button
                key={wi}
                onClick={() => onWallDimensionEdit(room.id, wi)}
                className="w-full flex items-center justify-between bg-[#0F172A] hover:bg-[#1E293B] border border-[#1E293B] rounded-lg px-3 h-8 text-xs transition-colors"
              >
                <span className="text-slate-400">Wall {wi + 1}</span>
                <span className="text-[#F97316] font-mono">{formatFeetInches(wallLength(room, wi))}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── Wall inspector ───────────────────────────────────────────

  if (selection.type === 'wall' && selection.wallIndex !== undefined) {
    const wi = selection.wallIndex;
    const wLen = wallLength(room, wi);
    return (
      <div className="p-4 space-y-4 overflow-y-auto">
        <h3 className="text-xs font-bold text-[#F97316] uppercase tracking-wider">Wall {wi + 1}</h3>
        <Field label="Length">
          <button
            onClick={() => onWallDimensionEdit(room.id, wi)}
            className="w-full text-left bg-[#0F172A] border border-[#F97316]/40 hover:border-[#F97316] rounded-lg px-3 h-8 text-sm text-[#F97316] font-mono transition-colors flex items-center justify-between"
          >
            <span>{formatFeetInches(wLen)}</span>
            <span className="text-xs text-slate-500">tap to edit</span>
          </button>
        </Field>
        <Field label="Room">
          <p className="text-sm text-slate-300">{room.name}</p>
        </Field>
        <div className="border-t border-[#1E293B] pt-3">
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Openings on this wall</p>
          {openings.filter((o) => o.room_id === room.id && o.wall_index === wi).length === 0
            ? <p className="text-xs text-slate-600">None — use Opening tool to add</p>
            : openings.filter((o) => o.room_id === room.id && o.wall_index === wi).map((op) => (
              <div key={op.id} className="text-xs text-slate-400 flex justify-between py-1">
                <span className="capitalize">{op.type}</span>
                <span className="font-mono text-slate-300">{formatFeetInches(op.width)} × {formatFeetInches(op.height)}</span>
              </div>
            ))
          }
        </div>
      </div>
    );
  }

  // ── Opening inspector ────────────────────────────────────────

  if (selection.type === 'opening' && selection.openingId) {
    const op = openings.find((o) => o.id === selection.openingId);
    if (!op) return null;
    const updateOp = (patch: Partial<FPOpening>) =>
      onOpeningsChange(openings.map((o) => o.id === op.id ? { ...o, ...patch } : o));
    const wLen = wallLength(room, op.wall_index);

    return (
      <div className="p-4 space-y-4 overflow-y-auto">
        <h3 className="text-xs font-bold text-[#F97316] uppercase tracking-wider capitalize">{op.type}</h3>
        <Field label="Type">
          <div className="flex gap-1.5">
            {(['door', 'window', 'opening'] as OpeningType[]).map((t) => (
              <button key={t}
                onClick={() => updateOp({ type: t })}
                className={`flex-1 h-8 text-xs font-bold rounded-lg capitalize transition-colors ${op.type === t ? 'bg-[#F97316] text-[#0F172A]' : 'bg-[#1E293B] text-slate-400 hover:text-slate-200'}`}
              >
                {t}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Width">
          <DimInput feet={op.width} onSave={(v) => updateOp({ width: v })} label="width" />
        </Field>
        <Field label="Height">
          <DimInput feet={op.height} onSave={(v) => updateOp({ height: v })} label="height" />
        </Field>
        <Field label="Offset from wall start">
          <DimInput
            feet={op.offset_from_start}
            onSave={(v) => updateOp({ offset_from_start: Math.max(0, Math.min(wLen - op.width, v)) })}
            label="offset"
          />
        </Field>
        {op.type === 'door' && (
          <Field label="Swing">
            <div className="flex gap-1.5">
              {(['left', 'right', 'none'] as DoorSwing[]).map((s) => (
                <button key={s}
                  onClick={() => updateOp({ swing: s })}
                  className={`flex-1 h-8 text-xs font-bold rounded-lg capitalize transition-colors ${op.swing === s ? 'bg-[#F97316] text-[#0F172A]' : 'bg-[#1E293B] text-slate-400 hover:text-slate-200'}`}
                >
                  {s}
                </button>
              ))}
            </div>
          </Field>
        )}
        <Field label="Label">
          <TextInput value={op.label ?? ''} onChange={(v) => updateOp({ label: v || null })} />
        </Field>
        <button
          onClick={() => { onOpeningsChange(openings.filter((o) => o.id !== op.id)); }}
          className="w-full h-8 text-xs font-bold text-red-400 hover:text-red-300 bg-red-400/10 hover:bg-red-400/20 rounded-lg transition-colors mt-2"
        >
          Delete Opening
        </button>
      </div>
    );
  }

  return null;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-slate-500">{label}</span>
      <span className="text-xs font-mono text-slate-300">{value}</span>
    </div>
  );
}

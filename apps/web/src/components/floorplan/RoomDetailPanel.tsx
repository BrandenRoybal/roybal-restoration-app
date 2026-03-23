/**
 * RoomDetailPanel — right-side inspector for the selected room.
 * Shows computed stats, openings (with inline edit), restoration metadata, and checkbox flags.
 */

import { useState } from "react";
import { X, Trash2, ChevronDown, ChevronUp } from "lucide-react";
import clsx from "clsx";
import type { Room, RoomOpening } from "@roybal/shared";
import { formatFeet, formatSqFt, formatLinearFt, parseFeetInches } from "../../utils/geometry";

interface Props {
  room: Room;
  openings: RoomOpening[];
  onUpdate: (updates: Partial<Room>) => Promise<void>;
  onDelete: () => void;
  onClose: () => void;
  onAddOpening: (type: RoomOpening["type"]) => void;
  onUpdateOpening: (id: string, updates: Partial<RoomOpening>) => Promise<void>;
  onDeleteOpening: (openingId: string) => void;
}

const CHECKBOX_LABELS: Record<string, string> = {
  remove_base: "Remove Base",
  flood_cut: "Flood Cut",
  clean: "Clean",
  disinfect: "Disinfect",
  seal: "Seal",
  dry: "Dry",
  rebuild: "Rebuild",
};

const ROOM_COLORS = [
  "#1e3a5f", "#1e4a3f", "#3a1e5f", "#5f1e3a",
  "#1e3a2f", "#3a2a1e", "#1e2a5f", "#4a3a1e",
];

export default function RoomDetailPanel({
  room, openings, onUpdate, onDelete, onClose, onAddOpening, onUpdateOpening, onDeleteOpening,
}: Props) {
  const [showRestoration, setShowRestoration] = useState(true);
  const [name, setName] = useState(room.name);
  const [height, setHeight] = useState(String(room.height ?? 8));
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const roomOpenings = openings.filter((o) => o.room_id === room.id);

  const save = async (updates: Partial<Room>) => {
    setSaving(true);
    await onUpdate(updates);
    setSaving(false);
  };

  const handleNameBlur = () => {
    if (name.trim() && name !== room.name) save({ name: name.trim() });
  };

  const handleHeightBlur = () => {
    const h = parseFloat(height);
    if (!isNaN(h) && h > 0 && h !== room.height) save({ height: h });
    else setHeight(String(room.height ?? 8));
  };

  const toggleFlag = (key: string) => {
    const flags = { ...(room.checkbox_flags ?? {}) } as Record<string, boolean>;
    flags[key] = !flags[key];
    save({ checkbox_flags: flags });
  };

  const netWallArea = (() => {
    if (!room.wall_area) return null;
    let openingArea = 0;
    for (const o of roomOpenings) openingArea += o.width * o.height;
    return Math.max(0, room.wall_area - openingArea);
  })();

  return (
    <div className="w-72 bg-[#0C0800] border-l border-[#2C1E00] flex flex-col overflow-hidden shrink-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[#2C1E00]">
        <input
          className="flex-1 bg-transparent text-sm font-bold text-slate-200 border-b border-transparent hover:border-[#2C1E00] focus:border-[#C9A84C] outline-none"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={handleNameBlur}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        />
        <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Stats */}
        <div className="px-3 py-3 border-b border-[#2C1E00] space-y-1.5">
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Measurements</p>
          <Row label="Floor Area" value={room.floor_area != null ? formatSqFt(room.floor_area) : "—"} />
          <Row label="Ceiling Area" value={room.ceiling_area != null ? formatSqFt(room.ceiling_area) : "—"} />
          <Row label="Perimeter" value={room.perimeter != null ? formatLinearFt(room.perimeter) : "—"} />
          <Row label="Gross Wall Area" value={room.wall_area != null ? formatSqFt(room.wall_area) : "—"} />
          {netWallArea != null && (
            <Row label="Net Wall Area" value={formatSqFt(netWallArea)} highlight />
          )}

          {/* Wall height */}
          <div className="flex items-center justify-between mt-2">
            <span className="text-xs text-slate-500">Wall Height</span>
            <div className="flex items-center gap-1">
              <input
                className="w-14 bg-[#080500] border border-[#2C1E00] rounded px-1.5 py-0.5 text-xs text-slate-200 text-right focus:border-[#C9A84C] outline-none"
                value={height}
                onChange={(e) => setHeight(e.target.value)}
                onBlur={handleHeightBlur}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              />
              <span className="text-xs text-slate-500">ft</span>
            </div>
          </div>
        </div>

        {/* Color picker */}
        <div className="px-3 py-2.5 border-b border-[#2C1E00]">
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Room Color</p>
          <div className="flex gap-1.5 flex-wrap">
            {ROOM_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => save({ color: c })}
                className={clsx(
                  "w-6 h-6 rounded border-2 transition-all",
                  room.color === c ? "border-[#C9A84C] scale-110" : "border-transparent hover:border-slate-400"
                )}
                style={{ background: c }}
              />
            ))}
          </div>
        </div>

        {/* Openings */}
        <div className="px-3 py-2.5 border-b border-[#2C1E00]">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">
              Openings {roomOpenings.length > 0 && `(${roomOpenings.length})`}
            </p>
            <div className="flex gap-1">
              {(["door", "window", "opening"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => onAddOpening(t)}
                  className="text-xs px-1.5 py-0.5 rounded bg-[#2C1E00] text-slate-400 hover:text-slate-200 capitalize"
                >
                  +{t[0]}
                </button>
              ))}
            </div>
          </div>
          {roomOpenings.length === 0 ? (
            <p className="text-xs text-slate-600">No openings. Use +d/+w/+o to add, or drag the toolbar icons onto a wall.</p>
          ) : (
            <div className="space-y-1">
              {roomOpenings.map((o) => (
                <OpeningRow
                  key={o.id}
                  opening={o}
                  onUpdate={onUpdateOpening}
                  onDelete={onDeleteOpening}
                />
              ))}
            </div>
          )}
        </div>

        {/* Restoration metadata */}
        <div className="border-b border-[#2C1E00]">
          <button
            className="w-full flex items-center justify-between px-3 py-2.5 text-xs font-bold text-slate-500 uppercase tracking-wider hover:text-slate-300"
            onClick={() => setShowRestoration((v) => !v)}
          >
            Restoration
            {showRestoration ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
          {showRestoration && (
            <div className="px-3 pb-3 space-y-2">
              <Select
                label="Category of Water"
                value={room.category_of_water ?? ""}
                onChange={(v) => save({ category_of_water: v as Room["category_of_water"] || null })}
                options={[
                  { value: "", label: "—" },
                  { value: "cat1", label: "Cat 1 — Clean" },
                  { value: "cat2", label: "Cat 2 — Gray" },
                  { value: "cat3", label: "Cat 3 — Black" },
                ]}
              />
              <Select
                label="Class of Loss"
                value={room.class_of_loss ?? ""}
                onChange={(v) => save({ class_of_loss: v as Room["class_of_loss"] || null })}
                options={[
                  { value: "", label: "—" },
                  { value: "class1", label: "Class 1" },
                  { value: "class2", label: "Class 2" },
                  { value: "class3", label: "Class 3" },
                  { value: "class4", label: "Class 4" },
                ]}
              />
              <Select
                label="Demo Status"
                value={room.demo_status ?? "none"}
                onChange={(v) => save({ demo_status: v as Room["demo_status"] })}
                options={[
                  { value: "none", label: "None" },
                  { value: "partial", label: "Partial" },
                  { value: "complete", label: "Complete" },
                ]}
              />
              <Select
                label="Drying Status"
                value={room.drying_status ?? "not_started"}
                onChange={(v) => save({ drying_status: v as Room["drying_status"] })}
                options={[
                  { value: "not_started", label: "Not Started" },
                  { value: "in_progress", label: "In Progress" },
                  { value: "complete", label: "Complete" },
                ]}
              />

              <div>
                <p className="text-xs text-slate-500 mb-1">Notes</p>
                <textarea
                  className="w-full bg-[#080500] border border-[#2C1E00] rounded px-2 py-1.5 text-xs text-slate-200 resize-none focus:border-[#C9A84C] outline-none"
                  rows={3}
                  placeholder="Containment, scope notes…"
                  defaultValue={room.room_notes ?? ""}
                  onBlur={(e) => {
                    if (e.target.value !== (room.room_notes ?? "")) save({ room_notes: e.target.value || null });
                  }}
                />
              </div>

              <div>
                <p className="text-xs text-slate-500 mb-1.5">Work Items</p>
                <div className="grid grid-cols-2 gap-x-2 gap-y-1">
                  {Object.entries(CHECKBOX_LABELS).map(([key, label]) => (
                    <label key={key} className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        className="accent-[#C9A84C] w-3 h-3"
                        checked={!!((room.checkbox_flags ?? {}) as Record<string, boolean>)[key]}
                        onChange={() => toggleFlag(key)}
                      />
                      <span className="text-xs text-slate-400">{label}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Delete */}
      <div className="px-3 py-2.5 border-t border-[#2C1E00] shrink-0">
        {saving && <p className="text-xs text-slate-500 mb-1 text-center">Saving…</p>}
        {confirmDelete ? (
          <div className="flex gap-2">
            <button
              onClick={() => { onDelete(); setConfirmDelete(false); }}
              className="flex-1 h-8 rounded-lg bg-red-500/20 border border-red-500/40 text-red-400 text-xs font-bold"
            >
              Delete Room
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="flex-1 h-8 rounded-lg bg-[#2C1E00] text-slate-400 text-xs"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            className="flex items-center gap-1.5 text-xs text-red-400/70 hover:text-red-400 transition-colors"
          >
            <Trash2 size={12} /> Delete room
          </button>
        )}
      </div>
    </div>
  );
}

// ── Opening row with inline dimension editing ─────────────────────────────────

function OpeningRow({
  opening, onUpdate, onDelete,
}: {
  opening: RoomOpening;
  onUpdate: (id: string, updates: Partial<RoomOpening>) => Promise<void>;
  onDelete: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [width, setWidth] = useState(formatFeet(opening.width));
  const [height, setHeight] = useState(String(opening.height));

  const dot = opening.type === "door" ? "bg-orange-500"
    : opening.type === "window" ? "bg-sky-400"
    : "bg-violet-400";

  const commitWidth = () => {
    const parsed = parseFeetInches(width);
    if (parsed !== null && parsed > 0.1) {
      onUpdate(opening.id, { width: parsed });
    } else {
      setWidth(formatFeet(opening.width));
    }
  };

  const commitHeight = () => {
    const h = parseFloat(height);
    if (!isNaN(h) && h > 0) {
      onUpdate(opening.id, { height: h });
    } else {
      setHeight(String(opening.height));
    }
  };

  return (
    <div className="border border-[#2C1E00] rounded-md overflow-hidden">
      {/* Row header */}
      <div
        className="flex items-center gap-1.5 px-2 py-1 cursor-pointer hover:bg-[#2C1E00]/30"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
        <span className="flex-1 text-xs capitalize text-slate-400">{opening.type}</span>
        <span className="text-xs text-slate-500 font-mono">
          {formatFeet(opening.width)} × {formatFeet(opening.height)}
        </span>
        <button
          className="text-slate-600 hover:text-red-400 ml-1 p-0.5"
          onClick={(e) => { e.stopPropagation(); onDelete(opening.id); }}
        >
          <X size={11} />
        </button>
      </div>

      {/* Expanded edit */}
      {expanded && (
        <div className="px-2 pb-2 grid grid-cols-2 gap-x-2 gap-y-1 border-t border-[#2C1E00]">
          <div>
            <p className="text-xs text-slate-600 mt-1 mb-0.5">Width</p>
            <input
              className="w-full text-xs bg-[#080500] border border-[#2C1E00] rounded px-1.5 py-0.5 text-slate-200 focus:border-[#C9A84C] outline-none font-mono"
              value={width}
              onChange={(e) => setWidth(e.target.value)}
              onBlur={commitWidth}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              placeholder={`e.g. 3' 0"`}
            />
          </div>
          <div>
            <p className="text-xs text-slate-600 mt-1 mb-0.5">Height (ft)</p>
            <input
              className="w-full text-xs bg-[#080500] border border-[#2C1E00] rounded px-1.5 py-0.5 text-slate-200 focus:border-[#C9A84C] outline-none font-mono"
              value={height}
              onChange={(e) => setHeight(e.target.value)}
              onBlur={commitHeight}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              placeholder="e.g. 6.8"
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Helper components ─────────────────────────────────────────────────────────

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-xs text-slate-500">{label}</span>
      <span className={clsx("text-xs font-mono font-bold", highlight ? "text-[#C9A84C]" : "text-slate-300")}>
        {value}
      </span>
    </div>
  );
}

function Select({
  label, value, onChange, options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div>
      <p className="text-xs text-slate-500 mb-0.5">{label}</p>
      <select
        className="w-full bg-[#080500] border border-[#2C1E00] rounded px-2 py-1 text-xs text-slate-200 focus:border-[#C9A84C] outline-none"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

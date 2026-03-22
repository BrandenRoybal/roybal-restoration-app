/**
 * EditorToolbar — top bar of the floor plan editor.
 * Tool selection, zoom controls, snap toggle, plan name.
 */

import { MousePointer2, Square, Pentagon, Hand, Grid3x3, ZoomIn, ZoomOut, RotateCcw, Undo2 } from "lucide-react";
import clsx from "clsx";

export type EditorTool = "select" | "rect" | "polygon" | "pan";

interface Props {
  tool: EditorTool;
  onToolChange: (t: EditorTool) => void;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetView: () => void;
  snapEnabled: boolean;
  onToggleSnap: () => void;
  canUndo: boolean;
  onUndo: () => void;
  planName: string;
  onRenamePlan: (name: string) => void;
}

const TOOLS: { id: EditorTool; Icon: React.FC<{ size?: number }>; label: string; shortcut: string }[] = [
  { id: "select", Icon: MousePointer2, label: "Select", shortcut: "V" },
  { id: "rect",   Icon: Square,        label: "Rectangle Room", shortcut: "R" },
  { id: "polygon",Icon: Pentagon,      label: "Polygon Room", shortcut: "P" },
  { id: "pan",    Icon: Hand,          label: "Pan", shortcut: "H" },
];

export default function EditorToolbar({
  tool, onToolChange,
  zoom, onZoomIn, onZoomOut, onResetView,
  snapEnabled, onToggleSnap,
  canUndo, onUndo,
  planName, onRenamePlan,
}: Props) {
  return (
    <div className="flex items-center gap-2 px-3 h-12 bg-[#0C0800] border-b border-[#2C1E00] shrink-0 overflow-x-auto">
      {/* Plan name — inline edit */}
      <input
        className="bg-transparent text-sm font-bold text-slate-200 w-40 truncate border-b border-transparent hover:border-[#2C1E00] focus:border-[#C9A84C] outline-none pr-1"
        value={planName}
        onChange={(e) => onRenamePlan(e.target.value)}
        onBlur={(e) => onRenamePlan(e.target.value.trim() || "Floor Plan")}
        title="Click to rename plan"
      />

      <div className="w-px h-6 bg-[#2C1E00] mx-1 shrink-0" />

      {/* Drawing tools */}
      <div className="flex items-center gap-0.5">
        {TOOLS.map(({ id, Icon, label, shortcut }) => (
          <button
            key={id}
            onClick={() => onToolChange(id)}
            title={`${label} (${shortcut})`}
            className={clsx(
              "flex items-center justify-center w-8 h-8 rounded-lg transition-colors",
              tool === id
                ? "bg-[#C9A84C]/20 text-[#C9A84C] border border-[#C9A84C]/40"
                : "text-slate-400 hover:text-slate-200 hover:bg-[#2C1E00]"
            )}
          >
            <Icon size={15} />
          </button>
        ))}
      </div>

      <div className="w-px h-6 bg-[#2C1E00] mx-1 shrink-0" />

      {/* Snap toggle */}
      <button
        onClick={onToggleSnap}
        title={`Snap to grid (${snapEnabled ? "on" : "off"})`}
        className={clsx(
          "flex items-center gap-1.5 px-2 h-7 rounded-lg text-xs font-bold transition-colors",
          snapEnabled
            ? "bg-[#C9A84C]/20 text-[#C9A84C] border border-[#C9A84C]/40"
            : "text-slate-400 hover:text-slate-200 hover:bg-[#2C1E00]"
        )}
      >
        <Grid3x3 size={13} />
        Snap
      </button>

      <div className="w-px h-6 bg-[#2C1E00] mx-1 shrink-0" />

      {/* Undo */}
      <button
        onClick={onUndo}
        disabled={!canUndo}
        title="Undo last action (Ctrl+Z)"
        className="flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-[#2C1E00] disabled:opacity-30 transition-colors"
      >
        <Undo2 size={15} />
      </button>

      <div className="w-px h-6 bg-[#2C1E00] mx-1 shrink-0" />

      {/* Zoom controls */}
      <div className="flex items-center gap-0.5">
        <button
          onClick={onZoomOut}
          title="Zoom out"
          className="flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-[#2C1E00] transition-colors"
        >
          <ZoomOut size={15} />
        </button>
        <span
          className="text-xs text-slate-400 w-10 text-center cursor-pointer hover:text-slate-200"
          onClick={onResetView}
          title="Reset view (double-click)"
        >
          {Math.round(zoom * 100)}%
        </span>
        <button
          onClick={onZoomIn}
          title="Zoom in"
          className="flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-[#2C1E00] transition-colors"
        >
          <ZoomIn size={15} />
        </button>
        <button
          onClick={onResetView}
          title="Reset zoom and pan"
          className="flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-[#2C1E00] transition-colors"
        >
          <RotateCcw size={13} />
        </button>
      </div>

      {/* Keyboard shortcuts hint */}
      <div className="ml-auto shrink-0 text-xs text-slate-600 hidden lg:block">
        V=Select · R=Rect · P=Polygon · H=Pan · Esc=Cancel · Ctrl+Z=Undo
      </div>
    </div>
  );
}

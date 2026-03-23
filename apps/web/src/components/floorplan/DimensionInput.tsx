import React, { useState, useEffect, useRef } from 'react';
import { parseFeetInches, formatFeetInches } from './dimensions';

interface Props {
  label: string;
  currentFeet: number;
  onSave: (feet: number) => void;
  onCancel: () => void;
  minFt?: number;
  maxFt?: number;
}

export default function DimensionInput({ label, currentFeet, onSave, onCancel, minFt = 0.1, maxFt = 200 }: Props) {
  const [value, setValue] = useState(formatFeetInches(currentFeet));
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') onCancel();
  };

  const commit = () => {
    const parsed = parseFeetInches(value);
    if (parsed === null) {
      setError('Enter a valid dimension like 12\'6" or 12.5');
      return;
    }
    if (parsed < minFt) {
      setError(`Minimum is ${formatFeetInches(minFt)}`);
      return;
    }
    if (parsed > maxFt) {
      setError(`Maximum is ${formatFeetInches(maxFt)}`);
      return;
    }
    setError(null);
    onSave(parsed);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="bg-[#0A1628] border border-[#1E293B] rounded-2xl p-6 w-80 shadow-2xl">
        <h3 className="text-sm font-bold text-slate-300 mb-1">{label}</h3>
        <p className="text-xs text-slate-600 mb-4">Enter feet/inches e.g. 12'6" or 12.5</p>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(null); }}
          onKeyDown={handleKeyDown}
          className="w-full bg-[#0F172A] border border-[#1E293B] rounded-xl px-4 h-11 text-base text-slate-200 font-mono focus:outline-none focus:border-[#F97316] transition-colors"
          placeholder="e.g. 12'6&quot;"
        />
        {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
        <div className="flex gap-3 mt-5">
          <button
            onClick={commit}
            className="flex-1 bg-[#F97316] hover:bg-[#EA6C0C] text-[#0F172A] font-bold text-sm h-10 rounded-xl transition-colors"
          >
            Apply
          </button>
          <button
            onClick={onCancel}
            className="flex-1 bg-[#1E293B] hover:bg-[#293548] text-slate-300 font-bold text-sm h-10 rounded-xl transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

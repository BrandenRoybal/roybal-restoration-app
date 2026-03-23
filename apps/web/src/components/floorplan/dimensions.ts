/**
 * Feet/inches dimension utilities.
 * Internal storage: decimal feet (number).
 * Display: imperial (e.g. 12' 6")
 */

/** Parse user input to decimal feet.
 * Accepts: "12", "12.5", "12'6\"", "12' 6\"", "12'6", "6\"", "0.5"
 */
export function parseFeetInches(input: string): number | null {
  const s = input.trim().replace(/\s+/g, ' ');
  if (!s) return null;

  // Pattern: 12'6" or 12' 6" or 12'6 or 12'
  const feetInches = s.match(/^(\d+(?:\.\d+)?)'(?:\s*(\d+(?:\.\d+)?)"?)?$/);
  if (feetInches) {
    const feet = parseFloat(feetInches[1] ?? '0');
    const inches = feetInches[2] ? parseFloat(feetInches[2]) : 0;
    return feet + inches / 12;
  }

  // Pattern: 6" (inches only)
  const inchOnly = s.match(/^(\d+(?:\.\d+)?)"$/);
  if (inchOnly) {
    return parseFloat(inchOnly[1] ?? '0') / 12;
  }

  // Plain decimal or integer (feet)
  const plain = s.match(/^(\d+(?:\.\d+)?)$/);
  if (plain) {
    return parseFloat(plain[1] ?? '0');
  }

  return null;
}

/** Format decimal feet to display string: "12' 6\"" */
export function formatFeetInches(feet: number): string {
  if (feet < 0) feet = 0;
  const totalInches = Math.round(feet * 12);
  const ft = Math.floor(totalInches / 12);
  const ins = totalInches % 12;
  if (ins === 0) return `${ft}'`;
  return `${ft}' ${ins}"`;
}

/** Short label for dimension on plan: "12'6\"" (no space) */
export function formatDimensionLabel(feet: number): string {
  if (feet < 0) feet = 0;
  const totalInches = Math.round(feet * 12);
  const ft = Math.floor(totalInches / 12);
  const ins = totalInches % 12;
  if (ins === 0) return `${ft}'`;
  return `${ft}'${ins}"`;
}

/** Round to nearest 1/12 ft (1 inch) */
export function roundToInch(feet: number): number {
  return Math.round(feet * 12) / 12;
}

/** Convert sq ft to display string */
export function formatSqFt(sqFt: number): string {
  return `${sqFt.toFixed(1)} sq ft`;
}

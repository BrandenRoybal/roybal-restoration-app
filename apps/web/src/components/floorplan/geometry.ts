import type { FPPoint, FPRoom, FPOpening, FPRoomCalculations } from '@roybal/shared';

// ── Distance & vector helpers ────────────────────────────────

export function dist(a: FPPoint, b: FPPoint): number {
  return Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
}

export function vecLen(p: FPPoint): number {
  return Math.sqrt(p.x ** 2 + p.y ** 2);
}

export function normalize(p: FPPoint): FPPoint {
  const len = vecLen(p);
  if (len === 0) return { x: 0, y: 0 };
  return { x: p.x / len, y: p.y / len };
}

export function lerp(a: FPPoint, b: FPPoint, t: number): FPPoint {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

// ── Wall segment helpers ─────────────────────────────────────

/** Return the two endpoints of wall[i] for a room polygon */
export function wallEndpoints(room: FPRoom, wallIndex: number): [FPPoint, FPPoint] {
  const pts = room.points;
  const a = pts[wallIndex] ?? { x: 0, y: 0 };
  const b = pts[(wallIndex + 1) % pts.length] ?? { x: 0, y: 0 };
  return [a, b];
}

/** Length of wall[i] in feet */
export function wallLength(room: FPRoom, wallIndex: number): number {
  const [a, b] = wallEndpoints(room, wallIndex);
  return dist(a, b);
}

/** Project a point onto a line segment, returning clamped t in [0,1] and closest point */
export function projectOntoSegment(p: FPPoint, a: FPPoint, b: FPPoint): { t: number; point: FPPoint } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { t: 0, point: a };
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return { t, point: { x: a.x + t * dx, y: a.y + t * dy } };
}

/** Snap a point to grid in feet */
export function snapToGrid(p: FPPoint, gridFt: number): FPPoint {
  return {
    x: Math.round(p.x / gridFt) * gridFt,
    y: Math.round(p.y / gridFt) * gridFt,
  };
}

/** Constrain angle to nearest 45° increment */
export function snapToAngle(anchor: FPPoint, p: FPPoint, angleDeg = 45): FPPoint {
  const dx = p.x - anchor.x;
  const dy = p.y - anchor.y;
  const angle = Math.atan2(dy, dx);
  const step = (angleDeg * Math.PI) / 180;
  const snapped = Math.round(angle / step) * step;
  const len = Math.sqrt(dx * dx + dy * dy);
  return { x: anchor.x + len * Math.cos(snapped), y: anchor.y + len * Math.sin(snapped) };
}

// ── Polygon helpers ──────────────────────────────────────────

/** Shoelace formula — returns area in ft² */
export function polygonArea(pts: FPPoint[]): number {
  if (pts.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    const pi = pts[i]!;
    const pj = pts[j]!;
    area += pi.x * pj.y;
    area -= pj.x * pi.y;
  }
  return Math.abs(area) / 2;
}

/** Perimeter in feet */
export function polygonPerimeter(pts: FPPoint[]): number {
  if (pts.length < 2) return 0;
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    p += dist(pts[i]!, pts[(i + 1) % pts.length]!);
  }
  return p;
}

/** Centroid of polygon */
export function polygonCentroid(pts: FPPoint[]): FPPoint {
  if (pts.length === 0) return { x: 0, y: 0 };
  let x = 0, y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
}

/** Is a polygon valid (≥3 non-collinear points, no self-intersections for convex check) */
export function isValidPolygon(pts: FPPoint[]): boolean {
  if (pts.length < 3) return false;
  // Check non-zero area
  return polygonArea(pts) > 0.01;
}

/** Move a single vertex and return new points array */
export function moveVertex(pts: FPPoint[], index: number, newPos: FPPoint): FPPoint[] {
  return pts.map((p, i) => (i === index ? newPos : p));
}

/**
 * Move a wall (edge index) inward/outward by delta perpendicular to it.
 * Moves both endpoints by the perpendicular delta while preserving connected walls.
 */
export function moveWall(pts: FPPoint[], wallIndex: number, delta: FPPoint): FPPoint[] {
  const n = pts.length;
  const iA = wallIndex;
  const iB = (wallIndex + 1) % n;
  return pts.map((p, i) => {
    if (i === iA || i === iB) {
      return { x: p.x + delta.x, y: p.y + delta.y };
    }
    return p;
  });
}

/** Midpoint of wall edge */
export function wallMidpoint(room: FPRoom, wallIndex: number): FPPoint {
  const [a, b] = wallEndpoints(room, wallIndex);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Inward-facing unit normal of a wall (assumes CCW polygon orientation) */
export function wallNormal(room: FPRoom, wallIndex: number): FPPoint {
  const [a, b] = wallEndpoints(room, wallIndex);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return { x: 0, y: -1 };
  // Rotate 90° CW to get inward normal for CCW polygon
  return { x: dy / len, y: -dx / len };
}

/** World-space position of an opening's center on a wall */
export function openingCenterPoint(room: FPRoom, opening: FPOpening): FPPoint {
  const [a, b] = wallEndpoints(room, opening.wall_index);
  const wLen = dist(a, b);
  if (wLen === 0) return a;
  const t = (opening.offset_from_start + opening.width / 2) / wLen;
  return lerp(a, b, Math.max(0, Math.min(1, t)));
}

/** Opening start and end points along wall */
export function openingEndpoints(room: FPRoom, opening: FPOpening): [FPPoint, FPPoint] {
  const [a, b] = wallEndpoints(room, opening.wall_index);
  const wLen = dist(a, b);
  if (wLen === 0) return [a, b];
  const t0 = opening.offset_from_start / wLen;
  const t1 = (opening.offset_from_start + opening.width) / wLen;
  return [lerp(a, b, Math.max(0, t0)), lerp(a, b, Math.min(1, t1))];
}

// ── Room calculations ────────────────────────────────────────

export function computeRoomCalcs(room: FPRoom, openings: FPOpening[]): FPRoomCalculations {
  const pts = room.points;
  const wallLengths = pts.map((_, i) => dist(pts[i]!, pts[(i + 1) % pts.length]!));
  const perimeter = wallLengths.reduce((s, l) => s + l, 0);
  const grossWallArea = perimeter * room.height;
  const openingArea = openings
    .filter((o) => o.room_id === room.id)
    .reduce((s, o) => s + o.width * o.height, 0);
  return {
    floor_area: polygonArea(pts),
    perimeter,
    gross_wall_area: grossWallArea,
    net_wall_area: Math.max(0, grossWallArea - openingArea),
    wall_lengths: wallLengths,
  };
}

// ── Hit testing ──────────────────────────────────────────────

const VERTEX_HIT_FT = 0.4;  // feet radius for vertex click
const WALL_HIT_FT = 0.25;   // feet tolerance for wall click

export function hitTestVertex(pts: FPPoint[], p: FPPoint): number {
  for (let i = 0; i < pts.length; i++) {
    if (dist(pts[i]!, p) <= VERTEX_HIT_FT) return i;
  }
  return -1;
}

export function hitTestWall(room: FPRoom, p: FPPoint): number {
  for (let i = 0; i < room.points.length; i++) {
    const [a, b] = wallEndpoints(room, i);
    const { point } = projectOntoSegment(p, a, b);
    if (dist(p, point) <= WALL_HIT_FT) return i;
  }
  return -1;
}

export function hitTestRoom(rooms: FPRoom[], p: FPPoint): FPRoom | null {
  // Point-in-polygon using ray casting
  for (const room of rooms) {
    if (pointInPolygon(p, room.points)) return room;
  }
  return null;
}

function pointInPolygon(p: FPPoint, pts: FPPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i]!.x, yi = pts[i]!.y;
    const xj = pts[j]!.x, yj = pts[j]!.y;
    const intersect = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// ── Coordinate conversion ────────────────────────────────────

export function worldToScreen(p: FPPoint, scale: number, pan: FPPoint): { x: number; y: number } {
  return { x: p.x * scale + pan.x, y: p.y * scale + pan.y };
}

export function screenToWorld(p: { x: number; y: number }, scale: number, pan: FPPoint): FPPoint {
  return { x: (p.x - pan.x) / scale, y: (p.y - pan.y) / scale };
}

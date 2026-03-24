/**
 * Floor plan geometry utilities.
 * All coordinates are in feet unless otherwise noted.
 * SVG pixel positions = feet × PIXELS_PER_FOOT (before zoom transform).
 */

import type { Point } from "@roybal/shared";

/** Base scale: 1 foot = this many SVG pixels (before zoom) */
export const PIXELS_PER_FOOT = 20;

/** Default colors for newly created rooms, cycled in order */
export const ROOM_COLORS = [
  "#1e3a5f",
  "#1e4a3f",
  "#3a1e5f",
  "#5f1e3a",
  "#1e3a2f",
  "#3a2a1e",
  "#1e2a5f",
  "#3a1e2f",
  "#1e4a5a",
  "#4a3a1e",
];

// ── Shoelace formula ──────────────────────────────────────────────────────────

/** Signed area using the shoelace formula. Returns negative for clockwise polygons. */
function signedArea(points: Point[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    const pi = points[i]!;
    const pj = points[j]!;
    area += pi.x * pj.y;
    area -= pj.x * pi.y;
  }
  return area / 2;
}

/** Polygon area in square feet (always positive) */
export function polygonArea(points: Point[]): number {
  if (points.length < 3) return 0;
  return Math.abs(signedArea(points));
}

/** Polygon perimeter in linear feet */
export function polygonPerimeter(points: Point[]): number {
  if (points.length < 2) return 0;
  let perimeter = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    perimeter += distanceBetween(points[i]!, points[j]!);
  }
  return perimeter;
}

/** Centroid of polygon in feet */
export function polygonCentroid(points: Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return { ...points[0]! };
  if (points.length === 2) {
    return { x: (points[0]!.x + points[1]!.x) / 2, y: (points[0]!.y + points[1]!.y) / 2 };
  }

  const area = signedArea(points);
  if (Math.abs(area) < 0.0001) {
    // Degenerate: use simple average
    return {
      x: points.reduce((s, p) => s + p.x, 0) / points.length,
      y: points.reduce((s, p) => s + p.y, 0) / points.length,
    };
  }

  let cx = 0, cy = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    const pi = points[i]!;
    const pj = points[j]!;
    const cross = pi.x * pj.y - pj.x * pi.y;
    cx += (pi.x + pj.x) * cross;
    cy += (pi.y + pj.y) * cross;
  }
  return { x: cx / (6 * area), y: cy / (6 * area) };
}

// ── Computed stats ────────────────────────────────────────────────────────────

export interface RoomStats {
  floor_area: number;
  perimeter: number;
  wall_area: number;
  ceiling_area: number;
  centroid_x: number;
  centroid_y: number;
}

/** Compute all room stats from polygon points and wall height */
export function computeRoomStats(points: Point[], height: number = 8): RoomStats {
  const floor_area = polygonArea(points);
  const perimeter = polygonPerimeter(points);
  const centroid = polygonCentroid(points);
  return {
    floor_area,
    perimeter,
    wall_area: perimeter * height,
    ceiling_area: floor_area,
    centroid_x: centroid.x,
    centroid_y: centroid.y,
  };
}

// ── Coordinate conversion ─────────────────────────────────────────────────────

/**
 * Convert a mouse event position (relative to SVG element) to canvas feet,
 * accounting for current pan and zoom.
 */
export function svgCoordsToFeet(
  svgX: number,
  svgY: number,
  pan: Point,
  zoom: number
): Point {
  return {
    x: (svgX - pan.x) / zoom / PIXELS_PER_FOOT,
    y: (svgY - pan.y) / zoom / PIXELS_PER_FOOT,
  };
}

/** Convert feet to SVG pixel position (before pan/zoom transform) */
export function feetToPixels(feet: number): number {
  return feet * PIXELS_PER_FOOT;
}

/** Get mouse position relative to an SVG element */
export function getMousePosition(
  e: MouseEvent | React.MouseEvent,
  svg: SVGSVGElement
): Point {
  const rect = svg.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

// ── Snap & grid ───────────────────────────────────────────────────────────────

/** Snap a value to the nearest multiple of gridSize */
export function snapToGrid(value: number, gridSize: number): number {
  return Math.round(value / gridSize) * gridSize;
}

/** Snap a Point to the nearest grid intersection */
export function snapPoint(p: Point, gridSize: number, enabled: boolean): Point {
  if (!enabled) return p;
  return { x: snapToGrid(p.x, gridSize), y: snapToGrid(p.y, gridSize) };
}

// ── Distance & proximity ──────────────────────────────────────────────────────

export function distanceBetween(a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Distance in SVG pixels between two canvas-foot points (at current zoom).
 * Used to test if two points are "close enough" for closing a polygon.
 */
export function pixelDistanceBetween(a: Point, b: Point, zoom: number): number {
  return distanceBetween(a, b) * PIXELS_PER_FOOT * zoom;
}

/** True if point p is within closeThresholdPx pixels of target (in screen space) */
export function isNear(p: Point, target: Point, zoom: number, thresholdPx = 14): boolean {
  return pixelDistanceBetween(p, target, zoom) <= thresholdPx;
}

// ── Formatting ────────────────────────────────────────────────────────────────

/** Format feet as feet+inches string: 12.5 → "12' 6"" */
export function formatFeet(feet: number): string {
  const sign = feet < 0 ? "-" : "";
  const abs = Math.abs(feet);
  const wholeFeet = Math.floor(abs);
  const inches = Math.round((abs - wholeFeet) * 12);
  if (inches === 0) return `${sign}${wholeFeet}'`;
  if (inches === 12) return `${sign}${wholeFeet + 1}'`;
  return `${sign}${wholeFeet}' ${inches}"`;
}

/** Format square feet for display */
export function formatSqFt(sqft: number): string {
  return `${sqft.toFixed(1)} sf`;
}

/** Format linear feet for display */
export function formatLinearFt(ft: number): string {
  return `${ft.toFixed(1)} lf`;
}

// ── Rectangle helpers ─────────────────────────────────────────────────────────

/** Create 4 polygon points from two corner points */
export function rectToPoints(a: Point, b: Point): Point[] {
  return [
    { x: a.x, y: a.y },
    { x: b.x, y: a.y },
    { x: b.x, y: b.y },
    { x: a.x, y: b.y },
  ];
}

/** Bounding box of a polygon (in feet) */
export function boundingBox(points: Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

// ── SVG path helpers ──────────────────────────────────────────────────────────

/** Build an SVG points string from polygon points (in feet → pixels) */
export function toSVGPoints(points: Point[]): string {
  return points.map((p) => `${feetToPixels(p.x)},${feetToPixels(p.y)}`).join(" ");
}

/** Build an SVG path "d" string for a closed polygon */
export function toSVGPath(points: Point[]): string {
  if (points.length < 2) return "";
  const parts = points.map(
    (p, i) => `${i === 0 ? "M" : "L"} ${feetToPixels(p.x)} ${feetToPixels(p.y)}`
  );
  return parts.join(" ") + " Z";
}

// ── Wall add / delete ─────────────────────────────────────────────────────────

/**
 * Split wall[wallIndex] into two walls by inserting a new vertex at its midpoint.
 * The new vertex can then be dragged to create a corner.
 */
export function insertVertexOnWall(points: Point[], wallIndex: number): Point[] {
  if (points.length < 3) return points;
  const i = wallIndex;
  const j = (i + 1) % points.length;
  const p = points[i]!;
  const q = points[j]!;
  const mid: Point = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  const result = [...points];
  // Insert after i; if j === 0 (last wall wraps), splice at end is correct
  result.splice(i + 1, 0, mid);
  return result;
}

/**
 * Delete the end vertex of wall[wallIndex], merging it with the next wall.
 * Returns null if the polygon would drop below 3 vertices.
 */
export function deleteWallVertex(points: Point[], wallIndex: number): Point[] | null {
  if (points.length <= 3) return null;
  const j = (wallIndex + 1) % points.length;
  const result = [...points];
  result.splice(j, 1);
  return result;
}

// ── Dimension parsing ─────────────────────────────────────────────────────────

/**
 * Parse a user-entered dimension string to decimal feet.
 * Accepts:
 *   "12"       → 12.0   (feet)
 *   "12.5"     → 12.5   (feet)
 *   "12'"      → 12.0   (feet)
 *   "12' 6\""  → 12.5   (12 feet 6 inches)
 *   "12'6\""   → 12.5
 *   "12' 6"    → 12.5   (common shorthand, apostrophe required)
 *   "6\""      → 0.5    (inches only)
 * Returns null if the string cannot be parsed or is negative.
 */
export function parseFeetInches(input: string): number | null {
  const s = input.trim().replace(/\s+/g, " ");
  if (!s) return null;

  // Inches only: "6\"" → 0.5
  const inchOnly = s.match(/^(\d+(?:\.\d+)?)"$/);
  if (inchOnly) {
    const v = parseFloat(inchOnly[1]!) / 12;
    return v >= 0 ? v : null;
  }

  // Feet + inches (apostrophe required): "12' 6\"" or "12'6\"" or "12' 6"
  const ftIn = s.match(/^(\d+(?:\.\d+?)?)'\s*(\d+(?:\.\d+?)?)"?$/);
  if (ftIn) {
    const v = parseFloat(ftIn[1]!) + parseFloat(ftIn[2]!) / 12;
    return v >= 0 ? v : null;
  }

  // Feet only: "12'" or "12" or "12.5"
  const ftOnly = s.match(/^(\d+(?:\.\d+?)?)'?$/);
  if (ftOnly) {
    const v = parseFloat(ftOnly[1]!);
    return v >= 0 ? v : null;
  }

  return null;
}

// ── Wall geometry helpers ─────────────────────────────────────────────────────

/**
 * Set the length of wall[wallIndex] to newLength by moving its end vertex
 * (index j = wallIndex+1) along the current wall direction.
 * Returns null if the geometry is degenerate or newLength is invalid.
 */
export function setWallLength(
  points: Point[],
  wallIndex: number,
  newLength: number
): Point[] | null {
  if (points.length < 3 || newLength < 0.1) return null;
  const i = wallIndex;
  const j = (i + 1) % points.length;
  const p = points[i]!;
  const q = points[j]!;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.01) return null;
  const result = [...points];
  result[j] = { x: p.x + (dx / len) * newLength, y: p.y + (dy / len) * newLength };
  return result;
}

/**
 * Move wall[wallIndex] perpendicular to itself by `delta` feet.
 * Both vertices on the wall move equally, preserving wall direction and length.
 */
export function moveWallPerp(points: Point[], wallIndex: number, delta: number): Point[] {
  if (points.length < 3) return points;
  const i = wallIndex;
  const j = (i + 1) % points.length;
  const p = points[i]!;
  const q = points[j]!;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.01) return points;
  const perpX = -dy / len;
  const perpY = dx / len;
  const result = [...points];
  result[i] = { x: p.x + perpX * delta, y: p.y + perpY * delta };
  result[j] = { x: q.x + perpX * delta, y: q.y + perpY * delta };
  return result;
}

/** Midpoint of a wall segment */
export function wallMidpoint(p: Point, q: Point): Point {
  return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
}

/**
 * Project a point onto line segment p→q.
 * Returns t (clamped 0–1), closest point on the segment, and distance to it.
 */
export function projectPointOntoSegment(
  point: Point,
  p: Point,
  q: Point
): { t: number; closest: Point; distance: number } {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 0.0001) {
    return { t: 0, closest: { ...p }, distance: distanceBetween(point, p) };
  }
  const t = Math.max(0, Math.min(1, ((point.x - p.x) * dx + (point.y - p.y) * dy) / len2));
  const closest = { x: p.x + t * dx, y: p.y + t * dy };
  return { t, closest, distance: distanceBetween(point, closest) };
}

/**
 * Find the nearest wall of a polygon to a given point (all in feet).
 * Returns { wallIndex, t } if within thresholdPx screen pixels, else null.
 */
export function findNearestWall(
  points: Point[],
  point: Point,
  zoom: number,
  thresholdPx = 12
): { wallIndex: number; t: number } | null {
  let best: { wallIndex: number; t: number; distPx: number } | null = null;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    const { t, distance } = projectPointOntoSegment(point, points[i]!, points[j]!);
    const distPx = distance * PIXELS_PER_FOOT * zoom;
    if (distPx <= thresholdPx && (!best || distPx < best.distPx)) {
      best = { wallIndex: i, t, distPx };
    }
  }
  return best ? { wallIndex: best.wallIndex, t: best.t } : null;
}

// React type import for getMousePosition
import type React from "react";

/**
 * useFloorPlan — data hooks for canvas floor plan feature.
 *
 * useCanvasPlansForJob  — list all canvas plans for a job
 * useCanvasPlan         — load full plan with rooms, openings, markers
 */

import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabase";
import type { CanvasPlan, Room, RoomOpening, RoomMarker, Point } from "@roybal/shared";
import { computeRoomStats } from "../utils/geometry";

// ─────────────────────────────────────────────────────────────────────────────
// Plan list (used in Job Detail Floor Plan tab)
// ─────────────────────────────────────────────────────────────────────────────

export function useCanvasPlansForJob(jobId: string) {
  const [plans, setPlans] = useState<CanvasPlan[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("canvas_plans")
      .select("*")
      .eq("job_id", jobId)
      .order("created_at", { ascending: true });
    setPlans((data ?? []) as CanvasPlan[]);
    setLoading(false);
  }, [jobId]);

  useEffect(() => { load(); }, [load]);

  const createPlan = async (name: string, levelName: string): Promise<CanvasPlan | null> => {
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase
      .from("canvas_plans")
      .insert({ job_id: jobId, name, level_name: levelName, created_by: user?.id })
      .select()
      .single();
    if (error || !data) return null;
    const plan = data as CanvasPlan;
    setPlans((prev) => [...prev, plan]);
    return plan;
  };

  const deletePlan = async (planId: string) => {
    await supabase.from("canvas_plans").delete().eq("id", planId);
    setPlans((prev) => prev.filter((p) => p.id !== planId));
  };

  const updatePlan = async (planId: string, updates: Partial<CanvasPlan>): Promise<void> => {
    const { data } = await supabase
      .from("canvas_plans")
      .update(updates)
      .eq("id", planId)
      .select()
      .single();
    if (data) setPlans((prev) => prev.map((p) => (p.id === planId ? (data as CanvasPlan) : p)));
  };

  return { plans, loading, createPlan, deletePlan, updatePlan, reload: load };
}

// ─────────────────────────────────────────────────────────────────────────────
// Full plan data (used inside the editor)
// ─────────────────────────────────────────────────────────────────────────────

export function useCanvasPlan(planId: string) {
  const [plan, setPlan] = useState<CanvasPlan | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [openings, setOpenings] = useState<RoomOpening[]>([]);
  const [markers, setMarkers] = useState<RoomMarker[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!planId) return;
    (async () => {
      setLoading(true);
      const [planRes, roomsRes, markersRes] = await Promise.all([
        supabase.from("canvas_plans").select("*").eq("id", planId).single(),
        supabase.from("rooms").select("*").eq("canvas_plan_id", planId).order("name"),
        supabase.from("room_markers").select("*").eq("canvas_plan_id", planId),
      ]);

      if (planRes.data) setPlan(planRes.data as CanvasPlan);

      const roomData = (roomsRes.data ?? []) as Room[];
      setRooms(roomData);

      if (roomData.length > 0) {
        const roomIds = roomData.map((r) => r.id);
        const { data: openingData } = await supabase
          .from("room_openings")
          .select("*")
          .in("room_id", roomIds);
        setOpenings((openingData ?? []) as RoomOpening[]);
      }

      setMarkers((markersRes.data ?? []) as RoomMarker[]);
      setLoading(false);
    })();
  }, [planId]);

  // ── Rooms ──

  const createRoom = async (
    jobId: string,
    name: string,
    points: Point[],
    height: number = 8,
    color: string = "#1e3a5f"
  ): Promise<Room | null> => {
    setSaving(true);
    const stats = computeRoomStats(points, height);
    const { data, error } = await supabase
      .from("rooms")
      .insert({
        job_id: jobId,
        canvas_plan_id: planId,
        name,
        floor_level: plan?.level_name ?? "Main",
        affected: true,
        polygon_points: points,
        height,
        color,
        ...stats,
      })
      .select()
      .single();
    setSaving(false);
    if (error || !data) return null;
    const room = data as Room;
    setRooms((prev) => [...prev, room]);
    return room;
  };

  const updateRoom = async (roomId: string, updates: Partial<Room>): Promise<Room | null> => {
    // If polygon_points or height changed, recompute stats
    const existing = rooms.find((r) => r.id === roomId);
    const points = (updates.polygon_points ?? existing?.polygon_points ?? []) as Point[];
    const height = updates.height ?? existing?.height ?? 8;

    let statsUpdates = {};
    if (updates.polygon_points !== undefined || updates.height !== undefined) {
      statsUpdates = computeRoomStats(points, height);
    }

    const { data, error } = await supabase
      .from("rooms")
      .update({ ...updates, ...statsUpdates })
      .eq("id", roomId)
      .select()
      .single();
    if (error || !data) return null;
    const updated = data as Room;
    setRooms((prev) => prev.map((r) => (r.id === roomId ? updated : r)));
    return updated;
  };

  const deleteRoom = async (roomId: string) => {
    await supabase.from("rooms").delete().eq("id", roomId);
    setRooms((prev) => prev.filter((r) => r.id !== roomId));
    setOpenings((prev) => prev.filter((o) => o.room_id !== roomId));
  };

  /** Optimistic local update — call updateRoom separately for persistence */
  const setRoomPointsLocal = (roomId: string, points: Point[]) => {
    setRooms((prev) =>
      prev.map((r) => {
        if (r.id !== roomId) return r;
        const stats = computeRoomStats(points, r.height ?? 8);
        return { ...r, polygon_points: points, ...stats };
      })
    );
  };

  // ── Openings ──

  const createOpening = async (opening: Omit<RoomOpening, "id" | "created_at">): Promise<RoomOpening | null> => {
    const { data, error } = await supabase.from("room_openings").insert(opening).select().single();
    if (error || !data) return null;
    const created = data as RoomOpening;
    setOpenings((prev) => [...prev, created]);
    return created;
  };

  const deleteOpening = async (openingId: string) => {
    await supabase.from("room_openings").delete().eq("id", openingId);
    setOpenings((prev) => prev.filter((o) => o.id !== openingId));
  };

  // ── Markers ──

  const createMarker = async (
    marker: Omit<RoomMarker, "id" | "created_at">
  ): Promise<RoomMarker | null> => {
    const { data, error } = await supabase.from("room_markers").insert(marker).select().single();
    if (error || !data) return null;
    const created = data as RoomMarker;
    setMarkers((prev) => [...prev, created]);
    return created;
  };

  const deleteMarker = async (markerId: string) => {
    await supabase.from("room_markers").delete().eq("id", markerId);
    setMarkers((prev) => prev.filter((m) => m.id !== markerId));
  };

  // ── Plan ──

  const updatePlan = async (updates: Partial<CanvasPlan>) => {
    if (!plan) return;
    const { data } = await supabase
      .from("canvas_plans")
      .update(updates)
      .eq("id", planId)
      .select()
      .single();
    if (data) setPlan(data as CanvasPlan);
  };

  return {
    plan,
    rooms,
    openings,
    markers,
    loading,
    saving,
    // room ops
    createRoom,
    updateRoom,
    deleteRoom,
    setRoomPointsLocal,
    // opening ops
    createOpening,
    deleteOpening,
    // marker ops
    createMarker,
    deleteMarker,
    // plan ops
    updatePlan,
    // local state setters (for optimistic updates)
    setRooms,
    setOpenings,
    setMarkers,
  };
}

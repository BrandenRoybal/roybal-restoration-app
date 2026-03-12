/**
 * Supabase ↔ WatermelonDB sync layer.
 *
 * Uses WatermelonDB's built-in sync protocol with Supabase as the backend.
 * Pull: fetch records updated after last sync timestamp
 * Push: send locally-created/modified/deleted records to Supabase
 *
 * Call `performSync()` when:
 *   - App comes to foreground
 *   - User explicitly pulls to refresh
 *   - After creating a job while online
 */

import { synchronize } from "@nozbe/watermelondb/sync";
import { database } from "./database";
import { supabase } from "../supabase";

const SYNC_TABLES = [
  "jobs",
  "rooms",
  "moisture_readings",
  "equipment_logs",
  "photos",
  "line_items",
] as const;

let isSyncing = false;

/**
 * Main sync function. Safe to call multiple times — debounces concurrent calls.
 */
export async function performSync(): Promise<void> {
  if (isSyncing) {
    console.log("[Sync] Already syncing, skipping.");
    return;
  }

  isSyncing = true;
  console.log("[Sync] Starting sync…");

  try {
    await synchronize({
      database,

      // ── PULL: fetch changes from Supabase ──────────────────────────
      pullChanges: async ({ lastPulledAt }) => {
        const timestamp = lastPulledAt
          ? new Date(lastPulledAt).toISOString()
          : new Date(0).toISOString();

        const changes: Record<string, { created: unknown[]; updated: unknown[]; deleted: string[] }> = {};

        for (const table of SYNC_TABLES) {
          // Pull created/updated
          const { data: updated, error } = await supabase
            .from(table)
            .select("*")
            .gte("updated_at", timestamp);

          if (error) {
            console.warn(`[Sync] Pull error for ${table}:`, error.message);
            changes[table] = { created: [], updated: [], deleted: [] };
            continue;
          }

          // Pull deleted (if you add a soft-delete column, filter here)
          // For now, we don't sync deletions
          changes[table] = {
            created: [],
            updated: (updated ?? []).map(transformPull),
            deleted: [],
          };
        }

        return { changes, timestamp: Date.now() };
      },

      // ── PUSH: send local changes to Supabase ───────────────────────
      pushChanges: async ({ changes }) => {
        for (const table of SYNC_TABLES) {
          const tableChanges = changes[table];
          if (!tableChanges) continue;

          const { created, updated, deleted } = tableChanges;

          // Upsert created + updated records
          const toUpsert = [...created, ...updated].map(transformPush);
          if (toUpsert.length > 0) {
            const { error } = await supabase
              .from(table)
              .upsert(toUpsert, { onConflict: "id" });
            if (error) {
              console.error(`[Sync] Push upsert error for ${table}:`, error.message);
            }
          }

          // Note: We don't push deletes to avoid accidental data loss.
          // Soft-delete via status field instead.
        }
      },

      // Only push one batch at a time for reliability
      pushBatchSize: 50,
    });

    console.log("[Sync] Sync complete.");
  } catch (err) {
    console.error("[Sync] Sync failed:", err);
    throw err;
  } finally {
    isSyncing = false;
  }
}

/**
 * Transform a Supabase row for WatermelonDB consumption.
 * Maps server UUID to `server_id`, converts timestamps.
 */
function transformPull(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    id: row["id"],             // WatermelonDB uses this as the local ID initially
    server_id: row["id"],      // Track the server UUID
    is_pending_sync: false,
    // Convert ISO timestamp strings to milliseconds
    created_at: row["created_at"] ? new Date(row["created_at"] as string).getTime() : Date.now(),
    updated_at: row["updated_at"] ? new Date(row["updated_at"] as string).getTime() : Date.now(),
  };
}

/**
 * Transform a WatermelonDB record for Supabase push.
 * Uses `server_id` as the Supabase UUID if available.
 */
function transformPush(record: Record<string, unknown>): Record<string, unknown> {
  const { is_pending_sync, synced_at, local_uri, is_pending_upload, ...rest } = record;
  return {
    ...rest,
    id: record["server_id"] ?? record["id"],
    // Convert millisecond timestamps back to ISO strings
    created_at: record["created_at"]
      ? new Date(record["created_at"] as number).toISOString()
      : new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

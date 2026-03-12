/**
 * WatermelonDB Schema — Roybal Restoration offline database.
 *
 * Mirrors the Supabase schema for offline-capable field operations.
 * UUIDs are stored as strings. Timestamps as seconds (Unix epoch).
 * Sync state is managed by WatermelonDB's built-in sync protocol.
 */

import { appSchema, tableSchema } from "@nozbe/watermelondb";

export const schema = appSchema({
  version: 1,
  tables: [
    // ── Jobs ──────────────────────────────────────
    tableSchema({
      name: "jobs",
      columns: [
        { name: "server_id", type: "string", isOptional: true },
        { name: "job_number", type: "string", isOptional: true },
        { name: "status", type: "string" },
        { name: "loss_type", type: "string", isOptional: true },
        { name: "loss_category", type: "string", isOptional: true },
        { name: "date_of_loss", type: "string", isOptional: true },
        { name: "property_address", type: "string" },
        { name: "owner_name", type: "string", isOptional: true },
        { name: "owner_phone", type: "string", isOptional: true },
        { name: "owner_email", type: "string", isOptional: true },
        { name: "insurance_carrier", type: "string", isOptional: true },
        { name: "claim_number", type: "string", isOptional: true },
        { name: "adjuster_name", type: "string", isOptional: true },
        { name: "adjuster_phone", type: "string", isOptional: true },
        { name: "adjuster_email", type: "string", isOptional: true },
        { name: "magicplan_project_id", type: "string", isOptional: true },
        { name: "notes", type: "string", isOptional: true },
        { name: "created_by", type: "string", isOptional: true },
        { name: "created_at", type: "number" },
        { name: "updated_at", type: "number" },
        { name: "synced_at", type: "number", isOptional: true },
        { name: "is_pending_sync", type: "boolean" },
      ],
    }),

    // ── Rooms ─────────────────────────────────────
    tableSchema({
      name: "rooms",
      columns: [
        { name: "server_id", type: "string", isOptional: true },
        { name: "job_id", type: "string" },          // WatermelonDB local ID
        { name: "job_server_id", type: "string", isOptional: true }, // Supabase UUID
        { name: "name", type: "string" },
        { name: "floor_level", type: "string" },
        { name: "affected", type: "boolean" },
        { name: "created_at", type: "number" },
        { name: "is_pending_sync", type: "boolean" },
      ],
    }),

    // ── Moisture Readings ──────────────────────────
    tableSchema({
      name: "moisture_readings",
      columns: [
        { name: "server_id", type: "string", isOptional: true },
        { name: "job_id", type: "string" },
        { name: "job_server_id", type: "string", isOptional: true },
        { name: "room_id", type: "string" },
        { name: "room_server_id", type: "string", isOptional: true },
        { name: "reading_date", type: "string" },
        { name: "location_description", type: "string" },
        { name: "material_type", type: "string" },
        { name: "moisture_pct", type: "number" },
        { name: "is_dry", type: "boolean" },
        { name: "recorded_by", type: "string", isOptional: true },
        { name: "created_at", type: "number" },
        { name: "is_pending_sync", type: "boolean" },
      ],
    }),

    // ── Equipment Logs ────────────────────────────
    tableSchema({
      name: "equipment_logs",
      columns: [
        { name: "server_id", type: "string", isOptional: true },
        { name: "job_id", type: "string" },
        { name: "job_server_id", type: "string", isOptional: true },
        { name: "room_id", type: "string", isOptional: true },
        { name: "room_server_id", type: "string", isOptional: true },
        { name: "equipment_type", type: "string" },
        { name: "equipment_name", type: "string" },
        { name: "asset_number", type: "string", isOptional: true },
        { name: "serial_number", type: "string", isOptional: true },
        { name: "date_placed", type: "string" },
        { name: "date_removed", type: "string", isOptional: true },
        { name: "placed_by", type: "string", isOptional: true },
        { name: "created_at", type: "number" },
        { name: "updated_at", type: "number" },
        { name: "is_pending_sync", type: "boolean" },
      ],
    }),

    // ── Photos (metadata only — actual files uploaded when online) ──
    tableSchema({
      name: "photos",
      columns: [
        { name: "server_id", type: "string", isOptional: true },
        { name: "job_id", type: "string" },
        { name: "job_server_id", type: "string", isOptional: true },
        { name: "room_id", type: "string", isOptional: true },
        { name: "room_server_id", type: "string", isOptional: true },
        { name: "local_uri", type: "string", isOptional: true },  // local file path before upload
        { name: "storage_path", type: "string", isOptional: true }, // Supabase path after upload
        { name: "caption", type: "string", isOptional: true },
        { name: "category", type: "string" },
        { name: "taken_at", type: "number" },
        { name: "gps_lat", type: "number", isOptional: true },
        { name: "gps_lng", type: "number", isOptional: true },
        { name: "uploaded_by", type: "string", isOptional: true },
        { name: "created_at", type: "number" },
        { name: "is_pending_upload", type: "boolean" }, // true until file is uploaded
        { name: "is_pending_sync", type: "boolean" },
      ],
    }),

    // ── Line Items ────────────────────────────────
    tableSchema({
      name: "line_items",
      columns: [
        { name: "server_id", type: "string", isOptional: true },
        { name: "job_id", type: "string" },
        { name: "job_server_id", type: "string", isOptional: true },
        { name: "room_id", type: "string", isOptional: true },
        { name: "room_server_id", type: "string", isOptional: true },
        { name: "category", type: "string" },
        { name: "description", type: "string" },
        { name: "quantity", type: "number" },
        { name: "unit", type: "string" },
        { name: "unit_price", type: "number" },
        { name: "notes", type: "string", isOptional: true },
        { name: "billing_type", type: "string" },
        { name: "sort_order", type: "number" },
        { name: "created_at", type: "number" },
        { name: "updated_at", type: "number" },
        { name: "is_pending_sync", type: "boolean" },
      ],
    }),
  ],
});

/**
 * WatermelonDB database initialization.
 * Uses expo-sqlite as the underlying adapter for React Native.
 */

import { Database } from "@nozbe/watermelondb";
import SQLiteAdapter from "@nozbe/watermelondb/adapters/sqlite";
import { schema } from "./schema";
import { migrations } from "./migrations";

const adapter = new SQLiteAdapter({
  schema,
  migrations,
  dbName: "roybal_restoration",
  jsi: true, // Use JSI for better performance (requires Hermes)
  onSetUpError: (error) => {
    console.error("WatermelonDB setup error:", error);
  },
});

export const database = new Database({
  adapter,
  modelClasses: [],  // Models are defined per-table if needed
});

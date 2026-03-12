/**
 * WatermelonDB migrations.
 * Add new migrations here as the schema evolves.
 */

import { schemaMigrations } from "@nozbe/watermelondb/Schema/migrations";

export const migrations = schemaMigrations({
  migrations: [
    // v1 is the initial schema — no migration needed,
    // WatermelonDB creates the DB fresh on first run.
    // Add future migrations here:
    // {
    //   toVersion: 2,
    //   steps: [
    //     addColumns({ table: "jobs", columns: [{ name: "new_field", type: "string", isOptional: true }] }),
    //   ],
    // },
  ],
});

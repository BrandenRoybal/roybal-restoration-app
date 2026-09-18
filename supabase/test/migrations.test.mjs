// Applies the migrations that a plain Postgres can take, then runs the SQL
// assertion files beside this one. This is the first test in the repo that
// touches a database at all.
//
// WHAT IT CANNOT DO, stated up front so nobody mistakes it for the real thing.
// `supabase db reset` — replaying 0000_baseline.sql and every file after it
// against the local Supabase stack — is the actual replay test, and it is a P1
// item (03 §7.3) that needs the Supabase CLI and its docker-compose. The
// baseline is a production dump: it wants pg_net, pg_cron, pgsodium,
// supabase_vault, pg_graphql, the real auth and storage schemas and the
// supabase_admin role, and it will not apply to a stock postgres:16 container.
//
// So this runs harness.sql — a small stand-in for the Supabase-provided pieces,
// default privileges included — and then the migrations listed in MIGRATIONS
// below, which are the ones that depend on nothing outside it. That is enough
// to catch what actually goes wrong in a migration review: a syntax error, a
// column referenced by the wrong name, a policy that reads nothing, a trigger
// that never fires, and — the one this repo is most exposed to — a table left
// writable by anon because ALTER DEFAULT PRIVILEGES already granted it.
//
// A new migration that only needs the harness adds its filename to MIGRATIONS
// and, if it is worth asserting anything about, a `*.test.sql` file beside it.

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');

// Migrations this harness can replay, in order. 0000-0003 are not here:
// 0000 is the production dump, and 0001-0003 rewrite objects it creates
// (contacts, contact_merge_suggestions, cron.job).
const MIGRATIONS = ['0004_backbone_contract_tables.sql'];

const DB_URL = process.env.MIGRATION_TEST_DATABASE_URL || process.env.DATABASE_URL || '';

function havePsql() {
  try {
    execFileSync('psql', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function psql(url, args) {
  return execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', url, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const reason = !DB_URL
  ? 'set DATABASE_URL (or MIGRATION_TEST_DATABASE_URL) to a scratch Postgres to run this'
  : !havePsql()
    ? 'psql is not on PATH'
    : null;

// node:test treats `skip` as set whenever the key is present, so the option
// object is built rather than passed with a null.
const dbTest = reason ? { skip: reason } : {};

test('migrations apply and hold their invariants', dbTest, async (t) => {
  // A scratch database per run, so a previous failure cannot leave state that
  // makes the next run pass.
  const dbName = `migration_test_${process.pid}_${Date.now()}`;
  const adminUrl = DB_URL;
  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${dbName}`;

  psql(adminUrl, ['-c', `create database "${dbName}"`]);

  try {
    await t.test('the Supabase stand-in applies', () => {
      psql(String(testUrl), ['-f', join(here, 'harness.sql')]);
    });

    for (const file of MIGRATIONS) {
      await t.test(`${file} applies`, () => {
        psql(String(testUrl), ['-f', join(migrationsDir, file)]);
      });

      // A migration that cannot be applied twice cannot be replayed, and a
      // replay is exactly what a `supabase db reset` in CI will do.
      await t.test(`${file} is re-runnable`, () => {
        psql(String(testUrl), ['-f', join(migrationsDir, file)]);
      });
    }

    const assertionFiles = readdirSync(here)
      .filter((f) => f.endsWith('.test.sql'))
      .sort();

    for (const file of assertionFiles) {
      await t.test(file, () => {
        psql(String(testUrl), ['-f', join(here, file)]);
      });
    }
  } finally {
    try {
      psql(adminUrl, ['-c', `drop database if exists "${dbName}" with (force)`]);
    } catch {
      // A leaked scratch database in CI is thrown away with the container.
    }
  }
});

test('every migration file is either replayed here or explained', () => {
  const onDisk = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  // 0000-0003 predate this harness and need the real Supabase stack; see the
  // header. Anything newer must be listed in MIGRATIONS, so a migration cannot
  // quietly arrive without a replay.
  const grandfathered = new Set([
    '0000_baseline.sql',
    '0001_contact_value_review.sql',
    '0002_preview_never_beats_photo.sql',
    '0003_cron_http_timeout.sql',
  ]);
  const unaccounted = onDisk.filter((f) => !grandfathered.has(f) && !MIGRATIONS.includes(f));

  if (unaccounted.length) {
    throw new Error(
      `migration(s) with no replay in supabase/test/migrations.test.mjs: ${unaccounted.join(', ')}. ` +
        'Add the filename to MIGRATIONS, or to the grandfathered list with a reason.',
    );
  }
});

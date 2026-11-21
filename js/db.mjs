/**
 * Server-only SQL helper. Uses Postgres when DATABASE_URL is set (Cursor Apps),
 * otherwise in-memory PGlite for local/dev/tests.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @type {import("pg").Pool | undefined} */
let pool;
/** @type {string | undefined} */
let poolUrl;
/** @type {Promise<import("@electric-sql/pglite").PGlite> | undefined} */
let local;

function readDatabaseUrl() {
  return process.env.DATABASE_URL?.trim() ?? "";
}

function isPgliteUrl(url) {
  return url.startsWith("pglite:");
}

/**
 * @template {Record<string, unknown>} [T=Record<string, unknown>]
 * @param {string} text
 * @param {unknown[]} [params]
 * @returns {Promise<T[]>}
 */
export async function sql(text, params = []) {
  const databaseUrl = readDatabaseUrl();
  if (databaseUrl !== "" && !isPgliteUrl(databaseUrl)) {
    const pg = await import("pg");
    if (!pool || poolUrl !== databaseUrl) {
      if (pool) await pool.end().catch(() => {});
      pool = new pg.default.Pool({ connectionString: databaseUrl, max: 5 });
      poolUrl = databaseUrl;
    }
    return /** @type {T[]} */ ((await pool.query(text, params)).rows);
  }

  local ??= startLocal().catch((error) => {
    local = undefined;
    throw error;
  });
  const db = await local;
  const result = await db.query(text, params);
  return /** @type {T[]} */ (result.rows ?? []);
}

export function usingDurableDatabase() {
  return readDatabaseUrl() !== "";
}

export function isPgliteDurableTestMode() {
  return isPgliteUrl(readDatabaseUrl());
}

/** Test helper — drop the PGlite handle so the next call reloads migrations. */
export async function resetLocalDatabase() {
  const databaseUrl = readDatabaseUrl();
  if (databaseUrl && !isPgliteUrl(databaseUrl)) {
    if (pool) {
      await pool.end().catch(() => {});
      pool = undefined;
      poolUrl = undefined;
    }
    return;
  }
  if (local) {
    try {
      const db = await local;
      await db.close?.();
    } catch {
      /* ignore */
    }
  }
  local = undefined;
}

async function startLocal() {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  const dir = join(ROOT, "migrations");
  const files = (await readdir(dir).catch(() => []))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    await db.exec(await readFile(join(dir, file), "utf8"));
  }
  return db;
}
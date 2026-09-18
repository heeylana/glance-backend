import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../config.js";
import * as schema from "./schema.js";

let _sql: ReturnType<typeof postgres> | null = null;
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function db() {
  if (!_db) {
    _sql = postgres(env.DATABASE_URL, { max: 10, prepare: false });
    _db = drizzle(_sql, { schema });
  }
  return _db;
}

export async function closeDb() {
  await _sql?.end({ timeout: 5 });
  _sql = null;
  _db = null;
}

export { schema };

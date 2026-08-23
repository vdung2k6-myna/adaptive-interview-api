import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import config from "./config";

// Parse connection string to work around pg 8.23+ SASL auth issue
const dbUrl = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;

const pool = new Pool({
  host: dbUrl?.hostname || "localhost",
  port: dbUrl ? parseInt(dbUrl.port, 10) || 5432 : 5432,
  database: dbUrl ? dbUrl.pathname.replace(/^\//, "") : undefined,
  user: dbUrl?.username || undefined,
  password: dbUrl?.password || undefined,
  max: config.database.poolSize,
});

export const db = drizzle(pool, { schema });

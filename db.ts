import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

export const pool = new pg.Pool({
  connectionString: url,
  ssl: url.includes("render.com") ? { rejectUnauthorized: false } : undefined,
});

export async function logEvent(
  client: pg.PoolClient | pg.Pool,
  kind: string,
  payload: Record<string, unknown>
): Promise<void> {
  await client.query("insert into events (kind, payload) values ($1, $2)", [kind, payload]);
}

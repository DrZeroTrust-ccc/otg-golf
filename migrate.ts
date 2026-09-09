import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pool } from "./db.js";

// Applies every migrations/*.sql in filename order, once each.
async function main() {
  const dir = path.resolve("migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const client = await pool.connect();
  try {
    // 000 creates schema_migrations itself, so run it unconditionally (it's idempotent).
    await client.query(await readFile(path.join(dir, files[0]), "utf8"));
    for (const f of files) {
      const done = await client.query("select 1 from schema_migrations where filename = $1", [f]);
      if (done.rowCount) { console.log(`skip   ${f}`); continue; }
      await client.query("begin");
      try {
        await client.query(await readFile(path.join(dir, f), "utf8"));
        await client.query("insert into schema_migrations (filename) values ($1)", [f]);
        await client.query("commit");
        console.log(`applied ${f}`);
      } catch (e) {
        await client.query("rollback");
        throw e;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

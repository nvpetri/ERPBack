import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Database } from "../src/database.mjs";
import { config } from "../src/core.mjs";
const db = new Database(config().database),
  client = await db.pool.connect();
try {
  await client.query("SELECT pg_advisory_lock(7482531)");
  await client.query(
    "CREATE TABLE IF NOT EXISTS _erp_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  for (const name of (await readdir("db/migrations"))
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    const sql = await readFile("db/migrations/" + name, "utf8"),
      checksum = createHash("sha256").update(sql).digest("hex");
    const {
      rows: [existing],
    } = await client.query(
      "SELECT checksum FROM _erp_migrations WHERE name=$1",
      [name],
    );
    if (existing) {
      if (existing.checksum !== checksum)
        throw new Error("Migration alterada após aplicação: " + name);
      continue;
    }
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query(
        "INSERT INTO _erp_migrations(name,checksum) VALUES($1,$2)",
        [name, checksum],
      );
      await client.query("COMMIT");
      console.log("Aplicada: " + name);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  }
  console.log("Banco sincronizado.");
} catch (e) {
  console.error(
    "Migration recusada. Código: " +
      (e.code || "CONFIG") +
      ". Confira banco, permissões e histórico.",
  );
  process.exitCode = 1;
} finally {
  await client.query("SELECT pg_advisory_unlock(7482531)").catch(() => {});
  client.release();
  await db.close();
}

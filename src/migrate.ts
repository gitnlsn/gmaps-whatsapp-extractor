import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { withClient, query } from "./db";

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

/**
 * Splits a migration into individual statements.
 *
 * Postgres' simple query protocol parses an entire multi-statement string
 * before executing any of it, so a CREATE FUNCTION whose body references a
 * function created earlier in the same string fails at parse time. Sending one
 * statement at a time avoids that. The splitter is dollar-quote aware because
 * function bodies contain semicolons.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;

  while (i < sql.length) {
    const rest = sql.slice(i);

    // Line comment
    if (rest.startsWith("--")) {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // Block comment
    if (rest.startsWith("/*")) {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // Single-quoted string
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      current += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    // Dollar-quoted block: $tag$ ... $tag$
    const dollar = rest.match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end === -1 ? sql.length : end + tag.length;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }

    if (sql[i] === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
      i++;
      continue;
    }

    current += sql[i];
    i++;
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}

export async function migrate(): Promise<void> {
  await withClient(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const applied = new Set(
      (await client.query<{ name: string }>("SELECT name FROM _migrations")).rows.map(
        (r) => r.name
      )
    );

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) continue;

      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf-8");
      const statements = splitStatements(sql);
      console.log(`Applying ${file} (${statements.length} statements)...`);

      // Each migration is its own transaction: a failure leaves the previous
      // ones applied and recorded, so a re-run resumes rather than restarting.
      await client.query("BEGIN");
      try {
        for (const [idx, stmt] of statements.entries()) {
          try {
            await client.query(stmt);
          } catch (err) {
            // Point at the exact statement rather than the whole file.
            const head = stmt.replace(/^--[^\n]*\n/gm, "").trim().split("\n")[0];
            throw new Error(
              `statement ${idx + 1}/${statements.length} (${head.slice(0, 90)}): ` +
                (err as Error).message
            );
          }
        }
        await client.query("INSERT INTO _migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        ran++;
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }

    if (ran === 0) {
      console.log(`Database up to date (${files.length} migration(s) already applied).`);
    } else {
      console.log(`Applied ${ran} migration(s).`);
    }
  });

  const [{ count }] = await query<{ count: string }>(
    "SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = 'public'"
  );
  console.log(`Public schema now has ${count} tables.`);
}

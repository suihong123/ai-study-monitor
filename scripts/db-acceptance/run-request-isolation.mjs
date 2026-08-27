import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const runtimeDir =
  process.env.V09_PG_RUNTIME_DIR ?? "/private/tmp/codex-v09-pg-runtime";
const dataDir =
  process.env.V09_REQUEST_ISOLATION_PG_DATA_DIR ??
  `/private/tmp/codex-v09-request-isolation-${process.pid}`;
const port = Number(process.env.V09_REQUEST_ISOLATION_PG_PORT ?? 55441);

const embeddedPostgresPath = path.join(
  runtimeDir,
  "node_modules/embedded-postgres/dist/index.js"
);
const { default: EmbeddedPostgres } = await import(
  pathToFileURL(embeddedPostgresPath).href
);
const schemaSql = await readFile(
  path.join(repoRoot, "supabase/schema.sql"),
  "utf8"
);

const database = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: "postgres",
  password: "request-isolation-only",
  port,
  persistent: false,
  postgresFlags: ["-h", "127.0.0.1"]
});

await database.initialise();
await database.start();
const rootClient = database.getPgClient("postgres", "127.0.0.1");
await rootClient.connect();

try {
  await rootClient.query(`
    do $$
    begin
      create role service_role nologin;
    exception when duplicate_object then null;
    end $$;
    do $$
    begin
      create role anon nologin;
    exception when duplicate_object then null;
    end $$;
    do $$
    begin
      create role authenticated nologin;
    exception when duplicate_object then null;
    end $$;
  `);
  await rootClient.query(schemaSql);

  const accessCode = (
    await rootClient.query(`
      insert into access_codes (
        code, plan_type, total_minutes, used_minutes, status
      ) values (
        'ISOLATE', 'trial', 120, 0, 'active'
      )
      returning id
    `)
  ).rows[0];
  const session = (
    await rootClient.query(
      `
        insert into sessions (
          access_code_id, start_time, session_token, status
        ) values ($1, now(), 'old-token', 'active')
        returning id
      `,
      [accessCode.id]
    )
  ).rows[0];

  async function persist(token, reason) {
    return (
      await rootClient.query(
        `
          select persist_analysis_result_if_session_current(
            $1, $2, $3, 'studying', 'present', 'studying', now(), 0.9,
            $4, 'qwen', 15, false, false, 'vision_qwen:test',
            100, 50, 0.003, 250, null
          ) as result
        `,
        [accessCode.id, session.id, token, reason]
      )
    ).rows[0].result;
  }

  await rootClient.query(
    `update sessions set session_token = 'new-token' where id = $1`,
    [session.id]
  );

  const staleResult = await persist("old-token", "旧环境结果");
  assert.equal(staleResult.persisted, false);
  assert.equal(staleResult.resultCode, "session_reactivated_elsewhere");

  const countsAfterStale = (
    await rootClient.query(
      `
        select
          (select count(*)::integer from sessions where access_code_id = $1) sessions,
          (select count(*)::integer from records where session_id = $2) records,
          (select count(*)::integer from ai_call_logs where session_id = $2) ai_calls,
          (select count(*)::integer from error_logs where session_id = $2) errors,
          (select used_minutes from access_codes where id = $1) used_minutes
      `,
      [accessCode.id, session.id]
    )
  ).rows[0];
  assert.deepEqual(countsAfterStale, {
    sessions: 1,
    records: 0,
    ai_calls: 0,
    errors: 0,
    used_minutes: 0
  });

  const currentResult = await persist("new-token", "新环境结果");
  assert.equal(currentResult.persisted, true);
  assert.ok(currentResult.recordId);

  const finalCounts = (
    await rootClient.query(
      `
        select
          (select count(*)::integer from sessions where access_code_id = $1) sessions,
          (select count(*)::integer from records where session_id = $2) records,
          (select count(*)::integer from ai_call_logs where session_id = $2) ai_calls,
          (select count(*)::integer from ai_call_logs
             where session_id = $2 and model_type like 'report_%') reports,
          (select used_minutes from access_codes where id = $1) used_minutes
      `,
      [accessCode.id, session.id]
    )
  ).rows[0];
  assert.deepEqual(finalCounts, {
    sessions: 1,
    records: 1,
    ai_calls: 1,
    reports: 0,
    used_minutes: 0
  });

  process.stdout.write(
    `${JSON.stringify({
      passed: true,
      staleResult,
      currentResult,
      countsAfterStale,
      finalCounts,
      productionConnectionUsed: false
    }, null, 2)}\n`
  );
} finally {
  await rootClient.end().catch(() => undefined);
  await database.stop().catch(() => undefined);
}

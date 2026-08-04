import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const runtimeDir =
  process.env.V09_PG_RUNTIME_DIR ?? "/private/tmp/codex-v09-pg-runtime";
const dataDir =
  process.env.V09_PG_DATA_DIR ??
  `/private/tmp/codex-v09-pg-data-${process.pid}`;
const port = Number(process.env.V09_PG_PORT ?? 55439);
const password = "isolated-v09-only";
const acceptanceDatabase = "v09_acceptance";
const referenceDatabase = "v09_schema_reference";

const embeddedPostgresPath = path.join(
  runtimeDir,
  "node_modules/embedded-postgres/dist/index.js"
);
const { default: EmbeddedPostgres } = await import(
  pathToFileURL(embeddedPostgresPath).href
);

const fixtureSql = await readFile(
  path.join(scriptDir, "seed-v08-fixtures.sql"),
  "utf8"
);
const snapshotSql = await readFile(
  path.join(scriptDir, "snapshot.sql"),
  "utf8"
);
const migrationSql = await readFile(
  path.join(repoRoot, "supabase/migration_2026_18_device_rebind_mvp.sql"),
  "utf8"
);
const verifySql = await readFile(
  path.join(repoRoot, "supabase/verify_2026_18_device_rebind_mvp.sql"),
  "utf8"
);
const currentSchemaSql = await readFile(
  path.join(repoRoot, "supabase/schema.sql"),
  "utf8"
);
const v08SchemaSql = execFileSync(
  "git",
  ["show", "98088ff:supabase/schema.sql"],
  { cwd: repoRoot, encoding: "utf8" }
);

const postgresLogs = [];
const database = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: "postgres",
  password,
  port,
  persistent: false,
  postgresFlags: ["-h", "127.0.0.1"],
  onLog: (message) => postgresLogs.push(String(message).trim()),
  onError: (error) => postgresLogs.push(`ERROR: ${String(error)}`)
});

const acceptanceResults = [];
const migrationNotices = [];
let migrationStartedAt = null;
let migrationFinishedAt = null;
let migrationDurationMs = null;
let migrationRolledBack = false;
let lockWaitObserved = false;
let databaseVersion = null;

function normaliseFunctionDefinition(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function resultCode(value) {
  return value?.resultCode ?? value?.resultcode;
}

function snapshotTotals(snapshot) {
  return snapshot.reduce(
    (totals, item) => ({
      accessCodes: totals.accessCodes + 1,
      activeSessions:
        totals.activeSessions + Number(item.active_session_count),
      historicalSessions:
        totals.historicalSessions + Number(item.historical_session_count),
      records: totals.records + Number(item.record_count),
      reports: totals.reports + Number(item.report_count)
    }),
    {
      accessCodes: 0,
      activeSessions: 0,
      historicalSessions: 0,
      records: 0,
      reports: 0
    }
  );
}

async function runCase(name, callback) {
  const startedAt = Date.now();
  try {
    const details = await callback();
    acceptanceResults.push({
      name,
      passed: true,
      durationMs: Date.now() - startedAt,
      details
    });
  } catch (error) {
    acceptanceResults.push({
      name,
      passed: false,
      durationMs: Date.now() - startedAt,
      details: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

async function queryCode(client, code) {
  const { rows } = await client.query(
    `select * from access_codes where code = $1`,
    [code]
  );
  assert.equal(rows.length, 1, `访问码 ${code} 不存在`);
  return rows[0];
}

async function queryActiveToken(client, code) {
  const { rows } = await client.query(
    `select session_token
     from sessions
     where access_code_id = (select id from access_codes where code = $1)
       and status = 'active'
       and end_time is null
     order by created_at desc
     limit 1`,
    [code]
  );
  return rows[0]?.session_token ?? null;
}

async function queryCount(client, sql, values = []) {
  const { rows } = await client.query(sql, values);
  return Number(rows[0]?.count ?? 0);
}

async function callRebind(client, {
  code,
  deviceId,
  requestId,
  newSessionToken,
  deviceName = "隔离测试环境",
  deviceModel = "Fixture",
  platform = "Other"
}) {
  const { rows } = await client.query(
    `select perform_device_rebind(
       $1, $2, $3, $4, $5, $6, $7, $8, $9
     ) as result`,
    [
      code,
      deviceId,
      deviceName,
      deviceModel,
      platform,
      requestId,
      newSessionToken,
      "127.0.0.1",
      "isolated-postgres-acceptance"
    ]
  );
  return rows[0].result;
}

async function successfulUserCount(client, code) {
  return queryCount(
    client,
    `select count(*)::integer
     from device_rebind_logs
     where access_code_id = (select id from access_codes where code = $1)
       and action_source = 'user'
       and success = true
       and result_code = 'rebound'`,
    [code]
  );
}

async function minuteState(client, code) {
  const { rows } = await client.query(
    `select total_minutes, used_minutes,
            greatest(total_minutes - used_minutes, 0) as remaining_minutes
     from access_codes
     where code = $1`,
    [code]
  );
  return rows[0];
}

async function insertSuccessfulHistory(client, code, expressions) {
  const codeRow = await queryCode(client, code);
  for (let index = 0; index < expressions.length; index += 1) {
    await client.query(
      `insert into device_rebind_logs (
         access_code_id, access_code, idempotency_key, action_source,
         old_device_id, new_device_id, window_count_before, window_count_after,
         success, result_code, response_payload, created_at
       ) values (
         $1, $2, $3, 'user',
         $4, $5, $6, $7,
         true, 'rebound', '{}'::jsonb, ${expressions[index]}
       )`,
      [
        codeRow.id,
        code,
        `fixture-history-${code}-${index}`,
        `old-${index}`,
        `new-${index}`,
        index,
        index + 1
      ]
    );
  }
  await client.query(
    `update access_codes set rebind_total = $2 where id = $1`,
    [codeRow.id, expressions.length]
  );
}

async function functionDefinitions(client) {
  const { rows } = await client.query(
    `select routine.proname, pg_get_functiondef(routine.oid) as definition
     from pg_proc as routine
     join pg_namespace as namespace on namespace.oid = routine.pronamespace
     where namespace.nspname = 'public'
       and routine.proname in (
         'get_device_rebind_status',
         'perform_device_rebind',
         'admin_reset_device_environment'
       )
     order by routine.proname`
  );
  return Object.fromEntries(
    rows.map((row) => [
      row.proname,
      normaliseFunctionDefinition(row.definition)
    ])
  );
}

await database.initialise();
await database.start();

const rootClient = database.getPgClient("postgres", "127.0.0.1");
await rootClient.connect();

try {
  const versionResult = await rootClient.query(
    `select version() as version, current_setting('listen_addresses') as listen_addresses`
  );
  databaseVersion = versionResult.rows[0];
  assert.equal(databaseVersion.listen_addresses, "127.0.0.1");

  await rootClient.query(
    `do $$
     begin
       create role service_role nologin;
     exception when duplicate_object then
       null;
     end
     $$;
     do $$
     begin
       create role anon nologin;
     exception when duplicate_object then
       null;
     end
     $$;
     do $$
     begin
       create role authenticated nologin;
     exception when duplicate_object then
       null;
     end
     $$`
  );
  await database.createDatabase(acceptanceDatabase);
  await database.createDatabase(referenceDatabase);

  const client = database.getPgClient(acceptanceDatabase, "127.0.0.1");
  const monitorClient = database.getPgClient(
    acceptanceDatabase,
    "127.0.0.1"
  );
  await client.connect();
  await monitorClient.connect();

  try {
    client.on("notice", (notice) => {
      migrationNotices.push({
        severity: notice.severity,
        code: notice.code,
        message: notice.message
      });
    });

    await client.query(v08SchemaSql);
    await client.query(fixtureSql);

    const beforeSnapshot = (await client.query(snapshotSql)).rows[0].snapshot;
    assert.equal(beforeSnapshot.length, 19);

    migrationStartedAt = new Date().toISOString();
    const migrationStartMs = Date.now();
    const migrationBackendPid = (
      await client.query(`select pg_backend_pid() as pid`)
    ).rows[0].pid;
    let migrationSettled = false;

    const monitorPromise = (async () => {
      while (!migrationSettled) {
        const { rows } = await monitorClient.query(
          `select wait_event_type, wait_event
           from pg_stat_activity
           where pid = $1`,
          [migrationBackendPid]
        );
        if (rows[0]?.wait_event_type === "Lock") {
          lockWaitObserved = true;
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    })();

    try {
      await client.query("begin");
      await client.query("set local lock_timeout = '3s'");
      await client.query("set local statement_timeout = '30s'");
      await client.query(migrationSql);
      await client.query("commit");
    } catch (error) {
      migrationRolledBack = true;
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      migrationSettled = true;
      await monitorPromise;
      migrationFinishedAt = new Date().toISOString();
      migrationDurationMs = Date.now() - migrationStartMs;
    }

    const afterSnapshot = (await client.query(snapshotSql)).rows[0].snapshot;
    assert.deepEqual(afterSnapshot, beforeSnapshot);
    const beforeTotals = snapshotTotals(beforeSnapshot);
    const afterTotals = snapshotTotals(afterSnapshot);
    assert.deepEqual(afterTotals, beforeTotals);
    const initialReactivationLogCount = await queryCount(
      client,
      `select count(*)::integer from device_rebind_logs`
    );
    assert.equal(initialReactivationLogCount, 0);

    await client.query("begin transaction read only");
    let verificationStatementCount = 0;
    try {
      const verificationResult = await client.query(verifySql);
      verificationStatementCount = Array.isArray(verificationResult)
        ? verificationResult.length
        : 1;
    } finally {
      await client.query("rollback");
    }

    const { rows: configRows } = await client.query(
      `select rebind_window_days, rebind_max_count,
              rebind_min_interval_seconds
       from device_rebind_configs where id = true`
    );
    assert.deepEqual(configRows[0], {
      rebind_window_days: 15,
      rebind_max_count: 10,
      rebind_min_interval_seconds: 60
    });

    const { rows: retiredFieldRows } = await client.query(
      `select column_name
       from information_schema.columns
       where table_schema = 'public'
         and table_name in ('access_codes', 'device_rebind_configs')
         and column_name in ('free_rebind_count', 'rebind_cost_minutes')`
    );
    assert.equal(retiredFieldRows.length, 0);

    const referenceClient = database.getPgClient(
      referenceDatabase,
      "127.0.0.1"
    );
    await referenceClient.connect();
    try {
      await referenceClient.query(currentSchemaSql);
      const migratedFunctionDefinitions = await functionDefinitions(client);
      const referenceFunctionDefinitions =
        await functionDefinitions(referenceClient);
      assert.equal(Object.keys(migratedFunctionDefinitions).length, 3);
      assert.deepEqual(
        migratedFunctionDefinitions,
        referenceFunctionDefinitions
      );
    } finally {
      await referenceClient.end();
    }

    await runCase("迁移与19码权益快照", async () => ({
      accessCodes: beforeSnapshot.length,
      snapshotsEqual: true,
      beforeTotals,
      afterTotals,
      initialReactivationLogCount,
      functionDefinitionsMatchSchema: true,
      verificationStatementCount,
      config: configRows[0]
    }));

    await runCase("首次绑定不计次数", async () => {
      const beforeMinutes = await minuteState(client, "ISO001");
      const result = await callRebind(client, {
        code: "ISO001",
        deviceId: "first-environment",
        requestId: "first-binding-request",
        newSessionToken: "first-binding-token"
      });
      assert.equal(resultCode(result), "first_activated");
      assert.equal(await successfulUserCount(client, "ISO001"), 0);
      assert.equal((await queryCode(client, "ISO001")).rebind_total, 0);
      assert.deepEqual(await minuteState(client, "ISO001"), beforeMinutes);
      return result;
    });

    await runCase("同环境进入不计次数且不触发60秒", async () => {
      const result = await callRebind(client, {
        code: "ISO001",
        deviceId: "first-environment",
        requestId: "same-environment-request",
        newSessionToken: "same-environment-token"
      });
      assert.equal(resultCode(result), "already_active");
      assert.equal(await successfulUserCount(client, "ISO001"), 0);
      assert.equal(
        await queryCount(
          client,
          `select count(*)::integer from device_rebind_logs
           where access_code_id = (
             select id from access_codes where code = 'ISO001'
           )`
        ),
        0
      );
      return result;
    });

    await runCase("第一次重新绑定与旧令牌失效", async () => {
      const beforeMinutes = await minuteState(client, "ISO005");
      const oldToken = await queryActiveToken(client, "ISO005");
      const result = await callRebind(client, {
        code: "ISO005",
        deviceId: "replacement-environment",
        requestId: "first-rebind-request",
        newSessionToken: "rotated-token-ISO005"
      });
      assert.equal(resultCode(result), "rebound");
      assert.equal(result.usedCount, 1);
      assert.equal(await successfulUserCount(client, "ISO005"), 1);
      assert.equal((await queryCode(client, "ISO005")).rebind_total, 1);
      assert.notEqual(await queryActiveToken(client, "ISO005"), oldToken);
      assert.equal(
        await queryActiveToken(client, "ISO005"),
        "rotated-token-ISO005"
      );
      assert.deepEqual(await minuteState(client, "ISO005"), beforeMinutes);

      const { rows } = await client.query(
        `select old_device_id, new_device_id, window_count_before,
                window_count_after, user_agent
         from device_rebind_logs
         where access_code_id = (
           select id from access_codes where code = 'ISO005'
         ) and success = true`
      );
      assert.deepEqual(rows[0], {
        old_device_id: "fixture-env-005",
        new_device_id: "replacement-environment",
        window_count_before: 0,
        window_count_after: 1,
        user_agent: "isolated-postgres-acceptance"
      });
      return {
        result,
        oldToken,
        newToken: await queryActiveToken(client, "ISO005"),
        auditRows: rows.length
      };
    });

    await runCase("成功后60秒内第三环境被拒", async () => {
      const beforeMinutes = await minuteState(client, "ISO005");
      const tokenBefore = await queryActiveToken(client, "ISO005");
      const result = await callRebind(client, {
        code: "ISO005",
        deviceId: "third-environment",
        requestId: "rate-limit-request",
        newSessionToken: "should-not-be-used"
      });
      assert.equal(resultCode(result), "rate_limited");
      assert.equal(await successfulUserCount(client, "ISO005"), 1);
      assert.equal(
        await queryActiveToken(client, "ISO005"),
        tokenBefore
      );
      assert.deepEqual(await minuteState(client, "ISO005"), beforeMinutes);
      assert.equal(
        await queryCount(
          client,
          `select count(*)::integer from device_rebind_logs
           where access_code_id = (
             select id from access_codes where code = 'ISO005'
           ) and success = false and result_code = 'rate_limited'`
        ),
        1
      );
      return result;
    });

    await runCase("第10次允许且第11次拒绝", async () => {
      await insertSuccessfulHistory(
        client,
        "ISO006",
        Array.from(
          { length: 9 },
          (_, index) => `now() - interval '${9 - index} days'`
        )
      );
      const beforeMinutes = await minuteState(client, "ISO006");
      const tenth = await callRebind(client, {
        code: "ISO006",
        deviceId: "tenth-environment",
        requestId: "tenth-request",
        newSessionToken: "tenth-token"
      });
      assert.equal(resultCode(tenth), "rebound");
      assert.equal(tenth.usedCount, 10);

      const eleventh = await callRebind(client, {
        code: "ISO006",
        deviceId: "eleventh-environment",
        requestId: "eleventh-request",
        newSessionToken: "eleventh-token"
      });
      assert.equal(resultCode(eleventh), "window_limit_reached");
      assert.equal(await successfulUserCount(client, "ISO006"), 10);
      assert.ok(eleventh.nextAvailableAt);

      const { rows } = await client.query(
        `select min(created_at) + interval '15 days' as expected
         from device_rebind_logs
         where access_code_id = (
           select id from access_codes where code = 'ISO006'
         ) and action_source = 'user' and success = true
           and result_code = 'rebound'
           and created_at > now() - interval '15 days'`
      );
      assert.equal(
        new Date(eleventh.nextAvailableAt).getTime(),
        new Date(rows[0].expected).getTime()
      );
      assert.deepEqual(await minuteState(client, "ISO006"), beforeMinutes);
      return { tenth, eleventh };
    });

    await runCase("超过15天后滚动恢复额度", async () => {
      await insertSuccessfulHistory(client, "ISO007", [
        "now() - interval '15 days 1 second'",
        ...Array.from(
          { length: 9 },
          (_, index) => `now() - interval '${14 - index} days'`
        )
      ]);
      const result = await callRebind(client, {
        code: "ISO007",
        deviceId: "window-restored-environment",
        requestId: "window-restored-request",
        newSessionToken: "window-restored-token"
      });
      assert.equal(resultCode(result), "rebound");
      assert.equal(result.usedCount, 10);
      const status = (
        await client.query(
          `select get_device_rebind_status(
             (select id from access_codes where code = 'ISO007')
           ) as status`
        )
      ).rows[0].status;
      assert.equal(status.usedCount, 10);
      return { result, status };
    });

    await runCase("相同请求ID幂等重放", async () => {
      const beforeMinutes = await minuteState(client, "ISO008");
      const first = await callRebind(client, {
        code: "ISO008",
        deviceId: "idempotent-environment",
        requestId: "stable-idempotency-request",
        newSessionToken: "idempotent-token-first"
      });
      const tokenAfterFirst = await queryActiveToken(client, "ISO008");
      const replay = await callRebind(client, {
        code: "ISO008",
        deviceId: "idempotent-environment",
        requestId: "stable-idempotency-request",
        newSessionToken: "idempotent-token-must-not-apply"
      });
      assert.equal(resultCode(first), "rebound");
      assert.equal(resultCode(replay), "rebound");
      assert.equal(replay.replayed, true);
      assert.equal(await successfulUserCount(client, "ISO008"), 1);
      assert.equal(
        await queryActiveToken(client, "ISO008"),
        tokenAfterFirst
      );
      assert.deepEqual(await minuteState(client, "ISO008"), beforeMinutes);
      return { first, replay };
    });

    await runCase("两个环境真实并发只有一次成功", async () => {
      const beforeMinutes = await minuteState(client, "ISO009");
      const firstClient = database.getPgClient(
        acceptanceDatabase,
        "127.0.0.1"
      );
      const secondClient = database.getPgClient(
        acceptanceDatabase,
        "127.0.0.1"
      );
      await Promise.all([firstClient.connect(), secondClient.connect()]);
      let results;
      const startedAt = Date.now();
      try {
        results = await Promise.all([
          callRebind(firstClient, {
            code: "ISO009",
            deviceId: "concurrent-environment-a",
            requestId: "concurrent-request-a",
            newSessionToken: "concurrent-token-a"
          }),
          callRebind(secondClient, {
            code: "ISO009",
            deviceId: "concurrent-environment-b",
            requestId: "concurrent-request-b",
            newSessionToken: "concurrent-token-b"
          })
        ]);
      } finally {
        await Promise.all([firstClient.end(), secondClient.end()]);
      }
      const codes = results.map(resultCode).sort();
      assert.deepEqual(codes, ["rate_limited", "rebound"]);
      assert.equal(await successfulUserCount(client, "ISO009"), 1);
      assert.deepEqual(await minuteState(client, "ISO009"), beforeMinutes);
      assert.ok(Date.now() - startedAt < 5000, "并发测试疑似发生死锁");
      return {
        resultCodes: codes,
        winningEnvironment: (await queryCode(client, "ISO009")).device_id
      };
    });

    await runCase("事务中途失败完整回滚", async () => {
      const codeBefore = await queryCode(client, "ISO010");
      const tokenBefore = await queryActiveToken(client, "ISO010");
      const minutesBefore = await minuteState(client, "ISO010");
      const logCountBefore = await queryCount(
        client,
        `select count(*)::integer from device_rebind_logs
         where access_code_id = $1`,
        [codeBefore.id]
      );

      await client.query(
        `create or replace function fail_fixture_rebind_log()
         returns trigger language plpgsql as $$
         begin
           if new.access_code_id = '${codeBefore.id}'::uuid
             and new.success = true then
             raise exception 'fixture forced rollback';
           end if;
           return new;
         end
         $$;
         create trigger fixture_force_rebind_rollback
         before insert on device_rebind_logs
         for each row execute function fail_fixture_rebind_log();`
      );

      let failed = false;
      try {
        await callRebind(client, {
          code: "ISO010",
          deviceId: "must-rollback-environment",
          requestId: "forced-rollback-request",
          newSessionToken: "must-rollback-token"
        });
      } catch (error) {
        failed = /fixture forced rollback/.test(String(error));
      } finally {
        await client.query(
          `drop trigger if exists fixture_force_rebind_rollback
             on device_rebind_logs;
           drop function if exists fail_fixture_rebind_log();`
        );
      }
      assert.equal(failed, true);
      const codeAfter = await queryCode(client, "ISO010");
      assert.equal(codeAfter.device_id, codeBefore.device_id);
      assert.equal(codeAfter.rebind_total, codeBefore.rebind_total);
      assert.equal(await queryActiveToken(client, "ISO010"), tokenBefore);
      assert.deepEqual(await minuteState(client, "ISO010"), minutesBefore);
      assert.equal(
        await queryCount(
          client,
          `select count(*)::integer from device_rebind_logs
           where access_code_id = $1`,
          [codeBefore.id]
        ),
        logCountBefore
      );
      return { forcedFailure: true, stateRestored: true };
    });

    await runCase("管理员重置不占用户次数", async () => {
      await insertSuccessfulHistory(client, "ISO011", [
        "now() - interval '3 days'",
        "now() - interval '2 days'"
      ]);
      const codeBefore = await queryCode(client, "ISO011");
      const tokenBefore = await queryActiveToken(client, "ISO011");
      const minutesBefore = await minuteState(client, "ISO011");
      const userCountBefore = await successfulUserCount(client, "ISO011");
      const { rows } = await client.query(
        `select admin_reset_device_environment(
           $1, $2, $3, $4, $5
         ) as result`,
        [
          codeBefore.id,
          "真机验收前重置",
          "isolated-admin",
          "admin-reset-request",
          "admin-reset-token"
        ]
      );
      assert.equal(resultCode(rows[0].result), "admin_reset");
      const codeAfter = await queryCode(client, "ISO011");
      assert.equal(codeAfter.device_id, null);
      assert.equal(
        await successfulUserCount(client, "ISO011"),
        userCountBefore
      );
      assert.notEqual(await queryActiveToken(client, "ISO011"), tokenBefore);
      assert.equal(
        await queryActiveToken(client, "ISO011"),
        "admin-reset-token"
      );
      assert.deepEqual(await minuteState(client, "ISO011"), minutesBefore);

      const { rows: adminRows } = await client.query(
        `select action_type, reason
         from admin_actions
         where access_code_id = $1
         order by created_at desc
         limit 1`,
        [codeBefore.id]
      );
      assert.deepEqual(adminRows[0], {
        action_type: "reset_device_environment",
        reason: "真机验收前重置"
      });
      assert.equal(
        await queryCount(
          client,
          `select count(*)::integer from device_rebind_logs
           where access_code_id = $1
             and action_source = 'admin'
             and result_code = 'admin_reset'`,
          [codeBefore.id]
        ),
        1
      );
      return rows[0].result;
    });

    const failedCases = acceptanceResults.filter((item) => !item.passed);
    assert.equal(failedCases.length, 0);

    const finalSummary = {
      environment: {
        databaseVersion,
        host: "127.0.0.1",
        port,
        database: acceptanceDatabase,
        dataDir,
        productionConnectionUsed: false
      },
      migration: {
        startedAt: migrationStartedAt,
        finishedAt: migrationFinishedAt,
        durationMs: migrationDurationMs,
        success: true,
        transactionRolledBack: migrationRolledBack,
        lockWaitObserved,
        notices: migrationNotices,
        warnings: migrationNotices.filter(
          (notice) => notice.severity === "WARNING"
        )
      },
      compatibility: {
        accessCodeCountBefore: beforeSnapshot.length,
        accessCodeCountAfter: afterSnapshot.length,
        snapshotsEqual: true,
        beforeTotals,
        afterTotals,
        initialReactivationLogCount: 0
      },
      results: acceptanceResults,
      postgresLogTail: postgresLogs.slice(-8)
    };

    process.stdout.write(`${JSON.stringify(finalSummary, null, 2)}\n`);
  } finally {
    await Promise.allSettled([client.end(), monitorClient.end()]);
  }
} finally {
  await rootClient.end().catch(() => undefined);
  await database.stop().catch(() => undefined);
}

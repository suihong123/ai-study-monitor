import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const runtimeDir =
  process.env.V09_PG_RUNTIME_DIR ?? "/private/tmp/codex-v09-pg-runtime";
const configPath = process.env.V09_HOSTED_CONFIG;
const expectedProjectRef = process.env.V09_EXPECTED_PROJECT_REF;

assert.ok(configPath, "缺少 V09_HOSTED_CONFIG");
assert.ok(expectedProjectRef, "缺少 V09_EXPECTED_PROJECT_REF");
assert.equal(
  process.env.V09_HOSTED_ALLOW_INITIALISE,
  "YES",
  "必须显式设置 V09_HOSTED_ALLOW_INITIALISE=YES"
);

const config = JSON.parse(await readFile(configPath, "utf8"));
assert.equal(config.projectRef, expectedProjectRef);
assert.match(config.projectRef, /^[a-z]{20}$/);
assert.match(config.host, /\.pooler\.supabase\.com$/);
assert.equal(config.user, `postgres.${config.projectRef}`);
assert.equal(config.database, "postgres");
assert.notEqual(config.projectRef, "fmrmumamtbejpwafmuib");

const pgEntryPath = path.join(
  runtimeDir,
  "node_modules/pg/lib/index.js"
);
const pgModule = await import(pathToFileURL(pgEntryPath).href);
const Client = pgModule.default?.Client ?? pgModule.Client;

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

const clientConfig = {
  host: config.host,
  port: Number(config.port),
  database: config.database,
  user: config.user,
  password: config.password,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20_000,
  query_timeout: 40_000,
  application_name: "v09-hosted-acceptance"
};

const results = [];
const migrationNotices = [];
const functionNames = [
  "get_device_rebind_status",
  "perform_device_rebind",
  "admin_reset_device_environment"
];

function normaliseSql(value) {
  return String(value)
    .replace(/--.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function functionSql(sql, name) {
  const marker = `create or replace function ${name}`;
  const start = sql.toLowerCase().indexOf(marker);
  assert.ok(start >= 0, `${name} 不存在`);
  const end = sql.toLowerCase().indexOf(
    `revoke all on function ${name}`,
    start
  );
  assert.ok(end > start, `${name} 缺少权限收口`);
  return normaliseSql(sql.slice(start, end));
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
  const startedAt = new Date();
  try {
    const details = await callback();
    results.push({
      name,
      passed: true,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      details
    });
  } catch (error) {
    results.push({
      name,
      passed: false,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
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

async function queryCount(client, sql, values = []) {
  const { rows } = await client.query(sql, values);
  return Number(rows[0]?.count ?? 0);
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

async function minuteState(client, code) {
  const { rows } = await client.query(
    `select total_minutes, used_minutes,
            greatest(total_minutes - used_minutes, 0) as remaining_minutes
     from access_codes where code = $1`,
    [code]
  );
  return rows[0];
}

async function callRebind(
  client,
  {
    code,
    deviceId,
    requestId,
    newSessionToken,
    deviceName = "托管测试环境",
    deviceModel = "Hosted Fixture",
    platform = "Other"
  }
) {
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
      "hosted-supabase-acceptance"
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
        `hosted-history-${code}-${index}`,
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

const client = new Client(clientConfig);
const monitorClient = new Client({
  ...clientConfig,
  application_name: "v09-hosted-acceptance-monitor"
});
await Promise.all([client.connect(), monitorClient.connect()]);

let migration = null;
let beforeSnapshot = null;
let afterSnapshot = null;
let beforeTotals = null;
let afterTotals = null;
let lockWaitObserved = false;

try {
  const connectionStartedAt = Date.now();
  const { rows: environmentRows } = await client.query(
    `select version() as version,
            current_setting('timezone') as timezone,
            current_user,
            inet_server_addr()::text as server_address,
            inet_server_port() as server_port`
  );
  const networkRoundTripMs = Date.now() - connectionStartedAt;

  const { rows: existingRows } = await client.query(
    `select to_regclass('public.access_codes') as access_codes`
  );
  assert.equal(
    existingRows[0].access_codes,
    null,
    "测试项目已存在 access_codes；为防误覆盖，已停止"
  );

  await runCase("从生产v0.8结构初始化19码脱敏数据", async () => {
    await client.query(v08SchemaSql);
    await client.query(fixtureSql);
    beforeSnapshot = (await client.query(snapshotSql)).rows[0].snapshot;
    assert.equal(beforeSnapshot.length, 19);
    beforeTotals = snapshotTotals(beforeSnapshot);
    assert.deepEqual(beforeTotals, {
      accessCodes: 19,
      activeSessions: 6,
      historicalSessions: 16,
      records: 48,
      reports: 10
    });
    return { beforeTotals, trueDeviceAccessCode: "ISO019" };
  });

  await runCase("migration 18 托管事务执行", async () => {
    client.on("notice", (notice) => {
      migrationNotices.push({
        severity: notice.severity,
        code: notice.code,
        message: notice.message
      });
    });
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const backendPid = (
      await client.query(`select pg_backend_pid() as pid`)
    ).rows[0].pid;
    let settled = false;
    const monitorPromise = (async () => {
      while (!settled) {
        const { rows } = await monitorClient.query(
          `select wait_event_type, wait_event
           from pg_stat_activity where pid = $1`,
          [backendPid]
        );
        if (rows[0]?.wait_event_type === "Lock") {
          lockWaitObserved = true;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })();

    let rolledBack = false;
    try {
      await client.query("begin");
      await client.query("set local lock_timeout = '5s'");
      await client.query("set local statement_timeout = '40s'");
      await client.query(migrationSql);
      await client.query("commit");
    } catch (error) {
      rolledBack = true;
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      settled = true;
      await monitorPromise;
    }

    migration = {
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      success: true,
      rolledBack,
      lockWaitObserved,
      notices: migrationNotices,
      warnings: migrationNotices.filter(
        (notice) => notice.severity === "WARNING"
      )
    };
    return migration;
  });

  await runCase("只读 verify SQL 与权益快照", async () => {
    afterSnapshot = (await client.query(snapshotSql)).rows[0].snapshot;
    afterTotals = snapshotTotals(afterSnapshot);
    assert.deepEqual(afterSnapshot, beforeSnapshot);
    assert.deepEqual(afterTotals, beforeTotals);
    assert.equal(
      await queryCount(
        client,
        `select count(*)::integer from device_rebind_logs`
      ),
      0
    );

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
    return {
      verificationStatementCount,
      beforeTotals,
      afterTotals,
      snapshotsEqual: true,
      config: configRows[0]
    };
  });

  await runCase("RLS、security definer 与函数权限", async () => {
    const { rows: rlsRows } = await client.query(
      `select relname, relrowsecurity
       from pg_class
       join pg_namespace on pg_namespace.oid = pg_class.relnamespace
       where pg_namespace.nspname = 'public'
         and relname in (
           'plan_configs', 'access_codes', 'sessions', 'records',
           'error_logs', 'ai_call_logs', 'ai_model_configs',
           'suspicious_logs', 'admin_actions',
           'device_rebind_configs', 'device_rebind_logs'
         )
       order by relname`
    );
    assert.equal(rlsRows.length, 11);
    assert.ok(rlsRows.every((row) => row.relrowsecurity === true));

    const { rows: functionRows } = await client.query(
      `select routine.proname,
              routine.prosecdef,
              routine.proconfig,
              has_function_privilege(
                'service_role', routine.oid, 'EXECUTE'
              ) as service_role_execute,
              has_function_privilege(
                'anon', routine.oid, 'EXECUTE'
              ) as anon_execute,
              has_function_privilege(
                'authenticated', routine.oid, 'EXECUTE'
              ) as authenticated_execute
       from pg_proc as routine
       join pg_namespace as namespace
         on namespace.oid = routine.pronamespace
       where namespace.nspname = 'public'
         and routine.proname = any($1::text[])
       order by routine.proname`,
      [functionNames]
    );
    assert.equal(functionRows.length, 3);
    for (const row of functionRows) {
      assert.equal(row.prosecdef, true);
      assert.ok(
        row.proconfig?.some((value) => value === "search_path=public")
      );
      assert.equal(row.service_role_execute, true);
      assert.equal(row.anon_execute, false);
      assert.equal(row.authenticated_execute, false);
    }

    for (const role of ["anon", "authenticated"]) {
      await client.query("begin read only");
      try {
        await client.query(`set local role ${role}`);
        const { rows } = await client.query(
          `select count(*)::integer from access_codes`
        );
        assert.equal(Number(rows[0].count), 0);
      } finally {
        await client.query("rollback");
      }
    }

    await client.query("begin read only");
    let serviceRoleCount;
    try {
      await client.query("set local role service_role");
      serviceRoleCount = await queryCount(
        client,
        `select count(*)::integer from access_codes`
      );
      assert.equal(serviceRoleCount, 19);
      const { rows } = await client.query(
        `select get_device_rebind_status(
           (select id from access_codes where code = 'ISO019')
         ) as status`
      );
      assert.equal(rows[0].status.usedCount, 0);
    } finally {
      await client.query("rollback");
    }

    for (const name of functionNames) {
      assert.equal(
        functionSql(migrationSql, name),
        functionSql(currentSchemaSql, name)
      );
    }

    const { rows: extensionRows } = await client.query(
      `select extname from pg_extension order by extname`
    );
    return {
      rlsTables: rlsRows.map((row) => row.relname),
      functions: functionRows,
      serviceRoleVisibleAccessCodes: serviceRoleCount,
      anonVisibleAccessCodes: 0,
      authenticatedVisibleAccessCodes: 0,
      extensions: extensionRows.map((row) => row.extname)
    };
  });

  await runCase("首次绑定不计次数", async () => {
    const beforeMinutes = await minuteState(client, "ISO001");
    const result = await callRebind(client, {
      code: "ISO001",
      deviceId: "hosted-first-environment",
      requestId: "hosted-first-binding",
      newSessionToken: "hosted-first-token"
    });
    assert.equal(resultCode(result), "first_activated");
    assert.equal(await successfulUserCount(client, "ISO001"), 0);
    assert.equal((await queryCode(client, "ISO001")).rebind_total, 0);
    assert.deepEqual(await minuteState(client, "ISO001"), beforeMinutes);
    return result;
  });

  await runCase("同环境进入不计次数", async () => {
    const result = await callRebind(client, {
      code: "ISO001",
      deviceId: "hosted-first-environment",
      requestId: "hosted-same-environment",
      newSessionToken: "hosted-same-environment-token"
    });
    assert.equal(resultCode(result), "already_active");
    assert.equal(await successfulUserCount(client, "ISO001"), 0);
    return result;
  });

  await runCase("新环境重新绑定、令牌轮换且分钟不变", async () => {
    const beforeMinutes = await minuteState(client, "ISO005");
    const oldToken = await queryActiveToken(client, "ISO005");
    const result = await callRebind(client, {
      code: "ISO005",
      deviceId: "hosted-replacement-environment",
      requestId: "hosted-first-rebind",
      newSessionToken: "hosted-rotated-token"
    });
    assert.equal(resultCode(result), "rebound");
    assert.equal(await successfulUserCount(client, "ISO005"), 1);
    assert.notEqual(await queryActiveToken(client, "ISO005"), oldToken);
    assert.deepEqual(await minuteState(client, "ISO005"), beforeMinutes);
    const { rows } = await client.query(
      `select old_device_id, new_device_id, window_count_before,
              window_count_after, result_code
       from device_rebind_logs
       where access_code_id = (
         select id from access_codes where code = 'ISO005'
       ) and success = true`
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      old_device_id: "fixture-env-005",
      new_device_id: "hosted-replacement-environment",
      window_count_before: 0,
      window_count_after: 1,
      result_code: "rebound"
    });
    return { result, auditRows: rows.length, oldTokenRotated: true };
  });

  await runCase("60秒内第三环境被拒", async () => {
    const beforeMinutes = await minuteState(client, "ISO005");
    const tokenBefore = await queryActiveToken(client, "ISO005");
    const result = await callRebind(client, {
      code: "ISO005",
      deviceId: "hosted-third-environment",
      requestId: "hosted-rate-limit",
      newSessionToken: "hosted-unused-token"
    });
    assert.equal(resultCode(result), "rate_limited");
    assert.equal(await successfulUserCount(client, "ISO005"), 1);
    assert.equal(await queryActiveToken(client, "ISO005"), tokenBefore);
    assert.deepEqual(await minuteState(client, "ISO005"), beforeMinutes);
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
      deviceId: "hosted-tenth-environment",
      requestId: "hosted-tenth",
      newSessionToken: "hosted-tenth-token"
    });
    const eleventh = await callRebind(client, {
      code: "ISO006",
      deviceId: "hosted-eleventh-environment",
      requestId: "hosted-eleventh",
      newSessionToken: "hosted-eleventh-token"
    });
    assert.equal(resultCode(tenth), "rebound");
    assert.equal(tenth.usedCount, 10);
    assert.equal(resultCode(eleventh), "window_limit_reached");
    assert.ok(eleventh.nextAvailableAt);
    assert.equal(await successfulUserCount(client, "ISO006"), 10);
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
      deviceId: "hosted-window-restored",
      requestId: "hosted-window-restored",
      newSessionToken: "hosted-window-token"
    });
    assert.equal(resultCode(result), "rebound");
    assert.equal(result.usedCount, 10);
    return result;
  });

  await runCase("相同请求ID幂等重放", async () => {
    const beforeMinutes = await minuteState(client, "ISO008");
    const first = await callRebind(client, {
      code: "ISO008",
      deviceId: "hosted-idempotent-environment",
      requestId: "hosted-stable-request",
      newSessionToken: "hosted-idempotent-token"
    });
    const tokenAfterFirst = await queryActiveToken(client, "ISO008");
    const replay = await callRebind(client, {
      code: "ISO008",
      deviceId: "hosted-idempotent-environment",
      requestId: "hosted-stable-request",
      newSessionToken: "hosted-token-must-not-apply"
    });
    assert.equal(resultCode(first), "rebound");
    assert.equal(replay.replayed, true);
    assert.equal(await successfulUserCount(client, "ISO008"), 1);
    assert.equal(await queryActiveToken(client, "ISO008"), tokenAfterFirst);
    assert.deepEqual(await minuteState(client, "ISO008"), beforeMinutes);
    return { first, replay };
  });

  await runCase("托管会话池双连接并发只有一次成功", async () => {
    const beforeMinutes = await minuteState(client, "ISO009");
    const firstClient = new Client({
      ...clientConfig,
      application_name: "v09-hosted-concurrency-a"
    });
    const secondClient = new Client({
      ...clientConfig,
      application_name: "v09-hosted-concurrency-b"
    });
    await Promise.all([firstClient.connect(), secondClient.connect()]);
    const requestStartTimes = [
      new Date().toISOString(),
      new Date().toISOString()
    ];
    const startedAt = Date.now();
    let concurrentResults;
    try {
      concurrentResults = await Promise.all([
        callRebind(firstClient, {
          code: "ISO009",
          deviceId: "hosted-concurrent-a",
          requestId: "hosted-concurrent-request-a",
          newSessionToken: "hosted-concurrent-token-a"
        }),
        callRebind(secondClient, {
          code: "ISO009",
          deviceId: "hosted-concurrent-b",
          requestId: "hosted-concurrent-request-b",
          newSessionToken: "hosted-concurrent-token-b"
        })
      ]);
    } finally {
      await Promise.all([firstClient.end(), secondClient.end()]);
    }
    const durationMs = Date.now() - startedAt;
    const codes = concurrentResults.map(resultCode).sort();
    assert.deepEqual(codes, ["rate_limited", "rebound"]);
    assert.equal(await successfulUserCount(client, "ISO009"), 1);
    assert.deepEqual(await minuteState(client, "ISO009"), beforeMinutes);
    assert.ok(durationMs < 10_000, "托管并发疑似死锁或超时");
    const finalCode = await queryCode(client, "ISO009");
    return {
      requestStartTimes,
      responses: concurrentResults,
      resultCodes: codes,
      successLogCount: 1,
      deadlock: false,
      timeout: false,
      durationMs,
      finalEnvironment: finalCode.device_id,
      finalWindowCount: await successfulUserCount(client, "ISO009")
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
      `create or replace function fail_hosted_rebind_log()
       returns trigger language plpgsql as $$
       begin
         if new.access_code_id = '${codeBefore.id}'::uuid
           and new.success = true then
           raise exception 'hosted fixture forced rollback';
         end if;
         return new;
       end
       $$;
       create trigger hosted_force_rebind_rollback
       before insert on device_rebind_logs
       for each row execute function fail_hosted_rebind_log();`
    );
    let failed = false;
    try {
      await callRebind(client, {
        code: "ISO010",
        deviceId: "hosted-must-rollback",
        requestId: "hosted-forced-rollback",
        newSessionToken: "hosted-must-rollback-token"
      });
    } catch (error) {
      failed = /hosted fixture forced rollback/.test(String(error));
    } finally {
      await client.query(
        `drop trigger if exists hosted_force_rebind_rollback
           on device_rebind_logs;
         drop function if exists fail_hosted_rebind_log();`
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
        "托管真机验收前重置",
        "hosted-admin",
        "hosted-admin-reset",
        "hosted-admin-reset-token"
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
    assert.deepEqual(await minuteState(client, "ISO011"), minutesBefore);
    assert.equal(
      await queryCount(
        client,
        `select count(*)::integer
         from device_rebind_logs
         where access_code_id = $1
           and action_source = 'admin'
           and result_code = 'admin_reset'`,
        [codeBefore.id]
      ),
      1
    );
    return rows[0].result;
  });

  assert.equal(results.filter((item) => !item.passed).length, 0);

  const summary = {
    environment: {
      projectRef: config.projectRef,
      host: config.host,
      connectionMode: "Supabase session pooler",
      productionConnectionUsed: false,
      database: environmentRows[0],
      networkRoundTripMs
    },
    migration,
    compatibility: {
      beforeTotals,
      afterTotals,
      snapshotsEqual: true
    },
    results
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} finally {
  await Promise.allSettled([client.end(), monitorClient.end()]);
}

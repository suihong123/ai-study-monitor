import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const runtimeDir =
  process.env.V09_PG_RUNTIME_DIR ?? "/private/tmp/codex-v09-pg-runtime";
const configPath = process.env.V09_HOSTED_CONFIG;
const expectedProjectRef = process.env.V09_EXPECTED_PROJECT_REF;

assert.ok(configPath, "缺少 V09_HOSTED_CONFIG");
assert.ok(expectedProjectRef, "缺少 V09_EXPECTED_PROJECT_REF");
assert.equal(
  process.env.V09_HOSTED_ALLOW_RESET,
  "YES",
  "必须显式设置 V09_HOSTED_ALLOW_RESET=YES"
);

const config = JSON.parse(await readFile(configPath, "utf8"));
assert.equal(config.projectRef, expectedProjectRef);
assert.match(config.projectRef, /^[a-z]{20}$/);
assert.match(config.host, /\.pooler\.supabase\.com$/);
assert.equal(config.user, `postgres.${config.projectRef}`);
assert.notEqual(config.projectRef, "fmrmumamtbejpwafmuib");

const pgEntryPath = path.join(
  runtimeDir,
  "node_modules/pg/lib/index.js"
);
const pgModule = await import(pathToFileURL(pgEntryPath).href);
const Client = pgModule.default?.Client ?? pgModule.Client;
const client = new Client({
  host: config.host,
  port: Number(config.port),
  database: config.database,
  user: config.user,
  password: config.password,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20_000,
  application_name: "v09-hosted-test-reset"
});

await client.connect();
try {
  await client.query("begin");
  try {
    await client.query(
      `drop schema public cascade;
       create schema public authorization pg_database_owner;
       grant usage on schema public
         to public, postgres, anon, authenticated, service_role;`
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
  const { rows } = await client.query(
    `select to_regclass('public.access_codes') as access_codes,
            count(*)::integer as public_object_count
     from pg_class
     join pg_namespace on pg_namespace.oid = pg_class.relnamespace
     where pg_namespace.nspname = 'public'`
  );
  assert.equal(rows[0].access_codes, null);
  assert.equal(Number(rows[0].public_object_count), 0);
  process.stdout.write(
    `${JSON.stringify({
      projectRef: config.projectRef,
      publicSchemaRebuilt: true,
      publicObjectCount: 0,
      productionConnectionUsed: false
    }, null, 2)}\n`
  );
} finally {
  await client.end();
}

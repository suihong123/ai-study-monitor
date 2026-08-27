import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateDeviceRebindPolicy } from "@/lib/device-rebind-policy";

const now = new Date("2026-07-29T12:00:00.000Z");

function minutesAgo(minutes: number) {
  return new Date(now.getTime() - minutes * 60_000).toISOString();
}

function daysAgo(days: number) {
  return new Date(now.getTime() - days * 24 * 60 * 60_000).toISOString();
}

const baseInput = {
  currentDeviceId: "environment-a",
  requestedDeviceId: "environment-b",
  successfulReactivationTimes: [] as string[],
  windowDays: 15,
  maxCount: 10,
  minIntervalSeconds: 60,
  now
};

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migration_2026_18_device_rebind_mvp.sql"),
  "utf8"
).toLowerCase();
const schema = readFileSync(
  resolve(process.cwd(), "supabase/schema.sql"),
  "utf8"
).toLowerCase();
const verificationSql = readFileSync(
  resolve(process.cwd(), "supabase/verify_2026_18_device_rebind_mvp.sql"),
  "utf8"
).toLowerCase();
const homePage = readFileSync(
  resolve(process.cwd(), "app/page.tsx"),
  "utf8"
);
const supervisePage = readFileSync(
  resolve(process.cwd(), "app/supervise/page.tsx"),
  "utf8"
);
const adminPage = readFileSync(
  resolve(process.cwd(), "app/admin/page.tsx"),
  "utf8"
);
const accessCodeRoute = readFileSync(
  resolve(process.cwd(), "app/api/access-code/route.ts"),
  "utf8"
);
const rebindRoute = readFileSync(
  resolve(process.cwd(), "app/api/device/rebind/route.ts"),
  "utf8"
);

describe("rolling browser environment reactivation policy", () => {
  it("① 首次激活不计次数", () => {
    expect(
      evaluateDeviceRebindPolicy({ ...baseInput, currentDeviceId: null })
    ).toMatchObject({
      result: "first_activation",
      allowed: true,
      usedCount: 0,
      nextCount: 0
    });
  });

  it("② 同一环境再次进入不计次数", () => {
    expect(
      evaluateDeviceRebindPolicy({
        ...baseInput,
        requestedDeviceId: "environment-a"
      })
    ).toMatchObject({
      result: "same_environment",
      allowed: true,
      usedCount: 0,
      nextCount: 0
    });
  });

  it("③ 不同环境第一次重新激活成功", () => {
    expect(evaluateDeviceRebindPolicy(baseInput)).toMatchObject({
      result: "reactivation",
      allowed: true
    });
  });

  it("④ 第一次确认后滚动次数由0变1", () => {
    expect(evaluateDeviceRebindPolicy(baseInput).nextCount).toBe(1);
  });

  it("⑤ 最近15天第10次允许成功", () => {
    const decision = evaluateDeviceRebindPolicy({
      ...baseInput,
      successfulReactivationTimes: Array.from({ length: 9 }, (_, index) =>
        daysAgo(index + 1)
      )
    });
    expect(decision).toMatchObject({
      result: "reactivation",
      allowed: true,
      usedCount: 9,
      nextCount: 10
    });
  });

  it("⑥ 最近15天已有10次时第11次被拒", () => {
    const decision = evaluateDeviceRebindPolicy({
      ...baseInput,
      successfulReactivationTimes: Array.from({ length: 10 }, (_, index) =>
        daysAgo(index + 1)
      )
    });
    expect(decision).toMatchObject({
      result: "window_limit_reached",
      allowed: false,
      usedCount: 10,
      nextCount: 10
    });
    expect(decision.nextAvailableAt).toBeTruthy();
  });

  it("⑦ 最早记录超过15天后恢复一次", () => {
    const decision = evaluateDeviceRebindPolicy({
      ...baseInput,
      successfulReactivationTimes: [
        daysAgo(16),
        ...Array.from({ length: 9 }, (_, index) => daysAgo(index + 1))
      ]
    });
    expect(decision).toMatchObject({
      result: "reactivation",
      allowed: true,
      usedCount: 9,
      nextCount: 10
    });
  });

  it("⑧ 正好15天的边界记录不再计入滚动窗口", () => {
    expect(
      evaluateDeviceRebindPolicy({
        ...baseInput,
        successfulReactivationTimes: [daysAgo(15)]
      })
    ).toMatchObject({
      usedCount: 0,
      nextCount: 1
    });
  });

  it("⑨ 60秒内第二次重新激活被拒", () => {
    expect(
      evaluateDeviceRebindPolicy({
        ...baseInput,
        successfulReactivationTimes: [minutesAgo(0.5)]
      })
    ).toMatchObject({
      result: "rate_limited",
      allowed: false,
      usedCount: 1,
      nextCount: 2
    });
  });

  it("⑩ 到达60秒边界后可以继续", () => {
    expect(
      evaluateDeviceRebindPolicy({
        ...baseInput,
        successfulReactivationTimes: [minutesAgo(1)]
      })
    ).toMatchObject({
      result: "reactivation",
      allowed: true,
      usedCount: 1,
      nextCount: 2
    });
  });
});

describe("database atomicity and audit contract", () => {
  const performFunction = migration.slice(
    migration.indexOf("create or replace function perform_device_rebind"),
    migration.indexOf("create or replace function admin_reset_device_environment")
  );

  it("⑪ 取消只关闭确认框，不调用重新激活接口", () => {
    expect(homePage).toContain("setPendingDeviceRebind(null)");
    expect(homePage).toContain('onClick={() => void confirmDeviceRebind()}');
  });

  it("⑫ 失败路径只写失败日志，不增加成功计数", () => {
    expect(performFunction).toContain("false, 'rate_limited'");
    expect(performFunction).toContain("false, 'window_limit_reached'");
    expect(performFunction).toContain("and success = true");
    expect(performFunction).toContain("and result_code = 'rebound'");
  });

  it("⑬ 绑定、成功记录和令牌轮换处于同一数据库函数事务", () => {
    expect(performFunction).toContain("update access_codes");
    expect(performFunction).toContain("update sessions");
    expect(performFunction).toContain("insert into device_rebind_logs");
    expect(performFunction).not.toContain("exception when");
  });

  it("⑭ 相同幂等请求复用首次结果", () => {
    expect(migration).toContain("unique (access_code_id, idempotency_key)");
    expect(performFunction).toContain("and idempotency_key = p_idempotency_key");
    expect(performFunction).toContain("jsonb_build_object('replayed', true)");
    expect(rebindRoute).toContain('.select("response_payload")');
    expect(rebindRoute.indexOf('.select("response_payload")')).toBeLessThan(
      rebindRoute.indexOf("const ipLimit")
    );
  });

  it("⑮ 不同环境并发通过访问码行锁串行，并由60秒限制保证只有一次成功", () => {
    expect(performFunction).toContain("where code = trim(p_access_code)\n  for update");
    expect(performFunction).toContain(
      "last_success_at + make_interval(secs => config_min_interval_seconds) > now()"
    );
    expect(performFunction).toContain(
      "if current_code.device_id = p_new_device_id then"
    );
  });

  it("⑯ 重新激活函数不修改任何监督时长字段", () => {
    expect(performFunction).not.toMatch(/\bused_minutes\s*=/);
    expect(performFunction).not.toMatch(/\bused_minutes_today\s*=/);
    expect(performFunction).not.toMatch(/\btotal_minutes\s*=/);
    expect(performFunction).not.toMatch(/\bduration_minutes\s*=/);
  });

  it("⑰ 未上线结构不再包含免费次数字段和换绑费用", () => {
    for (const sql of [schema, migration]) {
      expect(sql).not.toContain("free_rebind_count");
      expect(sql).not.toContain("rebind_cost_minutes");
      expect(sql).not.toContain("deducted_minutes");
    }
  });

  it("⑱ 成功后轮换活跃会话令牌", () => {
    expect(performFunction).toContain("set session_token = p_new_session_token");
    expect(performFunction).toContain("and status = 'active'");
    expect(performFunction).toContain("and end_time is null");
  });

  it("⑱-1 托管 Supabase 显式撤销 anon 和 authenticated 函数执行权", () => {
    for (const sql of [schema, migration]) {
      expect(sql).toContain("from public, anon, authenticated");
      expect(sql).toContain(
        "grant execute on function get_device_rebind_status(uuid) to service_role"
      );
      expect(sql).toContain(
        "grant execute on function perform_device_rebind("
      );
      expect(sql).toContain(
        "grant execute on function admin_reset_device_environment("
      );
    }
  });

  it("⑲ 旧页面收到401后停止摄像头、清理状态并返回首页", () => {
    expect(supervisePage).toContain("session_reactivated_elsewhere");
    expect(supervisePage).toContain(
      "streamRef.current?.getTracks().forEach((track) => track.stop())"
    );
    expect(supervisePage).toContain(
      'window.sessionStorage.removeItem("current-supervision")'
    );
    expect(supervisePage).toContain('router.replace("/")');
    expect(supervisePage).toContain(
      "当前访问码已在其他使用环境中重新绑定，本页面的监督已停止。"
    );
  });

  it("⑳ 新环境重新验证时优先恢复活跃会话，不重复创建", () => {
    expect(accessCodeRoute.indexOf("if (activeSession)")).toBeGreaterThan(-1);
    expect(accessCodeRoute.indexOf("if (activeSession)")).toBeLessThan(
      accessCodeRoute.indexOf(".insert({", accessCodeRoute.indexOf("if (activeSession)"))
    );
    expect(accessCodeRoute).toContain("recoverable: true");
  });

  it("⑳-1 无效访问码日志不记录用户输入的访问码明文", () => {
    expect(accessCodeRoute).not.toContain("`无效访问码：${code}`");
    expect(accessCodeRoute).not.toContain("`访问码不存在：${code}`");
    expect(accessCodeRoute).toContain("无效访问码尝试（访问码已脱敏）");
    expect(accessCodeRoute).toContain("访问码不存在（访问码已脱敏）");
  });

  it("㉑ 管理员重置不计入用户滚动次数并轮换令牌", () => {
    expect(migration).toContain("'admin_reset'");
    expect(migration).toContain("'admin'");
    expect(migration).toContain("and action_source = 'user'");
    expect(migration).toContain("create or replace function admin_reset_device_environment");
  });

  it("㉒ 历史可以还原原环境、新环境、操作前后次数和请求关联ID", () => {
    for (const field of [
      "old_device_id",
      "new_device_id",
      "window_count_before",
      "window_count_after",
      "idempotency_key",
      "user_agent"
    ]) {
      expect(migration).toContain(field);
    }
  });

  it("㉓ 用户端不再出现扣30分钟、付费换绑或物理设备识别文案", () => {
    expect(homePage).not.toContain("扣除 30");
    expect(homePage).not.toContain("付费换绑");
    expect(homePage).not.toContain("物理设备");
    expect(homePage).toContain("使用环境");
    expect(homePage).toContain("确认重新绑定");
  });

  it("㉔ 后台不再显示换绑费用，改为滚动窗口配置", () => {
    expect(adminPage).not.toContain("免费次数用完后扣除分钟");
    expect(adminPage).not.toContain("时长兑换");
    expect(adminPage).toContain("滚动窗口天数");
    expect(adminPage).toContain("两次成功操作最小间隔");
  });

  it("轻量异常标记覆盖10次、24小时5次、失败频繁和多UA", () => {
    expect(performFunction).toContain("success_count_24h >= 5");
    expect(performFunction).toContain("failed_count_10m >= 10");
    expect(performFunction).toContain("distinct_user_agents_24h >= 5");
    expect(performFunction).toContain("reactivation_flag_reason");
  });

  it("完整结构和生产迁移保持相同函数、配置与历史字段", () => {
    for (const sql of [schema, migration]) {
      expect(sql).toContain("create table if not exists device_rebind_configs");
      expect(sql).toContain("rebind_window_days integer not null default 15");
      expect(sql).toContain("rebind_max_count integer not null default 10");
      expect(sql).toContain(
        "rebind_min_interval_seconds integer not null default 60"
      );
      expect(sql).toContain("create or replace function get_device_rebind_status");
      expect(sql).toContain("create or replace function perform_device_rebind");
      expect(sql).toContain(
        "create or replace function admin_reset_device_environment"
      );
    }
  });

  it("迁移后验证脚本保持只读并检查三项数据库函数", () => {
    expect(verificationSql).not.toMatch(
      /\b(insert|update|delete|alter|drop|truncate|create)\s+/
    );
    expect(verificationSql).toContain("get_device_rebind_status_exists");
    expect(verificationSql).toContain("perform_device_rebind_exists");
    expect(verificationSql).toContain(
      "admin_reset_device_environment_exists"
    );
  });
});

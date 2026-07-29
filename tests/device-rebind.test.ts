import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { calculateRebindCooldown } from "@/lib/device-rebind-config";
import { evaluateDeviceRebindPolicy } from "@/lib/device-rebind-policy";

const baseInput = {
  currentDeviceId: "device-a",
  requestedDeviceId: "device-b",
  freeRebindCount: 3,
  remainingMinutes: 120,
  costMinutes: 30,
  cooldownRemainingSeconds: 0
};

describe("device rebind policy", () => {
  it("① 首次绑定不消耗免费次数或监督时长", () => {
    expect(
      evaluateDeviceRebindPolicy({ ...baseInput, currentDeviceId: null })
    ).toMatchObject({
      result: "first_bind",
      allowed: true,
      nextFreeRebindCount: 3,
      deductedMinutes: 0,
      nextRemainingMinutes: 120
    });
  });

  it("② 同设备进入不触发换绑", () => {
    expect(
      evaluateDeviceRebindPolicy({
        ...baseInput,
        requestedDeviceId: "device-a"
      })
    ).toMatchObject({
      result: "same_device",
      allowed: true,
      nextFreeRebindCount: 3,
      deductedMinutes: 0
    });
  });

  it("③ 有免费次数时允许换绑", () => {
    expect(evaluateDeviceRebindPolicy(baseInput).result).toBe("free_rebind");
  });

  it("④ 免费换绑后只减少一次免费次数", () => {
    expect(evaluateDeviceRebindPolicy(baseInput)).toMatchObject({
      nextFreeRebindCount: 2,
      deductedMinutes: 0,
      nextRemainingMinutes: 120
    });
  });

  it("⑤ 免费次数耗尽后改用监督时长兑换", () => {
    expect(
      evaluateDeviceRebindPolicy({ ...baseInput, freeRebindCount: 0 })
    ).toMatchObject({
      result: "paid_rebind",
      allowed: true
    });
  });

  it("⑥ 默认规则可精确扣除30分钟", () => {
    expect(
      evaluateDeviceRebindPolicy({ ...baseInput, freeRebindCount: 0 })
    ).toMatchObject({
      deductedMinutes: 30,
      nextRemainingMinutes: 90
    });
  });

  it("⑦ 剩余时长不足配置成本时拒绝且不扣减", () => {
    expect(
      evaluateDeviceRebindPolicy({
        ...baseInput,
        freeRebindCount: 0,
        remainingMinutes: 29
      })
    ).toMatchObject({
      result: "insufficient_minutes",
      allowed: false,
      deductedMinutes: 0,
      nextRemainingMinutes: 29
    });
  });

  it("⑧ 冷却期内拒绝换到另一设备", () => {
    expect(
      evaluateDeviceRebindPolicy({
        ...baseInput,
        cooldownRemainingSeconds: 60
      })
    ).toMatchObject({
      result: "cooldown_active",
      allowed: false,
      nextFreeRebindCount: 3,
      deductedMinutes: 0
    });

    expect(
      calculateRebindCooldown({
        lastRebindAt: "2026-07-29T00:00:00.000Z",
        cooldownHours: 24,
        now: new Date("2026-07-29T01:00:00.000Z")
      }).cooldownRemainingSeconds
    ).toBe(23 * 60 * 60);
  });
});

describe("device rebind database concurrency contract", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "supabase/migration_2026_18_device_rebind_mvp.sql"),
    "utf8"
  ).toLowerCase();
  const schema = readFileSync(
    resolve(process.cwd(), "supabase/schema.sql"),
    "utf8"
  ).toLowerCase();

  it("⑨ 并发换绑通过访问码行锁和同目标设备复检只扣一次", () => {
    expect(migration).toContain("where code = trim(p_access_code)\n  for update");
    expect(migration).toContain("if current_code.device_id = p_new_device_id then");
    expect(migration).toContain("current_code.used_minutes + deducted_minutes");
  });

  it("⑩ 重复点击通过唯一幂等键复用第一次结果", () => {
    expect(migration).toContain("unique (access_code_id, idempotency_key)");
    expect(migration).toContain("and idempotency_key = p_idempotency_key");
    expect(migration).toContain("jsonb_build_object('replayed', true)");
  });

  it("换绑成功会轮换活跃会话令牌，旧设备不能继续调用", () => {
    expect(migration).toContain("set session_token = p_new_session_token");
    expect(migration).toContain("and status = 'active'");
    expect(migration).toContain("and end_time is null");
  });

  it("新环境完整结构和旧环境迁移都包含换绑函数与数据表", () => {
    for (const sql of [schema, migration]) {
      expect(sql).toContain("create table if not exists device_rebind_configs");
      expect(sql).toContain("create table if not exists device_rebind_logs");
      expect(sql).toContain("create or replace function perform_device_rebind");
    }
  });
});

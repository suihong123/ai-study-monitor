import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  executeKeepAliveQuery,
  handleKeepAliveRequest
} from "@/lib/cron-keep-alive";

const cronSecret = "preview-cron-secret";

function cronRequest(secret?: string) {
  return new Request("https://example.test/api/cron/keep-alive", {
    headers: secret ? { authorization: `Bearer ${secret}` } : undefined
  });
}

describe("Supabase keep-alive cron", () => {
  it("未携带正确 Cron Secret 时返回 401 且不查询数据库", async () => {
    const query = vi.fn().mockResolvedValue({ ok: true });
    const response = await handleKeepAliveRequest(cronRequest("wrong"), {
      cronSecret,
      query,
      logError: vi.fn()
    });

    expect(response.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it("正确 Cron Secret 时返回 200 和最小响应", async () => {
    const query = vi.fn().mockResolvedValue({ ok: true });
    const response = await handleKeepAliveRequest(cronRequest(cronSecret), {
      cronSecret,
      query,
      logError: vi.fn()
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("数据库查询失败时返回 500 并只记录脱敏错误码", async () => {
    const logError = vi.fn();
    const response = await handleKeepAliveRequest(cronRequest(cronSecret), {
      cronSecret,
      query: vi.fn().mockResolvedValue({
        ok: false,
        errorCode: "database_read_failed"
      }),
      logError
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false });
    expect(logError).toHaveBeenCalledWith({
      errorCode: "database_read_failed"
    });
  });

  it("只执行 access_codes 的 select id limit 1，不调用写操作", async () => {
    const limit = vi.fn().mockResolvedValue({ data: [{ id: "test-id" }], error: null });
    const select = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ select });
    const client = { from } as unknown as SupabaseClient;

    await expect(executeKeepAliveQuery(client)).resolves.toEqual({ ok: true });
    expect(from).toHaveBeenCalledWith("access_codes");
    expect(select).toHaveBeenCalledWith("id");
    expect(limit).toHaveBeenCalledWith(1);
  });

  it("CRON_SECRET 未配置时失败关闭", async () => {
    const query = vi.fn().mockResolvedValue({ ok: true });
    const response = await handleKeepAliveRequest(cronRequest("anything"), {
      cronSecret: undefined,
      query,
      logError: vi.fn()
    });

    expect(response.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });
});

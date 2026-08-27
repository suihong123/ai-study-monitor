import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAdminRequest } from "@/lib/admin";
import {
  hashHostelLicenseKey,
  isValidHostelLicenseKey,
  normalizeHostelLicenseKey
} from "@/lib/hostel-admin/license-hash";
import {
  buildHostelCursorFilter,
  buildHostelLicenseDetailDTO,
  buildHostelLicenseOverview,
  decodeHostelLicenseCursor,
  encodeHostelLicenseCursor,
  getEffectiveHostelLicenseStatus,
  isHostelRowAfterCursor,
  toHostelActivationDTO,
  toHostelLicenseListItemDTO
} from "@/lib/hostel-admin/repository";
import type {
  HostelActivationRow,
  HostelLicenseRow
} from "@/lib/hostel-admin/types";

const now = new Date("2026-08-25T12:00:00.000Z");
const future = "2027-08-25T12:00:00.000Z";
const past = "2025-08-25T12:00:00.000Z";
const originalAdminPassword = process.env.ADMIN_PASSWORD;

function licenseRow(
  overrides: Partial<HostelLicenseRow> = {}
): HostelLicenseRow {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    status: "unused",
    plan: "commercial",
    max_activations: 2,
    expires_at: future,
    created_at: "2026-08-25T10:00:00.000Z",
    updated_at: "2026-08-25T11:00:00.000Z",
    ...overrides
  };
}

function activationRow(
  overrides: Partial<HostelActivationRow> = {}
): HostelActivationRow {
  return {
    id: "20000000-0000-4000-8000-000000000001",
    license_id: "10000000-0000-4000-8000-000000000001",
    device_name: "测试设备",
    activated_at: "2026-08-25T10:05:00.000Z",
    last_seen_at: "2026-08-25T11:05:00.000Z",
    revoked_at: null,
    ...overrides
  };
}

afterEach(() => {
  if (originalAdminPassword === undefined) {
    delete process.env.ADMIN_PASSWORD;
  } else {
    process.env.ADMIN_PASSWORD = originalAdminPassword;
  }
});

describe("Hostel Admin authorization", () => {
  it("无密码和错误密码均失败，正确密码通过", () => {
    process.env.ADMIN_PASSWORD = "test-admin-password";
    const request = (password?: string) =>
      new NextRequest("https://example.test/api/admin/hostel/overview", {
        headers: password ? { "x-admin-password": password } : undefined
      });

    expect(isAdminRequest(request())).toBe(false);
    expect(isAdminRequest(request("wrong-password"))).toBe(false);
    expect(isAdminRequest(request("test-admin-password"))).toBe(true);
  });

  it("Hostel API 对缺失或错误密码返回401", async () => {
    process.env.ADMIN_PASSWORD = "test-admin-password";
    const { GET } = await import("@/app/api/admin/hostel/overview/route");
    const missing = await GET(
      new NextRequest("https://example.test/api/admin/hostel/overview")
    );
    const wrong = await GET(
      new NextRequest("https://example.test/api/admin/hostel/overview", {
        headers: { "x-admin-password": "wrong-password" }
      })
    );
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
  });

  it("全部 Hostel API 每次执行服务端 Admin 验证并禁止缓存", () => {
    const routeFiles = [
      "app/api/admin/hostel/overview/route.ts",
      "app/api/admin/hostel/licenses/route.ts",
      "app/api/admin/hostel/licenses/search/route.ts",
      "app/api/admin/hostel/licenses/[licenseId]/route.ts",
      "app/api/admin/hostel/licenses/[licenseId]/activations/route.ts"
    ];
    for (const file of routeFiles) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(source).toContain("requireHostelAdmin(request)");
      expect(source).toContain("hostelAdminSupabase");
      expect(source).toContain("@/lib/hostel-admin/supabase");
      expect(source).not.toContain("@/lib/supabase/server");
      expect(source).not.toContain('select("*")');
    }
    const httpSource = readFileSync(
      resolve(process.cwd(), "lib/hostel-admin/http.ts"),
      "utf8"
    );
    expect(httpSource).toContain('"Cache-Control": "private, no-store, max-age=0"');

    const supabaseSource = readFileSync(
      resolve(process.cwd(), "lib/hostel-admin/supabase.ts"),
      "utf8"
    );
    expect(supabaseSource).toContain('cache: "no-store"');
    expect(supabaseSource).toContain("global: { fetch: hostelAdminNoStoreFetch }");
  });

  it("Hostel Admin Supabase 客户端强制覆盖底层 fetch 缓存策略", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { hostelAdminNoStoreFetch } = await import(
        "@/lib/hostel-admin/supabase"
      );
      await hostelAdminNoStoreFetch("https://example.test/rest/v1/hostel_licenses", {
        cache: "force-cache",
        headers: { accept: "application/json" }
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://example.test/rest/v1/hostel_licenses",
        expect.objectContaining({
          cache: "no-store",
          headers: { accept: "application/json" }
        })
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Hostel effective status and overview", () => {
  it("按统一优先级计算 effectiveStatus", () => {
    expect(getEffectiveHostelLicenseStatus("unused", null, now)).toBe("unused");
    expect(getEffectiveHostelLicenseStatus("unused", future, now)).toBe("unused");
    expect(getEffectiveHostelLicenseStatus("activated", future, now)).toBe(
      "activated"
    );
    expect(getEffectiveHostelLicenseStatus("unused", past, now)).toBe("expired");
    expect(getEffectiveHostelLicenseStatus("expired", future, now)).toBe("expired");
    expect(getEffectiveHostelLicenseStatus("revoked", past, now)).toBe("revoked");
    expect(getEffectiveHostelLicenseStatus("revoked", null, now)).toBe("revoked");
    expect(() =>
      getEffectiveHostelLicenseStatus("activated", null, now)
    ).toThrow("invalid_database_value");
    expect(() => getEffectiveHostelLicenseStatus("expired", null, now)).toThrow(
      "invalid_database_value"
    );
  });

  it("Overview 使用 effectiveStatus 而非原始 status", () => {
    expect(
      buildHostelLicenseOverview(
        [
          { status: "unused", expires_at: null },
          { status: "unused", expires_at: future },
          { status: "activated", expires_at: future },
          { status: "unused", expires_at: past },
          { status: "expired", expires_at: future },
          { status: "revoked", expires_at: past }
        ],
        now
      )
    ).toEqual({
      total: 6,
      unused: 2,
      activated: 1,
      expired: 2,
      revoked: 1,
      generatedAt: now.toISOString()
    });
  });
});

describe("Hostel License exact Hash search", () => {
  it("trim、大写、移除 whitespace、保留连字符后计算 UTF-8 SHA-256 lowercase hex", () => {
    const input = "  hostel - abcd - efgh - jklm  ";
    const normalized = "HOSTEL-ABCD-EFGH-JKLM";
    expect(normalizeHostelLicenseKey(input)).toBe(normalized);
    expect(isValidHostelLicenseKey(input)).toBe(true);
    expect(hashHostelLicenseKey(input)).toBe(
      createHash("sha256").update(normalized, "utf8").digest("hex")
    );
  });

  it("拒绝错误前缀、分段和易混淆字符", () => {
    for (const value of [
      "STUDY-ABCD-EFGH-JKLM",
      "HOSTEL-ABCD-EFGH",
      "HOSTEL-ABCI-EFGH-JKLM",
      "HOSTEL-ABCO-EFGH-JKLM",
      "HOSTEL-ABC1-EFGH-JKLM"
    ]) {
      expect(isValidHostelLicenseKey(value)).toBe(false);
      expect(() => hashHostelLicenseKey(value)).toThrow("invalid_license_format");
    }
  });

  it("前端使用 POST Body 且不写入 URL 或浏览器持久存储", () => {
    const source = readFileSync(
      resolve(process.cwd(), "app/admin/_components/HostelAdminPanel.tsx"),
      "utf8"
    );
    expect(source).toContain('fetch("/api/admin/hostel/licenses/search"');
    expect(source).toContain('method: "POST"');
    expect(source).toContain("body: JSON.stringify({ licenseKey: transientLicenseKey })");
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("sessionStorage");
    expect(source).not.toContain("indexedDB");
    expect(source).not.toContain("analytics");
  });
});

describe("Hostel DTO whitelist and activations", () => {
  it("列表 DTO 只返回白名单字段", () => {
    const row = {
      ...licenseRow(),
      owner_id: "owner-redacted",
      key_hash: "hash-redacted"
    } as HostelLicenseRow & { owner_id: string; key_hash: string };
    const dto = toHostelLicenseListItemDTO(row, 1, now);
    expect(dto).toEqual({
      id: row.id,
      status: "unused",
      plan: "commercial",
      maxActivations: 2,
      activeActivationCount: 1,
      expiresAt: future,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
    expect(JSON.stringify(dto)).not.toContain("owner_id");
    expect(JSON.stringify(dto)).not.toContain("key_hash");
  });

  it("unused License 的 nullable 到期时间安全通过 DTO", () => {
    const dto = toHostelLicenseListItemDTO(
      licenseRow({ expires_at: null }),
      0,
      now
    );
    expect(dto.status).toBe("unused");
    expect(dto.expiresAt).toBeNull();
  });

  it("Admin 对 unused + NULL 使用统一说明且筛选兼容新旧库存", () => {
    const panelSource = readFileSync(
      resolve(process.cwd(), "app/admin/_components/HostelAdminPanel.tsx"),
      "utf8"
    );
    const repositorySource = readFileSync(
      resolve(process.cwd(), "lib/hostel-admin/repository.ts"),
      "utf8"
    );
    expect(panelSource).toContain('return "首次激活后开始计算"');
    expect(panelSource).toContain(
      "formatLicenseExpiry(license.status, license.expiresAt)"
    );
    expect(panelSource).toContain(
      "formatLicenseExpiry(detail.status, detail.expiresAt)"
    );
    expect(repositorySource).toContain(
      "expires_at.is.null,expires_at.gt.${nowIso}"
    );
  });

  it("Activation DTO 不返回设备 Hash，并正确区分绑定与可用", () => {
    const bound = {
      ...activationRow(),
      device_hash: "device-hash-redacted"
    } as HostelActivationRow & { device_hash: string };
    const revoked = activationRow({
      id: "20000000-0000-4000-8000-000000000002",
      revoked_at: "2026-08-25T11:30:00.000Z"
    });

    expect(toHostelActivationDTO(bound, "activated")).toMatchObject({
      isBound: true,
      isUsable: true
    });
    expect(toHostelActivationDTO(revoked, "activated")).toMatchObject({
      isBound: false,
      isUsable: false
    });
    expect(JSON.stringify(toHostelActivationDTO(bound, "activated"))).not.toContain(
      "device_hash"
    );
  });

  it("支持0/1/2台设备，过期或撤销 License 的 usableActivationCount 为0", () => {
    expect(buildHostelLicenseDetailDTO(licenseRow(), [], now)).toMatchObject({
      activeActivationCount: 0,
      usableActivationCount: 0,
      activations: []
    });

    expect(
      buildHostelLicenseDetailDTO(
        licenseRow({ status: "activated" }),
        [activationRow()],
        now
      )
    ).toMatchObject({ activeActivationCount: 1, usableActivationCount: 1 });

    const twoDevices = [
      activationRow(),
      activationRow({ id: "20000000-0000-4000-8000-000000000002" })
    ];
    expect(
      buildHostelLicenseDetailDTO(
        licenseRow({ status: "activated", expires_at: past }),
        twoDevices,
        now
      )
    ).toMatchObject({
      status: "expired",
      activeActivationCount: 2,
      usableActivationCount: 0
    });
    expect(
      buildHostelLicenseDetailDTO(
        licenseRow({ status: "revoked" }),
        twoDevices,
        now
      )
    ).toMatchObject({
      status: "revoked",
      activeActivationCount: 2,
      usableActivationCount: 0
    });
  });
});

describe("Hostel keyset pagination", () => {
  it("created_at DESC + id DESC Cursor 无重复、无遗漏", () => {
    const rows = [
      licenseRow({
        id: "10000000-0000-4000-8000-000000000005",
        created_at: "2026-08-25T12:00:00.000Z"
      }),
      licenseRow({
        id: "10000000-0000-4000-8000-000000000004",
        created_at: "2026-08-25T12:00:00.000Z"
      }),
      licenseRow({
        id: "10000000-0000-4000-8000-000000000003",
        created_at: "2026-08-25T11:00:00.000Z"
      }),
      licenseRow({
        id: "10000000-0000-4000-8000-000000000002",
        created_at: "2026-08-25T10:00:00.000Z"
      }),
      licenseRow({
        id: "10000000-0000-4000-8000-000000000001",
        created_at: "2026-08-25T09:00:00.000Z"
      })
    ];
    const firstPage = rows.slice(0, 2);
    const cursor = {
      createdAt: firstPage[1].created_at,
      id: firstPage[1].id
    };
    const encoded = encodeHostelLicenseCursor(cursor);
    expect(decodeHostelLicenseCursor(encoded)).toEqual(cursor);
    expect(buildHostelCursorFilter(cursor)).toContain("created_at.lt.");
    const remaining = rows.filter((row) => isHostelRowAfterCursor(row, cursor));
    expect(remaining.map((row) => row.id)).toEqual(rows.slice(2).map((row) => row.id));
    expect(new Set([...firstPage, ...remaining].map((row) => row.id)).size).toBe(
      rows.length
    );
  });

  it("Repository 使用批量 activation 查询且不包含写操作或 Study 表", () => {
    const source = readFileSync(
      resolve(process.cwd(), "lib/hostel-admin/repository.ts"),
      "utf8"
    );
    expect(source).toContain('.from("hostel_licenses")');
    expect(source).toContain('.from("hostel_license_activations")');
    expect(source).toContain('.in("license_id", licenseIds)');
    expect(source).toContain('.order("created_at", { ascending: false })');
    expect(source).toContain('.order("id", { ascending: false })');
    expect(source).not.toMatch(/\.insert\s*\(/);
    expect(source).not.toMatch(/\.update\s*\(/);
    expect(source).not.toMatch(/\.upsert\s*\(/);
    expect(source).not.toMatch(/\.delete\s*\(/);
    expect(source).not.toMatch(/\.rpc\s*\(/);
    expect(source).not.toContain('.from("access_codes")');
    expect(source).not.toContain('.from("sessions")');
    expect(source).not.toContain('select("*")');
  });
});

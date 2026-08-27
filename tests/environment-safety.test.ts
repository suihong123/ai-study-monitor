import { describe, expect, it } from "vitest";
import {
  assertSupabaseEnvironmentSafety,
  projectRefFromSupabaseUrl
} from "@/lib/environment-safety";

describe("部署环境与 Supabase 隔离", () => {
  it("可从标准 Supabase URL 提取 project ref", () => {
    expect(
      projectRefFromSupabaseUrl(
        "https://testprojectref00001.supabase.co"
      )
    ).toBe("testprojectref00001");
    expect(projectRefFromSupabaseUrl("https://example.com")).toBeNull();
  });

  it("测试环境只允许连接预期测试项目", () => {
    expect(() =>
      assertSupabaseEnvironmentSafety({
        appEnvironment: "staging",
        supabaseUrl: "https://testprojectref00001.supabase.co",
        expectedProjectRef: "testprojectref00001",
        forbiddenProjectRef: "prodprojectref000001"
      })
    ).not.toThrow();
  });

  it("测试环境拒绝生产项目", () => {
    expect(() =>
      assertSupabaseEnvironmentSafety({
        appEnvironment: "staging",
        supabaseUrl: "https://prodprojectref000001.supabase.co",
        expectedProjectRef: "testprojectref00001",
        forbiddenProjectRef: "prodprojectref000001"
      })
    ).toThrow("禁止连接非预期 Supabase 项目");
  });

  it("生产环境拒绝测试项目或缺失隔离配置", () => {
    expect(() =>
      assertSupabaseEnvironmentSafety({
        appEnvironment: "production",
        supabaseUrl: "https://testprojectref00001.supabase.co",
        expectedProjectRef: "prodprojectref000001",
        forbiddenProjectRef: "testprojectref00001"
      })
    ).toThrow();
    expect(() =>
      assertSupabaseEnvironmentSafety({
        appEnvironment: "production",
        supabaseUrl: "https://prodprojectref000001.supabase.co"
      })
    ).toThrow("缺少 Supabase URL 或预期 project ref");
  });

  it("未声明的本地开发环境保持兼容", () => {
    expect(() =>
      assertSupabaseEnvironmentSafety({
        supabaseUrl: undefined,
        expectedProjectRef: undefined
      })
    ).not.toThrow();
  });
});

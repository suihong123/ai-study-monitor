import { describe, expect, it } from "vitest";
import {
  hasEligibleTrendRecords,
  isEligibleTrendSession
} from "@/lib/report-trend";

describe("recent learning trend eligibility", () => {
  it("requires at least five real recognition records", () => {
    expect(
      hasEligibleTrendRecords(
        Array.from({ length: 4 }, () => ({ analyze_mode: "qwen" }))
      )
    ).toBe(false);
    expect(
      hasEligibleTrendRecords([
        { analyze_mode: "qwen" },
        { analyze_mode: "qwen" },
        { analyze_mode: "mock" },
        { analyze_mode: "qwen" },
        { analyze_mode: "qwen" }
      ])
    ).toBe(false);
  });

  it("accepts five or more non-mock recognition records", () => {
    expect(
      hasEligibleTrendRecords(
        Array.from({ length: 5 }, () => ({ analyze_mode: "qwen" }))
      )
    ).toBe(true);
  });

  it("requires ten minutes and at least fifty percent coverage", () => {
    expect(
      isEligibleTrendSession({ durationMinutes: 9, dataCoverageRate: 80 })
    ).toBe(false);
    expect(
      isEligibleTrendSession({ durationMinutes: 10, dataCoverageRate: 49 })
    ).toBe(false);
    expect(
      isEligibleTrendSession({ durationMinutes: 10, dataCoverageRate: 50 })
    ).toBe(true);
  });
});

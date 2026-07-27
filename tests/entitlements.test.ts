import { describe, expect, it } from "vitest";
import {
  calculateChargeableMinutes,
  calculateElapsedWholeMinutes,
  calculateSessionDurationMinutes,
  remainingMinutes
} from "@/lib/entitlements";
import { defaultPlanConfigs, planTotalMinutes } from "@/lib/plans";

describe("total-time entitlements", () => {
  it("uses only total and used minutes to calculate remaining access", () => {
    expect(remainingMinutes(120, 0)).toBe(120);
    expect(remainingMinutes(120, 119)).toBe(1);
    expect(remainingMinutes(120, 120)).toBe(0);
    expect(remainingMinutes(120, 150)).toBe(0);
  });

  it("rounds a completed supervision session up to the next minute", () => {
    expect(
      calculateSessionDurationMinutes(
        "2026-07-27T10:00:00.000Z",
        "2026-07-27T10:00:01.000Z"
      )
    ).toBe(1);
    expect(
      calculateSessionDurationMinutes(
        "2026-07-27T10:00:00.000Z",
        "2026-07-27T10:01:01.000Z"
      )
    ).toBe(2);
  });

  it("does not stop an active session before its last whole minute is used", () => {
    expect(
      calculateElapsedWholeMinutes(
        "2026-07-27T10:00:00.000Z",
        "2026-07-27T10:00:59.000Z"
      )
    ).toBe(0);
    expect(
      calculateElapsedWholeMinutes(
        "2026-07-27T10:00:00.000Z",
        "2026-07-27T10:01:00.000Z"
      )
    ).toBe(1);
  });

  it("never charges more than the remaining total minutes", () => {
    expect(
      calculateChargeableMinutes(
        "2026-07-27T10:00:00.000Z",
        "2026-07-27T10:30:00.000Z",
        120,
        119
      )
    ).toBe(1);
  });

  it("keeps all current plans on real basic reports", () => {
    expect(
      Object.values(defaultPlanConfigs).every(
        (plan) => plan.report_level === "basic"
      )
    ).toBe(true);
    expect(planTotalMinutes).toEqual({
      trial: 120,
      basic_monthly: 3600,
      standard_monthly: 10800,
      pro_monthly: 43200
    });
  });
});

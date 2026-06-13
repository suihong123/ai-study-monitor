import type { PlanConfig, PlanType } from "@/types";

export const defaultPlanConfigs: Record<PlanType, Omit<PlanConfig, "id" | "created_at">> = {
  trial: {
    plan_type: "trial",
    name: "2小时体验版",
    daily_minutes: 120,
    base_interval_seconds: 90,
    min_interval_seconds: 60,
    report_level: "basic",
    price_suggest: "适合首次体验"
  },
  basic_monthly: {
    plan_type: "basic_monthly",
    name: "基础月卡",
    daily_minutes: 120,
    base_interval_seconds: 90,
    min_interval_seconds: 60,
    report_level: "basic",
    price_suggest: "适合每天2小时作业监督"
  },
  standard_monthly: {
    plan_type: "standard_monthly",
    name: "标准月卡",
    daily_minutes: 180,
    base_interval_seconds: 60,
    min_interval_seconds: 30,
    report_level: "standard",
    price_suggest: "适合每天3小时作业监督"
  },
  pro_monthly: {
    plan_type: "pro_monthly",
    name: "强化月卡",
    daily_minutes: 240,
    base_interval_seconds: 30,
    min_interval_seconds: 15,
    report_level: "advanced",
    price_suggest: "适合每天4小时高强度监督"
  }
};

export const planTotalMinutes: Record<PlanType, number> = {
  trial: 120,
  basic_monthly: 3600,
  standard_monthly: 5400,
  pro_monthly: 7200
};

export function getTodayKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

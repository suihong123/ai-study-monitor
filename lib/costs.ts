import type { ReportLevel } from "@/types";

export const costConfig = {
  visionAnalyzeCost: 0.003,
  reportCosts: {
    basic: 0,
    standard: 0.03,
    advanced: 0.1
  } satisfies Record<ReportLevel, number>
};

export function estimateVisionCost(count: number) {
  return Number((count * costConfig.visionAnalyzeCost).toFixed(3));
}

export function estimateReportCost(reportLevel: ReportLevel) {
  return costConfig.reportCosts[reportLevel];
}

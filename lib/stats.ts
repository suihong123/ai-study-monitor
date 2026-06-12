import type { ReportLevel, StudyRecord, StudyStats, StudyStatus } from "@/types";
import { costConfig } from "@/lib/costs";

export function calculateStats(records: StudyRecord[], durationMinutes?: number): StudyStats {
  const total = records.length;
  const count = (status: StudyStatus) =>
    records.filter((record) => record.status === status).length;
  const studyingCount = count("studying");
  const totalMinutes = durationMinutes ?? total;
  const focusRate = total === 0 ? 0 : Math.round((studyingCount / total) * 100);

  const distractedCount = count("distracted");
  const awayCount = count("away");
  const lyingCount = count("lying");
  const unrelatedCount = count("unrelated");
  let longestStudyingStreak = 0;
  let currentStudyingStreak = 0;
  records.forEach((record) => {
    if (record.status === "studying") {
      currentStudyingStreak += 1;
      longestStudyingStreak = Math.max(longestStudyingStreak, currentStudyingStreak);
    } else {
      currentStudyingStreak = 0;
    }
  });

  return {
    totalMinutes,
    effectiveMinutes: total === 0 ? 0 : Math.round((totalMinutes * studyingCount) / total),
    focusRate,
    studyingCount,
    distractedCount,
    awayCount,
    lyingCount,
    unrelatedCount,
    unknownCount: count("unknown"),
    abnormalCount: distractedCount + awayCount + lyingCount + unrelatedCount,
    reminderCount: records.filter((record) => record.triggered_reminder).length,
    longestFocusMinutes: longestStudyingStreak
  };
}

export function formatMinutes(minutes: number) {
  return `${Math.max(0, Math.round(minutes))}分钟`;
}

const reportCosts: Record<ReportLevel, number> = {
  basic: costConfig.reportCosts.basic,
  standard: costConfig.reportCosts.standard,
  advanced: costConfig.reportCosts.advanced
};

export function estimateCost(aiCallCount: number, reportLevel: ReportLevel) {
  return Number((aiCallCount * costConfig.visionAnalyzeCost + reportCosts[reportLevel]).toFixed(3));
}

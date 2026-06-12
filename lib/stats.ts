import type { LearningState, Presence, ReportLevel, StudyRecord, StudyStats } from "@/types";
import { costConfig } from "@/lib/costs";

export function calculateStats(records: StudyRecord[], durationMinutes?: number): StudyStats {
  const total = records.length;
  const normalized = records.map(normalizeRecordState);
  const countLearning = (state: LearningState) =>
    normalized.filter((record) => record.learningState === state && record.presence === "present").length;
  const countAway = () => normalized.filter((record) => record.presence === "away").length;
  const studyingCount = countLearning("studying");
  const thinkingCount = countLearning("thinking");
  const effectiveCount = studyingCount + thinkingCount;
  const totalMinutes = durationMinutes ?? total;
  const focusRate = total === 0 ? 0 : Math.round((effectiveCount / total) * 100);

  const suspectedDistractedCount = countLearning("suspected_distracted");
  const distractedCount = suspectedDistractedCount;
  const awayCount = countAway();
  const lyingCount = records.filter((record) => !record.learning_state && record.status === "lying").length;
  const unrelatedCount = records.filter((record) => !record.learning_state && record.status === "unrelated").length;
  const unknownCount = normalized.filter(
    (record) => record.presence === "present" && record.learningState === "unknown"
  ).length;
  let longestStudyingStreak = 0;
  let currentStudyingStreak = 0;
  normalized.forEach((record) => {
    if (
      record.presence === "present" &&
      (record.learningState === "studying" || record.learningState === "thinking")
    ) {
      currentStudyingStreak += 1;
      longestStudyingStreak = Math.max(longestStudyingStreak, currentStudyingStreak);
    } else {
      currentStudyingStreak = 0;
    }
  });

  return {
    totalMinutes,
    effectiveMinutes: total === 0 ? 0 : Math.round((totalMinutes * effectiveCount) / total),
    focusRate,
    studyingCount,
    thinkingCount,
    suspectedDistractedCount,
    distractedCount,
    awayCount,
    lyingCount,
    unrelatedCount,
    unknownCount,
    abnormalCount: distractedCount + awayCount + lyingCount + unrelatedCount,
    reminderCount: records.filter((record) => record.triggered_reminder).length,
    longestFocusMinutes: longestStudyingStreak
  };
}

export function normalizeRecordState(record: StudyRecord): {
  presence: Presence;
  learningState: LearningState;
} {
  if (record.presence && record.learning_state) {
    return {
      presence: record.presence,
      learningState: record.learning_state
    };
  }

  if (record.status === "studying") {
    return { presence: "present", learningState: "studying" };
  }
  if (record.status === "distracted" || record.status === "unrelated") {
    return { presence: "present", learningState: "suspected_distracted" };
  }
  if (record.status === "away") {
    return { presence: "away", learningState: "unknown" };
  }
  return { presence: "present", learningState: "unknown" };
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

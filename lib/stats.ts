import type { LearningState, Presence, ReportLevel, StudyRecord, StudyStats } from "@/types";
import { costConfig } from "@/lib/costs";

export function calculateStats(records: StudyRecord[], durationMinutes?: number): StudyStats {
  const total = records.length;
  const normalized = records.map(normalizeRecordState);
  const countLearning = (state: LearningState) =>
    normalized.filter((record) => record.learningState === state && record.presence === "present").length;
  const countAway = () => normalized.filter((record) => record.presence === "away").length;
  const studyingCount = countLearning("studying");
  const uncertainCount = countLearning("uncertain");
  const thinkingCount = 0;
  const effectiveCount = studyingCount;
  const totalMinutes = durationMinutes ?? total;
  const focusRate = total === 0 ? 0 : Math.round((effectiveCount / total) * 100);

  const suspectedDistractedCount = 0;
  const distractedCount = 0;
  const awayCount = countAway();
  const lyingCount = 0;
  const unrelatedCount = 0;
  const unknownCount = uncertainCount;
  let longestStudyingStreak = 0;
  let currentStudyingStreak = 0;
  normalized.forEach((record) => {
    if (
      record.presence === "present" &&
      record.learningState === "studying"
    ) {
      currentStudyingStreak += 1;
      longestStudyingStreak = Math.max(longestStudyingStreak, currentStudyingStreak);
    } else {
      currentStudyingStreak = 0;
    }
  });
  const reminderEffectiveness = calculateReminderEffectiveness(records);

  return {
    totalMinutes,
    effectiveMinutes: total === 0 ? 0 : Math.round((totalMinutes * effectiveCount) / total),
    focusRate,
    studyingCount,
    uncertainCount,
    thinkingCount,
    suspectedDistractedCount,
    distractedCount,
    awayCount,
    lyingCount,
    unrelatedCount,
    unknownCount,
    abnormalCount: awayCount,
    reminderCount: reminderEffectiveness.reminderCount,
    effectiveReminderCount: reminderEffectiveness.effectiveReminderCount,
    reminderResponseRate: reminderEffectiveness.reminderResponseRate,
    averageRecoverySeconds: reminderEffectiveness.averageRecoverySeconds,
    longestFocusMinutes: longestStudyingStreak
  };
}

export function calculateReminderEffectiveness(records: StudyRecord[]) {
  const reminders = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record.triggered_reminder);
  const recoverySeconds: number[] = [];

  reminders.forEach(({ record, index }) => {
    const reminderAt = new Date(record.timestamp).getTime();
    const following = records.slice(index + 1, index + 4);
    const recovered = following.find((candidate) => {
      const candidateAt = new Date(candidate.timestamp).getTime();
      const state = normalizeRecordState(candidate);
      return (
        Number.isFinite(reminderAt) &&
        Number.isFinite(candidateAt) &&
        candidateAt >= reminderAt &&
        candidateAt - reminderAt <= 3 * 60 * 1000 &&
        state.presence === "present" &&
        state.learningState === "studying"
      );
    });

    if (recovered) {
      recoverySeconds.push(
        Math.max(0, Math.round((new Date(recovered.timestamp).getTime() - reminderAt) / 1000))
      );
    }
  });

  const reminderCount = reminders.length;
  const effectiveReminderCount = recoverySeconds.length;
  return {
    reminderCount,
    effectiveReminderCount,
    reminderResponseRate:
      reminderCount === 0 ? 0 : Math.round((effectiveReminderCount / reminderCount) * 100),
    averageRecoverySeconds:
      effectiveReminderCount === 0
        ? 0
        : Math.round(
            recoverySeconds.reduce((sum, seconds) => sum + seconds, 0) /
              effectiveReminderCount
          )
  };
}

export function normalizeRecordState(record: StudyRecord): {
  presence: Presence;
  learningState: LearningState;
} {
  if (record.presence && record.learning_state) {
    return {
      presence: record.presence,
      learningState: record.learning_state === "studying" ? "studying" : "uncertain"
    };
  }

  if (record.status === "studying") {
    return { presence: "present", learningState: "studying" };
  }
  if (record.status === "distracted" || record.status === "unrelated") {
    return { presence: "present", learningState: "uncertain" };
  }
  if (record.status === "away") {
    return { presence: "away", learningState: "uncertain" };
  }
  return { presence: "present", learningState: "uncertain" };
}

export function calculateLearningInsights(records: StudyRecord[], durationMinutes?: number) {
  const normalized = records.map(normalizeRecordState);
  const studyingCount = normalized.filter(
    (record) => record.presence === "present" && record.learningState === "studying"
  ).length;
  const uncertainCount = normalized.filter(
    (record) => record.presence === "present" && record.learningState === "uncertain"
  ).length;
  const thinkingCount = 0;
  const distractedCount = 0;
  const awayCount = normalized.filter((record) => record.presence === "away").length;
  const unknownCount = uncertainCount;
  const accountableCount = studyingCount + uncertainCount + awayCount;
  const focusRate =
    accountableCount === 0
      ? 0
      : Math.round((studyingCount / accountableCount) * 100);
  const baseMinutes = durationMinutes ?? accountableCount;

  return {
    studyingCount,
    uncertainCount,
    thinkingCount,
    distractedCount,
    awayCount,
    unknownCount,
    accountableCount,
    focusRate,
    grade: learningGrade(focusRate),
    gradeText: learningGradeText(focusRate),
    studyingPercent: percentage(studyingCount, accountableCount),
    uncertainPercent: percentage(uncertainCount, accountableCount),
    thinkingPercent: 0,
    distractedPercent: percentage(distractedCount, accountableCount),
    awayPercent: percentage(awayCount, accountableCount),
    studyingMinutes: estimatedMinutes(studyingCount, accountableCount, baseMinutes),
    uncertainMinutes: estimatedMinutes(uncertainCount, accountableCount, baseMinutes),
    thinkingMinutes: 0,
    abnormalMinutes: estimatedMinutes(awayCount, accountableCount, baseMinutes)
  };
}

function percentage(value: number, total: number) {
  return total === 0 ? 0 : Math.round((value / total) * 100);
}

function estimatedMinutes(value: number, total: number, durationMinutes: number) {
  return total === 0 ? 0 : Math.round((durationMinutes * value) / total);
}

function learningGrade(focusRate: number) {
  if (focusRate >= 90) return "A";
  if (focusRate >= 80) return "B+";
  if (focusRate >= 70) return "B";
  if (focusRate >= 60) return "C";
  return "D";
}

function learningGradeText(focusRate: number) {
  if (focusRate >= 90) return "专注表现优秀";
  if (focusRate >= 80) return "整体表现良好";
  if (focusRate >= 70) return "学习状态基本稳定";
  if (focusRate >= 60) return "学习证据偏少，建议优化拍摄角度";
  return "离座或证据不足较多，建议关注学习过程";
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

import type { DataConfidence, LearningState, Presence, ReportLevel, StudyRecord, StudyStats } from "@/types";
import { costConfig } from "@/lib/costs";

export function calculateStats(records: StudyRecord[], durationMinutes?: number): StudyStats {
  const normalized = records.map(normalizeRecordState);
  const countLearning = (state: LearningState) =>
    normalized.filter((record) => record.learningState === state && record.presence === "present").length;
  const countAway = () => normalized.filter((record) => record.presence === "away").length;
  const studyingCount = countLearning("studying");
  const uncertainCount = countLearning("uncertain");
  const thinkingCount = 0;
  const timeMetrics = calculateTimeMetrics(records, durationMinutes);
  const totalMinutes = timeMetrics.totalMinutes;
  const focusRate = timeMetrics.focusRate;

  const suspectedDistractedCount = 0;
  const distractedCount = 0;
  const awayCount = countAway();
  const lyingCount = 0;
  const unrelatedCount = 0;
  const unknownCount = uncertainCount;
  const reminderEffectiveness = calculateReminderEffectiveness(records);

  return {
    totalMinutes,
    observedMinutes: timeMetrics.observedMinutes,
    dataCoverageRate: timeMetrics.dataCoverageRate,
    dataConfidence: timeMetrics.dataConfidence,
    effectiveMinutes: timeMetrics.studyingMinutes,
    uncertainMinutes: timeMetrics.uncertainMinutes,
    awayMinutes: timeMetrics.awayMinutes,
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
    longestFocusMinutes: timeMetrics.longestFocusMinutes
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
  const timeMetrics = calculateTimeMetrics(records, durationMinutes);

  return {
    studyingCount,
    uncertainCount,
    thinkingCount,
    distractedCount,
    awayCount,
    unknownCount,
    accountableCount,
    focusRate: timeMetrics.focusRate,
    grade: learningGrade(timeMetrics.focusRate),
    gradeText: learningGradeText(timeMetrics.focusRate),
    studyingPercent: percentage(timeMetrics.studyingSeconds, timeMetrics.observedSeconds),
    uncertainPercent: percentage(timeMetrics.uncertainSeconds, timeMetrics.observedSeconds),
    thinkingPercent: 0,
    distractedPercent: percentage(distractedCount, accountableCount),
    awayPercent: percentage(timeMetrics.awaySeconds, timeMetrics.observedSeconds),
    studyingMinutes: timeMetrics.studyingMinutes,
    uncertainMinutes: timeMetrics.uncertainMinutes,
    thinkingMinutes: 0,
    abnormalMinutes: timeMetrics.awayMinutes,
    observedMinutes: timeMetrics.observedMinutes,
    dataCoverageRate: timeMetrics.dataCoverageRate,
    dataConfidence: timeMetrics.dataConfidence
  };
}

function percentage(value: number, total: number) {
  return total === 0 ? 0 : Math.round((value / total) * 100);
}

function calculateTimeMetrics(records: StudyRecord[], durationMinutes?: number) {
  const sorted = [...records].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
  const timestamps = sorted.map((record) => new Date(record.timestamp).getTime());
  const validDeltas = timestamps
    .slice(0, -1)
    .map((timestamp, index) => (timestamps[index + 1] - timestamp) / 1000)
    .filter((seconds) => Number.isFinite(seconds) && seconds > 0 && seconds <= 300)
    .sort((a, b) => a - b);
  const medianInterval = validDeltas.length
    ? validDeltas[Math.floor(validDeltas.length / 2)]
    : 60;
  const inferredSeconds =
    sorted.length === 0
      ? 0
      : Math.max(
          60,
          (timestamps[timestamps.length - 1] - timestamps[0]) / 1000 + medianInterval
        );
  const totalSeconds = Math.max(
    0,
    durationMinutes === undefined ? inferredSeconds : durationMinutes * 60
  );
  let studyingSeconds = 0;
  let uncertainSeconds = 0;
  let awaySeconds = 0;
  let longestFocusSeconds = 0;
  let currentFocusSeconds = 0;

  sorted.forEach((record, index) => {
    const state = normalizeRecordState(record);
    const expectedInterval = Math.min(
      300,
      Math.max(15, Number(record.current_frequency_seconds ?? medianInterval))
    );
    const rawInterval =
      index < sorted.length - 1
        ? (timestamps[index + 1] - timestamps[index]) / 1000
        : expectedInterval;
    const maxCredibleInterval = Math.min(300, Math.max(60, expectedInterval * 1.5));
    const seconds = Math.max(
      0,
      Math.min(Number.isFinite(rawInterval) ? rawInterval : expectedInterval, maxCredibleInterval)
    );

    if (state.presence === "away") {
      awaySeconds += seconds;
      currentFocusSeconds = 0;
    } else if (state.learningState === "studying") {
      studyingSeconds += seconds;
      currentFocusSeconds += seconds;
      longestFocusSeconds = Math.max(longestFocusSeconds, currentFocusSeconds);
    } else {
      uncertainSeconds += seconds;
      currentFocusSeconds = 0;
    }
  });

  const rawObservedSeconds = studyingSeconds + uncertainSeconds + awaySeconds;
  if (totalSeconds > 0 && rawObservedSeconds > totalSeconds) {
    const scale = totalSeconds / rawObservedSeconds;
    studyingSeconds *= scale;
    uncertainSeconds *= scale;
    awaySeconds *= scale;
    longestFocusSeconds *= scale;
  }
  const observedSeconds = studyingSeconds + uncertainSeconds + awaySeconds;
  const focusRate =
    observedSeconds === 0 ? 0 : Math.round((studyingSeconds / observedSeconds) * 100);
  const dataCoverageRate =
    totalSeconds === 0 ? 0 : Math.min(100, Math.round((observedSeconds / totalSeconds) * 100));
  const uncertainRate =
    observedSeconds === 0 ? 1 : uncertainSeconds / observedSeconds;
  const manualCorrectionRate =
    records.length === 0
      ? 0
      : records.filter((record) => record.manual_corrected).length / records.length;
  const hasMockRecords = records.some((record) => (record.analyze_mode ?? "mock") === "mock");
  const dataConfidence: DataConfidence =
    records.length < 5 || hasMockRecords || dataCoverageRate < 50
      ? "low"
      : dataCoverageRate >= 80 && uncertainRate <= 0.2 && manualCorrectionRate <= 0.2
      ? "high"
      : "medium";

  return {
    totalMinutes: Math.max(0, Math.round(totalSeconds / 60)),
    observedSeconds,
    studyingSeconds,
    uncertainSeconds,
    awaySeconds,
    observedMinutes: roundMinutes(observedSeconds),
    studyingMinutes: roundMinutes(studyingSeconds),
    uncertainMinutes: roundMinutes(uncertainSeconds),
    awayMinutes: roundMinutes(awaySeconds),
    longestFocusMinutes: Number((longestFocusSeconds / 60).toFixed(1)),
    focusRate,
    dataCoverageRate,
    dataConfidence
  };
}

function roundMinutes(seconds: number) {
  return Number((seconds / 60).toFixed(1));
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

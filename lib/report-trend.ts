import type { HabitTrendSession, StudyRecord } from "@/types";

export function hasEligibleTrendRecords(
  records: Pick<StudyRecord, "analyze_mode">[]
) {
  return (
    records.length >= 5 &&
    records.every((record) => (record.analyze_mode ?? "mock") !== "mock")
  );
}

export function isEligibleTrendSession(
  session: Pick<HabitTrendSession, "durationMinutes" | "dataCoverageRate">
) {
  return session.durationMinutes >= 10 && session.dataCoverageRate >= 50;
}

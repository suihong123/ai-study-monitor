"use client";

import { statusLabels, type LearningState, type Presence, type StudyStatus } from "@/types";

const styles: Record<StudyStatus, string> = {
  studying: "border-brand bg-emerald-50 text-brand",
  distracted: "border-warn bg-amber-50 text-warn",
  away: "border-alert bg-red-50 text-alert",
  lying: "border-alert bg-red-50 text-alert",
  unrelated: "border-warn bg-orange-50 text-warn",
  unknown: "border-muted bg-white text-muted"
};

export function StatusBadge({
  status,
  presence,
  learningState
}: {
  status: StudyStatus;
  presence?: Presence;
  learningState?: LearningState;
}) {
  return (
    <span
      className={`inline-flex min-h-9 items-center rounded-md border px-3 py-1 text-sm font-semibold ${styles[status]}`}
    >
      {displayStatus(status, presence, learningState)}
    </span>
  );
}

function displayStatus(status: StudyStatus, presence?: Presence, learningState?: LearningState) {
  const currentPresence = presence ?? (status === "away" ? "away" : "present");
  const currentLearningState =
    learningState ??
    (status === "studying"
      ? "studying"
      : status === "distracted" || status === "unrelated"
      ? "suspected_distracted"
      : "unknown");

  if (currentPresence === "away") return "离座";
  if (currentLearningState === "studying") return "在位 · 学习中";
  if (currentLearningState === "thinking") return "在位 · 思考中";
  if (currentLearningState === "suspected_distracted") return "在位 · 疑似走神";
  return statusLabels[status] === "离座" ? "在位 · 无法判断" : "在位 · 无法判断";
}

"use client";

import { statusLabels, type StudyStatus } from "@/types";

const styles: Record<StudyStatus, string> = {
  studying: "border-brand bg-emerald-50 text-brand",
  distracted: "border-warn bg-amber-50 text-warn",
  away: "border-alert bg-red-50 text-alert",
  lying: "border-alert bg-red-50 text-alert",
  unrelated: "border-warn bg-orange-50 text-warn",
  unknown: "border-muted bg-white text-muted"
};

export function StatusBadge({ status }: { status: StudyStatus }) {
  return (
    <span
      className={`inline-flex min-h-9 items-center rounded-md border px-3 py-1 text-sm font-semibold ${styles[status]}`}
    >
      {statusLabels[status]}
    </span>
  );
}

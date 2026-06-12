"use client";

import { formatMinutes } from "@/lib/stats";

export function Timer({
  label,
  minutes
}: {
  label: string;
  minutes: number;
}) {
  return (
    <div className="rounded-md border border-line bg-white p-4">
      <div className="text-sm text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-ink">
        {formatMinutes(minutes)}
      </div>
    </div>
  );
}

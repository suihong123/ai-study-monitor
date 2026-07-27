export function remainingMinutes(totalMinutes: number, usedMinutes: number) {
  const total = Number.isFinite(totalMinutes) ? totalMinutes : 0;
  const used = Number.isFinite(usedMinutes) ? usedMinutes : 0;
  return Math.max(0, total - used);
}

export function calculateSessionDurationMinutes(startTime: string, endTime: string) {
  const start = new Date(startTime).getTime();
  const end = new Date(endTime).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 1;
  return Math.max(1, Math.ceil(Math.max(0, end - start) / 60_000));
}

export function calculateElapsedWholeMinutes(startTime: string, currentTime: string) {
  const start = new Date(startTime).getTime();
  const current = new Date(currentTime).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(current)) return 0;
  return Math.max(0, Math.floor(Math.max(0, current - start) / 60_000));
}

export function calculateChargeableMinutes(
  startTime: string,
  endTime: string,
  totalMinutes: number,
  usedMinutes: number
) {
  return Math.min(
    calculateSessionDurationMinutes(startTime, endTime),
    remainingMinutes(totalMinutes, usedMinutes)
  );
}

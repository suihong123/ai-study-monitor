export type ReportHistoryEntry = {
  sessionId: string;
  reportToken: string;
  startTime: string;
  endTime: string;
};

const storageKey = "study-report-history";

export function saveReportHistory(entry: ReportHistoryEntry) {
  const current = loadReportHistory().filter((item) => item.sessionId !== entry.sessionId);
  window.localStorage.setItem(storageKey, JSON.stringify([entry, ...current].slice(0, 20)));
}

export function loadReportHistory(): ReportHistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(storageKey);
    return raw ? (JSON.parse(raw) as ReportHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

export function reportUrl(entry: Pick<ReportHistoryEntry, "sessionId" | "reportToken">) {
  return `/report?session_id=${encodeURIComponent(entry.sessionId)}&token=${encodeURIComponent(entry.reportToken)}`;
}

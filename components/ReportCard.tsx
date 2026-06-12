import { statusLabels, type ReportLevel, type StudyRecord, type StudyStats } from "@/types";

type Trend = Record<string, string> | null;

export function ReportCard({
  stats,
  conclusion,
  parentAdvice,
  records,
  reportLevel,
  trend
}: {
  stats: StudyStats;
  conclusion: string;
  parentAdvice: string;
  records: StudyRecord[];
  reportLevel: ReportLevel;
  trend: Trend;
}) {
  const coreItems = [
    ["总学习时长", `${stats.totalMinutes}分钟`],
    ["有效学习时长", `${stats.effectiveMinutes}分钟`],
    ["专注率", `${stats.focusRate}%`],
    ["异常次数", `${stats.abnormalCount}次`]
  ];

  const statusItems = [
    ["正常学习", stats.studyingCount],
    ["走神", stats.distractedCount],
    ["离座", stats.awayCount],
    ["趴桌", stats.lyingCount],
    ["无关物品", stats.unrelatedCount]
  ];

  return (
    <section className="w-full space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {coreItems.map(([label, value]) => (
          <div key={label} className="rounded-md border border-line bg-white p-4">
            <div className="text-sm text-muted">{label}</div>
            <div className="mt-1 text-2xl font-semibold">{value}</div>
          </div>
        ))}
      </div>

      <div className="rounded-md border border-line bg-white p-5">
        <h2 className="text-lg font-semibold">状态分布</h2>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {statusItems.map(([label, value]) => (
            <div key={label} className="rounded-md bg-panel p-3">
              <div className="text-sm text-muted">{label}</div>
              <div className="mt-1 text-xl font-semibold">{value}次</div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-md border border-line bg-white p-5">
        <h2 className="text-lg font-semibold">时间线</h2>
        <div className="mt-4 max-h-72 space-y-2 overflow-auto">
          {records.length === 0 ? (
            <p className="text-sm text-muted">暂无识别记录。</p>
          ) : (
            records.map((record, index) => (
              <div
                key={`${record.timestamp}-${index}`}
                className="flex items-center justify-between rounded-md bg-panel px-3 py-2 text-sm"
              >
                <span>{new Date(record.timestamp).toLocaleTimeString("zh-CN")}</span>
                <span className="font-medium">{statusLabels[record.status]}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <div className="rounded-md border border-line bg-white p-5">
          <h2 className="text-lg font-semibold">本次学习结论</h2>
          <p className="mt-3 leading-7 text-muted">{conclusion}</p>
        </div>
        <div className="rounded-md border border-line bg-white p-5">
          <h2 className="text-lg font-semibold">给家长的建议</h2>
          <p className="mt-3 leading-7 text-muted">{parentAdvice}</p>
        </div>
      </div>

      {reportLevel !== "basic" && trend && (
        <div className="rounded-md border border-line bg-white p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">趋势分析</h2>
            <span className="rounded-md bg-panel px-3 py-1 text-sm text-muted">
              {reportLevel === "advanced" ? "深度报告" : "标准报告"}
            </span>
          </div>
          <div className="mt-4 grid gap-3">
            {Object.entries(trend).map(([key, value]) => (
              <div key={key} className="rounded-md bg-panel p-3">
                <div className="text-sm font-medium text-ink">{trendTitle(key)}</div>
                <div className="mt-1 text-sm leading-6 text-muted">{value}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function trendTitle(key: string) {
  const titles: Record<string, string> = {
    declinePeriod: "专注下降时间段",
    statusSummary: "学习状态总结",
    segmentSuggestion: "是否建议分段学习",
    sevenDayTrend: "最近7天趋势",
    weekOverWeek: "与上周同比",
    distractionWindow: "最容易走神时间段",
    learningProfile: "学习状态画像",
    interventionAdvice: "家长干预建议"
  };
  return titles[key] ?? key;
}

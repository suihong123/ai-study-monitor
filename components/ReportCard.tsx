"use client";

import { useState } from "react";
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
  const [expanded, setExpanded] = useState(false);
  const isMockMode = records.length === 0 || records.some((record) => (record.analyze_mode ?? "mock") === "mock");
  const visibleRecords = expanded ? records : records.slice(0, 20);
  const totalStatusCount =
    stats.studyingCount +
    stats.distractedCount +
    stats.awayCount +
    stats.lyingCount +
    stats.unrelatedCount +
    stats.unknownCount;
  const summary = isMockMode
    ? "当前为测试模式，本次报告用于检查监督流程、摄像头角度和报告展示效果。"
    : buildOneLineSummary(stats);

  const coreItems = [
    ["总监督时长", `${stats.totalMinutes}分钟`],
    ["有效学习时长", `${stats.effectiveMinutes}分钟`],
    ["专注率", `${stats.focusRate}%`],
    ["异常次数", `${stats.abnormalCount}次`],
    ["提醒次数", `${stats.reminderCount}次`],
    ["最长连续专注时长", `${stats.longestFocusMinutes}分钟`]
  ];

  const statusItems = [
    ["学习中", stats.studyingCount],
    ["走神", stats.distractedCount],
    ["离座", stats.awayCount],
    ["趴桌", stats.lyingCount],
    ["玩无关物品", stats.unrelatedCount],
    ["无法判断", stats.unknownCount]
  ];

  return (
    <section className="w-full space-y-5">
      <div className="rounded-md border border-line bg-white p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold">本次总结</h2>
          {isMockMode && (
            <span className="rounded-md bg-amber-50 px-2 py-1 text-xs font-semibold text-warn">
              测试模式
            </span>
          )}
        </div>
        <p className="mt-3 text-lg leading-8">{summary}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {coreItems.map(([label, value]) => (
          <div key={label} className="rounded-md border border-line bg-white p-4">
            <div className="text-sm text-muted">{label}</div>
            <div className="mt-1 text-2xl font-semibold">{value}</div>
          </div>
        ))}
      </div>

      <div className="rounded-md border border-line bg-white p-5">
        <h2 className="text-lg font-semibold">{isMockMode ? "测试关键事件" : "关键事件"}</h2>
        <div className="mt-3 space-y-2 text-sm leading-6 text-muted">
          {buildKeyEvents(records, stats).map((item) => (
            <div key={item} className="rounded-md bg-panel p-3">{item}</div>
          ))}
        </div>
      </div>

      <div className="rounded-md border border-line bg-white p-5">
        <h2 className="text-lg font-semibold">状态分布</h2>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {statusItems.map(([label, value]) => (
            <div key={label} className="rounded-md bg-panel p-3">
              <div className="text-sm text-muted">{label}</div>
              <div className="mt-1 text-xl font-semibold">{value}次</div>
              <div className="mt-1 text-sm text-muted">
                占比 {totalStatusCount === 0 ? 0 : Math.round((Number(value) / totalStatusCount) * 100)}%
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-md border border-line bg-white p-5">
        <h2 className="text-lg font-semibold">学习结论</h2>
        <p className="mt-3 whitespace-pre-line leading-7 text-muted">{conclusion}</p>
      </div>

      <div className="rounded-md border border-line bg-white p-5">
        <h2 className="text-lg font-semibold">给家长的建议</h2>
        <p className="mt-3 whitespace-pre-line leading-7 text-muted">{parentAdvice}</p>
      </div>

      <div className="rounded-md border border-line bg-white p-5">
        <h2 className="text-lg font-semibold">时间线详情</h2>
        <div className="mt-4 space-y-3">
          {visibleRecords.length === 0 ? (
            <p className="text-sm text-muted">暂无识别记录。</p>
          ) : (
            visibleRecords.map((record, index) => (
              <div key={`${record.timestamp}-${index}`} className="rounded-md bg-panel p-3 text-sm">
                <div className="font-semibold">
                  {new Date(record.timestamp).toLocaleTimeString("zh-CN")}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="rounded-md bg-white px-2 py-1 font-medium">
                    {statusLabels[record.status]}
                  </span>
                  <span className="text-muted">
                    {record.triggered_reminder ? "已提醒" : "未提醒"}
                  </span>
                  {record.manual_corrected && (
                    <span className="rounded-md bg-amber-50 px-2 py-1 text-warn">
                      已手动纠正
                    </span>
                  )}
                </div>
                {record.reason && (
                  <div className="mt-2 leading-6 text-muted">{record.reason}</div>
                )}
              </div>
            ))
          )}
        </div>
        {records.length > 20 && !expanded && (
          <button
            onClick={() => setExpanded(true)}
            className="mt-4 rounded-md border border-line px-4 py-2 text-sm font-medium"
          >
            展开更多
          </button>
        )}
      </div>

      {reportLevel !== "basic" && trend && !isMockMode && (
        <div className="rounded-md border border-line bg-white p-5">
          <h2 className="text-lg font-semibold">趋势分析</h2>
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

function buildOneLineSummary(stats: StudyStats) {
  if (stats.focusRate >= 80) return "本次学习整体稳定，专注状态保持较好。";
  if (stats.focusRate >= 60) return "本次学习基本完成，中途出现一定分心，需要关注节奏。";
  if (stats.focusRate >= 40) return "本次学习专注度偏低，建议缩短单次学习时长。";
  return "本次学习异常较多，建议优先检查学习环境和任务难度。";
}

function buildKeyEvents(records: StudyRecord[], stats: StudyStats) {
  return [
    `本次共出现 ${stats.abnormalCount} 次异常状态`,
    `最集中异常时段：${findAbnormalWindow(records)}`,
    stats.longestFocusMinutes > 0
      ? `最长连续专注时长约 ${stats.longestFocusMinutes} 分钟`
      : "本次没有检测到连续稳定学习时段",
    `本次触发提醒 ${stats.reminderCount} 次`
  ];
}

function findAbnormalWindow(records: StudyRecord[]) {
  const abnormal = records.filter((record) =>
    ["distracted", "away", "lying", "unrelated"].includes(record.status)
  );
  if (abnormal.length === 0) return "未出现集中异常";
  const first = abnormal[0];
  const last = abnormal[Math.min(abnormal.length - 1, 2)];
  return `${formatMinute(first.timestamp)}-${formatMinute(last.timestamp)}`;
}

function formatMinute(value: string) {
  return new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  });
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

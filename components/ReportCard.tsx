"use client";

import { useState } from "react";
import { normalizeRecordState } from "@/lib/stats";
import { type HabitTrend, type ReportLevel, type StudyRecord, type StudyStats } from "@/types";

type Trend = Record<string, string> | null;
type HighlightTone = "brand" | "warn" | "alert" | "neutral";

export function ReportCard({
  stats,
  conclusion,
  parentAdvice,
  records,
  reportLevel,
  trend,
  habitTrend
}: {
  stats: StudyStats;
  conclusion: string;
  parentAdvice: string;
  records: StudyRecord[];
  reportLevel: ReportLevel;
  trend: Trend;
  habitTrend?: HabitTrend | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const isMockMode =
    records.length === 0 ||
    records.some((record) => (record.analyze_mode ?? "mock") === "mock");
  const insufficientData =
    stats.totalMinutes < 10 || records.length < 5 || (stats.dataCoverageRate ?? 0) < 50;
  const awayEventCount = countAwayEvents(records);
  const overview = buildReportOverview(stats, records, insufficientData, isMockMode);
  const focusItems = buildFocusItems(stats, records, insufficientData);
  const nextActions = buildNextActions(stats, insufficientData);
  const keyEvents = buildEventTimeline(records);
  const visibleRecords = expanded ? records : buildKeyTimeline(records).slice(0, 12);

  const keyMetrics = [
    ["总监督", `${stats.totalMinutes}分钟`],
    ["明确学习", `${stats.effectiveMinutes}分钟`],
    ["离座事件", `${awayEventCount}次`],
    ["提醒次数", `${stats.reminderCount}次`]
  ];

  const detailMetrics = [
    ["明确学习占比", records.length >= 5 ? `${stats.focusRate}%` : "数据采集中"],
    ["画面可用性", `${stats.dataCoverageRate ?? 0}%`],
    ["无法判断", `${stats.uncertainMinutes}分钟`],
    ["离座时长", `${stats.awayMinutes}分钟`],
    ["最长连续学习", `${stats.longestFocusMinutes}分钟`],
    ["提醒恢复率", stats.reminderCount > 0 ? `${stats.reminderResponseRate ?? 0}%` : "暂无提醒"]
  ];

  return (
    <section className="w-full space-y-5">
      <div className="rounded-md border border-line bg-white p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold">学习表现总览</h2>
          {isMockMode && (
            <span className="rounded-md bg-amber-50 px-2 py-1 text-xs font-semibold text-warn">
              测试模式
            </span>
          )}
        </div>
        <p className="mt-3 text-lg leading-8 text-ink">{overview.summary}</p>

        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          {keyMetrics.map(([label, value]) => (
            <div key={label} className="rounded-md bg-panel p-3">
              <div className="text-sm text-muted">{label}</div>
              <div className="mt-1 text-2xl font-semibold">{value}</div>
            </div>
          ))}
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <HighlightBox
            title="本次最该关注"
            content={overview.concern}
            tone={overview.concernTone}
          />
          <HighlightBox
            title="下次怎么做"
            content={overview.nextStep}
            tone="neutral"
          />
        </div>
      </div>

      <div className="rounded-md border border-line bg-white p-5">
        <h2 className="text-lg font-semibold">学习表现诊断</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {focusItems.map((item) => (
            <div key={item.title} className={`rounded-md p-4 ${toneClass(item.tone)}`}>
              <div className="text-sm font-medium text-ink">{item.title}</div>
              <p className="mt-2 text-sm leading-6 text-muted">{item.content}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-md border border-line bg-white p-5">
        <h2 className="text-lg font-semibold">习惯养成趋势</h2>
        <p className="mt-3 text-sm leading-6 text-muted">
          {habitTrend?.summary ??
            "趋势分析需要积累足够的数据样本。继续完成多次有效监督后，可观察平均连续学习时间是否提升。"}
        </p>
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          {[
            ["趋势样本", `${habitTrend?.sampleCount ?? 0}/${habitTrend?.requiredSampleCount ?? 3}次`],
            ["平均连续学习", habitTrend?.isEnoughData ? `${habitTrend.currentAverageFocusMinutes}分钟` : "样本不足"],
            ["本次最长连续", `${habitTrend?.currentLongestFocusMinutes ?? stats.longestFocusMinutes}分钟`],
            ["提醒后恢复率", habitTrend?.isEnoughData ? `${habitTrend.averageReminderResponseRate}%` : "样本不足"]
          ].map(([label, value]) => (
            <div key={label} className="rounded-md bg-panel p-3">
              <div className="text-sm text-muted">{label}</div>
              <div className="mt-1 text-xl font-semibold">{value}</div>
            </div>
          ))}
        </div>
        {habitTrend?.sessions && habitTrend.sessions.length > 0 && (
          <div className="mt-4 space-y-2">
            {habitTrend.sessions.slice(-5).map((item, index) => (
              <div key={item.sessionId} className="rounded-md bg-panel p-3 text-sm leading-6">
                <div className="font-medium">第 {index + 1} 次：{formatDate(item.startTime)}</div>
                <div className="text-muted">
                  平均连续学习 {item.averageFocusMinutes} 分钟 / 最长 {item.longestFocusMinutes} 分钟 / 中断 {item.interruptionCount} 次
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-md border border-line bg-white p-5">
        <h2 className="text-lg font-semibold">本次关键节点</h2>
        <div className="mt-4 space-y-3">
          {keyEvents.length === 0 ? (
            <p className="text-sm leading-6 text-muted">
              本次识别记录较少，暂未形成关键节点。建议完成至少10分钟监督后再查看。
            </p>
          ) : (
            keyEvents.map((event, index) => (
              <div key={`${event.time}-${index}`} className="rounded-md bg-panel p-3 text-sm">
                <div className="font-semibold">{event.time}</div>
                <div className="mt-1 text-ink">{event.title}</div>
                {event.detail && (
                  <div className="mt-1 leading-5 text-muted">{event.detail}</div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      <div className="rounded-md border border-line bg-white p-5">
        <h2 className="text-lg font-semibold">给家长的建议</h2>
        <div className="mt-3 space-y-2 text-sm leading-6 text-muted">
          {nextActions.map((item) => (
            <div key={item} className="rounded-md bg-panel p-3">{item}</div>
          ))}
        </div>
      </div>

      <div className="rounded-md border border-line bg-white p-5">
        <h2 className="text-lg font-semibold">趋势分析</h2>
        <div className="mt-3 rounded-md bg-amber-50 p-4 text-sm leading-6 text-warn">
          {buildTrendMessage(reportLevel, trend, records, insufficientData, habitTrend)}
        </div>
      </div>

      <details className="rounded-md border border-line bg-white p-5">
        <summary className="cursor-pointer text-lg font-semibold">详细数据</summary>
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3">
          {detailMetrics.map(([label, value]) => (
            <div key={label} className="rounded-md bg-panel p-3">
              <div className="text-sm text-muted">{label}</div>
              <div className="mt-1 text-xl font-semibold">{value}</div>
            </div>
          ))}
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3">
          {[
            ["学习中", stats.studyingCount],
            ["无法判断", stats.uncertainCount],
            ["离座", stats.awayCount]
          ].map(([label, value]) => (
            <div key={label} className="rounded-md bg-panel p-3">
              <div className="text-sm text-muted">{label}</div>
              <div className="mt-1 text-xl font-semibold">{value}次</div>
            </div>
          ))}
        </div>
      </details>

      <div className="rounded-md border border-line bg-white p-5">
        <h2 className="text-lg font-semibold">{expanded ? "全部识别记录" : "过程记录"}</h2>
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
                    {displayStateText(record)}
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
        {records.length > visibleRecords.length && !expanded && (
          <button
            onClick={() => setExpanded(true)}
            className="mt-4 rounded-md border border-line px-4 py-2 text-sm font-medium"
          >
            查看全部识别记录
          </button>
        )}
      </div>

      <div className="rounded-md border border-line bg-white p-5">
        <h2 className="text-lg font-semibold">原始结论</h2>
        <p className="mt-3 whitespace-pre-line leading-7 text-muted">
          {insufficientData ? "数据量或数据覆盖不足，当前不生成学习诊断。" : conclusion}
        </p>
        <p className="mt-3 whitespace-pre-line leading-7 text-muted">
          {insufficientData
            ? "建议先完成一段不少于10分钟的监督，确认摄像头角度、识别记录和报告生成流程稳定后，再参考学习建议。"
            : parentAdvice}
        </p>
      </div>
    </section>
  );
}

function HighlightBox({
  title,
  content,
  tone
}: {
  title: string;
  content: string;
  tone: HighlightTone;
}) {
  return (
    <div className={`rounded-md p-4 ${toneClass(tone)}`}>
      <div className="text-sm font-medium text-ink">{title}</div>
      <p className="mt-2 text-sm leading-6 text-muted">{content}</p>
    </div>
  );
}

function toneClass(tone: HighlightTone) {
  if (tone === "brand") return "bg-blue-50";
  if (tone === "warn") return "bg-amber-50";
  if (tone === "alert") return "bg-red-50";
  return "bg-panel";
}

function buildReportOverview(
  stats: StudyStats,
  records: StudyRecord[],
  insufficientData: boolean,
  isMockMode: boolean
) {
  const awayEventCount = countAwayEvents(records);

  if (insufficientData) {
    return {
      summary: "本次数据样本不足，暂不判断学习表现。建议完成至少10分钟监督后再查看报告。",
      concern: "当前最需要关注的是数据是否足够，而不是孩子表现本身。",
      concernTone: "warn" as HighlightTone,
      nextStep: "下次请保持页面前台运行，并确保摄像头能看到上半身、双手和桌面。"
    };
  }

  if (isMockMode) {
    return {
      summary: "当前为测试数据，本报告主要用于验证监督流程和报告展示效果。",
      concern: "测试模式下不要根据报告判断孩子真实学习状态。",
      concernTone: "warn" as HighlightTone,
      nextStep: "建议重点测试摄像头角度、提醒声音和报告生成流程。"
    };
  }

  const summary = `本次监督 ${stats.totalMinutes} 分钟，明确学习约 ${stats.effectiveMinutes} 分钟，离座事件 ${awayEventCount} 次，触发提醒 ${stats.reminderCount} 次。`;

  if (awayEventCount >= 2) {
    return {
      summary,
      concern: "本次最需要关注的是中途离座偏多，学习连续性受到影响。",
      concernTone: "alert" as HighlightTone,
      nextStep: "学习前先准备好水杯、文具和作业材料，减少中途离开座位。"
    };
  }

  if (stats.dataConfidence !== "high" || stats.uncertainCount >= 3) {
    return {
      summary,
      concern: "本次画面可用性一般，部分时间无法稳定判断学习状态。",
      concernTone: "warn" as HighlightTone,
      nextStep: "手机放在孩子侧前方45度，尽量同时看到上半身、双手和作业区域。"
    };
  }

  if (stats.focusRate >= 80) {
    return {
      summary,
      concern: "本次学习过程整体稳定，能看到较多明确学习行为。",
      concernTone: "brand" as HighlightTone,
      nextStep: "继续保持当前学习环境，结束后让孩子用1分钟复盘完成情况。"
    };
  }

  return {
    summary,
    concern: "本次明确学习行为占比不高，需要结合任务难度和学习环境继续观察。",
    concernTone: "warn" as HighlightTone,
    nextStep: "建议先采用20到25分钟短监督，逐步建立稳定学习节奏。"
  };
}

function buildFocusItems(
  stats: StudyStats,
  records: StudyRecord[],
  insufficientData: boolean
) {
  const awayEventCount = countAwayEvents(records);
  const coverageText =
    stats.dataConfidence === "high"
      ? "本次画面覆盖较稳定，报告参考价值较高。"
      : "本次画面覆盖还不够稳定，建议优先改善拍摄角度。";

  return [
    {
      title: "学习连续性",
      content: insufficientData
        ? "数据不足，暂不判断连续学习情况。"
        : stats.longestFocusMinutes > 0
        ? `最长连续明确学习约 ${stats.longestFocusMinutes} 分钟。`
        : "本次没有形成明显连续学习片段。",
      tone: stats.longestFocusMinutes >= 10 ? "brand" as HighlightTone : "neutral" as HighlightTone
    },
    {
      title: "离座情况",
      content:
        awayEventCount === 0
          ? "本次没有形成明显离座事件。"
          : `本次出现 ${awayEventCount} 次离座事件，需要关注学习前准备是否充分。`,
      tone: awayEventCount >= 2 ? "alert" as HighlightTone : "neutral" as HighlightTone
    },
    {
      title: "画面可用性",
      content: coverageText,
      tone: stats.dataConfidence === "high" ? "brand" as HighlightTone : "warn" as HighlightTone
    }
  ];
}

function buildNextActions(stats: StudyStats, insufficientData: boolean) {
  if (insufficientData) {
    return [
      "先完成一段不少于10分钟的监督，积累足够识别记录。",
      "监督时保持手机固定，避免页面切后台或锁屏。",
      "确保画面能看到孩子上半身、双手、桌面和作业区域。"
    ];
  }

  const actions: string[] = [];
  if (stats.awayCount >= 2) {
    actions.push("学习前准备好水杯、文具、作业材料，减少中途离座。");
  }
  if (stats.uncertainCount >= 3 || stats.dataConfidence !== "high") {
    actions.push("调整手机角度，优先保证能看到双手和作业区域。");
  }
  if (stats.focusRate < 70) {
    actions.push("下次先用20到25分钟一段的短监督，降低单次学习压力。");
  }
  if (stats.reminderCount > 0 && (stats.reminderResponseRate ?? 0) < 50) {
    actions.push("提醒后恢复不明显时，建议家长检查任务是否过难或环境是否有持续干扰。");
  }
  if (actions.length === 0) {
    actions.push("继续保持当前学习环境，结束后让孩子简短复盘完成内容。");
  }
  return actions;
}

function buildKeyTimeline(records: StudyRecord[]) {
  return records.filter((record, index) => {
    if (index === 0 || index === records.length - 1) return true;
    if (record.triggered_reminder || record.manual_corrected) return true;
    const current = normalizeRecordState(record);
    const previous = normalizeRecordState(records[index - 1]);
    return (
      current.presence !== previous.presence ||
      current.learningState !== previous.learningState
    );
  });
}

function buildEventTimeline(records: StudyRecord[]) {
  const events: Array<{ time: string; title: string; detail?: string }> = [];
  const keyRecords = buildKeyTimeline(records).slice(0, 8);

  keyRecords.forEach((record, index) => {
    const state = normalizeRecordState(record);
    const previous = index > 0 ? normalizeRecordState(keyRecords[index - 1]) : null;
    const time = formatMinute(record.timestamp);

    if (index === 0) {
      events.push({
        time,
        title: `开始记录：${displayStateText(record)}`,
        detail: record.triggered_reminder ? "本次记录触发了提醒。" : undefined
      });
      return;
    }

    if (!previous || state.presence !== previous.presence || state.learningState !== previous.learningState) {
      events.push({
        time,
        title: displayTransitionTitle(record),
        detail: record.triggered_reminder
          ? "系统已提醒。"
          : record.manual_corrected
          ? "用户已手动标记。"
          : undefined
      });
      return;
    }

    if (record.triggered_reminder || record.manual_corrected) {
      events.push({
        time,
        title: record.triggered_reminder ? "触发提醒" : "用户手动标记",
        detail: displayStateText(record)
      });
    }
  });

  return events;
}

function displayTransitionTitle(record: StudyRecord) {
  const state = normalizeRecordState(record);
  if (state.presence === "away") return "检测到离座";
  if (state.learningState === "studying") return "恢复到明确学习";
  return "画面证据不足";
}

function countAwayEvents(records: StudyRecord[]) {
  let count = 0;
  let previousAway = false;

  records.forEach((record) => {
    const isAway = normalizeRecordState(record).presence === "away";
    if (isAway && !previousAway) count += 1;
    previousAway = isAway;
  });

  return count;
}

function buildTrendMessage(
  reportLevel: ReportLevel,
  trend: Trend,
  records: StudyRecord[],
  insufficientData: boolean,
  habitTrend?: HabitTrend | null
) {
  if (!habitTrend || !habitTrend.isEnoughData) {
    return "趋势分析需要积累足够的数据样本。建议至少完成3次有效监督后，再观察平均连续学习时间是否提升、提醒后恢复是否变快、中断次数是否减少。";
  }

  if (habitTrend.direction === "improving") {
    return "最近几次监督显示，平均连续学习时间有提升迹象。当前更适合继续保持监督节奏，帮助孩子把外部提醒逐步变成学习习惯。";
  }

  if (habitTrend.direction === "declining") {
    return "最近几次监督显示，平均连续学习时间有所下降。建议先排查任务难度、学习环境和拍摄稳定性，再缩短单次学习目标。";
  }

  if (insufficientData || records.length < 20) {
    return "本次单次数据仍偏少，但历史样本已可开始观察习惯趋势。建议继续稳定使用，重点看连续学习时间是否逐渐变长。";
  }

  if (reportLevel === "basic") {
    return "最近几次监督表现基本稳定。当前阶段建议重点观察平均连续学习时间，而不是单次离座或短暂发呆。";
  }

  if (!trend) {
    return "当前历史样本不足，暂不生成趋势判断。";
  }

  return "已有一定识别记录，但长期趋势仍需要更多天的监督样本支撑。当前阶段建议关注平均连续学习时间和提醒后恢复率是否持续改善。";
}

function displayStateText(record: StudyRecord) {
  const state = normalizeRecordState(record);
  if (state.presence === "away") return "离座";
  if (state.learningState === "studying") return "在位 · 学习中";
  return "在位 · 无法判断";
}

function formatMinute(value: string) {
  return new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit"
  });
}

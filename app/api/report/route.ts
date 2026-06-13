import { NextRequest, NextResponse } from "next/server";
import { estimateReportCost } from "@/lib/costs";
import { checkRateLimit, logAiCall, logError, validateSessionRequest } from "@/lib/security";
import { calculateStats } from "@/lib/stats";
import type { ReportLevel, ReportPayload, StudyRecord } from "@/types";

function findDeclinePeriod(records: StudyRecord[]) {
  const midpoint = Math.floor(records.length / 2);
  if (records.length < 6) return "样本较少，暂不判断明显下降时段。";

  const firstHalf = records.slice(0, midpoint);
  const secondHalf = records.slice(midpoint);
  const firstFocus = firstHalf.filter((r) => r.status === "studying").length;
  const secondFocus = secondHalf.filter((r) => r.status === "studying").length;

  return secondFocus < firstFocus
    ? "后半段专注记录减少，建议关注学习后半程疲劳。"
    : "本次未发现明显专注下降时段。";
}

function buildBasicConclusion(stats: ReturnType<typeof calculateStats>) {
  if (stats.focusRate >= 80) return "本次学习状态较好，整体专注度较高。";
  if (stats.focusRate >= 60) return "本次学习有一定明确学习行为，也存在部分证据不足记录。";
  if (stats.focusRate >= 40) return "本次明确学习行为占比偏低，建议缩短单次学习时间并优化拍摄角度。";
  return "本次离座或证据不足较多，建议家长关注学习环境、拍摄角度和任务难度。";
}

function buildParentAdvice(stats: ReturnType<typeof calculateStats>) {
  const advice: string[] = [];
  if (stats.awayCount >= 2) {
    advice.push("本次离座次数较多，建议家长关注学习前是否准备充分，例如水杯、文具、作业材料。");
  }
  if (stats.uncertainCount >= 3) {
    advice.push("本次证据不足记录较多，建议调整手机角度，确保能看到孩子上半身、双手和作业区域。");
  }
  const unknownRate =
    stats.studyingCount +
      stats.awayCount +
      stats.uncertainCount ===
    0
      ? 0
      : stats.uncertainCount /
        (stats.studyingCount +
          stats.awayCount +
          stats.uncertainCount);
  if (unknownRate > 0.2) {
    advice.push("建议调整手机角度，确保画面能看到孩子上半身、桌面和双手。");
  }
  if (stats.focusRate >= 80) {
    advice.push("建议保持当前学习节奏。");
  }
  if (advice.length === 0) {
    advice.push("建议保持当前学习安排，结束后用简短复盘帮助孩子确认完成情况。");
  }
  return advice.join("\n");
}

function buildMockTrend(reportLevel: ReportLevel, records: StudyRecord[]) {
  if (reportLevel === "basic") return null;

  const base = {
    declinePeriod: findDeclinePeriod(records),
    statusSummary: "学习前段进入状态较快，中后段需要关注是否能持续看到明确学习行为。",
    segmentSuggestion: records.length >= 50 ? "建议分段学习" : "暂不强制分段"
  };

  if (reportLevel === "standard") return base;

  return {
    ...base,
    sevenDayTrend: "最近7天专注率模拟趋势：68% -> 72% -> 70% -> 76% -> 74% -> 78% -> 80%。",
    weekOverWeek: "与上周同比模拟提升约6个百分点。",
    distractionWindow: "证据不足高发时间段模拟为学习开始后35-50分钟。",
    learningProfile: "学习状态画像：启动较快，明确学习行为记录中等，后半程更依赖环境稳定。",
    interventionAdvice: "家长可在第30分钟安排一次短暂停顿，帮助孩子确认剩余任务。"
  };
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  const body = (await request.json()) as Partial<ReportPayload>;
  const auth = await validateSessionRequest(request, body);
  if (!auth.ok) return auth.response;

  const limited = await checkRateLimit({
    request,
    kind: "report",
    accessCodeId: auth.context.accessCode.id
  });
  if (!limited.ok) {
    return NextResponse.json({ error: "报告生成过于频繁" }, { status: 429 });
  }

  const records: StudyRecord[] = body.records ?? [];
  const stats = body.stats ?? calculateStats(records);
  const reportLevel = auth.context.accessCode.report_level as ReportLevel;
  const isMockMode = records.length === 0 || records.some((record) => (record.analyze_mode ?? "mock") === "mock");
  const insufficientData = stats.totalMinutes < 10 || records.length < 5;
  const conclusion = insufficientData
    ? "数据量不足，本报告仅供测试。当前不生成专注率结论和学习诊断。"
    : isMockMode
    ? "当前为测试数据，本次报告仅用于验证监督流程。正式接入 AI 视觉识别后，将根据真实学习状态生成分析。"
    : buildBasicConclusion(stats);
  const parentAdvice = insufficientData
    ? "建议先完成一段不少于10分钟的监督，确认摄像头角度、识别记录和报告生成流程稳定后，再参考学习建议。"
    : isMockMode
    ? "当前为测试数据，建议先重点测试摄像头角度、监督流程和报告展示效果。"
    : buildParentAdvice(stats);
  const trend = buildMockTrend(reportLevel, records);

  const summary = [
    records.length >= 5
      ? `本次学习总时长${stats.totalMinutes}分钟，有效学习${stats.effectiveMinutes}分钟，专注率${stats.focusRate}%。`
      : `本次学习总时长${stats.totalMinutes}分钟，有效学习${stats.effectiveMinutes}分钟，专注率数据采集中。`,
    conclusion,
    parentAdvice
  ].join("\n");

  const output = {
    summary,
    conclusion,
    parentAdvice,
    trend,
    stats,
    reportLevel,
    provider: reportLevel === "basic" ? "template" : "mock-deepseek"
  };

  try {
    await logAiCall({
      sessionId: auth.context.session.id,
      accessCodeId: auth.context.accessCode.id,
      modelType: `report_${reportLevel}`,
      status: "success",
      inputSize: JSON.stringify(records).length,
      outputSize: JSON.stringify(output).length,
      estimatedCost: estimateReportCost(reportLevel),
      latencyMs: Date.now() - startedAt
    });
  } catch (error) {
    await logError({
      sessionId: auth.context.session.id,
      accessCodeId: auth.context.accessCode.id,
      errorType: "report接口失败",
      errorMessage: error instanceof Error ? error.message : "报告调用日志写入失败"
    });
  }

  return NextResponse.json(output);
}

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
  if (stats.focusRate >= 80) return "本次学习专注度较好，有效学习时间占比较高。";
  if (stats.focusRate >= 60) return "本次学习基本完成，但中途存在一定走神或姿态问题。";
  return "本次有效学习占比偏低，建议家长关注任务难度、休息节奏和桌面干扰。";
}

function buildParentAdvice(stats: ReturnType<typeof calculateStats>) {
  if (stats.awayCount > 0) return "建议开始前准备好文具、水杯和作业清单，减少中途离座。";
  if (stats.lyingCount > 0) return "建议调整桌椅高度和灯光，提醒孩子保持稳定坐姿。";
  if (stats.distractedCount >= 3) return "建议采用25分钟学习+5分钟休息模式，降低连续学习疲劳。";
  return "建议保持当前学习安排，结束后用简短复盘帮助孩子确认完成情况。";
}

function buildMockTrend(reportLevel: ReportLevel, records: StudyRecord[]) {
  if (reportLevel === "basic") return null;

  const base = {
    declinePeriod: findDeclinePeriod(records),
    statusSummary: "学习前段进入状态较快，中后段需要关注任务切换和疲劳。",
    segmentSuggestion: records.length >= 50 ? "建议分段学习" : "暂不强制分段"
  };

  if (reportLevel === "standard") return base;

  return {
    ...base,
    sevenDayTrend: "最近7天专注率模拟趋势：68% -> 72% -> 70% -> 76% -> 74% -> 78% -> 80%。",
    weekOverWeek: "与上周同比模拟提升约6个百分点。",
    distractionWindow: "最容易走神时间段模拟为学习开始后35-50分钟。",
    learningProfile: "学习状态画像：启动较快，持续专注能力中等，后半程更依赖环境稳定。",
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
  const conclusion = buildBasicConclusion(stats);
  const parentAdvice = buildParentAdvice(stats);
  const trend = buildMockTrend(reportLevel, records);

  const summary = [
    `本次学习总时长${stats.totalMinutes}分钟，有效学习${stats.effectiveMinutes}分钟，专注率${stats.focusRate}%。`,
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

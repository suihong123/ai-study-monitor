import { NextRequest, NextResponse } from "next/server";
import { estimateReportCost } from "@/lib/costs";
import { checkRateLimit, logAiCall, logError } from "@/lib/security";
import { calculateStats } from "@/lib/stats";
import { supabaseAdmin } from "@/lib/supabase/server";
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
  if (stats.focusRate >= 80) return "本次明确学习行为占比较高，学习过程整体稳定。";
  if (stats.focusRate >= 60) return "本次学习有一定明确学习行为，也存在部分证据不足记录。";
  if (stats.focusRate >= 40) return "本次明确学习行为占比偏低，建议缩短单次学习时间并优化拍摄角度。";
  return "本次离座或证据不足较多，建议家长关注学习环境、拍摄角度和任务难度。";
}

function buildParentAdvice(stats: ReturnType<typeof calculateStats>) {
  const advice: string[] = [];
  if (stats.awayCount >= 2) {
    advice.push("本次离座识别记录较多，建议家长关注学习前是否准备充分，例如水杯、文具、作业材料。");
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
    advice.push("建议保持当前的学习节奏和桌面环境。");
  }
  if (stats.reminderCount >= 2 && (stats.reminderResponseRate ?? 0) < 50) {
    advice.push("本次提醒后恢复学习的比例偏低，建议检查任务是否过难，或学习环境是否存在持续干扰。");
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

async function generateReport(
  request: NextRequest,
  params: Partial<ReportPayload>,
  logGeneration: boolean
) {
  const startedAt = Date.now();
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Supabase环境变量未配置" }, { status: 500 });
  }
  if (!params.sessionId || !params.reportToken) {
    return NextResponse.json({ error: "报告访问参数无效" }, { status: 400 });
  }

  const { data: session, error: sessionError } = await supabaseAdmin
    .from("sessions")
    .select("*")
    .eq("id", params.sessionId)
    .eq("report_token", params.reportToken)
    .maybeSingle();
  if (sessionError) {
    return NextResponse.json({ error: sessionError.message }, { status: 500 });
  }
  if (!session || !session.end_time || !["completed", "expired"].includes(session.status)) {
    return NextResponse.json({ error: "报告不存在或监督尚未结束" }, { status: 404 });
  }

  const [{ data: recordsData, error: recordsError }, { data: accessCode, error: codeError }] =
    await Promise.all([
      supabaseAdmin
        .from("records")
        .select("*")
        .eq("session_id", session.id)
        .order("timestamp", { ascending: true }),
      supabaseAdmin
        .from("access_codes")
        .select("id, report_level")
        .eq("id", session.access_code_id)
        .single()
    ]);
  if (recordsError || codeError) {
    return NextResponse.json(
      { error: recordsError?.message ?? codeError?.message ?? "报告数据读取失败" },
      { status: 500 }
    );
  }

  if (logGeneration) {
    const limited = await checkRateLimit({
      request,
      kind: "report",
      accessCodeId: accessCode.id
    });
    if (!limited.ok) {
      return NextResponse.json({ error: "报告生成过于频繁" }, { status: 429 });
    }
  }

  const records = (recordsData ?? []) as StudyRecord[];
  const stats = calculateStats(records, session.duration_minutes ?? undefined);
  const reportLevel = (session.report_level ?? accessCode.report_level ?? "basic") as ReportLevel;
  const isMockMode = records.length === 0 || records.some((record) => (record.analyze_mode ?? "mock") === "mock");
  const insufficientData =
    stats.totalMinutes < 10 || records.length < 5 || stats.dataCoverageRate < 50;
  const conclusion = insufficientData
    ? "数据量或数据覆盖不足，当前不生成明确学习占比结论和学习诊断。"
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
      ? `本次监督${stats.totalMinutes}分钟，明确学习${stats.effectiveMinutes}分钟，明确学习占比${stats.focusRate}%。`
      : `本次监督${stats.totalMinutes}分钟，当前数据量不足。`,
    conclusion,
    parentAdvice
  ].join("\n");

  const output = {
    summary,
    conclusion,
    parentAdvice,
    trend,
    stats,
    records,
    reportLevel,
    provider: reportLevel === "basic" ? "template" : "mock-deepseek",
    session: {
      id: session.id,
      startTime: session.start_time,
      endTime: session.end_time,
      durationMinutes: session.duration_minutes,
      status: session.status
    }
  };

  if (logGeneration) {
    try {
      await logAiCall({
        sessionId: session.id,
        accessCodeId: session.access_code_id,
        modelType: `report_${reportLevel}`,
        status: "success",
        inputSize: JSON.stringify(records).length,
        outputSize: JSON.stringify(output).length,
        estimatedCost: estimateReportCost(reportLevel),
        latencyMs: Date.now() - startedAt
      });
    } catch (error) {
      await logError({
        sessionId: session.id,
        accessCodeId: session.access_code_id,
        errorType: "report接口失败",
        errorMessage: error instanceof Error ? error.message : "报告调用日志写入失败"
      });
    }
  }

  return NextResponse.json(output);
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as Partial<ReportPayload>;
  return generateReport(request, body, true);
}

export async function GET(request: NextRequest) {
  return generateReport(
    request,
    {
      sessionId: request.nextUrl.searchParams.get("session_id") ?? undefined,
      reportToken: request.nextUrl.searchParams.get("token") ?? undefined
    },
    false
  );
}

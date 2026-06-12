import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/admin";
import { getTodayKey } from "@/lib/plans";
import { supabaseAdmin } from "@/lib/supabase/server";
import { logError } from "@/lib/security";

function todayStartIso() {
  return `${getTodayKey()}T00:00:00+08:00`;
}

export async function GET(request: NextRequest) {
  if (!isAdminRequest(request)) {
    await logError({
      errorType: "未授权访问",
      errorMessage: "后台接口密码错误或缺失"
    });
    return NextResponse.json({ error: "后台密码错误" }, { status: 401 });
  }
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Supabase环境变量未配置" }, { status: 500 });
  }

  const since = todayStartIso();
  const sessionId = request.nextUrl.searchParams.get("sessionId");

  const [
    accessCodes,
    sessions,
    todaySessions,
    aiLogs,
    todayAiLogs,
    errorLogs,
    todayErrorLogs,
    suspiciousLogs,
    todaySuspiciousLogs,
    adminActions
  ] = await Promise.all([
    supabaseAdmin.from("access_codes").select("*").order("created_at", { ascending: false }),
    supabaseAdmin
      .from("sessions")
      .select("*, access_codes(code, plan_type)")
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("sessions")
      .select("*, access_codes(code, plan_type)")
      .gte("created_at", since),
    supabaseAdmin
      .from("ai_call_logs")
      .select("*, access_codes(code, plan_type)")
      .order("created_at", { ascending: false })
      .limit(200),
    supabaseAdmin.from("ai_call_logs").select("*").gte("created_at", since),
    supabaseAdmin
      .from("error_logs")
      .select("*, access_codes(code)")
      .order("created_at", { ascending: false })
      .limit(200),
    supabaseAdmin.from("error_logs").select("*").gte("created_at", since),
    supabaseAdmin
      .from("suspicious_logs")
      .select("*, access_codes(code)")
      .order("created_at", { ascending: false })
      .limit(200),
    supabaseAdmin.from("suspicious_logs").select("*").gte("created_at", since),
    supabaseAdmin
      .from("admin_actions")
      .select("*, access_codes(code)")
      .order("created_at", { ascending: false })
      .limit(200)
  ]);

  const failed = [
    accessCodes,
    sessions,
    todaySessions,
    aiLogs,
    todayAiLogs,
    errorLogs,
    todayErrorLogs,
    suspiciousLogs,
    todaySuspiciousLogs,
    adminActions
  ].find((result) => result.error);

  if (failed?.error) {
    return NextResponse.json({ error: failed.error.message }, { status: 500 });
  }

  const todaySessionRows = todaySessions.data ?? [];
  const todayAiRows = todayAiLogs.data ?? [];
  const reportRows = todayAiRows.filter((row) =>
    String(row.model_type ?? "").startsWith("report_")
  );
  const mockAnalyzeCount = todayAiRows.filter((row) => row.model_type === "vision_mock").length;
  const qwenAnalyzeCount = todayAiRows.filter((row) => row.model_type === "vision_qwen").length;
  const { count: correctionCount } = await supabaseAdmin
    .from("records")
    .select("id", { count: "exact", head: true })
    .eq("manual_corrected", true);
  const { count: recordCount } = await supabaseAdmin
    .from("records")
    .select("id", { count: "exact", head: true });

  const dashboard = {
    todayNewAccessCodes: (accessCodes.data ?? []).filter(
      (code) => String(code.created_at) >= since
    ).length,
    todaySessions: todaySessionRows.length,
    todaySupervisionMinutes: todaySessionRows.reduce(
      (sum, row) => sum + Number(row.duration_minutes ?? 0),
      0
    ),
    todayAiCalls: todayAiRows.length,
    todayEstimatedAiCost: Number(
      todayAiRows
        .reduce((sum, row) => sum + Number(row.estimated_cost ?? 0), 0)
        .toFixed(3)
    ),
    todayReports: reportRows.length,
    todayErrors: (todayErrorLogs.data ?? []).length,
    todaySuspicious: (todaySuspiciousLogs.data ?? []).length,
    mockAnalyzeCount,
    qwenAnalyzeCount,
    manualCorrectionCount: correctionCount ?? 0,
    manualCorrectionRate:
      recordCount && recordCount > 0
        ? Number((((correctionCount ?? 0) / recordCount) * 100).toFixed(1))
        : 0
  };

  const allAiRows = aiLogs.data ?? [];
  const allSessionRows = sessions.data ?? [];
  const costByAccessCode = allAiRows.reduce<Record<string, {
    accessCode: string;
    planType: string;
    aiCalls: number;
    estimatedCost: number;
    reportCount: number;
    reportCost: number;
    sessionCount: number;
    supervisionMinutes: number;
    averageHourlyCost: number;
    averageSessionCost: number;
  }>>((acc, row) => {
    const key = row.access_code_id ?? "unknown";
    const access = row.access_codes as { code?: string; plan_type?: string } | null;
    acc[key] ??= {
      accessCode: access?.code ?? key,
      planType: access?.plan_type ?? "-",
      aiCalls: 0,
      estimatedCost: 0,
      reportCount: 0,
      reportCost: 0,
      sessionCount: 0,
      supervisionMinutes: 0,
      averageHourlyCost: 0,
      averageSessionCost: 0
    };
    acc[key].aiCalls += 1;
    acc[key].estimatedCost = Number(
      (acc[key].estimatedCost + Number(row.estimated_cost ?? 0)).toFixed(3)
    );
    if (String(row.model_type ?? "").startsWith("report_")) {
      acc[key].reportCount += 1;
      acc[key].reportCost = Number(
        (acc[key].reportCost + Number(row.estimated_cost ?? 0)).toFixed(3)
      );
    }
    return acc;
  }, {});

  allSessionRows.forEach((session) => {
    const key = session.access_code_id ?? "unknown";
    const access = session.access_codes as { code?: string; plan_type?: string } | null;
    costByAccessCode[key] ??= {
      accessCode: access?.code ?? key,
      planType: access?.plan_type ?? "-",
      aiCalls: 0,
      estimatedCost: 0,
      reportCount: 0,
      reportCost: 0,
      sessionCount: 0,
      supervisionMinutes: 0,
      averageHourlyCost: 0,
      averageSessionCost: 0
    };
    costByAccessCode[key].sessionCount += 1;
    costByAccessCode[key].supervisionMinutes += Number(session.duration_minutes ?? 0);
  });

  Object.values(costByAccessCode).forEach((item) => {
    item.averageHourlyCost =
      item.supervisionMinutes > 0
        ? Number((item.estimatedCost / (item.supervisionMinutes / 60)).toFixed(3))
        : 0;
    item.averageSessionCost =
      item.sessionCount > 0
        ? Number((item.estimatedCost / item.sessionCount).toFixed(3))
        : 0;
  });

  let sessionDetail = null;
  if (sessionId) {
    const [session, records, calls, errors] = await Promise.all([
      supabaseAdmin
        .from("sessions")
        .select("*, access_codes(code, plan_type)")
        .eq("id", sessionId)
        .maybeSingle(),
      supabaseAdmin
        .from("records")
        .select("*")
        .eq("session_id", sessionId)
        .order("timestamp", { ascending: true }),
      supabaseAdmin
        .from("ai_call_logs")
        .select("*")
        .eq("session_id", sessionId)
        .order("created_at", { ascending: true }),
      supabaseAdmin
        .from("error_logs")
        .select("*")
        .eq("session_id", sessionId)
        .order("created_at", { ascending: true })
    ]);

    sessionDetail = {
      session: session.data,
      records: records.data ?? [],
      aiCalls: calls.data ?? [],
      errors: errors.data ?? []
    };
  }

  return NextResponse.json({
    dashboard,
    accessCodes: accessCodes.data ?? [],
    sessions: sessions.data ?? [],
    aiCallLogs: aiLogs.data ?? [],
    errorLogs: errorLogs.data ?? [],
    suspiciousLogs: suspiciousLogs.data ?? [],
    adminActions: adminActions.data ?? [],
    costByAccessCode: Object.values(costByAccessCode),
    sessionDetail
  });
}

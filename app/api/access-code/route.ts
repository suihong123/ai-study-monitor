import { NextRequest, NextResponse } from "next/server";
import { canUseAccessCode, statusMessages } from "@/lib/access-code-status";
import { isAdminRequest } from "@/lib/admin";
import { defaultPlanConfigs, getTodayKey, planTotalMinutes } from "@/lib/plans";
import { supabaseAdmin } from "@/lib/supabase/server";
import { calculateStats, estimateCost } from "@/lib/stats";
import {
  checkRateLimit,
  generateSessionToken,
  getClientIp,
  getUserAgent,
  logError,
  logSuspicious,
  validateSessionRequest
} from "@/lib/security";
import type {
  AccessCodeStatus,
  LearningState,
  PlanConfig,
  PlanType,
  ReportLevel,
  StudyRecord,
  StudyStatus
} from "@/types";

function legacyLearningStateFromStatus(status: StudyStatus): LearningState {
  if (status === "studying") return "studying";
  if (status === "distracted" || status === "unrelated") return "suspected_distracted";
  return "unknown";
}

function missingSupabase() {
  return NextResponse.json(
    { error: "Supabase环境变量未配置" },
    { status: 500 }
  );
}

export async function GET(request: NextRequest) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "后台密码错误" }, { status: 401 });
  }
  if (!supabaseAdmin) return missingSupabase();

  const { data, error } = await supabaseAdmin
    .from("access_codes")
    .select("*, sessions(*)")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ accessCodes: data ?? [] });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const action = body.action as string | undefined;

  if (!supabaseAdmin) return missingSupabase();

  if (action === "validate") {
    return handleValidateCode(request, body.code, body.deviceId);
  }

  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "后台密码错误" }, { status: 401 });
  }

  if (action === "create") {
    return createCode(body.planType);
  }

  if (action === "disable") {
    return adminUpdateAccessCode(request, body.id, { status: "disabled" }, "disable_access_code", body.reason);
  }

  if (action === "unbind") {
    return adminUpdateAccessCode(request, body.id, { device_id: null }, "unbind_device", body.reason);
  }

  if (action === "reset-today") {
    return adminUpdateAccessCode(request, body.id, {
      used_minutes_today: 0,
      last_reset_date: getTodayKey()
    }, "reset_daily_minutes", body.reason);
  }

  if (action === "set-status") {
    return setAccessCodeStatus(request, body);
  }

  if (action === "adjust-minutes") {
    return adjustMinutes(request, body);
  }

  if (action === "update-plan") {
    return updatePlan(request, body);
  }

  if (action === "update-admin-notes") {
    return adminUpdateAccessCode(
      request,
      body.id,
      { admin_notes: body.adminNotes ?? "" },
      "update_admin_notes",
      body.reason
    );
  }

  return NextResponse.json({ error: "未知操作" }, { status: 400 });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  if (!supabaseAdmin) return missingSupabase();

  if (body.action === "finish-session") {
    return handleFinishSession(request, body);
  }

  return NextResponse.json({ error: "未知操作" }, { status: 400 });
}

async function loadPlanConfig(planType: PlanType) {
  const fallback = defaultPlanConfigs[planType];
  if (!fallback) return null;

  const { data } = await supabaseAdmin!
    .from("plan_configs")
    .select("*")
    .eq("plan_type", planType)
    .maybeSingle();

  return ((data as PlanConfig | null) ?? fallback) as PlanConfig;
}

async function handleValidateCode(request: NextRequest, code: string, deviceId: string) {
  const ip = getClientIp(request);
  const userAgent = getUserAgent(request);
  const limited = await checkRateLimit({
    request,
    kind: "verify",
    accessCodeId: null,
    scope: "ip"
  });
  if (!limited.ok) {
    return NextResponse.json({ error: "访问过于频繁，请稍后再试" }, { status: 429 });
  }

  if (!code || !deviceId) {
    await logError({
      errorType: "access_code验证失败",
      errorMessage: "缺少访问码或设备ID"
    });
    return NextResponse.json({ error: "请输入访问码" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin!
    .from("access_codes")
    .select("*")
    .eq("code", code.trim())
    .maybeSingle();

  if (error) {
    await logError({ errorType: "access_code验证失败", errorMessage: error.message });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    await logSuspicious({
      ip,
      userAgent,
      eventType: "无效访问码尝试",
      message: `无效访问码：${code}`
    });
    await logError({
      errorType: "access_code验证失败",
      errorMessage: `访问码不存在：${code}`
    });
    return NextResponse.json({ error: "访问码不存在" }, { status: 404 });
  }
  const codeLimited = await checkRateLimit({
    request,
    kind: "verify",
    accessCodeId: data.id,
    scope: "accessCode"
  });
  if (!codeLimited.ok) {
    return NextResponse.json({ error: "访问过于频繁，请稍后再试" }, { status: 429 });
  }
  if (!canUseAccessCode(data.status)) {
    if (data.status === "blacklist") {
      await logSuspicious({
        accessCodeId: data.id,
        ip,
        userAgent,
        eventType: "黑名单访问",
        message: statusMessages.blacklist
      });
    }
    return NextResponse.json(
      { error: statusMessages[data.status as AccessCodeStatus] || "访问码不可用" },
      { status: 403 }
    );
  }
  if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) {
    return NextResponse.json({ error: "访问码已过期" }, { status: 403 });
  }
  if (data.device_id && data.device_id !== deviceId) {
    await logSuspicious({
      accessCodeId: data.id,
      ip,
      userAgent,
      eventType: "多设备尝试",
      message: "访问码被其他设备尝试使用"
    });
    return NextResponse.json(
      { error: "该访问码已绑定其他设备，请联系客服解绑。" },
      { status: 403 }
    );
  }

  const today = getTodayKey();
  const resetValues =
    data.last_reset_date === today
      ? {}
      : { used_minutes_today: 0, last_reset_date: today };
  const normalizedCode = {
    ...data,
    ...resetValues
  };

  const totalRemainingMinutes =
    normalizedCode.total_minutes - normalizedCode.used_minutes;
  const todayRemainingMinutes =
    normalizedCode.daily_minutes - normalizedCode.used_minutes_today;

  if (totalRemainingMinutes <= 0) {
    await logSuspicious({
      accessCodeId: data.id,
      ip,
      userAgent,
      eventType: "额度不足仍继续调用",
      message: "总剩余时长不足"
    });
    return NextResponse.json({ error: "总剩余时长不足" }, { status: 403 });
  }
  if (todayRemainingMinutes <= 0) {
    await logSuspicious({
      accessCodeId: data.id,
      ip,
      userAgent,
      eventType: "额度不足仍继续调用",
      message: "今日额度不足"
    });
    return NextResponse.json({ error: "今日额度不足" }, { status: 403 });
  }

  const updates: Record<string, unknown> = { ...resetValues };
  if (!data.device_id) updates.device_id = deviceId;

  if (Object.keys(updates).length > 0) {
    const { error: updateError } = await supabaseAdmin!
      .from("access_codes")
      .update(updates)
      .eq("id", data.id);
    if (updateError) {
      await logError({
        accessCodeId: data.id,
        errorType: "access_code验证失败",
        errorMessage: updateError.message
      });
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }
    normalizedCode.device_id = normalizedCode.device_id ?? deviceId;
  }

  const sessionToken = generateSessionToken();
  const { data: session, error: sessionError } = await supabaseAdmin!
    .from("sessions")
    .insert({
      access_code_id: data.id,
      start_time: new Date().toISOString(),
      report_level: normalizedCode.report_level,
      session_token: sessionToken,
      status: "active",
      ip,
      user_agent: userAgent
    })
    .select("*")
    .single();

  if (sessionError) {
    await logError({
      accessCodeId: data.id,
      errorType: "access_code验证失败",
      errorMessage: sessionError.message
    });
    return NextResponse.json({ error: sessionError.message }, { status: 500 });
  }

  return NextResponse.json({
    accessCode: normalizedCode,
    session,
    totalRemainingMinutes,
    todayRemainingMinutes
  });
}

async function createCode(planType: PlanType) {
  const plan = await loadPlanConfig(planType);
  if (!plan) {
    return NextResponse.json({ error: "套餐类型无效" }, { status: 400 });
  }

  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + 3);

  const { data, error } = await supabaseAdmin!
    .from("access_codes")
    .insert({
      code,
      plan_type: plan.plan_type,
      total_minutes: planTotalMinutes[plan.plan_type],
      used_minutes: 0,
      daily_minutes: plan.daily_minutes,
      used_minutes_today: 0,
      last_reset_date: getTodayKey(),
      report_level: plan.report_level,
      base_interval_seconds: plan.base_interval_seconds,
      min_interval_seconds: plan.min_interval_seconds,
      status: "active",
      expires_at: expiresAt.toISOString()
    })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ accessCode: data });
}

async function updateCode(id: string, values: Record<string, unknown>) {
  if (!id) return NextResponse.json({ error: "缺少访问码ID" }, { status: 400 });

  const { data, error } = await supabaseAdmin!
    .from("access_codes")
    .update(values)
    .eq("id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ accessCode: data });
}

async function getAccessCode(id: string) {
  const { data, error } = await supabaseAdmin!
    .from("access_codes")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function logAdminAction(params: {
  request: NextRequest;
  accessCodeId: string;
  actionType: string;
  beforeData: unknown;
  afterData: unknown;
  reason?: string;
}) {
  const admin = params.request.headers.get("x-admin-password") ? "ADMIN_PASSWORD" : "unknown";
  await supabaseAdmin!.from("admin_actions").insert({
    admin,
    access_code_id: params.accessCodeId,
    action_type: params.actionType,
    before_data: params.beforeData,
    after_data: params.afterData,
    reason: params.reason ?? null
  });
}

async function adminUpdateAccessCode(
  request: NextRequest,
  id: string,
  values: Record<string, unknown>,
  actionType: string,
  reason?: string
) {
  if (!id) return NextResponse.json({ error: "缺少访问码ID" }, { status: 400 });
  const before = await getAccessCode(id);
  const { data, error } = await supabaseAdmin!
    .from("access_codes")
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await logAdminAction({
    request,
    accessCodeId: id,
    actionType,
    beforeData: before,
    afterData: data,
    reason
  });
  return NextResponse.json({ accessCode: data });
}

async function setAccessCodeStatus(
  request: NextRequest,
  body: {
    id: string;
    status: AccessCodeStatus;
    reason?: string;
  }
) {
  const actionTypes: Record<AccessCodeStatus, string> = {
    active: "resume_access_code",
    watch: "set_watch",
    paused: "pause_access_code",
    refunded: "refund_freeze",
    expired: "disable_access_code",
    disabled: "disable_access_code",
    blacklist: "blacklist_access_code"
  };

  if ((body.status === "refunded" || body.status === "blacklist") && !body.reason) {
    return NextResponse.json({ error: "请填写原因" }, { status: 400 });
  }
  const before = await getAccessCode(body.id);

  const values: Record<string, unknown> = {
    status: body.status,
    freeze_reason:
      body.status === "refunded" || body.status === "blacklist" || body.status === "paused"
        ? body.reason ?? null
        : null
  };

  return adminUpdateAccessCode(
    request,
    body.id,
    values,
    body.status === "active" && before.status === "blacklist"
      ? "unblacklist_access_code"
      : body.status === "active"
      ? "resume_access_code"
      : actionTypes[body.status],
    body.reason
  );
}

async function adjustMinutes(
  request: NextRequest,
  body: {
    id: string;
    mode: "add" | "reduce" | "set-total" | "set-daily";
    minutes: number;
    reason?: string;
  }
) {
  const before = await getAccessCode(body.id);
  const minutes = Number(body.minutes);
  if (!Number.isFinite(minutes) || minutes < 0) {
    return NextResponse.json({ error: "分钟数无效" }, { status: 400 });
  }

  const values: Record<string, unknown> = {};
  let actionType = "add_minutes";
  if (body.mode === "add") {
    values.total_minutes = before.total_minutes + minutes;
    actionType = "add_minutes";
  }
  if (body.mode === "reduce") {
    values.total_minutes = Math.max(before.used_minutes, before.total_minutes - minutes);
    actionType = "reduce_minutes";
  }
  if (body.mode === "set-total") {
    values.total_minutes = minutes;
    actionType = "update_total_minutes";
  }
  if (body.mode === "set-daily") {
    values.daily_minutes = minutes;
    actionType = "update_daily_minutes";
  }
  return adminUpdateAccessCode(request, body.id, values, actionType, body.reason);
}

async function updatePlan(
  request: NextRequest,
  body: {
    id: string;
    planType: PlanType;
    resetUsed?: boolean;
    reason?: string;
  }
) {
  const plan = await loadPlanConfig(body.planType);
  if (!plan) return NextResponse.json({ error: "套餐类型无效" }, { status: 400 });

  const values: Record<string, unknown> = {
    plan_type: plan.plan_type,
    daily_minutes: plan.daily_minutes,
    base_interval_seconds: plan.base_interval_seconds,
    min_interval_seconds: plan.min_interval_seconds,
    report_level: plan.report_level
  };
  if (body.resetUsed) {
    values.used_minutes = 0;
    values.used_minutes_today = 0;
    values.last_reset_date = getTodayKey();
  }
  return adminUpdateAccessCode(request, body.id, values, "update_plan", body.reason);
}

async function handleFinishSession(request: NextRequest, body: {
  sessionId: string;
  accessCodeId: string;
  records: StudyRecord[];
  endTime: string;
  durationMinutes?: number;
  aiCallCount?: number;
  sessionToken?: string;
  reportLevel?: ReportLevel;
}) {
  if (!body.sessionId || !body.accessCodeId) {
    return NextResponse.json({ error: "缺少会话信息" }, { status: 400 });
  }
  const auth = await validateSessionRequest(request, {
    accessCodeId: body.accessCodeId,
    sessionId: body.sessionId,
    sessionToken: body.sessionToken
  });
  if (!auth.ok) return auth.response;

  const records = body.records ?? [];
  const stats = calculateStats(records, body.durationMinutes);
  const reportLevel = auth.context.accessCode.report_level;
  const aiCallCount = body.aiCallCount ?? records.length;
  const estimatedCost = estimateCost(aiCallCount, reportLevel);

  const unsavedRecords = records.filter((record) => !record.id);
  const savedRecords = records.filter((record) => record.id);
  if (savedRecords.length > 0) {
    await Promise.all(
      savedRecords.map((record) =>
        supabaseAdmin!
          .from("records")
          .update({
            presence: record.presence ?? (record.status === "away" ? "away" : "present"),
            learning_state: record.learning_state ?? legacyLearningStateFromStatus(record.status),
            current_frequency_seconds: record.current_frequency_seconds ?? null,
            frequency_boosted_by_abnormal: record.frequency_boosted_by_abnormal ?? false,
            frequency_lowered_by_focus: record.frequency_lowered_by_focus ?? false,
            triggered_reminder: record.triggered_reminder ?? false,
            error_message: record.error_message ?? null,
            manual_corrected: record.manual_corrected ?? false,
            correction_source: record.correction_source ?? null,
            corrected_at: record.corrected_at ?? null
          })
          .eq("id", record.id)
          .eq("session_id", body.sessionId)
      )
    );
  }
  if (unsavedRecords.length > 0) {
    const { error: recordsError } = await supabaseAdmin!.from("records").insert(
      unsavedRecords.map((record) => ({
        session_id: body.sessionId,
        status: record.status,
        presence: record.presence ?? (record.status === "away" ? "away" : "present"),
        learning_state: record.learning_state ?? legacyLearningStateFromStatus(record.status),
        timestamp: record.timestamp,
        confidence: record.confidence ?? null,
        reason: record.reason ?? null,
        analyze_mode: record.analyze_mode ?? "mock",
        current_frequency_seconds: record.current_frequency_seconds ?? null,
        frequency_boosted_by_abnormal: record.frequency_boosted_by_abnormal ?? false,
        frequency_lowered_by_focus: record.frequency_lowered_by_focus ?? false,
        triggered_reminder: record.triggered_reminder ?? false,
        ai_called: record.ai_called ?? true,
        error_message: record.error_message ?? null,
        manual_corrected: record.manual_corrected ?? false,
        correction_source: record.correction_source ?? null,
        corrected_at: record.corrected_at ?? null
      }))
    );
    if (recordsError) {
      await logError({
        sessionId: body.sessionId,
        accessCodeId: body.accessCodeId,
        errorType: "图片上传失败",
        errorMessage: recordsError.message
      });
      return NextResponse.json({ error: recordsError.message }, { status: 500 });
    }
  }

  const { error: sessionError } = await supabaseAdmin!
    .from("sessions")
    .update({
      end_time: body.endTime,
      duration_minutes: stats.totalMinutes,
      focus_rate: stats.focusRate,
      ai_call_count: aiCallCount,
      estimated_cost: estimatedCost,
      report_level: reportLevel,
      session_token: null,
      status: "ended"
    })
    .eq("id", body.sessionId);

  if (sessionError) {
    await logError({
      sessionId: body.sessionId,
      accessCodeId: body.accessCodeId,
      errorType: "额度扣减失败",
      errorMessage: sessionError.message
    });
    return NextResponse.json({ error: sessionError.message }, { status: 500 });
  }

  const { data: accessCode, error: codeError } = await supabaseAdmin!
    .from("access_codes")
    .select("used_minutes, used_minutes_today, last_reset_date")
    .eq("id", body.accessCodeId)
    .single();

  if (codeError) {
    await logError({
      sessionId: body.sessionId,
      accessCodeId: body.accessCodeId,
      errorType: "额度扣减失败",
      errorMessage: codeError.message
    });
    return NextResponse.json({ error: codeError.message }, { status: 500 });
  }

  const today = getTodayKey();
  const usedToday =
    accessCode.last_reset_date === today ? accessCode.used_minutes_today : 0;

  const { error: updateError } = await supabaseAdmin!
    .from("access_codes")
    .update({
      used_minutes: accessCode.used_minutes + stats.totalMinutes,
      used_minutes_today: usedToday + stats.totalMinutes,
      last_reset_date: today
    })
    .eq("id", body.accessCodeId);

  if (updateError) {
    await logError({
      sessionId: body.sessionId,
      accessCodeId: body.accessCodeId,
      errorType: "额度扣减失败",
      errorMessage: updateError.message
    });
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ stats, aiCallCount, estimatedCost });
}

import { NextRequest, NextResponse } from "next/server";
import { canUseAccessCode, statusMessages } from "@/lib/access-code-status";
import { isAdminRequest } from "@/lib/admin";
import {
  calculateRebindCooldown,
  getDeviceRebindConfig
} from "@/lib/device-rebind-config";
import { remainingMinutes } from "@/lib/entitlements";
import { defaultPlanConfigs, planTotalMinutes } from "@/lib/plans";
import { privacyNoticeVersion } from "@/lib/privacy";
import {
  sessionTimeoutSeconds,
  settleExpiredSessionsForAccessCode,
  settleSession
} from "@/lib/session-settlement";
import { supabaseAdmin } from "@/lib/supabase/server";
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
  PlanConfig,
  PlanType,
  StudyRecord,
} from "@/types";

function missingSupabase() {
  return NextResponse.json(
    { error: "Supabase环境变量未配置" },
    { status: 500 }
  );
}

export async function GET(request: NextRequest) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "验证失败" }, { status: 401 });
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
    return handleValidateCode(
      request,
      body.code,
      body.deviceId,
      body.deviceName,
      body.deviceModel,
      body.devicePlatform,
      body.privacyAcknowledged,
      body.privacyNoticeVersion
    );
  }

  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "验证失败" }, { status: 401 });
  }

  if (action === "create") {
    return createCode(body.planType);
  }

  if (action === "disable") {
    return adminUpdateAccessCode(request, body.id, { status: "disabled" }, "disable_access_code", body.reason);
  }

  if (action === "unbind") {
    const response = await adminUpdateAccessCode(
      request,
      body.id,
      {
        device_id: null,
        current_device_name: null,
        current_device_model: null,
        current_device_platform: null,
        device_bound_at: null
      },
      "unbind_device",
      body.reason
    );
    if (response.status < 400 && body.id) {
      await supabaseAdmin
        .from("sessions")
        .update({ session_token: generateSessionToken() })
        .eq("access_code_id", body.id)
        .eq("status", "active")
        .is("end_time", null);
    }
    return response;
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

async function handleValidateCode(
  request: NextRequest,
  code: string,
  deviceId: string,
  deviceName: string,
  deviceModel: string,
  devicePlatform: string,
  privacyAcknowledged: boolean,
  submittedPrivacyNoticeVersion?: string
) {
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
  if (!privacyAcknowledged) {
    return NextResponse.json(
      { error: "请先确认摄像头与数据处理说明" },
      { status: 400 }
    );
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
  await settleExpiredSessionsForAccessCode(data.id);

  const { data: refreshedCode, error: refreshError } = await supabaseAdmin!
    .from("access_codes")
    .select("*")
    .eq("id", data.id)
    .single();

  if (refreshError) {
    await logError({
      accessCodeId: data.id,
      errorType: "access_code验证失败",
      errorMessage: refreshError.message
    });
    return NextResponse.json({ error: refreshError.message }, { status: 500 });
  }

  let normalizedCode = refreshedCode;

  const totalRemainingMinutes = remainingMinutes(
    normalizedCode.total_minutes,
    normalizedCode.used_minutes
  );

  if (totalRemainingMinutes <= 0) {
    await logSuspicious({
      accessCodeId: data.id,
      ip,
      userAgent,
      eventType: "额度不足仍继续调用",
      message: "总剩余时长不足"
    });
    return NextResponse.json(
      { error: normalizedCode.plan_type === "trial" ? "体验额度已用完" : "总剩余时长不足" },
      { status: 403 }
    );
  }

  if (normalizedCode.device_id && normalizedCode.device_id !== deviceId) {
    const config = await getDeviceRebindConfig();
    const cooldown = calculateRebindCooldown({
      lastRebindAt: normalizedCode.last_rebind_at,
      cooldownHours: config.rebindCooldownHours
    });
    const freeRebindCount = Math.max(0, Number(normalizedCode.free_rebind_count ?? 0));

    await logSuspicious({
      accessCodeId: normalizedCode.id,
      ip,
      userAgent,
      eventType: "新设备检测",
      message: "检测到访问码正在从另一台设备尝试进入"
    });

    return NextResponse.json(
      {
        error: "检测到新的设备",
        code: "device_rebind_required",
        rebindRequired: {
          freeRebindCount,
          remainingMinutes: totalRemainingMinutes,
          costMinutes: config.rebindCostMinutes,
          cooldownHours: config.rebindCooldownHours,
          cooldownRemainingSeconds: cooldown.cooldownRemainingSeconds,
          nextRebindAt: cooldown.nextRebindAt,
          isFree: freeRebindCount > 0
        }
      },
      { status: 409 }
    );
  }

  const updates: Record<string, unknown> = {};
  if (!normalizedCode.device_id) {
    updates.device_id = deviceId;
    updates.current_device_name = String(deviceName ?? "").trim().slice(0, 120) || null;
    updates.current_device_model = String(deviceModel ?? "").trim().slice(0, 120) || null;
    updates.current_device_platform = String(devicePlatform ?? "").trim().slice(0, 20) || "Other";
    updates.device_bound_at = new Date().toISOString();
    updates.updated_at = new Date().toISOString();
  }

  if (Object.keys(updates).length > 0) {
    const { data: boundCode, error: updateError } = await supabaseAdmin!
      .from("access_codes")
      .update(updates)
      .eq("id", data.id)
      .is("device_id", null)
      .select("*")
      .maybeSingle();
    if (updateError) {
      await logError({
        accessCodeId: data.id,
        errorType: "access_code验证失败",
        errorMessage: updateError.message
      });
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }
    if (boundCode) {
      normalizedCode = boundCode;
    } else {
      const { data: concurrentlyBoundCode, error: reloadError } = await supabaseAdmin!
        .from("access_codes")
        .select("*")
        .eq("id", data.id)
        .single();
      if (reloadError) {
        return NextResponse.json({ error: reloadError.message }, { status: 500 });
      }
      if (concurrentlyBoundCode.device_id !== deviceId) {
        const config = await getDeviceRebindConfig();
        const cooldown = calculateRebindCooldown({
          lastRebindAt: concurrentlyBoundCode.last_rebind_at,
          cooldownHours: config.rebindCooldownHours
        });
        return NextResponse.json(
          {
            error: "检测到新的设备",
            code: "device_rebind_required",
            rebindRequired: {
              freeRebindCount: Math.max(
                0,
                Number(concurrentlyBoundCode.free_rebind_count ?? 0)
              ),
              remainingMinutes: totalRemainingMinutes,
              costMinutes: config.rebindCostMinutes,
              cooldownHours: config.rebindCooldownHours,
              cooldownRemainingSeconds: cooldown.cooldownRemainingSeconds,
              nextRebindAt: cooldown.nextRebindAt,
              isFree: Number(concurrentlyBoundCode.free_rebind_count ?? 0) > 0
            }
          },
          { status: 409 }
        );
      }
      normalizedCode = concurrentlyBoundCode;
    }
  }

  const activeSince = new Date(Date.now() - sessionTimeoutSeconds * 1000).toISOString();
  const { data: activeSession, error: activeSessionError } = await supabaseAdmin!
    .from("sessions")
    .select("*")
    .eq("access_code_id", data.id)
    .eq("status", "active")
    .is("end_time", null)
    .gte("last_active_at", activeSince)
    .order("last_active_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (activeSessionError) {
    await logError({
      accessCodeId: data.id,
      errorType: "access_code验证失败",
      errorMessage: activeSessionError.message
    });
    return NextResponse.json({ error: activeSessionError.message }, { status: 500 });
  }

  if (activeSession) {
    const acknowledgedAt = activeSession.privacy_acknowledged_at ?? new Date().toISOString();
    const noticeVersion =
      activeSession.privacy_notice_version ??
      (submittedPrivacyNoticeVersion === privacyNoticeVersion
        ? submittedPrivacyNoticeVersion
        : privacyNoticeVersion);
    if (!activeSession.privacy_acknowledged_at || !activeSession.privacy_notice_version) {
      const { error: privacyUpdateError } = await supabaseAdmin!
        .from("sessions")
        .update({
          privacy_notice_version: noticeVersion,
          privacy_acknowledged_at: acknowledgedAt
        })
        .eq("id", activeSession.id);
      if (privacyUpdateError) {
        return NextResponse.json(
          { error: privacyUpdateError.message },
          { status: 500 }
        );
      }
      activeSession.privacy_notice_version = noticeVersion;
      activeSession.privacy_acknowledged_at = acknowledgedAt;
    }
    return NextResponse.json({
      accessCode: normalizedCode,
      session: activeSession,
      totalRemainingMinutes,
      recoverable: true
    });
  }

  const sessionToken = generateSessionToken();
  const now = new Date().toISOString();
  const { data: session, error: sessionError } = await supabaseAdmin!
    .from("sessions")
    .insert({
      access_code_id: data.id,
      start_time: now,
      last_active_at: now,
      report_level: normalizedCode.report_level,
      session_token: sessionToken,
      status: "active",
      ip,
      user_agent: userAgent,
      privacy_notice_version:
        submittedPrivacyNoticeVersion === privacyNoticeVersion
          ? submittedPrivacyNoticeVersion
          : privacyNoticeVersion,
      privacy_acknowledged_at: now
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
    recoverable: false
  });
}

async function createCode(planType: PlanType) {
  const plan = await loadPlanConfig(planType);
  if (!plan) {
    return NextResponse.json({ error: "套餐类型无效" }, { status: 400 });
  }

  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  const { data, error } = await supabaseAdmin!
    .from("access_codes")
    .insert({
      code,
      plan_type: plan.plan_type,
      total_minutes: planTotalMinutes[plan.plan_type],
      used_minutes: 0,
      daily_minutes: plan.daily_minutes,
      used_minutes_today: 0,
      last_reset_date: null,
      report_level: "basic",
      base_interval_seconds: plan.base_interval_seconds,
      min_interval_seconds: plan.min_interval_seconds,
      status: "active",
      expires_at: null
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
    mode: "add" | "reduce" | "set-total";
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
    values.total_minutes = Math.max(before.used_minutes, minutes);
    actionType = "update_total_minutes";
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
  const before = await getAccessCode(body.id);

  const values: Record<string, unknown> = {
    plan_type: plan.plan_type,
    daily_minutes: plan.daily_minutes,
    base_interval_seconds: plan.base_interval_seconds,
    min_interval_seconds: plan.min_interval_seconds,
    report_level: "basic",
    total_minutes: body.resetUsed
      ? planTotalMinutes[plan.plan_type]
      : Math.max(planTotalMinutes[plan.plan_type], before.used_minutes),
    expires_at: null
  };
  if (body.resetUsed) {
    values.used_minutes = 0;
    values.used_minutes_today = 0;
    values.last_reset_date = null;
  }
  return adminUpdateAccessCode(request, body.id, values, "update_plan", body.reason);
}

async function handleFinishSession(request: NextRequest, body: {
  sessionId: string;
  accessCodeId: string;
  records?: StudyRecord[];
  sessionToken?: string;
}) {
  if (!body.sessionId || !body.accessCodeId) {
    return NextResponse.json({ error: "缺少会话信息" }, { status: 400 });
  }
  const auth = await validateSessionRequest(request, {
    accessCodeId: body.accessCodeId,
    sessionId: body.sessionId,
    sessionToken: body.sessionToken
  }, { allowQuotaExhausted: true });
  if (!auth.ok) return auth.response;

  const records = Array.isArray(body.records) ? body.records : undefined;
  const result = await settleSession({
    sessionId: body.sessionId,
    accessCodeId: body.accessCodeId,
    records,
    status: "completed"
  });

  if (!result.ok) {
    await logError({
      sessionId: body.sessionId,
      accessCodeId: body.accessCodeId,
      errorType: "额度扣减失败",
      errorMessage: result.error
    });
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return NextResponse.json({
    stats: result.stats,
    aiCallCount: result.aiCallCount,
    estimatedCost: result.estimatedCost,
    skipped: result.skipped
  });
}

import { NextRequest, NextResponse } from "next/server";
import { canUseAccessCode, statusMessages } from "@/lib/access-code-status";
import { calculateElapsedWholeMinutes, remainingMinutes } from "@/lib/entitlements";
import { supabaseAdmin } from "@/lib/supabase/server";
import type { AccessCode, AccessCodeStatus, StudySession } from "@/types";

type LimitKey = "analyze" | "report" | "verify";
type SessionContext = {
  session: StudySession & { session_token: string | null; status: string | null };
  accessCode: AccessCode;
  ip: string;
  userAgent: string;
};

const limits = new Map<string, { count: number; resetAt: number }>();

const limitRules = {
  analyze: {
    accessCode: 6,
    ip: 20
  },
  report: {
    accessCode: 2,
    ip: 10
  },
  verify: {
    accessCode: 10,
    ip: 10
  }
};

export function getClientIp(request: NextRequest | Request) {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "unknown";
  return request.headers.get("x-real-ip") ?? "unknown";
}

export function getUserAgent(request: NextRequest | Request) {
  return request.headers.get("user-agent") ?? "unknown";
}

export function generateSessionToken() {
  return crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
}

function checkBucket(key: string, max: number) {
  const now = Date.now();
  const existing = limits.get(key);
  if (!existing || existing.resetAt <= now) {
    limits.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (existing.count >= max) return false;
  existing.count += 1;
  return true;
}

export async function checkRateLimit(params: {
  request: NextRequest | Request;
  kind: LimitKey;
  accessCodeId?: string | null;
  scope?: "ip" | "accessCode" | "both";
}) {
  const ip = getClientIp(params.request);
  const rule = limitRules[params.kind];
  const scope = params.scope ?? "both";
  const ipOk = scope === "accessCode" ? true : checkBucket(`${params.kind}:ip:${ip}`, rule.ip);
  const codeOk = scope === "ip" || !params.accessCodeId
    ? true
    : params.accessCodeId
    ? checkBucket(`${params.kind}:code:${params.accessCodeId}`, rule.accessCode)
    : true;

  if (ipOk && codeOk) return { ok: true, ip };

  await logSuspicious({
    accessCodeId: params.accessCodeId ?? null,
    ip,
    userAgent: getUserAgent(params.request),
    eventType: "rate_limit触发",
    message: `${params.kind} 超出每分钟调用限制`
  });
  await logError({
    accessCodeId: params.accessCodeId ?? null,
    errorType: "rate_limit触发",
    errorMessage: `${params.kind} 超出每分钟调用限制`
  });
  return { ok: false, ip };
}

export async function logError(params: {
  sessionId?: string | null;
  accessCodeId?: string | null;
  errorType: string;
  errorMessage: string;
  stack?: string | null;
}) {
  if (!supabaseAdmin) return;
  await supabaseAdmin.from("error_logs").insert({
    session_id: params.sessionId ?? null,
    access_code_id: params.accessCodeId ?? null,
    error_type: params.errorType,
    error_message: params.errorMessage,
    stack: params.stack ?? null
  });
}

export async function logSuspicious(params: {
  accessCodeId?: string | null;
  ip: string;
  userAgent: string;
  eventType: string;
  message: string;
}) {
  if (!supabaseAdmin) return;
  await supabaseAdmin.from("suspicious_logs").insert({
    access_code_id: params.accessCodeId ?? null,
    ip: params.ip,
    user_agent: params.userAgent,
    event_type: params.eventType,
    message: params.message
  });
}

export async function logAiCall(params: {
  sessionId: string;
  accessCodeId: string;
  modelType: string;
  status: string;
  inputSize?: number;
  outputSize?: number;
  estimatedCost: number;
  latencyMs: number;
}) {
  if (!supabaseAdmin) return;
  await supabaseAdmin.from("ai_call_logs").insert({
    session_id: params.sessionId,
    access_code_id: params.accessCodeId,
    model_type: params.modelType,
    status: params.status,
    input_size: params.inputSize ?? 0,
    output_size: params.outputSize ?? 0,
    estimated_cost: params.estimatedCost,
    latency_ms: params.latencyMs
  });
}

export async function validateSessionRequest(
  request: NextRequest | Request,
  body: {
    accessCodeId?: string;
    sessionId?: string;
    sessionToken?: string;
  },
  options: { allowQuotaExhausted?: boolean } = {}
): Promise<
  | { ok: true; context: SessionContext }
  | { ok: false; response: NextResponse; ip: string; userAgent: string }
> {
  const ip = getClientIp(request);
  const userAgent = getUserAgent(request);

  if (!supabaseAdmin) {
    return {
      ok: false,
      ip,
      userAgent,
      response: NextResponse.json({ error: "Supabase环境变量未配置" }, { status: 500 })
    };
  }

  if (!body.accessCodeId || !body.sessionId || !body.sessionToken) {
    await logSuspicious({
      accessCodeId: body.accessCodeId ?? null,
      ip,
      userAgent,
      eventType: "session_token错误",
      message: "请求缺少 accessCodeId、sessionId 或 sessionToken"
    });
    await logError({
      sessionId: body.sessionId ?? null,
      accessCodeId: body.accessCodeId ?? null,
      errorType: "session_token错误",
      errorMessage: "缺少会话鉴权参数"
    });
    return {
      ok: false,
      ip,
      userAgent,
      response: NextResponse.json({ error: "会话无效，请重新开始监督" }, { status: 401 })
    };
  }

  const { data: session, error: sessionError } = await supabaseAdmin
    .from("sessions")
    .select("*")
    .eq("id", body.sessionId)
    .eq("access_code_id", body.accessCodeId)
    .maybeSingle();

  if (
    sessionError ||
    !session ||
    session.session_token !== body.sessionToken ||
    session.end_time ||
    session.status !== "active"
  ) {
    await logSuspicious({
      accessCodeId: body.accessCodeId,
      ip,
      userAgent,
      eventType: "session_token错误",
      message: sessionError?.message ?? "session_token 不匹配或会话已结束"
    });
    await logError({
      sessionId: body.sessionId,
      accessCodeId: body.accessCodeId,
      errorType: "session_token错误",
      errorMessage: sessionError?.message ?? "session_token 不匹配或会话已结束"
    });
    return {
      ok: false,
      ip,
      userAgent,
      response: NextResponse.json({ error: "会话无效，请重新开始监督" }, { status: 401 })
    };
  }

  const { data: accessCode, error: codeError } = await supabaseAdmin
    .from("access_codes")
    .select("*")
    .eq("id", body.accessCodeId)
    .maybeSingle();

  if (codeError || !accessCode) {
    await logError({
      sessionId: body.sessionId,
      accessCodeId: body.accessCodeId,
      errorType: "access_code验证失败",
      errorMessage: codeError?.message ?? "访问码不存在"
    });
    return {
      ok: false,
      ip,
      userAgent,
      response: NextResponse.json({ error: "访问码不存在" }, { status: 403 })
    };
  }

  const totalRemaining = remainingMinutes(
    accessCode.total_minutes,
    accessCode.used_minutes
  );
  const activeElapsedMinutes = calculateElapsedWholeMinutes(
    session.start_time,
    new Date().toISOString()
  );
  const quotaExhausted =
    totalRemaining <= 0 ||
    (!options.allowQuotaExhausted && activeElapsedMinutes >= totalRemaining);

  const status = accessCode.status as AccessCodeStatus;
  if (!canUseAccessCode(status) || quotaExhausted) {
    const message =
      quotaExhausted
        ? "额度不足仍继续调用"
        : statusMessages[status] || "访问码不可用";
    if (status === "blacklist") {
      await logSuspicious({
        accessCodeId: body.accessCodeId,
        ip,
        userAgent,
        eventType: "黑名单访问",
        message
      });
    }
    await logSuspicious({
      accessCodeId: body.accessCodeId,
      ip,
      userAgent,
      eventType: message,
      message
    });
    await logError({
      sessionId: body.sessionId,
      accessCodeId: body.accessCodeId,
      errorType: "access_code验证失败",
      errorMessage: message
    });
    return {
      ok: false,
      ip,
      userAgent,
      response: NextResponse.json(
        {
          error: quotaExhausted ? "监督时长已用完，本次监督将自动结束" : message,
          code: quotaExhausted ? "quota_exhausted" : "access_code_unavailable"
        },
        { status: 403 }
      )
    };
  }

  return {
    ok: true,
    context: {
      session: session as SessionContext["session"],
      accessCode: accessCode as AccessCode,
      ip,
      userAgent
    }
  };
}

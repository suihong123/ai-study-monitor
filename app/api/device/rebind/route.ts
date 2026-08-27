import { NextRequest, NextResponse } from "next/server";
import {
  checkRateLimit,
  generateSessionToken,
  getClientIp,
  getUserAgent,
  logError,
  logSuspicious
} from "@/lib/security";
import { settleExpiredSessionsForAccessCode } from "@/lib/session-settlement";
import { supabaseAdmin } from "@/lib/supabase/server";
import type { DevicePlatform, DeviceRebindResult } from "@/types";

const supportedPlatforms = new Set<DevicePlatform>([
  "Android",
  "iOS",
  "Windows",
  "Mac",
  "Other"
]);

function cleanText(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function statusForResult(result: DeviceRebindResult) {
  if (result.success) return 200;
  if (result.resultCode === "access_code_not_found") return 404;
  if (result.resultCode === "rate_limited") return 429;
  if (result.resultCode === "window_limit_reached") return 429;
  if (result.resultCode === "access_code_unavailable") return 403;
  return 400;
}

export async function POST(request: NextRequest) {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Supabase环境变量未配置" }, { status: 500 });
  }

  const ip = getClientIp(request);
  const userAgent = getUserAgent(request);
  const body = await request.json();
  const accessCode = cleanText(body.code, 64).toUpperCase();
  const deviceId = cleanText(body.deviceId, 128);
  const deviceName = cleanText(body.deviceName, 120);
  const deviceModel = cleanText(body.deviceModel, 120);
  const submittedPlatform = cleanText(body.devicePlatform, 20) as DevicePlatform;
  const devicePlatform = supportedPlatforms.has(submittedPlatform)
    ? submittedPlatform
    : "Other";
  const idempotencyKey = cleanText(body.idempotencyKey, 128);

  if (!accessCode || !deviceId || idempotencyKey.length < 8) {
    return NextResponse.json(
      { error: "重新绑定请求信息不完整", code: "invalid_request" },
      { status: 400 }
    );
  }

  const { data: codeRow, error: codeError } = await supabaseAdmin
    .from("access_codes")
    .select("id")
    .eq("code", accessCode)
    .maybeSingle();

  if (codeError) {
    await logError({
      errorType: "DEVICE_REBOUND",
      errorMessage: codeError.message
    });
    return NextResponse.json({ error: codeError.message }, { status: 500 });
  }

  // 幂等重放必须先于应用层限流。同一请求即使第一次响应丢失，
  // 也应直接复用数据库保存的原结果，不能被后续重试次数误伤。
  if (codeRow?.id) {
    const { data: replayLog, error: replayError } = await supabaseAdmin
      .from("device_rebind_logs")
      .select("response_payload")
      .eq("access_code_id", codeRow.id)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();

    if (replayError) {
      await logError({
        accessCodeId: codeRow.id,
        errorType: "DEVICE_REBOUND",
        errorMessage: replayError.message
      });
      return NextResponse.json(
        { error: "重新绑定失败，请稍后再试", code: "server_error" },
        { status: 500 }
      );
    }

    if (replayLog?.response_payload) {
      const replayedResult = {
        ...(replayLog.response_payload as unknown as DeviceRebindResult),
        replayed: true
      };
      return NextResponse.json(
        {
          ...replayedResult,
          error: replayedResult.success ? undefined : replayedResult.message,
          code: replayedResult.resultCode
        },
        { status: statusForResult(replayedResult) }
      );
    }
  }

  const ipLimit = await checkRateLimit({
    request,
    kind: "rebind",
    accessCodeId: null,
    scope: "ip"
  });
  if (!ipLimit.ok) {
    return NextResponse.json({ error: "操作过于频繁，请稍后再试" }, { status: 429 });
  }

  if (codeRow?.id) {
    const codeLimit = await checkRateLimit({
      request,
      kind: "rebind",
      accessCodeId: codeRow.id,
      scope: "accessCode"
    });
    if (!codeLimit.ok) {
      return NextResponse.json({ error: "操作过于频繁，请稍后再试" }, { status: 429 });
    }
    await settleExpiredSessionsForAccessCode(codeRow.id);
  }

  const { data, error } = await supabaseAdmin.rpc("perform_device_rebind", {
    p_access_code: accessCode,
    p_new_device_id: deviceId,
    p_new_device_name: deviceName,
    p_new_device_model: deviceModel,
    p_new_device_platform: devicePlatform,
    p_idempotency_key: idempotencyKey,
    p_new_session_token: generateSessionToken(),
    p_ip: ip,
    p_user_agent: userAgent
  });

  if (error) {
    await logError({
      accessCodeId: codeRow?.id ?? null,
      errorType: "DEVICE_REBOUND",
      errorMessage: error.message
    });
    return NextResponse.json(
      { error: "重新绑定失败，请稍后再试", code: "server_error" },
      { status: 500 }
    );
  }

  const result = data as DeviceRebindResult;

  if (!codeRow?.id && result.resultCode === "access_code_not_found") {
    await logSuspicious({
      ip,
      userAgent,
      eventType: "使用环境重新绑定",
      message: "无效访问码重新绑定尝试"
    });
  }

  return NextResponse.json(
    {
      ...result,
      error: result.success ? undefined : result.message,
      code: result.resultCode
    },
    { status: statusForResult(result) }
  );
}

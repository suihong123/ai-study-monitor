import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/admin";
import { getDeviceRebindConfig } from "@/lib/device-rebind-config";
import { logError } from "@/lib/security";
import { supabaseAdmin } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  if (!isAdminRequest(request)) {
    await logError({
      errorType: "未授权访问",
      errorMessage: "后台重新绑定配置接口密码错误或缺失"
    });
    return NextResponse.json({ error: "验证失败" }, { status: 401 });
  }

  return NextResponse.json({ rebindConfig: await getDeviceRebindConfig() });
}

export async function POST(request: NextRequest) {
  if (!isAdminRequest(request)) {
    await logError({
      errorType: "未授权访问",
      errorMessage: "后台重新绑定配置接口密码错误或缺失"
    });
    return NextResponse.json({ error: "验证失败" }, { status: 401 });
  }
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Supabase环境变量未配置" }, { status: 500 });
  }

  const body = await request.json();
  const rebindWindowDays = Number(body.rebindWindowDays);
  const rebindMaxCount = Number(body.rebindMaxCount);
  const rebindMinIntervalSeconds = Number(body.rebindMinIntervalSeconds);

  if (
    !Number.isInteger(rebindWindowDays) ||
    rebindWindowDays < 1 ||
    rebindWindowDays > 90
  ) {
    return NextResponse.json({ error: "滚动窗口天数必须是1–90的整数" }, { status: 400 });
  }
  if (
    !Number.isInteger(rebindMaxCount) ||
    rebindMaxCount < 1 ||
    rebindMaxCount > 100
  ) {
    return NextResponse.json({ error: "重新绑定上限必须是1–100的整数" }, { status: 400 });
  }
  if (
    !Number.isInteger(rebindMinIntervalSeconds) ||
    rebindMinIntervalSeconds < 10 ||
    rebindMinIntervalSeconds > 86_400
  ) {
    return NextResponse.json(
      { error: "最小操作间隔必须是10–86400秒的整数" },
      { status: 400 }
    );
  }

  const before = await getDeviceRebindConfig();
  const updatedAt = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from("device_rebind_configs")
    .upsert({
      id: true,
      rebind_window_days: rebindWindowDays,
      rebind_max_count: rebindMaxCount,
      rebind_min_interval_seconds: rebindMinIntervalSeconds,
      updated_at: updatedAt
    })
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rebindConfig = {
    rebindWindowDays: Number(data.rebind_window_days),
    rebindMaxCount: Number(data.rebind_max_count),
    rebindMinIntervalSeconds: Number(data.rebind_min_interval_seconds),
    updatedAt: data.updated_at,
    source: "database" as const
  };

  await supabaseAdmin.from("admin_actions").insert({
    admin: "ADMIN_PASSWORD",
    access_code_id: null,
    action_type: "update_device_rebind_config",
    before_data: before,
    after_data: rebindConfig,
    reason: "更新使用环境重新绑定规则"
  });

  return NextResponse.json({ rebindConfig });
}

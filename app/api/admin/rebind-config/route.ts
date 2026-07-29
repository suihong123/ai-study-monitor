import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/admin";
import { getDeviceRebindConfig } from "@/lib/device-rebind-config";
import { logError } from "@/lib/security";
import { supabaseAdmin } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  if (!isAdminRequest(request)) {
    await logError({
      errorType: "未授权访问",
      errorMessage: "后台换绑配置接口密码错误或缺失"
    });
    return NextResponse.json({ error: "验证失败" }, { status: 401 });
  }

  return NextResponse.json({ rebindConfig: await getDeviceRebindConfig() });
}

export async function POST(request: NextRequest) {
  if (!isAdminRequest(request)) {
    await logError({
      errorType: "未授权访问",
      errorMessage: "后台换绑配置接口密码错误或缺失"
    });
    return NextResponse.json({ error: "验证失败" }, { status: 401 });
  }
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Supabase环境变量未配置" }, { status: 500 });
  }

  const body = await request.json();
  const rebindCostMinutes = Number(body.rebindCostMinutes);
  const rebindCooldownHours = Number(body.rebindCooldownHours);

  if (!Number.isInteger(rebindCostMinutes) || rebindCostMinutes <= 0) {
    return NextResponse.json({ error: "换绑扣除时长必须是大于0的整数" }, { status: 400 });
  }
  if (!Number.isInteger(rebindCooldownHours) || rebindCooldownHours < 0) {
    return NextResponse.json({ error: "换绑冷却小时必须是非负整数" }, { status: 400 });
  }

  const before = await getDeviceRebindConfig();
  const updatedAt = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from("device_rebind_configs")
    .upsert({
      id: true,
      rebind_cost_minutes: rebindCostMinutes,
      rebind_cooldown_hours: rebindCooldownHours,
      updated_at: updatedAt
    })
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rebindConfig = {
    rebindCostMinutes: Number(data.rebind_cost_minutes),
    rebindCooldownHours: Number(data.rebind_cooldown_hours),
    updatedAt: data.updated_at,
    source: "database" as const
  };

  await supabaseAdmin.from("admin_actions").insert({
    admin: "ADMIN_PASSWORD",
    access_code_id: null,
    action_type: "update_device_rebind_config",
    before_data: before,
    after_data: rebindConfig,
    reason: "更新设备换绑规则"
  });

  return NextResponse.json({ rebindConfig });
}

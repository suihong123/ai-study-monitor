import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/admin";
import { getActiveVisionModelConfig } from "@/lib/model-config";
import { defaultQwenApiUrl } from "@/lib/model-options";
import { supabaseAdmin } from "@/lib/supabase/server";
import { logError } from "@/lib/security";

export async function GET(request: NextRequest) {
  if (!isAdminRequest(request)) {
    await logError({
      errorType: "未授权访问",
      errorMessage: "后台模型配置接口密码错误或缺失"
    });
    return NextResponse.json({ error: "验证失败" }, { status: 401 });
  }

  const modelConfig = await getActiveVisionModelConfig();
  return NextResponse.json({ modelConfig });
}

export async function POST(request: NextRequest) {
  if (!isAdminRequest(request)) {
    await logError({
      errorType: "未授权访问",
      errorMessage: "后台模型配置接口密码错误或缺失"
    });
    return NextResponse.json({ error: "验证失败" }, { status: 401 });
  }
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Supabase环境变量未配置" }, { status: 500 });
  }

  const body = await request.json();
  const mode = body.mode === "qwen" ? "qwen" : "mock";
  const model = String(body.model ?? "").trim();
  const apiUrl = String(body.apiUrl ?? defaultQwenApiUrl).trim();
  const estimatedCostPerCall = Number(body.estimatedCostPerCall ?? 0);
  const notes = String(body.notes ?? "").trim() || null;

  if (!model) {
    return NextResponse.json({ error: "请输入模型名称" }, { status: 400 });
  }
  if (!apiUrl.startsWith("https://")) {
    return NextResponse.json({ error: "接口地址必须是 HTTPS" }, { status: 400 });
  }
  if (!Number.isFinite(estimatedCostPerCall) || estimatedCostPerCall < 0) {
    return NextResponse.json({ error: "单次成本必须是非负数字" }, { status: 400 });
  }

  const before = await getActiveVisionModelConfig();
  const values = {
    provider: "qwen",
    mode,
    model,
    api_url: apiUrl,
    estimated_cost_per_call: estimatedCostPerCall,
    notes,
    is_active: true,
    updated_at: new Date().toISOString()
  };

  const { error: disableError } = await supabaseAdmin
    .from("ai_model_configs")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("provider", "qwen");

  if (disableError) {
    return NextResponse.json({ error: disableError.message }, { status: 500 });
  }

  const { data, error } = await supabaseAdmin
    .from("ai_model_configs")
    .insert(values)
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await supabaseAdmin.from("admin_actions").insert({
    admin: "ADMIN_PASSWORD",
    access_code_id: null,
    action_type: "update_model_config",
    before_data: before,
    after_data: data,
    reason: notes ?? "更新视觉模型配置"
  });

  return NextResponse.json({
    modelConfig: {
      id: data.id,
      mode: data.mode,
      provider: data.provider,
      model: data.model,
      apiUrl: data.api_url,
      estimatedCostPerCall: Number(data.estimated_cost_per_call ?? 0),
      notes: data.notes,
      source: "database",
      updatedAt: data.updated_at
    }
  });
}


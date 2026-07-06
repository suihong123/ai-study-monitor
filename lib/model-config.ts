import { costConfig } from "@/lib/costs";
import { defaultQwenApiUrl } from "@/lib/model-options";
import { supabaseAdmin } from "@/lib/supabase/server";

export type AnalyzeMode = "mock" | "qwen";

export type VisionModelConfig = {
  id?: string;
  mode: AnalyzeMode;
  provider: "qwen";
  model: string;
  apiUrl: string;
  estimatedCostPerCall: number;
  notes?: string | null;
  source: "database" | "environment";
  updatedAt?: string | null;
};

export function getEnvironmentVisionModelConfig(): VisionModelConfig {
  const mode = process.env.ANALYZE_MODE === "qwen" ? "qwen" : "mock";
  return {
    mode,
    provider: "qwen",
    model: process.env.QWEN_MODEL || "qwen3.6-flash",
    apiUrl: process.env.QWEN_API_URL || defaultQwenApiUrl,
    estimatedCostPerCall: costConfig.visionAnalyzeCost,
    source: "environment"
  };
}

export async function getActiveVisionModelConfig(): Promise<VisionModelConfig> {
  const fallback = getEnvironmentVisionModelConfig();
  if (!supabaseAdmin) return fallback;

  try {
    const { data, error } = await supabaseAdmin
      .from("ai_model_configs")
      .select("*")
      .eq("provider", "qwen")
      .eq("is_active", true)
      .maybeSingle();

    if (error || !data) return fallback;

    const mode = data.mode === "qwen" ? "qwen" : "mock";
    return {
      id: data.id,
      mode,
      provider: "qwen",
      model: data.model || fallback.model,
      apiUrl: data.api_url || fallback.apiUrl,
      estimatedCostPerCall:
        Number(data.estimated_cost_per_call ?? 0) > 0
          ? Number(data.estimated_cost_per_call)
          : fallback.estimatedCostPerCall,
      notes: data.notes ?? null,
      source: "database",
      updatedAt: data.updated_at ?? null
    };
  } catch {
    return fallback;
  }
}


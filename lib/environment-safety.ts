export type AppEnvironment = "development" | "staging" | "production";

export interface SupabaseEnvironmentSafetyInput {
  appEnvironment?: string;
  supabaseUrl?: string;
  expectedProjectRef?: string;
  forbiddenProjectRef?: string;
}

export function projectRefFromSupabaseUrl(url?: string) {
  if (!url) return null;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (!hostname.endsWith(".supabase.co")) return null;
    return hostname.split(".")[0] || null;
  } catch {
    return null;
  }
}

export function assertSupabaseEnvironmentSafety({
  appEnvironment,
  supabaseUrl,
  expectedProjectRef,
  forbiddenProjectRef
}: SupabaseEnvironmentSafetyInput) {
  if (appEnvironment !== "staging" && appEnvironment !== "production") {
    return;
  }

  if (!supabaseUrl || !expectedProjectRef) {
    throw new Error(
      `${appEnvironment} 环境缺少 Supabase URL 或预期 project ref`
    );
  }

  const actualProjectRef = projectRefFromSupabaseUrl(supabaseUrl);
  if (!actualProjectRef) {
    throw new Error(`${appEnvironment} 环境的 Supabase URL 无效`);
  }
  if (actualProjectRef !== expectedProjectRef) {
    throw new Error(
      `${appEnvironment} 环境禁止连接非预期 Supabase 项目`
    );
  }
  if (forbiddenProjectRef && actualProjectRef === forbiddenProjectRef) {
    throw new Error(
      `${appEnvironment} 环境禁止连接被标记为另一环境的 Supabase 项目`
    );
  }
}

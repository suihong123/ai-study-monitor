import { evaluateDeviceRebindPolicy } from "@/lib/device-rebind-policy";
import { supabaseAdmin } from "@/lib/supabase/server";
import type { DeviceRebindConfig, DeviceRebindRequired } from "@/types";

export const defaultDeviceRebindConfig: DeviceRebindConfig = {
  rebindWindowDays: 15,
  rebindMaxCount: 10,
  rebindMinIntervalSeconds: 60,
  updatedAt: null,
  source: "default"
};

export async function getDeviceRebindConfig(): Promise<DeviceRebindConfig> {
  if (!supabaseAdmin) return defaultDeviceRebindConfig;

  try {
    const { data, error } = await supabaseAdmin
      .from("device_rebind_configs")
      .select("*")
      .eq("id", true)
      .maybeSingle();

    if (error || !data) return defaultDeviceRebindConfig;

    return {
      rebindWindowDays: Math.min(
        90,
        Math.max(
          1,
          Number(data.rebind_window_days ?? defaultDeviceRebindConfig.rebindWindowDays)
        )
      ),
      rebindMaxCount: Math.min(
        100,
        Math.max(
          1,
          Number(data.rebind_max_count ?? defaultDeviceRebindConfig.rebindMaxCount)
        )
      ),
      rebindMinIntervalSeconds: Math.min(
        86_400,
        Math.max(
          10,
          Number(
            data.rebind_min_interval_seconds ??
              defaultDeviceRebindConfig.rebindMinIntervalSeconds
          )
        )
      ),
      updatedAt: data.updated_at ?? null,
      source: "database"
    };
  } catch {
    return defaultDeviceRebindConfig;
  }
}

export async function getDeviceRebindStatus(params: {
  accessCodeId: string;
  currentDeviceId: string | null;
  requestedDeviceId: string;
}): Promise<DeviceRebindRequired> {
  const config = await getDeviceRebindConfig();
  const now = new Date();
  const windowStart = new Date(
    now.getTime() - config.rebindWindowDays * 24 * 60 * 60 * 1000
  ).toISOString();
  const successfulTimes: string[] = [];

  if (supabaseAdmin) {
    const { data } = await supabaseAdmin
      .from("device_rebind_logs")
      .select("created_at")
      .eq("access_code_id", params.accessCodeId)
      .eq("action_source", "user")
      .eq("success", true)
      .eq("result_code", "rebound")
      .gt("created_at", windowStart)
      .order("created_at", { ascending: true });

    for (const row of data ?? []) {
      if (row.created_at) successfulTimes.push(String(row.created_at));
    }
  }

  const decision = evaluateDeviceRebindPolicy({
    currentDeviceId: params.currentDeviceId,
    requestedDeviceId: params.requestedDeviceId,
    successfulReactivationTimes: successfulTimes,
    windowDays: config.rebindWindowDays,
    maxCount: config.rebindMaxCount,
    minIntervalSeconds: config.rebindMinIntervalSeconds,
    now
  });

  return {
    usedCount: decision.usedCount,
    maxCount: decision.maxCount,
    nextCount: decision.nextCount,
    windowDays: config.rebindWindowDays,
    minIntervalSeconds: config.rebindMinIntervalSeconds,
    allowed: decision.allowed,
    limitReason:
      decision.result === "rate_limited" ||
      decision.result === "window_limit_reached"
        ? decision.result
        : null,
    nextAvailableAt: decision.nextAvailableAt
  };
}

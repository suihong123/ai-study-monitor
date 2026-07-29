import { supabaseAdmin } from "@/lib/supabase/server";
import type { DeviceRebindConfig } from "@/types";

export const defaultDeviceRebindConfig: DeviceRebindConfig = {
  rebindCostMinutes: 30,
  rebindCooldownHours: 24,
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
      rebindCostMinutes: Math.max(
        1,
        Number(data.rebind_cost_minutes ?? defaultDeviceRebindConfig.rebindCostMinutes)
      ),
      rebindCooldownHours: Math.max(
        0,
        Number(data.rebind_cooldown_hours ?? defaultDeviceRebindConfig.rebindCooldownHours)
      ),
      updatedAt: data.updated_at ?? null,
      source: "database"
    };
  } catch {
    return defaultDeviceRebindConfig;
  }
}

export function calculateRebindCooldown(params: {
  lastRebindAt?: string | null;
  cooldownHours: number;
  now?: Date;
}) {
  if (!params.lastRebindAt || params.cooldownHours <= 0) {
    return { cooldownRemainingSeconds: 0, nextRebindAt: null };
  }

  const lastRebindAt = new Date(params.lastRebindAt).getTime();
  if (!Number.isFinite(lastRebindAt)) {
    return { cooldownRemainingSeconds: 0, nextRebindAt: null };
  }

  const nextRebindAt = new Date(
    lastRebindAt + params.cooldownHours * 60 * 60 * 1000
  );
  const remaining = Math.max(
    0,
    Math.ceil((nextRebindAt.getTime() - (params.now ?? new Date()).getTime()) / 1000)
  );

  return {
    cooldownRemainingSeconds: remaining,
    nextRebindAt: remaining > 0 ? nextRebindAt.toISOString() : null
  };
}

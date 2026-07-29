export type DeviceRebindPolicyInput = {
  currentDeviceId: string | null;
  requestedDeviceId: string;
  freeRebindCount: number;
  remainingMinutes: number;
  costMinutes: number;
  cooldownRemainingSeconds: number;
};

export type DeviceRebindPolicyDecision = {
  result:
    | "first_bind"
    | "same_device"
    | "free_rebind"
    | "paid_rebind"
    | "cooldown_active"
    | "insufficient_minutes";
  allowed: boolean;
  nextFreeRebindCount: number;
  deductedMinutes: number;
  nextRemainingMinutes: number;
};

export function evaluateDeviceRebindPolicy(
  input: DeviceRebindPolicyInput
): DeviceRebindPolicyDecision {
  const freeRebindCount = Math.max(0, Math.floor(input.freeRebindCount));
  const remainingMinutes = Math.max(0, Math.floor(input.remainingMinutes));
  const costMinutes = Math.max(1, Math.floor(input.costMinutes));

  if (!input.currentDeviceId) {
    return {
      result: "first_bind",
      allowed: true,
      nextFreeRebindCount: freeRebindCount,
      deductedMinutes: 0,
      nextRemainingMinutes: remainingMinutes
    };
  }

  if (input.currentDeviceId === input.requestedDeviceId) {
    return {
      result: "same_device",
      allowed: true,
      nextFreeRebindCount: freeRebindCount,
      deductedMinutes: 0,
      nextRemainingMinutes: remainingMinutes
    };
  }

  if (input.cooldownRemainingSeconds > 0) {
    return {
      result: "cooldown_active",
      allowed: false,
      nextFreeRebindCount: freeRebindCount,
      deductedMinutes: 0,
      nextRemainingMinutes: remainingMinutes
    };
  }

  if (freeRebindCount > 0) {
    return {
      result: "free_rebind",
      allowed: true,
      nextFreeRebindCount: freeRebindCount - 1,
      deductedMinutes: 0,
      nextRemainingMinutes: remainingMinutes
    };
  }

  if (remainingMinutes < costMinutes) {
    return {
      result: "insufficient_minutes",
      allowed: false,
      nextFreeRebindCount: 0,
      deductedMinutes: 0,
      nextRemainingMinutes: remainingMinutes
    };
  }

  return {
    result: "paid_rebind",
    allowed: true,
    nextFreeRebindCount: 0,
    deductedMinutes: costMinutes,
    nextRemainingMinutes: remainingMinutes - costMinutes
  };
}

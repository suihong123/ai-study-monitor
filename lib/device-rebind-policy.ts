export type DeviceRebindPolicyInput = {
  currentDeviceId: string | null;
  requestedDeviceId: string;
  successfulReactivationTimes: string[];
  windowDays: number;
  maxCount: number;
  minIntervalSeconds: number;
  now?: Date;
};

export type DeviceRebindPolicyDecision = {
  result:
    | "first_activation"
    | "same_environment"
    | "reactivation"
    | "rate_limited"
    | "window_limit_reached";
  allowed: boolean;
  usedCount: number;
  maxCount: number;
  nextCount: number;
  nextAvailableAt: string | null;
};

export function evaluateDeviceRebindPolicy(
  input: DeviceRebindPolicyInput
): DeviceRebindPolicyDecision {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const windowDays = Math.min(90, Math.max(1, Math.floor(input.windowDays)));
  const maxCount = Math.min(100, Math.max(1, Math.floor(input.maxCount)));
  const minIntervalSeconds = Math.min(
    86_400,
    Math.max(10, Math.floor(input.minIntervalSeconds))
  );
  const windowStartMs = nowMs - windowDays * 24 * 60 * 60 * 1000;
  const successfulTimes = input.successfulReactivationTimes
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value) && value > windowStartMs && value <= nowMs)
    .sort((left, right) => left - right);
  const usedCount = successfulTimes.length;

  if (!input.currentDeviceId) {
    return {
      result: "first_activation",
      allowed: true,
      usedCount,
      maxCount,
      nextCount: usedCount,
      nextAvailableAt: null
    };
  }

  if (input.currentDeviceId === input.requestedDeviceId) {
    return {
      result: "same_environment",
      allowed: true,
      usedCount,
      maxCount,
      nextCount: usedCount,
      nextAvailableAt: null
    };
  }

  if (usedCount >= maxCount) {
    return {
      result: "window_limit_reached",
      allowed: false,
      usedCount,
      maxCount,
      nextCount: usedCount,
      nextAvailableAt: new Date(
        successfulTimes[0] + windowDays * 24 * 60 * 60 * 1000
      ).toISOString()
    };
  }

  const latestSuccessMs = successfulTimes[successfulTimes.length - 1];
  if (
    latestSuccessMs !== undefined &&
    latestSuccessMs + minIntervalSeconds * 1000 > nowMs
  ) {
    return {
      result: "rate_limited",
      allowed: false,
      usedCount,
      maxCount,
      nextCount: usedCount + 1,
      nextAvailableAt: new Date(
        latestSuccessMs + minIntervalSeconds * 1000
      ).toISOString()
    };
  }

  return {
    result: "reactivation",
    allowed: true,
    usedCount,
    maxCount,
    nextCount: usedCount + 1,
    nextAvailableAt: null
  };
}

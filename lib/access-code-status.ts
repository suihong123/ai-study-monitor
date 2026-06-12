import type { AccessCodeStatus } from "@/types";

export const statusLabels: Record<AccessCodeStatus, string> = {
  active: "正常使用",
  watch: "观察中",
  paused: "暂停使用",
  refunded: "退款冻结",
  expired: "已过期",
  disabled: "永久禁用",
  blacklist: "黑名单"
};

export const statusMessages: Record<AccessCodeStatus, string> = {
  active: "",
  watch: "",
  paused: "该访问码已暂停使用，请联系客服。",
  refunded: "该访问码已退款冻结，无法继续使用。",
  expired: "该访问码已过期。",
  disabled: "该访问码已被禁用，请联系客服。",
  blacklist: "该访问码存在异常，无法继续使用。"
};

export function canUseAccessCode(status: AccessCodeStatus) {
  return status === "active" || status === "watch";
}

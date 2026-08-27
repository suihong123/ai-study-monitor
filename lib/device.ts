"use client";

import type { DeviceInfo, DevicePlatform } from "@/types";

const DEVICE_KEY = "ai-study-supervisor-device-id";

export function getDeviceId() {
  const existing = window.localStorage.getItem(DEVICE_KEY);
  if (existing) return existing;

  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  window.localStorage.setItem(DEVICE_KEY, id);
  return id;
}

function getPlatform(userAgent: string): DevicePlatform {
  if (/android/i.test(userAgent)) return "Android";
  if (/iphone|ipad|ipod/i.test(userAgent)) return "iOS";
  if (/windows/i.test(userAgent)) return "Windows";
  if (/macintosh|mac os x/i.test(userAgent)) return "Mac";
  return "Other";
}

function getBrowserName(userAgent: string) {
  if (/edg\//i.test(userAgent)) return "Edge";
  if (/crios\//i.test(userAgent)) return "Chrome";
  if (/chrome\//i.test(userAgent)) return "Chrome";
  if (/firefox\//i.test(userAgent)) return "Firefox";
  if (/safari\//i.test(userAgent)) return "Safari";
  return "浏览器";
}

function getDeviceModel(userAgent: string, platform: DevicePlatform) {
  if (platform === "Android") {
    const match = userAgent.match(/;\s*([^;()]+?)\s+Build\//i);
    return match?.[1]?.trim() || "Android 设备";
  }
  if (platform === "iOS") {
    if (/ipad/i.test(userAgent)) return "iPad";
    if (/iphone/i.test(userAgent)) return "iPhone";
    return "iOS 设备";
  }
  if (platform === "Windows") return "Windows 设备";
  if (platform === "Mac") return "Mac";
  return "未知型号";
}

export function getDeviceInfo(): DeviceInfo {
  const userAgent = window.navigator.userAgent || "";
  const platform = getPlatform(userAgent);
  const model = getDeviceModel(userAgent, platform);
  const browser = getBrowserName(userAgent);

  return {
    deviceId: getDeviceId(),
    deviceName: `${model} · ${browser}`,
    deviceModel: model,
    devicePlatform: platform
  };
}

export function getDeviceRebindRequestId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `rebind-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

import { createHash } from "node:crypto";

export const hostelLicensePattern =
  /^HOSTEL-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;

export function normalizeHostelLicenseKey(value: string) {
  return value.trim().toUpperCase().replace(/\s+/g, "");
}

export function isValidHostelLicenseKey(value: string) {
  return hostelLicensePattern.test(normalizeHostelLicenseKey(value));
}

export function hashHostelLicenseKey(value: string) {
  const normalized = normalizeHostelLicenseKey(value);
  if (!hostelLicensePattern.test(normalized)) {
    throw new Error("invalid_license_format");
  }
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

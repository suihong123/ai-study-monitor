import type { NextRequest } from "next/server";

export function isAdminRequest(request: NextRequest) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return false;
  return request.headers.get("x-admin-password") === password;
}

import type { NextRequest } from "next/server";
import { isAdminRequest } from "@/lib/admin";

export function hostelAdminJson(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0"
    }
  });
}

export function requireHostelAdmin(request: NextRequest) {
  return isAdminRequest(request);
}

export function logHostelAdminReadError(route: string, errorCode: string) {
  console.error("[admin/hostel] read failed", {
    route,
    errorCode
  });
}

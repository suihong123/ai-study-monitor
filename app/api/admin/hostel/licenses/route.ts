import type { NextRequest } from "next/server";
import {
  hostelAdminJson,
  logHostelAdminReadError,
  requireHostelAdmin
} from "@/lib/hostel-admin/http";
import {
  HostelAdminRepositoryError,
  hostelRepositoryErrorCode,
  listHostelLicenses
} from "@/lib/hostel-admin/repository";
import type { HostelLicenseStatusFilter } from "@/lib/hostel-admin/types";
import { hostelAdminSupabase } from "@/lib/hostel-admin/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!requireHostelAdmin(request)) {
    return hostelAdminJson({ error: "unauthorized" }, 401);
  }
  if (!hostelAdminSupabase) {
    return hostelAdminJson({ error: "service_unavailable" }, 500);
  }

  const pageSizeValue = request.nextUrl.searchParams.get("pageSize");
  const pageSize = pageSizeValue ? Number(pageSizeValue) : 25;
  const cursor = request.nextUrl.searchParams.get("cursor");
  const status = (request.nextUrl.searchParams.get("status") ??
    "all") as HostelLicenseStatusFilter;

  try {
    const page = await listHostelLicenses(hostelAdminSupabase, {
      pageSize,
      cursor,
      status
    });
    return hostelAdminJson(page);
  } catch (error) {
    if (
      error instanceof HostelAdminRepositoryError &&
      ["invalid_cursor", "invalid_status"].includes(error.code)
    ) {
      return hostelAdminJson({ error: error.code }, 400);
    }
    const errorCode = hostelRepositoryErrorCode(error);
    logHostelAdminReadError("licenses", errorCode);
    return hostelAdminJson({ error: "hostel_licenses_unavailable" }, 500);
  }
}

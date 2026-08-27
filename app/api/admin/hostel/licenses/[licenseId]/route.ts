import type { NextRequest } from "next/server";
import {
  hostelAdminJson,
  logHostelAdminReadError,
  requireHostelAdmin
} from "@/lib/hostel-admin/http";
import {
  HostelAdminRepositoryError,
  getHostelLicenseDetail,
  hostelRepositoryErrorCode
} from "@/lib/hostel-admin/repository";
import { hostelAdminSupabase } from "@/lib/hostel-admin/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  context: { params: { licenseId: string } }
) {
  if (!requireHostelAdmin(request)) {
    return hostelAdminJson({ error: "unauthorized" }, 401);
  }
  if (!hostelAdminSupabase) {
    return hostelAdminJson({ error: "service_unavailable" }, 500);
  }
  try {
    const license = await getHostelLicenseDetail(
      hostelAdminSupabase,
      context.params.licenseId
    );
    if (!license) {
      return hostelAdminJson({ error: "license_not_found" }, 404);
    }
    return hostelAdminJson({ license });
  } catch (error) {
    if (
      error instanceof HostelAdminRepositoryError &&
      error.code === "invalid_license_id"
    ) {
      return hostelAdminJson({ error: "invalid_license_id" }, 400);
    }
    const errorCode = hostelRepositoryErrorCode(error);
    logHostelAdminReadError("license-detail", errorCode);
    return hostelAdminJson({ error: "hostel_license_unavailable" }, 500);
  }
}

import type { NextRequest } from "next/server";
import {
  hostelAdminJson,
  logHostelAdminReadError,
  requireHostelAdmin
} from "@/lib/hostel-admin/http";
import {
  getHostelLicenseOverview,
  hostelRepositoryErrorCode
} from "@/lib/hostel-admin/repository";
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
  try {
    const overview = await getHostelLicenseOverview(hostelAdminSupabase);
    return hostelAdminJson({ overview });
  } catch (error) {
    const errorCode = hostelRepositoryErrorCode(error);
    logHostelAdminReadError("overview", errorCode);
    return hostelAdminJson({ error: "hostel_overview_unavailable" }, 500);
  }
}

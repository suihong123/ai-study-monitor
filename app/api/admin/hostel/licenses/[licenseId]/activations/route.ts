import type { NextRequest } from "next/server";
import {
  hostelAdminJson,
  logHostelAdminReadError,
  requireHostelAdmin
} from "@/lib/hostel-admin/http";
import {
  HostelAdminRepositoryError,
  getHostelLicenseActivations,
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
    const activations = await getHostelLicenseActivations(
      hostelAdminSupabase,
      context.params.licenseId
    );
    if (!activations) {
      return hostelAdminJson({ error: "license_not_found" }, 404);
    }
    return hostelAdminJson(activations);
  } catch (error) {
    if (
      error instanceof HostelAdminRepositoryError &&
      error.code === "invalid_license_id"
    ) {
      return hostelAdminJson({ error: "invalid_license_id" }, 400);
    }
    const errorCode = hostelRepositoryErrorCode(error);
    logHostelAdminReadError("license-activations", errorCode);
    return hostelAdminJson({ error: "hostel_activations_unavailable" }, 500);
  }
}

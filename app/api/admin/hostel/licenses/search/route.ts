import type { NextRequest } from "next/server";
import { hashHostelLicenseKey } from "@/lib/hostel-admin/license-hash";
import {
  hostelAdminJson,
  logHostelAdminReadError,
  requireHostelAdmin
} from "@/lib/hostel-admin/http";
import {
  hostelRepositoryErrorCode,
  searchHostelLicenseByHash
} from "@/lib/hostel-admin/repository";
import { hostelAdminSupabase } from "@/lib/hostel-admin/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!requireHostelAdmin(request)) {
    return hostelAdminJson({ error: "unauthorized" }, 401);
  }
  if (!hostelAdminSupabase) {
    return hostelAdminJson({ error: "service_unavailable" }, 500);
  }

  let licenseKey = "";
  try {
    const body = (await request.json()) as { licenseKey?: unknown };
    if (typeof body.licenseKey !== "string" || body.licenseKey.length > 128) {
      return hostelAdminJson({ error: "invalid_license_format" }, 400);
    }
    licenseKey = body.licenseKey;
  } catch {
    return hostelAdminJson({ error: "invalid_request" }, 400);
  }

  let keyHash: string;
  try {
    keyHash = hashHostelLicenseKey(licenseKey);
  } catch {
    return hostelAdminJson({ error: "invalid_license_format" }, 400);
  } finally {
    licenseKey = "";
  }

  try {
    const license = await searchHostelLicenseByHash(hostelAdminSupabase, keyHash);
    keyHash = "";
    if (!license) {
      return hostelAdminJson({ error: "license_not_found" }, 404);
    }
    return hostelAdminJson({ license });
  } catch (error) {
    keyHash = "";
    const errorCode = hostelRepositoryErrorCode(error);
    logHostelAdminReadError("license-search", errorCode);
    return hostelAdminJson({ error: "hostel_search_unavailable" }, 500);
  }
}

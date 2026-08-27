import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  HostelActivationDTO,
  HostelActivationListDTO,
  HostelActivationRow,
  HostelLicenseCursor,
  HostelLicenseDetailDTO,
  HostelLicenseListItemDTO,
  HostelLicenseOverviewDTO,
  HostelLicensePageDTO,
  HostelLicenseRow,
  HostelLicenseStatus,
  HostelLicenseStatusFilter
} from "@/lib/hostel-admin/types";
import { hostelLicenseStatuses } from "@/lib/hostel-admin/types";

export const hostelLicenseSelect =
  "id,status,plan,max_activations,expires_at,created_at,updated_at";
export const hostelActivationSelect =
  "id,license_id,device_name,activated_at,last_seen_at,revoked_at";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class HostelAdminRepositoryError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "HostelAdminRepositoryError";
  }
}

function databaseReadFailed() {
  return new HostelAdminRepositoryError("database_read_failed");
}

function assertDate(value: string) {
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new HostelAdminRepositoryError("invalid_database_value");
  }
  return value;
}

function assertLicenseRow(value: unknown): HostelLicenseRow {
  if (!value || typeof value !== "object") {
    throw new HostelAdminRepositoryError("invalid_database_value");
  }
  const row = value as Partial<HostelLicenseRow>;
  if (
    typeof row.id !== "string" ||
    typeof row.status !== "string" ||
    typeof row.plan !== "string" ||
    typeof row.max_activations !== "number" ||
    typeof row.expires_at !== "string" ||
    typeof row.created_at !== "string" ||
    typeof row.updated_at !== "string"
  ) {
    throw new HostelAdminRepositoryError("invalid_database_value");
  }
  assertDate(row.expires_at);
  assertDate(row.created_at);
  assertDate(row.updated_at);
  return row as HostelLicenseRow;
}

function assertActivationRow(value: unknown): HostelActivationRow {
  if (!value || typeof value !== "object") {
    throw new HostelAdminRepositoryError("invalid_database_value");
  }
  const row = value as Partial<HostelActivationRow>;
  if (
    typeof row.id !== "string" ||
    typeof row.license_id !== "string" ||
    typeof row.device_name !== "string" ||
    typeof row.activated_at !== "string" ||
    typeof row.last_seen_at !== "string" ||
    !(typeof row.revoked_at === "string" || row.revoked_at === null)
  ) {
    throw new HostelAdminRepositoryError("invalid_database_value");
  }
  assertDate(row.activated_at);
  assertDate(row.last_seen_at);
  if (row.revoked_at) assertDate(row.revoked_at);
  return row as HostelActivationRow;
}

export function isHostelLicenseStatus(value: string): value is HostelLicenseStatus {
  return (hostelLicenseStatuses as readonly string[]).includes(value);
}

export function getEffectiveHostelLicenseStatus(
  status: string,
  expiresAt: string,
  now = new Date()
): HostelLicenseStatus {
  if (!isHostelLicenseStatus(status)) {
    throw new HostelAdminRepositoryError("invalid_database_value");
  }
  if (status === "revoked") return "revoked";
  if (status === "expired" || Date.parse(expiresAt) <= now.getTime()) {
    return "expired";
  }
  return status;
}

export function buildHostelLicenseOverview(
  rows: Array<Pick<HostelLicenseRow, "status" | "expires_at">>,
  now = new Date()
): HostelLicenseOverviewDTO {
  const overview: HostelLicenseOverviewDTO = {
    total: rows.length,
    unused: 0,
    activated: 0,
    expired: 0,
    revoked: 0,
    generatedAt: now.toISOString()
  };
  for (const row of rows) {
    const status = getEffectiveHostelLicenseStatus(
      row.status,
      assertDate(row.expires_at),
      now
    );
    overview[status] += 1;
  }
  return overview;
}

export function encodeHostelLicenseCursor(cursor: HostelLicenseCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeHostelLicenseCursor(value: string): HostelLicenseCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as Partial<HostelLicenseCursor>;
    if (
      typeof parsed.createdAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.createdAt)) ||
      typeof parsed.id !== "string" ||
      !uuidPattern.test(parsed.id)
    ) {
      throw new Error("invalid");
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new HostelAdminRepositoryError("invalid_cursor");
  }
}

export function buildHostelCursorFilter(cursor: HostelLicenseCursor) {
  return `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`;
}

export function isHostelRowAfterCursor(
  row: Pick<HostelLicenseRow, "created_at" | "id">,
  cursor: HostelLicenseCursor
) {
  return (
    row.created_at < cursor.createdAt ||
    (row.created_at === cursor.createdAt && row.id < cursor.id)
  );
}

export function toHostelLicenseListItemDTO(
  row: HostelLicenseRow,
  activeActivationCount: number,
  now: Date
): HostelLicenseListItemDTO {
  if (row.plan !== "commercial") {
    throw new HostelAdminRepositoryError("invalid_database_value");
  }
  return {
    id: row.id,
    status: getEffectiveHostelLicenseStatus(row.status, row.expires_at, now),
    plan: "commercial",
    maxActivations: row.max_activations,
    activeActivationCount,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function toHostelActivationDTO(
  row: HostelActivationRow,
  licenseStatus: HostelLicenseStatus
): HostelActivationDTO {
  const isBound = row.revoked_at === null;
  return {
    id: row.id,
    deviceName: row.device_name,
    activatedAt: row.activated_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    isBound,
    isUsable:
      isBound && licenseStatus !== "expired" && licenseStatus !== "revoked"
  };
}

function validPageSize(value: number) {
  if (!Number.isInteger(value) || value < 1) return 25;
  return Math.min(value, 100);
}

async function getActiveActivationCounts(
  client: SupabaseClient,
  licenseIds: string[]
) {
  const counts = new Map<string, number>();
  if (licenseIds.length === 0) return counts;
  const { data, error } = await client
    .from("hostel_license_activations")
    .select("license_id,revoked_at")
    .in("license_id", licenseIds)
    .is("revoked_at", null);
  if (error) throw databaseReadFailed();
  for (const value of data ?? []) {
    const row = value as { license_id?: unknown; revoked_at?: unknown };
    if (typeof row.license_id !== "string" || row.revoked_at !== null) {
      throw new HostelAdminRepositoryError("invalid_database_value");
    }
    counts.set(row.license_id, (counts.get(row.license_id) ?? 0) + 1);
  }
  return counts;
}

async function getLicenseRowById(client: SupabaseClient, licenseId: string) {
  if (!uuidPattern.test(licenseId)) {
    throw new HostelAdminRepositoryError("invalid_license_id");
  }
  const { data, error } = await client
    .from("hostel_licenses")
    .select(hostelLicenseSelect)
    .eq("id", licenseId)
    .maybeSingle();
  if (error) throw databaseReadFailed();
  return data ? assertLicenseRow(data) : null;
}

async function getActivationRowsForLicense(
  client: SupabaseClient,
  licenseId: string
) {
  const { data, error } = await client
    .from("hostel_license_activations")
    .select(hostelActivationSelect)
    .eq("license_id", licenseId)
    .order("activated_at", { ascending: false });
  if (error) throw databaseReadFailed();
  return (data ?? []).map(assertActivationRow);
}

export function buildHostelLicenseDetailDTO(
  license: HostelLicenseRow,
  activationRows: HostelActivationRow[],
  now = new Date()
): HostelLicenseDetailDTO {
  const licenseStatus = getEffectiveHostelLicenseStatus(
    license.status,
    license.expires_at,
    now
  );
  const activations = activationRows.map((row) =>
    toHostelActivationDTO(row, licenseStatus)
  );
  const activeActivationCount = activations.filter((item) => item.isBound).length;
  const base = toHostelLicenseListItemDTO(
    license,
    activeActivationCount,
    now
  );
  return {
    ...base,
    usableActivationCount:
      base.status === "expired" || base.status === "revoked"
        ? 0
        : activeActivationCount,
    activations
  };
}

export async function getHostelLicenseOverview(
  client: SupabaseClient,
  now = new Date()
) {
  const { data, error } = await client
    .from("hostel_licenses")
    .select("status,expires_at");
  if (error) throw databaseReadFailed();
  const rows = (data ?? []).map((value) => {
    const row = value as { status?: unknown; expires_at?: unknown };
    if (typeof row.status !== "string" || typeof row.expires_at !== "string") {
      throw new HostelAdminRepositoryError("invalid_database_value");
    }
    return { status: row.status, expires_at: row.expires_at };
  });
  return buildHostelLicenseOverview(rows, now);
}

export async function listHostelLicenses(
  client: SupabaseClient,
  options: {
    pageSize?: number;
    cursor?: string | null;
    status?: HostelLicenseStatusFilter;
    now?: Date;
  } = {}
): Promise<HostelLicensePageDTO> {
  const now = options.now ?? new Date();
  const pageSize = validPageSize(options.pageSize ?? 25);
  const status = options.status ?? "all";
  if (status !== "all" && !isHostelLicenseStatus(status)) {
    throw new HostelAdminRepositoryError("invalid_status");
  }

  let query = client
    .from("hostel_licenses")
    .select(hostelLicenseSelect)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });

  const nowIso = now.toISOString();
  if (status === "revoked") {
    query = query.eq("status", "revoked");
  } else if (status === "expired") {
    query = query
      .neq("status", "revoked")
      .or(`status.eq.expired,expires_at.lte.${nowIso}`);
  } else if (status === "unused" || status === "activated") {
    query = query.eq("status", status).gt("expires_at", nowIso);
  }

  if (options.cursor) {
    query = query.or(
      buildHostelCursorFilter(decodeHostelLicenseCursor(options.cursor))
    );
  }

  const { data, error } = await query.limit(pageSize + 1);
  if (error) throw databaseReadFailed();
  const rows = (data ?? []).map(assertLicenseRow);
  const hasMore = rows.length > pageSize;
  const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
  const counts = await getActiveActivationCounts(
    client,
    pageRows.map((row) => row.id)
  );
  const last = pageRows.at(-1);
  return {
    items: pageRows.map((row) =>
      toHostelLicenseListItemDTO(row, counts.get(row.id) ?? 0, now)
    ),
    pageSize,
    nextCursor:
      hasMore && last
        ? encodeHostelLicenseCursor({
            createdAt: last.created_at,
            id: last.id
          })
        : null
  };
}

export async function searchHostelLicenseByHash(
  client: SupabaseClient,
  keyHash: string,
  now = new Date()
) {
  const { data, error } = await client
    .from("hostel_licenses")
    .select(hostelLicenseSelect)
    .eq("key_hash", keyHash)
    .maybeSingle();
  if (error) throw databaseReadFailed();
  if (!data) return null;
  const row = assertLicenseRow(data);
  const counts = await getActiveActivationCounts(client, [row.id]);
  return toHostelLicenseListItemDTO(row, counts.get(row.id) ?? 0, now);
}

export async function getHostelLicenseActivations(
  client: SupabaseClient,
  licenseId: string,
  now = new Date()
): Promise<HostelActivationListDTO | null> {
  const license = await getLicenseRowById(client, licenseId);
  if (!license) return null;
  const licenseStatus = getEffectiveHostelLicenseStatus(
    license.status,
    license.expires_at,
    now
  );
  const rows = await getActivationRowsForLicense(client, licenseId);
  return {
    items: rows.map((row) => toHostelActivationDTO(row, licenseStatus))
  };
}

export async function getHostelLicenseDetail(
  client: SupabaseClient,
  licenseId: string,
  now = new Date()
): Promise<HostelLicenseDetailDTO | null> {
  const license = await getLicenseRowById(client, licenseId);
  if (!license) return null;
  const activationRows = await getActivationRowsForLicense(client, licenseId);
  return buildHostelLicenseDetailDTO(license, activationRows, now);
}

export function hostelRepositoryErrorCode(error: unknown) {
  return error instanceof HostelAdminRepositoryError
    ? error.code
    : "database_read_failed";
}

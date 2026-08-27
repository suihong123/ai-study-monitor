import { timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

type KeepAliveResult =
  | { ok: true }
  | { ok: false; errorCode: string };

type KeepAliveDependencies = {
  cronSecret: string | undefined;
  query: () => Promise<KeepAliveResult>;
  logError: (metadata: { errorCode: string }) => void;
};

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function isValidCronAuthorization(
  authorization: string | null,
  cronSecret: string | undefined
) {
  if (!cronSecret || !authorization) return false;
  return safeEqual(authorization, `Bearer ${cronSecret}`);
}

function safeDatabaseErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return "database_read_failed";
  }
  const code = String(error.code);
  return /^[A-Za-z0-9_-]{1,64}$/.test(code)
    ? code
    : "database_read_failed";
}

export async function executeKeepAliveQuery(
  client: SupabaseClient | null
): Promise<KeepAliveResult> {
  if (!client) {
    return { ok: false, errorCode: "supabase_not_configured" };
  }

  try {
    const { error } = await client
      .from("access_codes")
      .select("id")
      .limit(1);

    if (error) {
      return { ok: false, errorCode: safeDatabaseErrorCode(error) };
    }
    return { ok: true };
  } catch {
    return { ok: false, errorCode: "database_read_failed" };
  }
}

export async function handleKeepAliveRequest(
  request: Request,
  dependencies: KeepAliveDependencies
) {
  if (
    !isValidCronAuthorization(
      request.headers.get("authorization"),
      dependencies.cronSecret
    )
  ) {
    return Response.json({ ok: false }, { status: 401 });
  }

  let result: KeepAliveResult;
  try {
    result = await dependencies.query();
  } catch {
    result = { ok: false, errorCode: "database_read_failed" };
  }

  if (!result.ok) {
    dependencies.logError({ errorCode: result.errorCode });
    return Response.json({ ok: false }, { status: 500 });
  }

  return Response.json({ ok: true }, { status: 200 });
}

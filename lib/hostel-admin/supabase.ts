import { createClient } from "@supabase/supabase-js";
import { assertSupabaseEnvironmentSafety } from "@/lib/environment-safety";

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

assertSupabaseEnvironmentSafety({
  appEnvironment: process.env.APP_ENV,
  supabaseUrl: url,
  expectedProjectRef: process.env.EXPECTED_SUPABASE_PROJECT_REF,
  forbiddenProjectRef: process.env.FORBIDDEN_SUPABASE_PROJECT_REF
});

export const hostelAdminNoStoreFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, cache: "no-store" });

export const hostelAdminSupabase =
  url && serviceKey
    ? createClient(url, serviceKey, {
        global: { fetch: hostelAdminNoStoreFetch }
      })
    : null;

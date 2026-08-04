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

export const supabaseAdmin =
  url && serviceKey ? createClient(url, serviceKey) : null;

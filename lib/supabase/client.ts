import { createClient } from "@supabase/supabase-js";
import { assertSupabaseEnvironmentSafety } from "@/lib/environment-safety";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

assertSupabaseEnvironmentSafety({
  appEnvironment: process.env.NEXT_PUBLIC_APP_ENV,
  supabaseUrl: url,
  expectedProjectRef:
    process.env.NEXT_PUBLIC_EXPECTED_SUPABASE_PROJECT_REF,
  forbiddenProjectRef:
    process.env.NEXT_PUBLIC_FORBIDDEN_SUPABASE_PROJECT_REF
});

export const supabaseClient =
  url && anonKey ? createClient(url, anonKey) : null;

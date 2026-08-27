import type { NextRequest } from "next/server";
import {
  executeKeepAliveQuery,
  handleKeepAliveRequest
} from "@/lib/cron-keep-alive";
import { supabaseAdmin } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  return handleKeepAliveRequest(request, {
    cronSecret: process.env.CRON_SECRET,
    query: () => executeKeepAliveQuery(supabaseAdmin),
    logError: ({ errorCode }) => {
      console.error("[cron/keep-alive] database read failed", { errorCode });
    }
  });
}

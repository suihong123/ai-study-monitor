import { NextRequest } from "next/server";

export async function POST(request: NextRequest) {
  const body = await request.json();
  return fetch(new URL("/api/access-code", request.url), {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "user-agent": request.headers.get("user-agent") ?? "",
      "x-forwarded-for": request.headers.get("x-forwarded-for") ?? ""
    },
    body: JSON.stringify({ ...body, action: "finish-session" })
  });
}

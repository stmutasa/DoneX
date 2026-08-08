import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/lib/auth";
import { consumeState, exchangeCode, resolveOrigin } from "@/lib/google/oauth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const gate = await requireSession();
  if (gate) return gate;

  const origin = resolveOrigin(request);
  const params = request.nextUrl.searchParams;
  const fail = (reason: string) =>
    NextResponse.redirect(
      `${origin}/settings?google=error&reason=${encodeURIComponent(reason.slice(0, 200))}`,
      302
    );

  const denied = params.get("error");
  if (denied) return fail(denied);

  if (!consumeState(params.get("state"))) return fail("state_mismatch");

  const code = params.get("code");
  if (!code) return fail("missing_code");

  try {
    await exchangeCode(code, request);
  } catch (err) {
    return fail(err instanceof Error ? err.message : "exchange_failed");
  }

  return NextResponse.redirect(`${origin}/settings?google=connected`, 302);
}

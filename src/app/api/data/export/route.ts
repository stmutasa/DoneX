import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { exportAll, settingsRepo } from "@/lib/db/repos";
import { localDateKey } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireSession();
  if (gate) return gate;

  const data = exportAll();
  const date = localDateKey(new Date(), settingsRepo.getApp().tz);
  return new NextResponse(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="donex-export-${date}.json"`,
    },
  });
}

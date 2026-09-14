/**
 * Snapshots: list them, take one, download one, put one back, delete one.
 * Owner only — a backup carries everything, including the shared list.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth";
import {
  daysSinceBackup,
  deleteSnapshot,
  listSnapshots,
  readSnapshot,
  readStatus,
  restoreSnapshot,
  runBackup,
} from "@/lib/backup";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  // ?download=<name> streams one snapshot back as a file.
  const name = req.nextUrl.searchParams.get("download");
  if (name) {
    try {
      const body = readSnapshot(name);
      return new NextResponse(new Uint8Array(body), {
        status: 200,
        headers: {
          "Content-Type": "application/gzip",
          "Content-Disposition": `attachment; filename="${name}"`,
        },
      });
    } catch {
      return NextResponse.json({ error: "Unknown snapshot" }, { status: 404 });
    }
  }

  const status = readStatus();
  return NextResponse.json({
    snapshots: listSnapshots(),
    status,
    daysSince: daysSinceBackup(status),
  });
}

const PostSchema = z.object({ kind: z.enum(["manual"]).optional() });

export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const parsed = PostSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  try {
    return NextResponse.json({ ok: true, snapshot: runBackup("manual") });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Backup failed" },
      { status: 500 },
    );
  }
}

const PutSchema = z.object({
  name: z.string().min(1),
  includeSettings: z.boolean().optional(),
});

/** Restore. A safety snapshot is taken first, so this is itself undoable. */
export async function PUT(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const parsed = PutSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  try {
    const result = restoreSnapshot(parsed.data.name, parsed.data.includeSettings ?? false);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Restore failed" },
      { status: 500 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const name = req.nextUrl.searchParams.get("name") ?? "";
  try {
    deleteSnapshot(name);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Unknown snapshot" }, { status: 404 });
  }
}

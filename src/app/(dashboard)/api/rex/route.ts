import { NextRequest, NextResponse } from "next/server";
import { dbApi } from "@/lib/db";
import { requireSession } from "@/lib/authz";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireSession(req, (p) => p.rex.viewAll || p.users.manage);
  if (!auth.ok) return auth.response;

  const rexGroups = await dbApi.listRexGroups();
  return NextResponse.json({ ok: true, rexGroups });
}

export async function POST(req: NextRequest) {
  const auth = await requireSession(req, (p) => p.users.manage);
  if (!auth.ok) return auth.response;

  const body = await req.json();
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (name.length < 2 || name.length > 40) {
    return NextResponse.json(
      { ok: false, error: "Rex category name must be 2–40 characters" },
      { status: 400 }
    );
  }

  const dup = await dbApi.getRexGroupByName(name);
  if (dup) {
    return NextResponse.json(
      { ok: false, error: `Rex category "${dup.name}" already exists` },
      { status: 409 }
    );
  }

  const rex = await dbApi.createRexGroup(name);
  await dbApi.addAuditLog({
    actorUserId: auth.user.id,
    actorUsername: auth.user.username,
    action: "rex.create",
    targetType: "rex",
    targetId: String(rex.id),
    detail: { name: rex.name },
  });

  return NextResponse.json({ ok: true, rex }, { status: 201 });
}

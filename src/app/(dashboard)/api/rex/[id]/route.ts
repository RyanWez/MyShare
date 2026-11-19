import { NextRequest, NextResponse } from "next/server";
import { dbApi } from "@/lib/db";
import { requireSession } from "@/lib/authz";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, context: { params: { id: string } }) {
  const auth = await requireSession(req, (p) => p.users.manage);
  if (!auth.ok) return auth.response;

  const rexId = Number(context.params.id);
  if (!Number.isInteger(rexId) || rexId <= 0) {
    return NextResponse.json({ ok: false, error: "Invalid Rex id" }, { status: 400 });
  }

  const body = await req.json();
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (name.length < 2 || name.length > 40) {
    return NextResponse.json(
      { ok: false, error: "Rex category name must be 2–40 characters" },
      { status: 400 }
    );
  }

  const dup = await dbApi.getRexGroupByName(name);
  if (dup && dup.id !== rexId) {
    return NextResponse.json(
      { ok: false, error: `Rex category "${dup.name}" already exists` },
      { status: 409 }
    );
  }

  const updated = await dbApi.renameRexGroup(rexId, name);
  if (!updated) {
    return NextResponse.json({ ok: false, error: "Rex category not found" }, { status: 404 });
  }

  await dbApi.addAuditLog({
    actorUserId: auth.user.id,
    actorUsername: auth.user.username,
    action: "rex.rename",
    targetType: "rex",
    targetId: String(rexId),
    detail: { name: updated.name },
  });

  return NextResponse.json({ ok: true, rex: updated });
}

export async function DELETE(req: NextRequest, context: { params: { id: string } }) {
  const auth = await requireSession(req, (p) => p.users.manage);
  if (!auth.ok) return auth.response;

  const rexId = Number(context.params.id);
  if (!Number.isInteger(rexId) || rexId <= 0) {
    return NextResponse.json({ ok: false, error: "Invalid Rex id" }, { status: 400 });
  }

  const result = await dbApi.deleteRexGroup(rexId);
  if (!result.deleted) {
    return NextResponse.json(
      { ok: false, error: result.reason ?? "Cannot delete Rex category" },
      { status: result.status ?? 400 }
    );
  }

  await dbApi.addAuditLog({
    actorUserId: auth.user.id,
    actorUsername: auth.user.username,
    action: "rex.delete",
    targetType: "rex",
    targetId: String(rexId),
    detail: { name: result.name },
  });

  return NextResponse.json({ ok: true, deleted: true, name: result.name });
}

import { NextRequest, NextResponse } from "next/server";
import { dbApi } from "@/lib/db";
import { requireSession } from "@/lib/authz";
import { normalizePermissions, canGrantPermissions } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, context: { params: { id: string } }) {
  const auth = await requireSession(req, (p) => p.roles.manage);
  if (!auth.ok) return auth.response;

  const roleId = Number(context.params.id);
  if (!Number.isInteger(roleId) || roleId <= 0) {
    return NextResponse.json({ ok: false, error: "Invalid role id" }, { status: 400 });
  }

  const target = await dbApi.getRoleById(roleId);
  if (!target) {
    return NextResponse.json({ ok: false, error: "Role not found" }, { status: 404 });
  }

  if (target.is_system && target.name.toLowerCase() === "admin") {
    return NextResponse.json(
      { ok: false, error: "The system Admin role always retains full permissions" },
      { status: 400 }
    );
  }

  if (!canGrantPermissions(auth.user.permissions, target.permissions)) {
    return NextResponse.json(
      { ok: false, error: "Cannot modify a role with permissions you do not hold" },
      { status: 403 }
    );
  }

  const body = await req.json();
  let nextName: string | undefined = undefined;
  if (typeof body?.name === "string" && body.name.trim() !== target.name) {
    if (target.is_system) {
      return NextResponse.json(
        { ok: false, error: "System role names cannot be changed" },
        { status: 400 }
      );
    }
    const clean = body.name.trim();
    if (clean.length < 2 || clean.length > 40) {
      return NextResponse.json({ ok: false, error: "Role name must be 2–40 characters" }, { status: 400 });
    }
    const dup = (await dbApi.listRoles()).find(
      (r) => r.id !== roleId && r.name.toLowerCase() === clean.toLowerCase()
    );
    if (dup) {
      return NextResponse.json({ ok: false, error: `Role "${dup.name}" already exists` }, { status: 409 });
    }
    nextName = clean;
  }

  const nextPermissions = body?.permissions
    ? normalizePermissions(body.permissions, target.permissions)
    : undefined;

  if (nextPermissions && !canGrantPermissions(auth.user.permissions, nextPermissions)) {
    return NextResponse.json(
      { ok: false, error: "Cannot set permissions you do not hold" },
      { status: 403 }
    );
  }

  const updated = await dbApi.updateRole(roleId, {
    name: nextName,
    permissions: nextPermissions,
  });

  await dbApi.addAuditLog({
    actorUserId: auth.user.id,
    actorUsername: auth.user.username,
    action: "roles.update",
    targetType: "role",
    targetId: String(roleId),
    detail: { name: updated?.name },
  });

  return NextResponse.json({ ok: true, role: updated });
}

export async function DELETE(req: NextRequest, context: { params: { id: string } }) {
  const auth = await requireSession(req, (p) => p.roles.manage);
  if (!auth.ok) return auth.response;

  const roleId = Number(context.params.id);
  if (!Number.isInteger(roleId) || roleId <= 0) {
    return NextResponse.json({ ok: false, error: "Invalid role id" }, { status: 400 });
  }

  const target = await dbApi.getRoleById(roleId);
  if (target && !canGrantPermissions(auth.user.permissions, target.permissions)) {
    return NextResponse.json(
      { ok: false, error: "Cannot delete a role with permissions you do not hold" },
      { status: 403 }
    );
  }

  const res = await dbApi.deleteRole(roleId);
  if (!res.deleted) {
    return NextResponse.json({ ok: false, error: res.reason ?? "Cannot delete role" }, { status: 400 });
  }

  await dbApi.addAuditLog({
    actorUserId: auth.user.id,
    actorUsername: auth.user.username,
    action: "roles.delete",
    targetType: "role",
    targetId: String(roleId),
  });

  return NextResponse.json({ ok: true });
}

import { NextRequest, NextResponse } from "next/server";
import { dbApi } from "@/lib/db";
import { requireSession } from "@/lib/authz";
import { normalizePermissions, canGrantPermissions } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireSession(req, (p) => p.roles.manage || p.users.manage);
  if (!auth.ok) return auth.response;

  const roles = await dbApi.listRoles();
  return NextResponse.json({ ok: true, roles });
}

export async function POST(req: NextRequest) {
  const auth = await requireSession(req, (p) => p.roles.manage);
  if (!auth.ok) return auth.response;

  try {
    const body = await req.json();
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (name.length < 2 || name.length > 40) {
      return NextResponse.json(
        { ok: false, error: "Role name must be 2–40 characters" },
        { status: 400 }
      );
    }

    const existing = (await dbApi.listRoles()).find(
      (r) => r.name.toLowerCase() === name.toLowerCase()
    );
    if (existing) {
      return NextResponse.json(
        { ok: false, error: `Role "${existing.name}" already exists` },
        { status: 409 }
      );
    }

    const perms = normalizePermissions(body?.permissions);
    if (!canGrantPermissions(auth.user.permissions, perms)) {
      return NextResponse.json(
        { ok: false, error: "Cannot create a role with permissions you do not hold" },
        { status: 403 }
      );
    }
    const role = await dbApi.createRole(name, perms);

    await dbApi.addAuditLog({
      actorUserId: auth.user.id,
      actorUsername: auth.user.username,
      action: "roles.create",
      targetType: "role",
      targetId: String(role.id),
      detail: { name: role.name },
    });

    return NextResponse.json({ ok: true, role }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || "Failed to create role" },
      { status: 500 }
    );
  }
}

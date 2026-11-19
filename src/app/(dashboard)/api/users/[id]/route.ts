import { NextRequest, NextResponse } from "next/server";
import { dbApi } from "@/lib/db";
import { requireSession } from "@/lib/authz";
import { hashPassword } from "@/lib/password";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, context: { params: { id: string } }) {
  const auth = await requireSession(req, (p) => p.users.manage);
  if (!auth.ok) return auth.response;

  const userId = Number(context.params.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    return NextResponse.json({ ok: false, error: "Invalid user id" }, { status: 400 });
  }

  const target = await dbApi.getUserSessionById(userId);
  if (!target) {
    return NextResponse.json({ ok: false, error: "User not found" }, { status: 404 });
  }

  const body = await req.json();

  if (target.is_env_admin) {
    return NextResponse.json(
      {
        ok: false,
        error: "Root Admin is managed via ADMIN_USERNAME and AUTH_PASSWORD in .env",
      },
      { status: 400 }
    );
  }

  const updates: {
    username?: string;
    passwordHash?: string;
    roleId?: number;
    rexId?: number | null;
    isActive?: boolean;
    bumpTokenVersion?: boolean;
  } = {};

  if (typeof body?.username === "string" && body.username.trim() !== target.username) {
    const clean = body.username.trim();
    if (!/^[a-zA-Z0-9._-]{2,40}$/.test(clean)) {
      return NextResponse.json(
        { ok: false, error: "Username must be 2–40 characters (letters, numbers, ., _, -)" },
        { status: 400 }
      );
    }
    const dup = await dbApi.getUserAuthByUsername(clean);
    if (dup && dup.id !== userId) {
      return NextResponse.json({ ok: false, error: `Username "${clean}" already exists` }, { status: 409 });
    }
    updates.username = clean;
    updates.bumpTokenVersion = true;
  }

  if (typeof body?.password === "string" && body.password.length > 0) {
    if (body.password.length < 8) {
      return NextResponse.json(
        { ok: false, error: "Password must be at least 8 characters" },
        { status: 400 }
      );
    }
    updates.passwordHash = hashPassword(body.password);
    updates.bumpTokenVersion = true;
  }

  let effectiveRole = await dbApi.getRoleById(target.role_id);
  if (body?.roleId !== undefined) {
    const nextRoleId = Number(body.roleId);
    const role = await dbApi.getRoleById(nextRoleId);
    if (!role) return NextResponse.json({ ok: false, error: "Role not found" }, { status: 404 });
    updates.roleId = role.id;
    effectiveRole = role;
  }

  if (body?.rexMode === "new" && typeof body?.rexName === "string") {
    const rexName = body.rexName.trim();
    if (rexName.length < 2 || rexName.length > 40) {
      return NextResponse.json({ ok: false, error: "Rex name must be 2–40 characters" }, { status: 400 });
    }
    const dupRex = await dbApi.getRexGroupByName(rexName);
    if (dupRex) {
      return NextResponse.json(
        { ok: false, error: `Rex category "${dupRex.name}" already exists` },
        { status: 409 }
      );
    }
    const createdRex = await dbApi.createRexGroup(rexName);
    updates.rexId = createdRex.id;
  } else if (body?.rexMode === "none") {
    if (!effectiveRole?.permissions.rex.viewAll) {
      return NextResponse.json(
        { ok: false, error: "Scoped roles require a Rex category" },
        { status: 400 }
      );
    }
    updates.rexId = null;
  } else if (body?.rexId !== undefined) {
    if (body.rexId === null || body.rexId === "") {
      if (!effectiveRole?.permissions.rex.viewAll) {
        return NextResponse.json(
          { ok: false, error: "Scoped roles require a Rex category" },
          { status: 400 }
        );
      }
      updates.rexId = null;
    } else {
      const nextRexId = Number(body.rexId);
      const rex = await dbApi.getRexGroupById(nextRexId);
      if (!rex) return NextResponse.json({ ok: false, error: "Rex category not found" }, { status: 404 });
      updates.rexId = rex.id;
    }
  }

  if (typeof body?.isActive === "boolean") {
    if (userId === auth.user.id && !body.isActive) {
      return NextResponse.json({ ok: false, error: "You cannot disable your own account" }, { status: 400 });
    }
    updates.isActive = body.isActive;
  }

  const updated = await dbApi.updateUser(userId, updates);
  await dbApi.addAuditLog({
    actorUserId: auth.user.id,
    actorUsername: auth.user.username,
    action: "users.update",
    targetType: "user",
    targetId: String(userId),
    detail: {
      username: updated?.username,
      roleId: updated?.role_id,
      rexId: updated?.rex_id,
      isActive: updated?.is_active,
      passwordReset: Boolean(updates.passwordHash),
    },
  });

  return NextResponse.json({ ok: true, user: updated });
}

export async function DELETE(req: NextRequest, context: { params: { id: string } }) {
  const auth = await requireSession(req, (p) => p.users.manage);
  if (!auth.ok) return auth.response;

  const userId = Number(context.params.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    return NextResponse.json({ ok: false, error: "Invalid user id" }, { status: 400 });
  }
  if (userId === auth.user.id) {
    return NextResponse.json({ ok: false, error: "You cannot delete your own account" }, { status: 400 });
  }

  const target = await dbApi.getUserSessionById(userId);
  if (!target) {
    return NextResponse.json({ ok: false, error: "User not found" }, { status: 404 });
  }
  if (target.is_env_admin) {
    return NextResponse.json({ ok: false, error: "Root Admin cannot be deleted" }, { status: 400 });
  }

  const deleted = await dbApi.deleteUser(userId);
  if (deleted) {
    await dbApi.addAuditLog({
      actorUserId: auth.user.id,
      actorUsername: auth.user.username,
      action: "users.delete",
      targetType: "user",
      targetId: String(userId),
      detail: { username: target.username },
    });
  }
  return NextResponse.json({ ok: true, deleted });
}

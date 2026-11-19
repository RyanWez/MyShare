import { NextRequest, NextResponse } from "next/server";
import { dbApi } from "@/lib/db";
import { requireSession } from "@/lib/authz";
import { hashPassword } from "@/lib/password";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireSession(req, (p) => p.users.manage);
  if (!auth.ok) return auth.response;

  const [users, roles, rexGroups] = await Promise.all([
    dbApi.listUsers(),
    dbApi.listRoles(),
    dbApi.listRexGroups(),
  ]);

  return NextResponse.json({ ok: true, users, roles, rexGroups });
}

export async function POST(req: NextRequest) {
  const auth = await requireSession(req, (p) => p.users.manage);
  if (!auth.ok) return auth.response;

  try {
    const body = await req.json();
    const username = typeof body?.username === "string" ? body.username.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const roleId = Number(body?.roleId);
    const rexMode = body?.rexMode === "existing" ? "existing" : body?.rexMode === "none" ? "none" : "new";
    const rexName = typeof body?.rexName === "string" ? body.rexName.trim() : "";
    const existingRexId = Number(body?.rexId);

    if (!/^[a-zA-Z0-9._-]{2,40}$/.test(username)) {
      return NextResponse.json(
        {
          ok: false,
          error: "Username must be 2–40 characters (letters, numbers, ., _, - only)",
        },
        { status: 400 }
      );
    }

    if (password.length < 8) {
      return NextResponse.json(
        { ok: false, error: "Password must be at least 8 characters" },
        { status: 400 }
      );
    }

    if (!Number.isInteger(roleId) || roleId <= 0) {
      return NextResponse.json({ ok: false, error: "Please select a valid role" }, { status: 400 });
    }

    const role = await dbApi.getRoleById(roleId);
    if (!role) {
      return NextResponse.json({ ok: false, error: "Role not found" }, { status: 404 });
    }

    const existingUser = await dbApi.getUserAuthByUsername(username);
    if (existingUser) {
      return NextResponse.json(
        { ok: false, error: `Username "${username}" is already taken` },
        { status: 409 }
      );
    }

    let resolvedRexId: number | null = null;
    if (rexMode === "none") {
      if (!role.permissions.rex.viewAll) {
        return NextResponse.json(
          { ok: false, error: "Scoped roles require a Rex category" },
          { status: 400 }
        );
      }
      resolvedRexId = null;
    } else if (rexMode === "existing") {
      if (!Number.isInteger(existingRexId) || existingRexId <= 0) {
        return NextResponse.json(
          { ok: false, error: "Please choose an existing Rex category" },
          { status: 400 }
        );
      }
      const rex = await dbApi.getRexGroupById(existingRexId);
      if (!rex) {
        return NextResponse.json({ ok: false, error: "Rex category not found" }, { status: 404 });
      }
      resolvedRexId = rex.id;
    } else {
      if (rexName.length < 2 || rexName.length > 40) {
        return NextResponse.json(
          { ok: false, error: "Rex category name must be 2–40 characters" },
          { status: 400 }
        );
      }
      const dupRex = await dbApi.getRexGroupByName(rexName);
      if (dupRex) {
        return NextResponse.json(
          { ok: false, error: `Rex category "${dupRex.name}" already exists — names must be unique` },
          { status: 409 }
        );
      }
      const createdRex = await dbApi.createRexGroup(rexName);
      resolvedRexId = createdRex.id;
    }

    const created = await dbApi.createUser({
      username,
      passwordHash: hashPassword(password),
      roleId: role.id,
      rexId: resolvedRexId,
    });

    await dbApi.addAuditLog({
      actorUserId: auth.user.id,
      actorUsername: auth.user.username,
      action: "users.create",
      targetType: "user",
      targetId: String(created.id),
      detail: { username: created.username, roleName: role.name, rexId: resolvedRexId },
    });

    return NextResponse.json({ ok: true, user: created }, { status: 201 });
  } catch (err: any) {
    console.error("[api/users POST] Error:", err);
    return NextResponse.json(
      { ok: false, error: err?.message || "Failed to create user" },
      { status: 500 }
    );
  }
}

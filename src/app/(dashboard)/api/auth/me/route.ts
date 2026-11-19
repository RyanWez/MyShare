import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/authz";
import { dbApi } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;

  const { user } = auth;
  const rexGroups = user.permissions.rex.viewAll ? await dbApi.listRexGroups() : [];

  return NextResponse.json({
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      roleId: user.role_id,
      roleName: user.role_name,
      rexId: user.rex_id,
      rexName: user.rex_name,
      isEnvAdmin: user.is_env_admin,
      permissions: user.permissions,
    },
    rexGroups,
  });
}

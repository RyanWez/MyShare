/**
 * Node-only session hydration, RBAC enforcement, and Rex scoping helpers.
 * Never import in Edge middleware or client components.
 */
import { NextRequest, NextResponse } from "next/server";
import { parseSessionCookie, SESSION_COOKIE } from "./auth";
import { dbApi, type SimRow, type UserAuthRow } from "./db";
import type { RolePermissions } from "./permissions";

export type SessionCheckResult =
  | { ok: true; user: UserAuthRow }
  | { ok: false; response: NextResponse };

/**
 * Validate the session cookie against live PostgreSQL user + role state,
 * ensuring deactivated users, changed passwords, or updated role permissions
 * take effect immediately without waiting for cookie expiry.
 */
export async function requireSession(
  req: NextRequest,
  checkPermission?: (p: RolePermissions) => boolean
): Promise<SessionCheckResult> {
  const raw = req.cookies.get(SESSION_COOKIE)?.value;
  const parsed = await parseSessionCookie(raw);
  if (!parsed) {
    return {
      ok: false,
      response: NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }),
    };
  }

  const user = await dbApi.getUserSessionById(parsed.userId);
  if (!user || !user.is_active || user.token_version !== parsed.tokenVersion) {
    return {
      ok: false,
      response: NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }),
    };
  }

  if (checkPermission && !checkPermission(user.permissions)) {
    return {
      ok: false,
      response: NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 }),
    };
  }

  return { ok: true, user };
}

/**
 * Resolve the effective `rex_id` filter for a request:
 * - Users with `rex.viewAll` may view all Rex (`null`) or filter to a requested `rexId`.
 * - Scoped users are pinned strictly to their assigned `rex_id`.
 *   (Returns `-1` if a non-viewAll user has no Rex assigned, matching zero rows safely.)
 */
export function resolveScopedRexId(
  user: UserAuthRow,
  requestedRexParam?: string | null
): number | null {
  if (user.permissions.rex.viewAll) {
    if (!requestedRexParam || requestedRexParam === "all") return null;
    const n = Number(requestedRexParam);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  return user.rex_id ?? -1;
}

export function canAccessSim(user: UserAuthRow, sim: Pick<SimRow, "rex_id">): boolean {
  if (user.permissions.rex.viewAll) return true;
  return user.rex_id !== null && sim.rex_id === user.rex_id;
}

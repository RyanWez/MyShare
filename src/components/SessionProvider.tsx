"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_STAFF_PERMISSIONS, type RolePermissions } from "@/lib/permissions";
import type { RexGroup, SessionUser } from "@/lib/types";
import { invalidateCache } from "@/lib/api";

interface SessionContextValue {
  user: SessionUser | null;
  rexGroups: RexGroup[];
  loading: boolean;
  rexFilter: string;
  setRexFilter: (rexId: string) => void;
  refreshSession: () => Promise<void>;
  permissions: RolePermissions;
}

const SessionContext = React.createContext<SessionContextValue>({
  user: null,
  rexGroups: [],
  loading: true,
  rexFilter: "all",
  setRexFilter: () => {},
  refreshSession: async () => {},
  permissions: DEFAULT_STAFF_PERMISSIONS,
});

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = React.useState<SessionUser | null>(null);
  const [rexGroups, setRexGroups] = React.useState<RexGroup[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [rexFilter, setRexFilter] = React.useState<string>("all");

  const refreshSession = React.useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      if (res.status === 401) {
        invalidateCache();
        setUser(null);
        router.replace("/login");
        return;
      }
      const data = await res.json();
      if (data?.ok && data.user) {
        const nextRexGroups: RexGroup[] = Array.isArray(data.rexGroups) ? data.rexGroups : [];
        setUser(data.user as SessionUser);
        setRexGroups(nextRexGroups);
        setRexFilter((prev) =>
          prev !== "all" && !nextRexGroups.some((g) => String(g.id) === prev) ? "all" : prev
        );
      }
    } catch {
      // ignore transient network failure; pages show their own error banner
    } finally {
      setLoading(false);
    }
  }, [router]);

  React.useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const value = React.useMemo<SessionContextValue>(
    () => ({
      user,
      rexGroups,
      loading,
      rexFilter: user?.permissions.rex.viewAll ? rexFilter : "all",
      setRexFilter,
      refreshSession,
      permissions: user?.permissions ?? DEFAULT_STAFF_PERMISSIONS,
    }),
    [user, rexGroups, loading, rexFilter, refreshSession]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  return React.useContext(SessionContext);
}

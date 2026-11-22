"use client";

import * as React from "react";
import { Check, Lock, Plus, Save, ShieldAlert, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { useSession } from "@/components/SessionProvider";
import { DEFAULT_STAFF_PERMISSIONS, type RolePermissions } from "@/lib/permissions";
import type { RoleItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fmtAmount } from "@/lib/format";

function PermSwitch({
  label,
  hint,
  checked,
  disabled,
  danger,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  danger?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
        checked
          ? danger
            ? "border-alert/40 bg-alert-wash/40"
            : "border-brass/40 bg-brass-wash/30"
          : "border-hairline bg-card hover:border-hairline-strong",
        disabled && "cursor-not-allowed opacity-60"
      )}
    >
      <div className="min-w-0">
        <div className="text-xs font-medium text-ink">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] text-ink-mute">{hint}</div>}
      </div>
      <span
        aria-hidden="true"
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors",
          checked
            ? danger
              ? "border-alert bg-alert"
              : "border-brass bg-brass"
            : "border-hairline-strong bg-substrate"
        )}
      >
        <span
          className={cn(
            "inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform",
            checked ? "translate-x-4" : "translate-x-0.5"
          )}
        />
      </span>
    </button>
  );
}

export default function RolesPage() {
  const { loading: sessionLoading, permissions, refreshSession } = useSession();

  const [roles, setRoles] = React.useState<RoleItem[]>([]);
  const [selectedId, setSelectedId] = React.useState<number | null>(null);
  const [draftName, setDraftName] = React.useState("");
  const [draftPerms, setDraftPerms] = React.useState<RolePermissions>(DEFAULT_STAFF_PERMISSIONS);
  const [loaded, setLoaded] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const [newRoleOpen, setNewRoleOpen] = React.useState(false);
  const [newRoleName, setNewRoleName] = React.useState("");
  const [deleteConfirm, setDeleteConfirm] = React.useState<RoleItem | null>(null);

  const loadRoles = React.useCallback(async () => {
    if (sessionLoading || !permissions.roles.manage) return;
    try {
      const res = await fetch("/api/roles", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const list: RoleItem[] = data.roles ?? [];
      setRoles(list);
      setError(null);
      setSelectedId((prev) => (prev && list.some((r) => r.id === prev) ? prev : (list[0]?.id ?? null)));
    } catch (err: any) {
      setError(err?.message || "Failed to load roles");
    } finally {
      setLoaded(true);
    }
  }, [sessionLoading, permissions.roles.manage]);

  React.useEffect(() => {
    void loadRoles();
  }, [loadRoles]);

  const selectedRole = React.useMemo(
    () => roles.find((r) => r.id === selectedId) ?? null,
    [roles, selectedId]
  );

  React.useEffect(() => {
    if (!selectedRole) return;
    setDraftName(selectedRole.name);
    setDraftPerms(structuredClone(selectedRole.permissions));
  }, [selectedRole]);

  const isLockedAdmin = Boolean(selectedRole?.is_system && selectedRole.name.toLowerCase() === "admin");

  async function handleSave() {
    if (!selectedRole || isLockedAdmin || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/roles/${selectedRole.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(selectedRole.is_system ? {} : { name: draftName.trim() }),
          permissions: draftPerms,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Failed to save role");
      toast.success(`Saved permissions for "${data.role.name}"`);
      await loadRoles();
      await refreshSession();
    } catch (err: any) {
      toast.error(err?.message || "Couldn't save role");
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateRole(e: React.FormEvent) {
    e.preventDefault();
    if (saving || newRoleName.trim().length < 2) return;
    setSaving(true);
    try {
      const res = await fetch("/api/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newRoleName.trim(),
          permissions: DEFAULT_STAFF_PERMISSIONS,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Failed to create role");
      toast.success(`Role "${data.role.name}" created`);
      setNewRoleOpen(false);
      setNewRoleName("");
      await loadRoles();
      setSelectedId(data.role.id);
    } catch (err: any) {
      toast.error(err?.message || "Couldn't create role");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteRole() {
    if (!deleteConfirm || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/roles/${deleteConfirm.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Failed to delete role");
      toast.success(`Deleted role "${deleteConfirm.name}"`);
      setDeleteConfirm(null);
      setSelectedId(null);
      await loadRoles();
    } catch (err: any) {
      toast.error(err?.message || "Couldn't delete role");
    } finally {
      setSaving(false);
    }
  }

  if (!sessionLoading && !permissions.roles.manage) {
    return (
      <div className="max-w-5xl mx-auto pt-6">
        <EmptyState title="Access restricted" body="Only Administrators can manage role permissions." />
      </div>
    );
  }

  if (!loaded || sessionLoading) {
    return (
      <div className="max-w-6xl mx-auto grid gap-6 md:grid-cols-[260px_1fr] animate-pulse">
        <div className="h-64 rounded-lg border border-hairline bg-card" />
        <div className="h-96 rounded-lg border border-hairline bg-card" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-5xl mx-auto pt-6">
        <ErrorState what="roles" detail={error} onRetry={loadRoles} />
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto grid gap-6 md:grid-cols-[260px_1fr]">
      {/* Roles Sidebar */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="font-mono text-eyebrow font-semibold uppercase text-ink-mute">
            Roles ({roles.length})
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setNewRoleName("");
              setNewRoleOpen(true);
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            New Role
          </Button>
        </div>

        <div className="overflow-hidden rounded-lg border border-hairline bg-card shadow-panel divide-y divide-hairline">
          {roles.map((r) => {
            const active = r.id === selectedId;
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => setSelectedId(r.id)}
                className={cn(
                  "flex w-full items-center justify-between gap-2 px-3.5 py-3 text-left transition-colors",
                  active ? "bg-brass-wash/50" : "hover:bg-substrate/60"
                )}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-xs font-semibold text-ink">
                      {r.name}
                    </span>
                    {r.is_system && (
                      <span className="rounded border border-hairline bg-substrate px-1 py-0.5 font-mono text-[9px] uppercase text-ink-mute">
                        System
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 font-mono text-[10.5px] tnum text-ink-mute">
                    {fmtAmount(r.user_count ?? 0)} {r.user_count === 1 ? "user" : "users"}
                  </div>
                </div>
                {active && <Check className="h-3.5 w-3.5 shrink-0 text-brass" />}
              </button>
            );
          })}
        </div>
      </div>

      {/* Permission Editor */}
      {selectedRole && (
        <div className="space-y-5 rounded-lg border border-hairline bg-card p-5 shadow-panel">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline pb-4">
            <div className="min-w-0 flex-1">
              {selectedRole.is_system ? (
                <div className="flex items-center gap-2">
                  <h2 className="font-mono text-base font-semibold text-ink">{selectedRole.name}</h2>
                  {isLockedAdmin && (
                    <span className="inline-flex items-center gap-1 rounded border border-brass/40 bg-brass-wash px-2 py-0.5 font-mono text-[10px] uppercase text-brass-deep">
                      <Lock className="h-3 w-3" />
                      Full Access Locked
                    </span>
                  )}
                </div>
              ) : (
                <Input
                  label="Role Name"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  className="max-w-xs font-mono"
                />
              )}
            </div>

            <div className="flex items-center gap-2">
              {!selectedRole.is_system && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeleteConfirm(selectedRole)}
                  className="text-alert-deep hover:bg-alert-wash/40"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </Button>
              )}
              {!isLockedAdmin && (
                <Button size="sm" onClick={handleSave} loading={saving}>
                  <Save className="h-3.5 w-3.5" />
                  Save Permissions
                </Button>
              )}
            </div>
          </div>

          {/* 1. Overview */}
          <section className="space-y-3">
            <div className="font-mono text-eyebrow font-semibold uppercase text-ink-mute">
              1. Overview Dashboard
            </div>
            <PermSwitch
              label="Allow viewing Overview page"
              hint="If turned off, operators automatically land on their next permitted tab."
              checked={draftPerms.overview.view}
              disabled={isLockedAdmin}
              onChange={(v) =>
                setDraftPerms((p) => ({
                  ...p,
                  overview: {
                    ...p.overview,
                    view: v,
                    ...(v
                      ? {}
                      : {
                          totalBalance: false,
                          successMetric: false,
                          volumeMetric: false,
                          debitedMetric: false,
                          netVolumeMetric: false,
                          transfersChart: false,
                          volumeChart: false,
                          topErrorsChart: false,
                          recentList: false,
                        }),
                  },
                }))
              }
            />
            {draftPerms.overview.view && (
              <div className="grid gap-2 pl-3 border-l-2 border-hairline sm:grid-cols-2">
                <PermSwitch
                  label="Total Available Balance"
                  checked={draftPerms.overview.totalBalance}
                  disabled={isLockedAdmin}
                  onChange={(v) => setDraftPerms((p) => ({ ...p, overview: { ...p.overview, totalBalance: v } }))}
                />
                <PermSwitch
                  label="Success Count & Rate"
                  checked={draftPerms.overview.successMetric}
                  disabled={isLockedAdmin}
                  onChange={(v) => setDraftPerms((p) => ({ ...p, overview: { ...p.overview, successMetric: v } }))}
                />
                <PermSwitch
                  label="Volume Moved Metric"
                  checked={draftPerms.overview.volumeMetric}
                  disabled={isLockedAdmin}
                  onChange={(v) => setDraftPerms((p) => ({ ...p, overview: { ...p.overview, volumeMetric: v } }))}
                />
                <PermSwitch
                  label="Total Debited (incl. 5% Fee)"
                  checked={draftPerms.overview.debitedMetric}
                  disabled={isLockedAdmin}
                  onChange={(v) => setDraftPerms((p) => ({ ...p, overview: { ...p.overview, debitedMetric: v } }))}
                />
                <PermSwitch
                  label="Volume (-20%) Metric"
                  checked={draftPerms.overview.netVolumeMetric}
                  disabled={isLockedAdmin}
                  onChange={(v) => setDraftPerms((p) => ({ ...p, overview: { ...p.overview, netVolumeMetric: v } }))}
                />
                <PermSwitch
                  label="Transfers Chart"
                  checked={draftPerms.overview.transfersChart}
                  disabled={isLockedAdmin}
                  onChange={(v) => setDraftPerms((p) => ({ ...p, overview: { ...p.overview, transfersChart: v } }))}
                />
                <PermSwitch
                  label="Volume Moved Chart"
                  checked={draftPerms.overview.volumeChart}
                  disabled={isLockedAdmin}
                  onChange={(v) => setDraftPerms((p) => ({ ...p, overview: { ...p.overview, volumeChart: v } }))}
                />
                <PermSwitch
                  label="Top Error Reasons"
                  checked={draftPerms.overview.topErrorsChart}
                  disabled={isLockedAdmin}
                  onChange={(v) => setDraftPerms((p) => ({ ...p, overview: { ...p.overview, topErrorsChart: v } }))}
                />
                <PermSwitch
                  label="Recent Transfers List"
                  checked={draftPerms.overview.recentList}
                  disabled={isLockedAdmin}
                  onChange={(v) => setDraftPerms((p) => ({ ...p, overview: { ...p.overview, recentList: v } }))}
                />
              </div>
            )}
          </section>

          {/* 2. Transfer */}
          <section className="space-y-2.5 border-t border-hairline pt-4">
            <div className="font-mono text-eyebrow font-semibold uppercase text-ink-mute">
              2. Transfer
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <PermSwitch
                label="View Transfer tab"
                checked={draftPerms.transfer.view}
                disabled={isLockedAdmin}
                onChange={(v) =>
                  setDraftPerms((p) => ({
                    ...p,
                    transfer: { view: v, execute: v ? p.transfer.execute : false },
                  }))
                }
              />
              <PermSwitch
                label="Execute transfers (Send OTP & Confirm)"
                checked={draftPerms.transfer.execute}
                disabled={isLockedAdmin || !draftPerms.transfer.view}
                onChange={(v) =>
                  setDraftPerms((p) => ({ ...p, transfer: { ...p.transfer, execute: v } }))
                }
              />
            </div>
          </section>

          {/* 3. SIM Tray */}
          <section className="space-y-2.5 border-t border-hairline pt-4">
            <div className="font-mono text-eyebrow font-semibold uppercase text-ink-mute">
              3. SIM Tray
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <PermSwitch
                label="View SIM Tray"
                checked={draftPerms.sims.view}
                disabled={isLockedAdmin}
                onChange={(v) =>
                  setDraftPerms((p) => ({
                    ...p,
                    sims: {
                      view: v,
                      addLogin: v ? p.sims.addLogin : false,
                      refresh: v ? p.sims.refresh : false,
                      refreshUnlimited: v ? p.sims.refreshUnlimited : false,
                      delete: v ? p.sims.delete : false,
                      moveRex: v ? p.sims.moveRex : false,
                    },
                  }))
                }
              />
              <PermSwitch
                label="Log in / Add SIM"
                checked={draftPerms.sims.addLogin}
                disabled={isLockedAdmin || !draftPerms.sims.view}
                onChange={(v) => setDraftPerms((p) => ({ ...p, sims: { ...p.sims, addLogin: v } }))}
              />
              <PermSwitch
                label="Refresh Balance & Expiry"
                checked={draftPerms.sims.refresh}
                disabled={isLockedAdmin || !draftPerms.sims.view}
                onChange={(v) =>
                  setDraftPerms((p) => ({
                    ...p,
                    sims: {
                      ...p.sims,
                      refresh: v,
                      refreshUnlimited: v ? p.sims.refreshUnlimited : false,
                    },
                  }))
                }
              />
              <PermSwitch
                label="Bypass Refresh Rate Limit"
                hint="Skip the 5-minute SIM cooldown and per-minute burst cap."
                checked={draftPerms.sims.refreshUnlimited}
                disabled={isLockedAdmin || !draftPerms.sims.view || !draftPerms.sims.refresh}
                onChange={(v) =>
                  setDraftPerms((p) => ({ ...p, sims: { ...p.sims, refreshUnlimited: v } }))
                }
              />
              <PermSwitch
                label="Delete SIMs"
                hint="Keep off for Staff so only Admin removes SIMs."
                danger
                checked={draftPerms.sims.delete}
                disabled={isLockedAdmin || !draftPerms.sims.view}
                onChange={(v) => setDraftPerms((p) => ({ ...p, sims: { ...p.sims, delete: v } }))}
              />
              <PermSwitch
                label="Move SIMs between Rex"
                hint="Requires View All Rex access."
                checked={draftPerms.sims.moveRex}
                disabled={isLockedAdmin || !draftPerms.sims.view || !draftPerms.rex.viewAll}
                onChange={(v) => setDraftPerms((p) => ({ ...p, sims: { ...p.sims, moveRex: v } }))}
              />
            </div>
          </section>

          {/* 4. Receivers & 5. History */}
          <section className="space-y-2.5 border-t border-hairline pt-4">
            <div className="font-mono text-eyebrow font-semibold uppercase text-ink-mute">
              4. Receivers & History
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <PermSwitch
                label="View Receivers"
                checked={draftPerms.receivers.view}
                disabled={isLockedAdmin}
                onChange={(v) => setDraftPerms((p) => ({ ...p, receivers: { view: v } }))}
              />
              <PermSwitch
                label="View History"
                checked={draftPerms.history.view}
                disabled={isLockedAdmin}
                onChange={(v) =>
                  setDraftPerms((p) => ({
                    ...p,
                    history: {
                      view: v,
                      export: v ? p.history.export : false,
                      delete: v ? p.history.delete : false,
                    },
                  }))
                }
              />
              <PermSwitch
                label="Export History CSV"
                checked={draftPerms.history.export}
                disabled={isLockedAdmin || !draftPerms.history.view}
                onChange={(v) =>
                  setDraftPerms((p) => ({ ...p, history: { ...p.history, export: v } }))
                }
              />
              <PermSwitch
                label="Delete History Logs"
                hint="Keep off for Staff to prevent deleting transfer logs."
                danger
                checked={draftPerms.history.delete}
                disabled={isLockedAdmin || !draftPerms.history.view}
                onChange={(v) =>
                  setDraftPerms((p) => ({ ...p, history: { ...p.history, delete: v } }))
                }
              />
            </div>
          </section>

          {/* 6. Admin & Cross-Rex */}
          <section className="space-y-2.5 border-t border-hairline pt-4">
            <div className="flex items-center gap-2 font-mono text-eyebrow font-semibold uppercase text-ink-mute">
              <ShieldAlert className="h-3.5 w-3.5 text-brass" />
              <span>5. Supervision & Administration</span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <PermSwitch
                label="View All Rex Categories"
                hint="Can view & filter across all Rex groups."
                checked={draftPerms.rex.viewAll}
                disabled={isLockedAdmin}
                onChange={(v) =>
                  setDraftPerms((p) => ({
                    ...p,
                    rex: { viewAll: v },
                    sims: { ...p.sims, moveRex: v ? p.sims.moveRex : false },
                  }))
                }
              />
              <PermSwitch
                label="Manage Users & Rex"
                checked={draftPerms.users.manage}
                disabled={isLockedAdmin}
                onChange={(v) => setDraftPerms((p) => ({ ...p, users: { manage: v } }))}
              />
              <PermSwitch
                label="Manage Role Permissions"
                checked={draftPerms.roles.manage}
                disabled={isLockedAdmin}
                onChange={(v) => setDraftPerms((p) => ({ ...p, roles: { manage: v } }))}
              />
            </div>
          </section>
        </div>
      )}

      {/* Create Role Modal */}
      <Dialog open={newRoleOpen} onOpenChange={setNewRoleOpen}>
        <DialogContent className="max-w-sm">
          <form onSubmit={handleCreateRole} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Create Custom Role</DialogTitle>
              <DialogDescription>
                Starts with Staff defaults — customize permissions right after creating.
              </DialogDescription>
            </DialogHeader>
            <Input
              label="Role Name"
              value={newRoleName}
              onChange={(e) => setNewRoleName(e.target.value)}
              placeholder="e.g. Supervisor or Viewer"
              className="font-mono"
            />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setNewRoleOpen(false)} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" loading={saving} disabled={newRoleName.trim().length < 2}>
                Create Role
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Role Confirmation */}
      <Dialog open={!!deleteConfirm} onOpenChange={(o) => !o && setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete role &quot;{deleteConfirm?.name}&quot;?</DialogTitle>
            <DialogDescription>
              Only custom roles with zero assigned users can be deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteConfirm(null)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="destructive" loading={saving} onClick={handleDeleteRole}>
              Delete Role
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

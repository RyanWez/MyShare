"use client";

import * as React from "react";
import {
  Check,
  Copy,
  Edit3,
  Eye,
  EyeOff,
  FolderPlus,
  KeyRound,
  Layers,
  Plus,
  RefreshCw,
  Search,
  Shield,
  Trash2,
  UserCheck,
  UserPlus,
  UserX,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { StatusDot } from "@/components/ui/StatusDot";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { useSession } from "@/components/SessionProvider";
import type { RexGroup, RoleItem, UserItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import { fmtAmount } from "@/lib/format";

function generateBrowserPassword(length = 24): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%^&*-_";
  const all = upper + lower + digits + symbols;
  const pick = (pool: string) => {
    const arr = new Uint32Array(1);
    window.crypto.getRandomValues(arr);
    return pool[arr[0] % pool.length];
  };
  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const arr = new Uint32Array(1);
    window.crypto.getRandomValues(arr);
    const j = arr[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  } catch {
    toast.error("Couldn't copy to clipboard");
  }
}

export default function UsersPage() {
  const { user: currentUser, loading: sessionLoading, permissions, refreshSession } = useSession();

  const [users, setUsers] = React.useState<UserItem[]>([]);
  const [roles, setRoles] = React.useState<RoleItem[]>([]);
  const [rexGroups, setRexGroups] = React.useState<RexGroup[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [search, setSearch] = React.useState("");
  const [rexFilter, setRexFilter] = React.useState("all");

  // Create User Dialog
  const [createOpen, setCreateOpen] = React.useState(false);
  const [newUsername, setNewUsername] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [showNewPw, setShowNewPw] = React.useState(true);
  const [newRoleId, setNewRoleId] = React.useState("");
  const [rexMode, setRexMode] = React.useState<"new" | "existing">("new");
  const [newRexName, setNewRexName] = React.useState("");
  const [existingRexId, setExistingRexId] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  // Edit User Dialog
  const [editUser, setEditUser] = React.useState<UserItem | null>(null);
  const [editUsername, setEditUsername] = React.useState("");
  const [editRoleId, setEditRoleId] = React.useState("");
  const [editRexMode, setEditRexMode] = React.useState<"existing" | "new" | "none">("existing");
  const [editRexId, setEditRexId] = React.useState("");
  const [editRexName, setEditRexName] = React.useState("");

  // Reset Password Dialog
  const [pwUser, setPwUser] = React.useState<UserItem | null>(null);
  const [resetPassword, setResetPassword] = React.useState("");
  const [showResetPw, setShowResetPw] = React.useState(true);

  // Post-save credentials summary (shown ONLY after server confirms creation/reset)
  const [savedCreds, setSavedCreds] = React.useState<{
    username: string;
    password: string;
    roleName: string;
    rexName: string;
    action: "created" | "reset";
  } | null>(null);

  // Delete User Dialog
  const [deleteUser, setDeleteUser] = React.useState<UserItem | null>(null);

  // Rex Group Modal (Create / Rename)
  const [rexDialogOpen, setRexDialogOpen] = React.useState(false);
  const [editingRex, setEditingRex] = React.useState<RexGroup | null>(null);
  const [rexInputName, setRexInputName] = React.useState("");

  const loadData = React.useCallback(async () => {
    if (sessionLoading || !permissions.users.manage) return;
    try {
      const res = await fetch("/api/users", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setUsers(data.users ?? []);
      setRoles(data.roles ?? []);
      setRexGroups(data.rexGroups ?? []);
      setError(null);
    } catch (err: any) {
      setError(err?.message || "Failed to load users");
    } finally {
      setLoaded(true);
    }
  }, [sessionLoading, permissions.users.manage]);

  React.useEffect(() => {
    void loadData();
  }, [loadData]);

  const selectedCreateRole = React.useMemo(
    () => roles.find((r) => String(r.id) === newRoleId),
    [roles, newRoleId]
  );
  const selectedEditRole = React.useMemo(
    () => roles.find((r) => String(r.id) === editRoleId),
    [roles, editRoleId]
  );

  const duplicateRexName = React.useMemo(() => {
    const clean = newRexName.trim().toLowerCase();
    if (!clean) return null;
    return rexGroups.find((g) => g.name.toLowerCase() === clean) ?? null;
  }, [newRexName, rexGroups]);

  function openCreateDialog() {
    const staffRole = roles.find((r) => r.name.toLowerCase() === "staff") ?? roles[0];
    setNewUsername("");
    setNewPassword(generateBrowserPassword(24));
    setShowNewPw(true);
    setNewRoleId(staffRole ? String(staffRole.id) : "");
    setRexMode("new");
    setNewRexName("");
    setExistingRexId(rexGroups[0] ? String(rexGroups[0].id) : "");
    setCreateOpen(true);
  }

  function openEditDialog(u: UserItem) {
    setEditUser(u);
    setEditUsername(u.username);
    setEditRoleId(String(u.role_id));
    if (u.rex_id) {
      setEditRexMode("existing");
      setEditRexId(String(u.rex_id));
    } else {
      setEditRexMode("none");
      setEditRexId(rexGroups[0] ? String(rexGroups[0].id) : "");
    }
    setEditRexName("");
  }

  async function handleCreateUser(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      const isGlobalRole = Boolean(selectedCreateRole?.permissions.rex.viewAll);
      const payload: Record<string, unknown> = {
        username: newUsername.trim(),
        password: newPassword,
        roleId: Number(newRoleId),
      };

      if (isGlobalRole && rexMode === "new" && !newRexName.trim()) {
        payload.rexMode = "none";
      } else if (rexMode === "existing") {
        payload.rexMode = "existing";
        payload.rexId = Number(existingRexId);
      } else {
        payload.rexMode = "new";
        payload.rexName = newRexName.trim();
      }

      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Failed to create user");
      toast.success(`User "${data.user.username}" created`);
      setCreateOpen(false);
      setSavedCreds({
        username: data.user.username,
        password: newPassword,
        roleName: data.user.role_name ?? selectedCreateRole?.name ?? "Staff",
        rexName: data.user.rex_name ?? "All Rex",
        action: "created",
      });
      await loadData();
      await refreshSession();
    } catch (err: any) {
      toast.error(err?.message || "Couldn't create user");
    } finally {
      setSaving(false);
    }
  }

  async function handleEditUser(e: React.FormEvent) {
    e.preventDefault();
    if (!editUser || saving) return;
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        username: editUsername.trim(),
        roleId: Number(editRoleId),
      };
      if (editRexMode === "none") {
        payload.rexMode = "none";
      } else if (editRexMode === "new") {
        payload.rexMode = "new";
        payload.rexName = editRexName.trim();
      } else {
        payload.rexId = editRexId ? Number(editRexId) : null;
      }

      const res = await fetch(`/api/users/${editUser.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Failed to update user");
      toast.success(`Updated "${data.user.username}"`);
      setEditUser(null);
      await loadData();
      await refreshSession();
    } catch (err: any) {
      toast.error(err?.message || "Couldn't update user");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive(u: UserItem) {
    try {
      const res = await fetch(`/api/users/${u.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !u.is_active }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Failed");
      toast.success(`${u.username} ${!u.is_active ? "enabled" : "disabled"}`);
      await loadData();
    } catch (err: any) {
      toast.error(err?.message || "Couldn't update user status");
    }
  }

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!pwUser || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/users/${pwUser.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: resetPassword }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Failed");
      toast.success(`Password updated for "${pwUser.username}"`);
      setSavedCreds({
        username: pwUser.username,
        password: resetPassword,
        roleName: pwUser.role_name,
        rexName: pwUser.rex_name ?? "All Rex",
        action: "reset",
      });
      setPwUser(null);
      setResetPassword("");
    } catch (err: any) {
      toast.error(err?.message || "Couldn't reset password");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteUser() {
    if (!deleteUser || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/users/${deleteUser.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Failed");
      toast.success(`Deleted "${deleteUser.username}"`);
      setDeleteUser(null);
      await loadData();
      await refreshSession();
    } catch (err: any) {
      toast.error(err?.message || "Couldn't delete user");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveRex(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      const url = editingRex ? `/api/rex/${editingRex.id}` : "/api/rex";
      const method = editingRex ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: rexInputName.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Failed");
      toast.success(editingRex ? `Renamed Rex to "${data.rex.name}"` : `Created "${data.rex.name}"`);
      setRexDialogOpen(false);
      await loadData();
      await refreshSession();
    } catch (err: any) {
      toast.error(err?.message || "Couldn't save Rex category");
    } finally {
      setSaving(false);
    }
  }

  const filteredUsers = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter((u) => {
      if (rexFilter !== "all") {
        if (rexFilter === "none" && u.rex_id !== null) return false;
        if (rexFilter !== "none" && String(u.rex_id) !== rexFilter) return false;
      }
      if (!q) return true;
      return (
        u.username.toLowerCase().includes(q) ||
        u.role_name.toLowerCase().includes(q) ||
        (u.rex_name ? u.rex_name.toLowerCase().includes(q) : false)
      );
    });
  }, [users, search, rexFilter]);

  if (!sessionLoading && !permissions.users.manage) {
    return (
      <div className="max-w-5xl mx-auto pt-6">
        <EmptyState title="Access restricted" body="Only Administrators can manage user accounts." />
      </div>
    );
  }

  if (!loaded || sessionLoading) {
    return (
      <div className="max-w-6xl mx-auto space-y-5 animate-pulse">
        <div className="h-9 w-64 rounded bg-substrate" />
        <div className="h-64 rounded-lg border border-hairline bg-card" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-5xl mx-auto pt-6">
        <ErrorState what="users" detail={error} onRetry={loadData} />
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative w-52 sm:w-64">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search username, Rex, role..."
              className="h-8 w-full rounded border border-hairline bg-card pl-8 pr-7 text-xs text-ink placeholder:text-ink-faint focus:border-brass focus:outline-none focus:ring-1 focus:ring-brass"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <Select
            aria-label="Filter users by Rex"
            value={rexFilter}
            onValueChange={setRexFilter}
            triggerClassName="min-w-[140px]"
            options={[
              { value: "all", label: "All Rex groups" },
              { value: "none", label: "Global (All Rex)" },
              ...rexGroups.map((g) => ({ value: String(g.id), label: g.name })),
            ]}
          />
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setEditingRex(null);
              setRexInputName("");
              setRexDialogOpen(true);
            }}
          >
            <FolderPlus className="h-3.5 w-3.5" />
            New Rex
          </Button>
          <Button size="sm" onClick={openCreateDialog}>
            <UserPlus className="h-3.5 w-3.5" />
            Create User
          </Button>
        </div>
      </div>

      {/* Users List */}
      <section className="overflow-hidden rounded-lg border border-hairline bg-card shadow-panel">
        <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
          <span className="font-mono text-eyebrow font-semibold uppercase text-ink-mute">
            Operators ({fmtAmount(filteredUsers.length)})
          </span>
          <span className="font-mono text-[10px] uppercase text-ink-faint">
            Shared 2FA from .env
          </span>
        </div>

        {filteredUsers.length === 0 ? (
          <EmptyState
            title="No users match"
            body="Try clearing the search or filter, or create a new user account."
            className="py-12"
          />
        ) : (
          <ul className="divide-y divide-hairline">
            {filteredUsers.map((u) => {
              const isSelf = currentUser?.id === u.id;
              return (
                <li
                  key={u.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 transition-colors hover:bg-substrate/50"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusDot tone={u.is_active ? "signal" : "alert"} size="sm" />
                      <span className="font-mono text-sm font-semibold text-ink">{u.username}</span>
                      {u.is_env_admin && (
                        <span className="rounded border border-brass/40 bg-brass-wash px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase text-brass-deep">
                          Root (.env)
                        </span>
                      )}
                      <span className="rounded border border-hairline bg-substrate px-1.5 py-0.5 font-mono text-[10px] uppercase text-ink-soft">
                        {u.role_name}
                      </span>
                      <span className="inline-flex items-center gap-1 rounded border border-hairline bg-card px-1.5 py-0.5 font-mono text-[10px] uppercase text-ink-mute">
                        <Layers className="h-3 w-3 text-brass" />
                        {u.rex_name ?? "All Rex"}
                      </span>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    {!u.is_env_admin ? (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openEditDialog(u)}
                          title="Edit user role or Rex"
                        >
                          <Edit3 className="h-3.5 w-3.5" />
                          <span className="hidden sm:inline">Edit</span>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setPwUser(u);
                            setResetPassword("");
                            setShowResetPw(true);
                          }}
                          title="Set a new password (existing password cannot be viewed)"
                        >
                          <KeyRound className="h-3.5 w-3.5" />
                          <span className="hidden sm:inline">Reset PW</span>
                        </Button>
                        {!isSelf && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => handleToggleActive(u)}
                              title={u.is_active ? "Disable account" : "Enable account"}
                              className={u.is_active ? "text-ink-mute hover:text-alert-deep" : "text-signal-deep"}
                            >
                              {u.is_active ? (
                                <UserX className="h-3.5 w-3.5" />
                              ) : (
                                <UserCheck className="h-3.5 w-3.5" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => setDeleteUser(u)}
                              title="Delete user"
                              className="hover:text-alert-deep"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        )}
                      </>
                    ) : (
                      <span className="font-mono text-[10px] uppercase text-ink-faint px-2">
                        Configured via .env
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Rex Categories Overview */}
      <section className="rounded-lg border border-hairline bg-card shadow-panel overflow-hidden">
        <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
          <span className="font-mono text-eyebrow font-semibold uppercase text-ink-mute">
            Rex Categories ({fmtAmount(rexGroups.length)})
          </span>
          <span className="font-mono text-[10px] uppercase text-ink-faint">
            Names must be unique
          </span>
        </div>

        {rexGroups.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-ink-mute">
            No Rex categories yet. Creating your first Staff user will create one automatically.
          </div>
        ) : (
          <div className="grid gap-px bg-hairline sm:grid-cols-2 lg:grid-cols-3">
            {rexGroups.map((g) => (
              <div
                key={g.id}
                className="flex items-center justify-between gap-3 bg-card px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="truncate font-mono text-xs font-semibold uppercase text-ink">
                    {g.name}
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] tnum text-ink-mute">
                    {fmtAmount(g.active_sim_count ?? 0)}/{fmtAmount(g.sim_count ?? 0)} SIMs ·{" "}
                    {fmtAmount(g.user_count ?? 0)} {g.user_count === 1 ? "user" : "users"}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => {
                    setEditingRex(g);
                    setRexInputName(g.name);
                    setRexDialogOpen(true);
                  }}
                  title={`Rename ${g.name}`}
                >
                  <Edit3 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Create User Modal */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <form onSubmit={handleCreateUser} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Create Operator Account</DialogTitle>
              <DialogDescription>
                Assign a username, password (manual or generated), unique Rex category, and role.
              </DialogDescription>
            </DialogHeader>

            <Input
              label="Username"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              placeholder="e.g. rex1_staff"
              autoComplete="off"
              className="font-mono"
            />

            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="font-mono text-eyebrow font-semibold uppercase text-ink-mute">
                  Password
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setNewPassword(generateBrowserPassword(24))}
                    className="inline-flex items-center gap-1 rounded border border-hairline bg-substrate px-2 py-0.5 font-mono text-[10px] uppercase text-ink-soft transition-colors hover:border-brass/60 hover:text-ink"
                  >
                    <RefreshCw className="h-2.5 w-2.5" />
                    Auto-generate
                  </button>
                  <button
                    type="button"
                    onClick={() => newPassword && copyText(newPassword)}
                    className="inline-flex items-center gap-1 rounded border border-hairline bg-substrate px-2 py-0.5 font-mono text-[10px] uppercase text-ink-soft transition-colors hover:border-brass/60 hover:text-ink"
                  >
                    <Copy className="h-2.5 w-2.5" />
                    Copy
                  </button>
                </div>
              </div>
              <div className="relative">
                <input
                  type={showNewPw ? "text" : "password"}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Min 8 characters or auto-generate"
                  autoComplete="new-password"
                  spellCheck={false}
                  autoCapitalize="none"
                  autoCorrect="off"
                  className="h-10 sm:h-9 w-full rounded border border-hairline bg-card pl-3 pr-9 font-mono text-xs text-ink focus:border-brass focus:outline-none focus:ring-1 focus:ring-brass"
                />
                <button
                  type="button"
                  onClick={() => setShowNewPw((s) => !s)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-mute hover:text-ink"
                  aria-label={showNewPw ? "Hide password" : "Show password"}
                >
                  {showNewPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {newPassword !== newPassword.trim() && (
                <p className="mt-1 text-[11px] text-brass-deep">
                  Warning: password starts or ends with a space.
                </p>
              )}
            </div>

            <div>
              <span className="mb-1.5 block font-mono text-eyebrow font-semibold uppercase text-ink-mute">
                Role
              </span>
              <Select
                aria-label="Select Role"
                value={newRoleId}
                onValueChange={setNewRoleId}
                className="w-full"
                options={roles.map((r) => ({
                  value: String(r.id),
                  label: r.name,
                }))}
              />
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="font-mono text-eyebrow font-semibold uppercase text-ink-mute">
                  Rex Category
                </span>
                {rexGroups.length > 0 && (
                  <SegmentedControl<"new" | "existing">
                    aria-label="Rex assignment mode"
                    value={rexMode}
                    onValueChange={setRexMode}
                    options={[
                      { value: "new", label: "New Rex" },
                      { value: "existing", label: "Existing" },
                    ]}
                  />
                )}
              </div>

              {rexMode === "new" ? (
                <div className="space-y-1">
                  <Input
                    value={newRexName}
                    onChange={(e) => setNewRexName(e.target.value)}
                    placeholder={
                      selectedCreateRole?.permissions.rex.viewAll
                        ? "Optional for Admin (leave empty for All Rex)"
                        : "e.g. Rex-1 (must be unique)"
                    }
                    className="font-mono"
                    error={
                      duplicateRexName
                        ? `"${duplicateRexName.name}" already exists — pick a unique name or switch to Existing.`
                        : undefined
                    }
                  />
                </div>
              ) : (
                <Select
                  aria-label="Select existing Rex category"
                  value={existingRexId}
                  onValueChange={setExistingRexId}
                  className="w-full"
                  options={rexGroups.map((g) => ({
                    value: String(g.id),
                    label: `${g.name} (${g.sim_count ?? 0} SIMs)`,
                  }))}
                />
              )}
            </div>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)} disabled={saving}>
                Cancel
              </Button>
              <Button
                type="submit"
                loading={saving}
                disabled={
                  !newUsername.trim() ||
                  newPassword.length < 8 ||
                  !newRoleId ||
                  (rexMode === "new" &&
                    !selectedCreateRole?.permissions.rex.viewAll &&
                    (!newRexName.trim() || Boolean(duplicateRexName)))
                }
              >
                Create User
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit User Modal */}
      <Dialog open={!!editUser} onOpenChange={(o) => !o && setEditUser(null)}>
        <DialogContent className="max-w-md">
          <form onSubmit={handleEditUser} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Edit {editUser?.username}</DialogTitle>
              <DialogDescription>
                Updating role or Rex takes effect immediately on the user&apos;s next request.
              </DialogDescription>
            </DialogHeader>

            <Input
              label="Username"
              value={editUsername}
              onChange={(e) => setEditUsername(e.target.value)}
              className="font-mono"
            />

            <div>
              <span className="mb-1.5 block font-mono text-eyebrow font-semibold uppercase text-ink-mute">
                Role
              </span>
              <Select
                aria-label="Edit Role"
                value={editRoleId}
                onValueChange={setEditRoleId}
                className="w-full"
                options={roles.map((r) => ({ value: String(r.id), label: r.name }))}
              />
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="font-mono text-eyebrow font-semibold uppercase text-ink-mute">
                  Rex Category
                </span>
                <SegmentedControl<"existing" | "new" | "none">
                  aria-label="Edit Rex mode"
                  value={editRexMode}
                  onValueChange={setEditRexMode}
                  options={[
                    ...(rexGroups.length > 0 ? [{ value: "existing" as const, label: "Existing" }] : []),
                    { value: "new", label: "New" },
                    ...(selectedEditRole?.permissions.rex.viewAll
                      ? [{ value: "none" as const, label: "All Rex" }]
                      : []),
                  ]}
                />
              </div>

              {editRexMode === "existing" ? (
                <Select
                  aria-label="Existing Rex"
                  value={editRexId}
                  onValueChange={setEditRexId}
                  className="w-full"
                  options={rexGroups.map((g) => ({ value: String(g.id), label: g.name }))}
                />
              ) : editRexMode === "new" ? (
                <Input
                  value={editRexName}
                  onChange={(e) => setEditRexName(e.target.value)}
                  placeholder="New unique Rex name"
                  className="font-mono"
                />
              ) : (
                <p className="text-xs text-ink-mute">Global Admin access across all Rex categories.</p>
              )}
            </div>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setEditUser(null)} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" loading={saving}>
                Save Changes
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Reset Password Modal */}
      <Dialog open={!!pwUser} onOpenChange={(o) => !o && setPwUser(null)}>
        <DialogContent className="max-w-md">
          <form onSubmit={handleResetPassword} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Reset Password · {pwUser?.username}</DialogTitle>
              <DialogDescription>
                Existing passwords are encrypted and cannot be viewed. Type a new password or click
                Auto-generate, then click Update Password to save.
              </DialogDescription>
            </DialogHeader>

            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="font-mono text-eyebrow font-semibold uppercase text-ink-mute">
                  New Password
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setResetPassword(generateBrowserPassword(24))}
                    className="inline-flex items-center gap-1 rounded border border-hairline bg-substrate px-2 py-0.5 font-mono text-[10px] uppercase text-ink-soft hover:border-brass/60"
                  >
                    <RefreshCw className="h-2.5 w-2.5" />
                    Auto-generate
                  </button>
                  <button
                    type="button"
                    onClick={() => resetPassword && copyText(resetPassword)}
                    disabled={!resetPassword}
                    className="inline-flex items-center gap-1 rounded border border-hairline bg-substrate px-2 py-0.5 font-mono text-[10px] uppercase text-ink-soft hover:border-brass/60 disabled:opacity-40"
                  >
                    <Copy className="h-2.5 w-2.5" />
                    Copy
                  </button>
                </div>
              </div>
              <div className="relative">
                <input
                  type={showResetPw ? "text" : "password"}
                  value={resetPassword}
                  onChange={(e) => setResetPassword(e.target.value)}
                  placeholder="Enter new password (min 8 chars) or Auto-generate"
                  autoComplete="new-password"
                  spellCheck={false}
                  autoCapitalize="none"
                  autoCorrect="off"
                  className="h-10 sm:h-9 w-full rounded border border-hairline bg-card pl-3 pr-9 font-mono text-xs text-ink placeholder:text-ink-faint focus:border-brass focus:outline-none focus:ring-1 focus:ring-brass"
                />
                <button
                  type="button"
                  onClick={() => setShowResetPw((s) => !s)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-mute hover:text-ink"
                  aria-label={showResetPw ? "Hide password" : "Show password"}
                >
                  {showResetPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {resetPassword && resetPassword !== resetPassword.trim() && (
                <p className="mt-1 text-[11px] text-brass-deep">
                  Warning: password starts or ends with a space.
                </p>
              )}
              {resetPassword.length >= 8 && (
                <p className="mt-1.5 text-[11px] text-ink-mute">
                  Not saved yet — click <strong className="text-ink">Update Password</strong> below to apply.
                </p>
              )}
            </div>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setPwUser(null)} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" loading={saving} disabled={resetPassword.length < 8}>
                Update Password
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Saved Credentials Confirmation Modal */}
      <Dialog open={!!savedCreds} onOpenChange={(o) => !o && setSavedCreds(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Check className="h-4 w-4 text-signal-deep" />
              {savedCreds?.action === "created" ? "Account Created & Saved" : "Password Updated & Saved"}
            </DialogTitle>
            <DialogDescription>
              Copy these credentials now and share them with the operator. The password cannot be
              viewed again after closing this window.
            </DialogDescription>
          </DialogHeader>

          {savedCreds && (
            <div className="space-y-3 rounded-lg border border-hairline bg-substrate/70 p-3.5 font-mono text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] uppercase text-ink-mute">Username</span>
                <span className="font-semibold text-ink select-all">{savedCreds.username}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] uppercase text-ink-mute">Role / Rex</span>
                <span className="text-ink-soft">
                  {savedCreds.roleName} · {savedCreds.rexName}
                </span>
              </div>
              <div className="border-t border-hairline pt-2.5">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[10px] uppercase text-ink-mute">Saved Password</span>
                  <button
                    type="button"
                    onClick={() => copyText(savedCreds.password)}
                    className="inline-flex items-center gap-1 rounded border border-hairline bg-card px-2 py-0.5 text-[10px] uppercase text-ink-soft transition-colors hover:border-brass/60 hover:text-ink"
                  >
                    <Copy className="h-2.5 w-2.5" />
                    Copy PW
                  </button>
                </div>
                <div className="break-all rounded border border-hairline bg-card px-2.5 py-2 text-ink select-all">
                  {savedCreds.password}
                </div>
              </div>
            </div>
          )}

          <DialogFooter>
            {savedCreds && (
              <Button
                type="button"
                variant="secondary"
                onClick={() =>
                  copyText(`Username: ${savedCreds.username}\nPassword: ${savedCreds.password}`)
                }
              >
                <Copy className="h-3.5 w-3.5" />
                Copy Login Details
              </Button>
            )}
            <Button type="button" onClick={() => setSavedCreds(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete User Confirmation */}
      <Dialog open={!!deleteUser} onOpenChange={(o) => !o && setDeleteUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete user {deleteUser?.username}?</DialogTitle>
            <DialogDescription>
              The Rex category and its SIMs/history remain untouched. Consider disabling the account
              instead if you only want to revoke login access.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteUser(null)} disabled={saving}>
              Cancel
            </Button>
            <Button variant="destructive" loading={saving} onClick={handleDeleteUser}>
              Delete User
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create / Rename Rex Modal */}
      <Dialog open={rexDialogOpen} onOpenChange={setRexDialogOpen}>
        <DialogContent className="max-w-sm">
          <form onSubmit={handleSaveRex} className="space-y-4">
            <DialogHeader>
              <DialogTitle>{editingRex ? `Rename ${editingRex.name}` : "New Rex Category"}</DialogTitle>
              <DialogDescription>
                Rex category names are unique across the console (e.g. Rex-1, Rex-9).
              </DialogDescription>
            </DialogHeader>
            <Input
              label="Rex Name"
              value={rexInputName}
              onChange={(e) => setRexInputName(e.target.value)}
              placeholder="Rex-1"
              className="font-mono"
            />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setRexDialogOpen(false)} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" loading={saving} disabled={rexInputName.trim().length < 2}>
                {editingRex ? "Rename" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

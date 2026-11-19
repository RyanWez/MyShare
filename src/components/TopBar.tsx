"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { BellOff, BellRing, Layers, LogOut, Menu, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { ThemeToggle } from "@/components/ThemeToggle";
import InstallButton from "@/components/InstallButton";
import { OPEN_COMMAND_PALETTE } from "@/components/CommandPalette";

export const OPEN_LOGOUT_CONFIRM = "myshare:open-logout-confirm";
import { useSession } from "@/components/SessionProvider";
import { invalidateCache } from "@/lib/api";
import {
  chime,
  disableNotifs,
  enableNotifs,
  notifEnabled,
  notifSupported,
} from "@/lib/notifications";
import { cn } from "@/lib/utils";

const PAGES: Record<string, { title: string; sub: string }> = {
  "/": { title: "Overview", sub: "Balances, daily capacity, and today's transfers" },
  "/transfer": { title: "New transfer", sub: "Send balance from one SIM to any Mytel number" },
  "/sims": { title: "SIM tray", sub: "Logged-in SIMs, bill expiry, and token life" },
  "/history": { title: "History", sub: "Every transfer this console has attempted" },
  "/receivers": { title: "Receivers", sub: "Numbers this console has sent to, grouped by total" },
  "/users": { title: "Users", sub: "Manage operator accounts and Rex categories" },
  "/roles": { title: "Role permission", sub: "Configure page and widget access per role" },
};

const REX_FILTER_ROUTES = new Set(["/", "/transfer", "/sims", "/history", "/receivers"]);

export default function TopBar({ onMenu }: { onMenu: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, permissions, rexGroups, rexFilter, setRexFilter } = useSession();
  const page = PAGES[pathname] ?? { title: "MyShare", sub: "" };
  const [logoutConfirmOpen, setLogoutConfirmOpen] = React.useState(false);
  const [loggingOut, setLoggingOut] = React.useState(false);
  const [scrolled, setScrolled] = React.useState(false);

  const [notifOn, setNotifOn] = React.useState(false);
  const [notifSupportedState, setNotifSupportedState] = React.useState(false);
  const [notifBusy, setNotifBusy] = React.useState(false);

  React.useEffect(() => {
    setNotifSupportedState(notifSupported());
    setNotifOn(notifEnabled());
  }, []);

  React.useEffect(() => {
    const onOpenLogout = () => setLogoutConfirmOpen(true);
    window.addEventListener(OPEN_LOGOUT_CONFIRM, onOpenLogout);
    return () => window.removeEventListener(OPEN_LOGOUT_CONFIRM, onOpenLogout);
  }, []);

  React.useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  async function toggleNotifications() {
    if (notifBusy) return;
    setNotifBusy(true);
    try {
      if (notifOn) {
        disableNotifs();
        setNotifOn(false);
        toast("Background notifications off");
        return;
      }
      const result = await enableNotifs();
      setNotifOn(notifEnabled());
      if (result === "enabled") {
        chime(true);
        toast.success("Background notifications on — alerts while the tab is hidden");
      } else {
        toast.error("Notification permission denied — allow it from this site in your browser settings");
      }
    } finally {
      setNotifBusy(false);
    }
  }

  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      invalidateCache();
      router.replace("/login");
      router.refresh();
    }
  }

  const showRexSelector =
    permissions.rex.viewAll && REX_FILTER_ROUTES.has(pathname) && rexGroups.length > 0;

  return (
    <header
      className={cn(
        "sticky top-0 z-30 flex min-h-[70px] flex-col justify-center border-b transition-[background-color,border-color,box-shadow] duration-200",
        scrolled
          ? "border-hairline-strong/80 bg-substrate/95 backdrop-blur-md shadow-lift"
          : "border-hairline bg-substrate"
      )}
    >
      <div className="flex items-center gap-3 px-4 py-2 sm:gap-4 sm:px-5 md:px-8">
        <Button
          variant="ghost"
          size="icon"
          onClick={onMenu}
          className="-ml-2 shrink-0 md:hidden"
          aria-label="Open menu"
        >
          <Menu className="h-4 w-4" strokeWidth={1.5} />
        </Button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate font-mono text-[13px] font-semibold uppercase tracking-[0.12em] text-ink">
              {page.title}
            </h1>
            {user?.rexName && !permissions.rex.viewAll && (
              <span className="hidden sm:inline-flex items-center rounded border border-brass/35 bg-brass-wash/70 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-brass-deep">
                {user.rexName}
              </span>
            )}
          </div>
          {page.sub && (
            <p className="mt-0.5 hidden truncate text-xs text-ink-mute sm:block">{page.sub}</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          {showRexSelector && (
            <div className="hidden md:flex items-center gap-1.5">
              <Layers className="h-3.5 w-3.5 text-ink-mute" strokeWidth={1.75} aria-hidden="true" />
              <Select
                aria-label="Filter by Rex category"
                value={rexFilter}
                onValueChange={setRexFilter}
                align="right"
                triggerClassName="min-w-[130px] max-w-[170px]"
                options={[
                  { value: "all", label: "All Rex" },
                  ...rexGroups.map((g) => ({
                    value: String(g.id),
                    label: `${g.name} (${g.sim_count ?? 0})`,
                  })),
                ]}
              />
            </div>
          )}

          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE))}
            aria-label="Search"
            title="Search (Ctrl K)"
            className="text-ink-mute hover:text-ink hover:bg-card border border-transparent hover:border-hairline transition-all duration-200"
          >
            <Search className="h-4 w-4" strokeWidth={1.8} />
          </Button>
          {notifSupportedState && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleNotifications}
              disabled={notifBusy}
              aria-label={notifOn ? "Notifications on" : "Notifications off"}
              title={
                notifOn
                  ? "Background notifications on — click to turn off"
                  : "Get notified when transfers finish while this tab is hidden"
              }
              className={cn(
                "border transition-all duration-200",
                notifOn
                  ? "border-brass/40 text-brass hover:bg-brass-wash hover:text-brass-deep"
                  : "text-ink-mute hover:text-ink hover:bg-card border-transparent hover:border-hairline"
              )}
            >
              {notifOn ? (
                <BellRing className="h-4 w-4" strokeWidth={1.8} />
              ) : (
                <BellOff className="h-4 w-4" strokeWidth={1.8} />
              )}
            </Button>
          )}
          <InstallButton />
          <ThemeToggle />
          {pathname !== "/transfer" && permissions.transfer.execute && (
            <Button asChild size="sm" className="px-2.5 sm:px-3">
              <Link href="/transfer" aria-label="New transfer">
                <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                <span className="hidden sm:inline">New transfer</span>
              </Link>
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setLogoutConfirmOpen(true)}
            disabled={loggingOut}
            aria-label="Log out"
            title={loggingOut ? "Logging out…" : "Log out"}
          >
            <LogOut
              className={cn("h-4 w-4", loggingOut && "animate-pulse")}
              strokeWidth={1.5}
            />
          </Button>
        </div>
      </div>

      {showRexSelector && (
        <div className="flex items-center gap-2 border-t border-hairline/60 px-4 py-1.5 md:hidden">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-mute">
            Rex
          </span>
          <Select
            aria-label="Filter by Rex category"
            value={rexFilter}
            onValueChange={setRexFilter}
            className="flex-1"
            options={[
              { value: "all", label: "All Rex" },
              ...rexGroups.map((g) => ({
                value: String(g.id),
                label: `${g.name} (${g.sim_count ?? 0})`,
              })),
            ]}
          />
        </div>
      )}

      <Dialog
        open={logoutConfirmOpen}
        onOpenChange={(open) => {
          if (!loggingOut) setLogoutConfirmOpen(open);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Log out of MyShare?</DialogTitle>
            <DialogDescription>
              {user ? (
                <>
                  You are signed in as{" "}
                  <span className="font-mono font-medium text-ink">{user.username}</span>{" "}
                  ({user.roleName} · {user.rexName ?? "All Rex"}). You will need your password and
                  2FA code to sign back in.
                </>
              ) : (
                "Your current session will end and you will be returned to the login screen."
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              autoFocus
              disabled={loggingOut}
              onClick={() => setLogoutConfirmOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              loading={loggingOut}
              onClick={logout}
            >
              <LogOut className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              Confirm Log Out
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </header>
  );
}

"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Eye, EyeOff, Lock, ShieldAlert, User } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ThemeToggle } from "@/components/ThemeToggle";
import { invalidateCache } from "@/lib/api";

export default function LoginPage() {
  return (
    <React.Suspense fallback={null}>
      <LoginForm />
    </React.Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [totpCode, setTotpCode] = React.useState("");
  const [totpRequired, setTotpRequired] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [locked, setLocked] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [succeeded, setSucceeded] = React.useState(false);
  const usernameRef = React.useRef<HTMLInputElement>(null);
  const passwordRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    usernameRef.current?.focus();
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/login")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d?.totpRequired) setTotpRequired(true);
        if (d?.ok && d.required === false) {
          const next = params.get("next");
          router.replace(next && next.startsWith("/") ? next : "/");
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [router, params]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || locked || succeeded) return;
    setBusy(true);
    setError(null);
    let ok = false;
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password, totpCode }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        ok = true;
        setSucceeded(true);
        invalidateCache();
        const next = params.get("next");
        router.replace(next && next.startsWith("/") ? next : "/");
        router.refresh();
        return;
      }
      if (res.status === 503) {
        setLocked(true);
        setError(String(data?.error ?? "Server is not configured for login"));
      } else {
        const msg = String(data?.error ?? "Invalid credentials");
        setError(msg);
        if (msg.toLowerCase().includes("auth code")) {
          setTotpCode("");
        } else {
          // Keep the entered password so the operator can toggle visibility to inspect typos/autofill.
          passwordRef.current?.focus();
          passwordRef.current?.select();
        }
      }
    } catch {
      setError("Network error — try again");
    } finally {
      if (!ok) setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg border border-hairline bg-card shadow-panel">
            <Lock className="h-5 w-5 text-brass" strokeWidth={1.75} />
          </div>
          <h1 className="font-mono text-[13px] font-semibold uppercase tracking-[0.12em] text-ink">
            My<span className="text-brass">Share</span> console
          </h1>
          <p className="mt-1.5 text-sm text-ink-mute">
            Sign in with your assigned operator account
          </p>
        </div>

        <form
          onSubmit={onSubmit}
          className="space-y-4 rounded-lg border border-hairline bg-card p-5 shadow-panel"
        >
          <Input
            ref={usernameRef}
            id="login-username"
            name="username"
            label="Username"
            type="text"
            autoComplete="username"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            enterKeyHint="next"
            required
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              if (error) setError(null);
            }}
            disabled={locked}
            iconLeft={<User className="h-4 w-4" strokeWidth={1.75} />}
            placeholder="MyShareAdmin"
          />

          <Input
            ref={passwordRef}
            id="login-password"
            name="password"
            label="Password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            enterKeyHint={totpRequired ? "next" : "done"}
            required
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (error) setError(null);
            }}
            disabled={locked}
            error={error ?? undefined}
            iconLeft={<Lock className="h-4 w-4" strokeWidth={1.75} />}
            actionRight={
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                className="flex h-8 w-8 items-center justify-center rounded text-ink-mute transition-colors hover:bg-substrate hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brass"
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                ) : (
                  <Eye className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                )}
              </button>
            }
            placeholder="••••••••"
          />

          {totpRequired && (
            <Input
              id="login-totp"
              name="one-time-code"
              label="Google Auth Code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              spellCheck={false}
              enterKeyHint="done"
              required
              maxLength={6}
              value={totpCode}
              onChange={(e) => {
                setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6));
                if (error) setError(null);
              }}
              disabled={locked}
              placeholder="123456"
              className="text-center font-mono tracking-widest"
            />
          )}

          <Button
            type="submit"
            className="w-full"
            loading={busy}
            disabled={
              locked ||
              succeeded ||
              !username.trim() ||
              !password ||
              (totpRequired && totpCode.length < 6)
            }
          >
            {succeeded ? "Unlocking…" : "Sign in"}
          </Button>

          {locked && (
            <div className="flex items-start gap-2 rounded border border-alert/40 bg-alert-wash p-3 text-xs text-alert-deep">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Set AUTH_PASSWORD and DATABASE_URL in .env to enable console login.</span>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

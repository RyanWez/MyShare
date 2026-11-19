"use client";

import { useEffect, useRef } from "react";
import { invalidateCache } from "@/lib/api";

// 8 hours in milliseconds
const INACTIVITY_LIMIT = 8 * 60 * 60 * 1000;

export function InactivityProvider({ children }: { children: React.ReactNode }) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastActivityRef = useRef<number>(Date.now());
  const loggingOutRef = useRef(false);

  useEffect(() => {
    lastActivityRef.current = Date.now();

    async function forceLogout() {
      if (loggingOutRef.current) return;
      loggingOutRef.current = true;
      try {
        await fetch("/api/auth/logout", { method: "POST" });
      } catch {}
      invalidateCache();
      window.location.assign("/login");
    }

    function scheduleCheck(delayMs: number) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => {
        const elapsed = Date.now() - lastActivityRef.current;
        if (elapsed >= INACTIVITY_LIMIT) {
          void forceLogout();
        } else {
          scheduleCheck(INACTIVITY_LIMIT - elapsed);
        }
      }, delayMs);
    }

    function handleActivity() {
      lastActivityRef.current = Date.now();
    }

    function handleVisibilityChange() {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastActivityRef.current >= INACTIVITY_LIMIT) {
        void forceLogout();
      }
    }

    scheduleCheck(INACTIVITY_LIMIT);

    const events = ["mousedown", "mousemove", "keydown", "scroll", "touchstart"];
    for (const event of events) {
      window.addEventListener(event, handleActivity, { passive: true });
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      for (const event of events) {
        window.removeEventListener(event, handleActivity);
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  return <>{children}</>;
}

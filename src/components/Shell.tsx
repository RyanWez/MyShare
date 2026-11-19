"use client";

import * as React from "react";
import Sidebar from "@/components/Sidebar";
import TopBar from "@/components/TopBar";
import { CommandPalette } from "@/components/CommandPalette";
import NotificationBridge from "@/components/NotificationBridge";
import { cn } from "@/lib/utils";

/** Holds the mobile drawer state shared by the rail and the top bar. */
export default function Shell({ children }: { children: React.ReactNode }) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(false);

  return (
    <div className="flex min-h-screen">
      <Sidebar 
        open={menuOpen} 
        onClose={() => setMenuOpen(false)} 
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed(!collapsed)}
      />
      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col",
          collapsed ? "md:pl-20" : "md:pl-60"
        )}
        style={{
          transition: collapsed
            ? "padding-left 340ms cubic-bezier(0.45, 0.05, 0.25, 1)"
            : "padding-left 480ms cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      >
        <TopBar onMenu={() => setMenuOpen(true)} />
        <main className="flex-1 px-5 py-6 md:px-8 md:py-8">{children}</main>
      </div>
      {/* App-wide ⌘K launcher; portal-renders above everything. */}
      <CommandPalette />
      {/* Turns background SSE transfer results into OS notifications. */}
      <NotificationBridge />
    </div>
  );
}

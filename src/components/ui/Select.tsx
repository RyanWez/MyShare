"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string = string> {
  value: T;
  onValueChange: (value: T) => void;
  options: SelectOption<T>[];
  placeholder?: string;
  "aria-label"?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  /** Render option text in tabular monospace (ideal for phone numbers). */
  mono?: boolean;
  align?: "left" | "right";
}

interface Placement {
  left: number;
  top: number;
  minWidth: number;
  openUp: boolean;
}

const VIEWPORT_MARGIN = 8;
const MENU_GAP = 6;
const MENU_MAX_H = 260;
const CLOSE_ANIM_MS = 160;

/**
 * Compute viewport-clamped anchor coordinates from the trigger rect and either
 * the measured menu dimensions or a fast initial estimate (so frame 1 already
 * lands on the trigger with zero off-screen flash or coordinate interpolation).
 */
function computePlacement(
  trigger: HTMLElement,
  align: "left" | "right",
  estimatedItemCount: number,
  menu?: HTMLElement | null
): Placement {
  const anchor = trigger.getBoundingClientRect();
  const minWidth = Math.max(anchor.width, 180);
  const menuWidth = menu && menu.offsetWidth > 0 ? Math.max(menu.offsetWidth, minWidth) : minWidth;
  const estHeight = Math.min(Math.max(estimatedItemCount, 1) * 32 + 10, MENU_MAX_H);
  const menuHeight =
    menu && menu.scrollHeight > 0 ? Math.min(menu.scrollHeight, MENU_MAX_H) : estHeight;

  let left = align === "right" ? anchor.right - menuWidth : anchor.left;
  left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(left, window.innerWidth - VIEWPORT_MARGIN - menuWidth)
  );

  const spaceBelow = window.innerHeight - anchor.bottom - VIEWPORT_MARGIN - MENU_GAP;
  const spaceAbove = anchor.top - VIEWPORT_MARGIN - MENU_GAP;
  const openUp = spaceBelow < Math.min(menuHeight, 160) && spaceAbove > spaceBelow;
  const top = openUp
    ? Math.max(VIEWPORT_MARGIN, anchor.top - MENU_GAP - menuHeight)
    : anchor.bottom + MENU_GAP;

  return { left, top, minWidth, openUp };
}

/**
 * Custom elevated dropdown replacing native `<select>`.
 *
 * Portalled to `document.body` with viewport-aware collision flipping, explicit
 * `pointer-events-auto` (so it stays clickable inside Radix modal Dialogs where
 * `body` has `pointer-events: none`), and compositor-only wave animations so
 * `left`/`top` coordinates never transition across the viewport.
 */
export function Select<T extends string = string>({
  value,
  onValueChange,
  options,
  placeholder = "Select…",
  "aria-label": ariaLabel,
  id,
  disabled = false,
  className,
  triggerClassName,
  mono = false,
  align = "left",
}: SelectProps<T>) {
  const [open, setOpen] = React.useState(false);
  const [renderMenu, setRenderMenu] = React.useState(false);
  const [closing, setClosing] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const [placement, setPlacement] = React.useState<Placement | null>(null);

  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const closeTimerRef = React.useRef<number | null>(null);
  const listId = React.useId();

  React.useEffect(() => {
    setMounted(true);
    return () => {
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    };
  }, []);

  const selectedIndex = React.useMemo(
    () => options.findIndex((o) => o.value === value),
    [options, value]
  );
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const openMenu = React.useCallback(() => {
    if (disabled) return;
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (triggerRef.current) {
      setPlacement(computePlacement(triggerRef.current, align, options.length));
    }
    setClosing(false);
    setRenderMenu(true);
    setOpen(true);
  }, [disabled, align, options.length]);

  const closeMenu = React.useCallback(() => {
    setOpen(false);
    setClosing(true);
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    closeTimerRef.current = window.setTimeout(
      () => {
        setRenderMenu(false);
        setClosing(false);
        setPlacement(null);
        closeTimerRef.current = null;
      },
      reduced ? 10 : CLOSE_ANIM_MS
    );
  }, []);

  const updatePlacement = React.useCallback(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger) return;
    const next = computePlacement(trigger, align, options.length, menu);
    setPlacement((prev) =>
      prev &&
      Math.abs(prev.left - next.left) < 0.5 &&
      Math.abs(prev.top - next.top) < 0.5 &&
      Math.abs(prev.minWidth - next.minWidth) < 0.5 &&
      prev.openUp === next.openUp
        ? prev
        : next
    );
  }, [align, options.length]);

  // Refine placement against actual rendered dimensions before the first paint,
  // and keep aligned when the window or an ancestor container scrolls/resizes.
  React.useLayoutEffect(() => {
    if (!open || !renderMenu) return;
    updatePlacement();

    const handleScroll = (e: Event) => {
      if (menuRef.current && e.target === menuRef.current) return;
      updatePlacement();
    };
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [open, renderMenu, updatePlacement]);

  // Seed highlight at the current selection whenever opened.
  React.useEffect(() => {
    if (!open) return;
    const firstEnabled = options.findIndex((o) => !o.disabled);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : firstEnabled);
  }, [open, selectedIndex, options]);

  // Keep keyboard-focused option scrolled into view INSIDE the menu only
  // (never using scrollIntoView(), which can jerk outer scroll containers).
  React.useEffect(() => {
    if (!open || activeIndex < 0 || !menuRef.current) return;
    const menu = menuRef.current;
    const row = menu.querySelectorAll<HTMLElement>("[role='option']")[activeIndex];
    if (!row) return;
    const rowTop = row.offsetTop;
    const rowBottom = rowTop + row.offsetHeight;
    if (rowTop < menu.scrollTop + 4) {
      menu.scrollTop = Math.max(0, rowTop - 4);
    } else if (rowBottom > menu.scrollTop + menu.clientHeight - 4) {
      menu.scrollTop = rowBottom - menu.clientHeight + 4;
    }
  }, [open, activeIndex]);

  React.useEffect(() => {
    if (!open) return;

    function handlePointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      closeMenu();
    }

    document.addEventListener("mousedown", handlePointerDown, true);
    return () => document.removeEventListener("mousedown", handlePointerDown, true);
  }, [open, closeMenu]);

  function moveActive(step: 1 | -1) {
    if (options.length === 0) return;
    let idx = activeIndex < 0 ? (step > 0 ? -1 : 0) : activeIndex;
    for (let i = 0; i < options.length; i++) {
      idx = (idx + step + options.length) % options.length;
      if (!options[idx].disabled) {
        setActiveIndex(idx);
        return;
      }
    }
  }

  function selectOption(opt: SelectOption<T>) {
    if (opt.disabled) return;
    onValueChange(opt.value);
    closeMenu();
    triggerRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;

    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openMenu();
      }
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveActive(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveActive(-1);
        break;
      case "Home": {
        e.preventDefault();
        const first = options.findIndex((o) => !o.disabled);
        if (first >= 0) setActiveIndex(first);
        break;
      }
      case "End": {
        e.preventDefault();
        for (let i = options.length - 1; i >= 0; i--) {
          if (!options[i].disabled) {
            setActiveIndex(i);
            break;
          }
        }
        break;
      }
      case "Enter":
      case " ":
        e.preventDefault();
        if (activeIndex >= 0 && options[activeIndex]) {
          selectOption(options[activeIndex]);
        }
        break;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
        triggerRef.current?.focus();
        break;
      case "Tab":
        closeMenu();
        break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const char = e.key.toLowerCase();
          const match = options.findIndex(
            (o, idx) => !o.disabled && idx > activeIndex && o.label.toLowerCase().startsWith(char)
          );
          const wrapMatch =
            match >= 0
              ? match
              : options.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(char));
          if (wrapMatch >= 0) setActiveIndex(wrapMatch);
        }
    }
  }

  const originClass = placement?.openUp
    ? align === "right"
      ? "origin-bottom-right"
      : "origin-bottom-left"
    : align === "right"
      ? "origin-top-right"
      : "origin-top-left";

  const animClass = closing
    ? placement?.openUp
      ? "dropdown-wave-out-up"
      : "dropdown-wave-out-down"
    : placement?.openUp
      ? "dropdown-wave-in-up"
      : "dropdown-wave-in-down";

  return (
    <div className={cn("relative inline-block", className)}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listId}
        disabled={disabled}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={handleKeyDown}
        className={cn(
          "inline-flex h-10 sm:h-8 w-full items-center justify-between gap-2.5 rounded-md border px-2.5 text-xs transition-[background-color,border-color,box-shadow,color] duration-150",
          "bg-card text-ink shadow-panel",
          open
            ? "border-brass/70 ring-1 ring-brass/30"
            : "border-hairline hover:border-hairline-strong hover:bg-card/90",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brass focus-visible:ring-offset-2",
          "disabled:cursor-not-allowed disabled:opacity-50",
          mono && "font-mono tnum",
          triggerClassName
        )}
      >
        <span className={cn("truncate", !selected && "text-ink-mute")}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-ink-mute transition-transform duration-200 ease-out",
            open && "rotate-180 text-brass"
          )}
          strokeWidth={1.75}
          aria-hidden="true"
        />
      </button>

      {mounted &&
        renderMenu &&
        placement &&
        createPortal(
          <div
            ref={menuRef}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            onKeyDown={handleKeyDown}
            onMouseDown={(e) => {
              // Keep focus clean and prevent outside-dialog dismiss interference.
              e.stopPropagation();
            }}
            style={{
              left: placement.left,
              top: placement.top,
              minWidth: placement.minWidth,
            }}
            className={cn(
              "fixed z-[60] max-h-[260px] overflow-y-auto rounded-lg border border-hairline-strong/80 bg-card/95 p-1 shadow-dialog",
              "ring-1 ring-inset ring-white/[0.04] backdrop-blur-md transition-none will-change-[transform,opacity]",
              closing ? "pointer-events-none" : "pointer-events-auto",
              originClass,
              animClass
            )}
          >
            {options.map((opt, idx) => {
              const isSelected = opt.value === value;
              const isActive = idx === activeIndex;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={opt.disabled}
                  onMouseEnter={() => !opt.disabled && setActiveIndex(idx)}
                  onClick={(e) => {
                    e.stopPropagation();
                    selectOption(opt);
                  }}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 sm:py-1.5 text-left text-xs transition-colors duration-100",
                    mono && "font-mono tnum",
                    opt.disabled
                      ? "cursor-not-allowed opacity-40"
                      : isSelected
                        ? "bg-brass-wash/75 font-medium text-ink"
                        : isActive
                          ? "bg-substrate text-ink"
                          : "text-ink-soft hover:bg-substrate hover:text-ink"
                  )}
                >
                  <span className="truncate">{opt.label}</span>
                  <Check
                    className={cn(
                      "h-3.5 w-3.5 shrink-0 transition-opacity duration-150",
                      isSelected ? "opacity-100 text-brass" : "opacity-0"
                    )}
                    strokeWidth={2.25}
                    aria-hidden="true"
                  />
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </div>
  );
}

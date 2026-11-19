"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
  /** Optional text matched by the search input instead of `label`. */
  searchText?: string;
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
  /** Show a pinned search input at the top of the dropdown menu. */
  searchable?: boolean;
  searchPlaceholder?: string;
  emptySearchText?: string;
}

interface Placement {
  left: number;
  top: number;
  minWidth: number;
  openUp: boolean;
}

const VIEWPORT_MARGIN = 8;
const MENU_GAP = 6;
const MENU_MAX_H = 264;
const SEARCH_HEADER_H = 44;
const CLOSE_ANIM_MS = 160;

/**
 * Compute anchor coordinates from the trigger rect and either the measured menu
 * dimensions or a fast initial estimate (so frame 1 already lands on the
 * trigger with zero off-screen flash or coordinate interpolation).
 */
function computePlacement(
  trigger: HTMLElement,
  align: "left" | "right",
  estimatedItemCount: number,
  searchable: boolean,
  menu?: HTMLElement | null,
  portalHost?: HTMLElement | null
): Placement {
  const anchor = trigger.getBoundingClientRect();
  const minWidth = Math.max(anchor.width, searchable ? 210 : 180);
  const menuWidth = menu && menu.offsetWidth > 0 ? Math.max(menu.offsetWidth, minWidth) : minWidth;
  const estHeight = Math.min(
    Math.max(estimatedItemCount, 1) * 32 + (searchable ? SEARCH_HEADER_H + 10 : 10),
    MENU_MAX_H
  );
  const measuredHeight = menu
    ? Math.min(Math.max(menu.offsetHeight, menu.scrollHeight), MENU_MAX_H)
    : estHeight;
  const menuHeight = measuredHeight > 0 ? measuredHeight : estHeight;

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

  if (portalHost) {
    const hostRect = portalHost.getBoundingClientRect();
    return {
      left: left - (hostRect.left + portalHost.clientLeft),
      top: top - (hostRect.top + portalHost.clientTop),
      minWidth,
      openUp,
    };
  }

  return { left, top, minWidth, openUp };
}

/**
 * Custom elevated dropdown replacing native `<select>`.
 *
 * Portalled to `document.body` (or the enclosing `[role="dialog"]` when inside a
 * modal so Radix FocusScope allows typing in the search input) with
 * viewport-aware collision flipping, explicit `pointer-events-auto`, and
 * compositor-only wave animations.
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
  searchable = false,
  searchPlaceholder = "Search…",
  emptySearchText = "No matching options",
}: SelectProps<T>) {
  const [open, setOpen] = React.useState(false);
  const [renderMenu, setRenderMenu] = React.useState(false);
  const [closing, setClosing] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const [placement, setPlacement] = React.useState<Placement | null>(null);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [portalHost, setPortalHost] = React.useState<HTMLElement | null>(null);

  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
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

  const visibleOptions = React.useMemo(() => {
    if (!searchable) return options;
    const q = searchQuery.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => {
      const haystack = (o.searchText ?? o.label).toLowerCase();
      return haystack.includes(q);
    });
  }, [options, searchable, searchQuery]);

  const openMenu = React.useCallback(() => {
    if (disabled) return;
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    const dialogHost = triggerRef.current?.closest<HTMLElement>("[role='dialog']") ?? null;
    setPortalHost(dialogHost);
    setSearchQuery("");
    if (triggerRef.current) {
      setPlacement(
        computePlacement(triggerRef.current, align, options.length, searchable, null, dialogHost)
      );
    }
    setClosing(false);
    setRenderMenu(true);
    setOpen(true);
  }, [disabled, align, options.length, searchable]);

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
        setSearchQuery("");
        closeTimerRef.current = null;
      },
      reduced ? 10 : CLOSE_ANIM_MS
    );
  }, []);

  const updatePlacement = React.useCallback(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger) return;
    const next = computePlacement(
      trigger,
      align,
      visibleOptions.length,
      searchable,
      menu,
      portalHost
    );
    setPlacement((prev) =>
      prev &&
      Math.abs(prev.left - next.left) < 0.5 &&
      Math.abs(prev.top - next.top) < 0.5 &&
      Math.abs(prev.minWidth - next.minWidth) < 0.5 &&
      prev.openUp === next.openUp
        ? prev
        : next
    );
  }, [align, visibleOptions.length, searchable, portalHost]);

  // Refine placement against actual rendered dimensions before the first paint,
  // and keep aligned when the window or an ancestor container scrolls/resizes.
  React.useLayoutEffect(() => {
    if (!open || !renderMenu) return;
    updatePlacement();

    const handleScroll = (e: Event) => {
      if (menuRef.current && (e.target === menuRef.current || e.target === listRef.current)) {
        return;
      }
      updatePlacement();
    };
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [open, renderMenu, updatePlacement]);

  // Focus the search input when opened in searchable mode.
  React.useEffect(() => {
    if (!open || !searchable) return;
    const raf = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [open, searchable]);

  // Seed highlight at the current selection (or first filtered match when searching).
  React.useEffect(() => {
    if (!open) return;
    const firstEnabled = visibleOptions.findIndex((o) => !o.disabled);
    if (searchable && searchQuery.trim().length > 0) {
      setActiveIndex(firstEnabled);
      return;
    }
    const visSelected = visibleOptions.findIndex((o) => o.value === value);
    setActiveIndex(visSelected >= 0 ? visSelected : firstEnabled);
  }, [open, value, visibleOptions, searchable, searchQuery]);

  // Keep keyboard-focused option scrolled into view INSIDE the options container only.
  React.useEffect(() => {
    if (!open || activeIndex < 0) return;
    const scroller = searchable ? listRef.current : menuRef.current;
    if (!scroller) return;
    const row = scroller.querySelectorAll<HTMLElement>("[role='option']")[activeIndex];
    if (!row) return;
    const rowTop = row.offsetTop;
    const rowBottom = rowTop + row.offsetHeight;
    if (rowTop < scroller.scrollTop + 4) {
      scroller.scrollTop = Math.max(0, rowTop - 4);
    } else if (rowBottom > scroller.scrollTop + scroller.clientHeight - 4) {
      scroller.scrollTop = rowBottom - scroller.clientHeight + 4;
    }
  }, [open, activeIndex, searchable]);

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
    if (visibleOptions.length === 0) return;
    let idx = activeIndex < 0 ? (step > 0 ? -1 : 0) : activeIndex;
    for (let i = 0; i < visibleOptions.length; i++) {
      idx = (idx + step + visibleOptions.length) % visibleOptions.length;
      if (!visibleOptions[idx].disabled) {
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
        if (searchable && document.activeElement === searchInputRef.current) return;
        e.preventDefault();
        const first = visibleOptions.findIndex((o) => !o.disabled);
        if (first >= 0) setActiveIndex(first);
        break;
      }
      case "End": {
        if (searchable && document.activeElement === searchInputRef.current) return;
        e.preventDefault();
        for (let i = visibleOptions.length - 1; i >= 0; i--) {
          if (!visibleOptions[i].disabled) {
            setActiveIndex(i);
            break;
          }
        }
        break;
      }
      case "Enter":
        e.preventDefault();
        if (activeIndex >= 0 && visibleOptions[activeIndex]) {
          selectOption(visibleOptions[activeIndex]);
        }
        break;
      case " ":
        if (searchable && document.activeElement === searchInputRef.current) return;
        e.preventDefault();
        if (activeIndex >= 0 && visibleOptions[activeIndex]) {
          selectOption(visibleOptions[activeIndex]);
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
        if (!searchable && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const char = e.key.toLowerCase();
          const match = visibleOptions.findIndex(
            (o, idx) => !o.disabled && idx > activeIndex && o.label.toLowerCase().startsWith(char)
          );
          const wrapMatch =
            match >= 0
              ? match
              : visibleOptions.findIndex(
                  (o) => !o.disabled && o.label.toLowerCase().startsWith(char)
                );
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

  const portalContainer = portalHost ?? (mounted ? document.body : null);

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
        portalContainer &&
        createPortal(
          <div
            ref={menuRef}
            id={listId}
            role={searchable ? undefined : "listbox"}
            aria-label={searchable ? undefined : ariaLabel}
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
              portalHost ? "absolute" : "fixed",
              "z-[60] rounded-lg border border-hairline-strong/80 bg-card/95 shadow-dialog",
              searchable ? "flex max-h-[264px] flex-col overflow-hidden" : "max-h-[260px] overflow-y-auto p-1",
              "ring-1 ring-inset ring-white/[0.04] backdrop-blur-md transition-none will-change-[transform,opacity]",
              closing ? "pointer-events-none" : "pointer-events-auto",
              originClass,
              animClass
            )}
          >
            {searchable && (
              <div className="shrink-0 border-b border-hairline p-1.5">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={searchPlaceholder}
                    aria-label={searchPlaceholder}
                    autoComplete="off"
                    spellCheck={false}
                    className="h-8 w-full rounded border border-hairline bg-substrate/80 pl-7 pr-7 font-mono text-xs text-ink placeholder:text-ink-faint focus:border-brass focus:bg-card focus:outline-none focus:ring-1 focus:ring-brass"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => {
                        setSearchQuery("");
                        searchInputRef.current?.focus();
                      }}
                      aria-label="Clear search"
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-ink-faint hover:text-ink"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </div>
            )}

            <div
              ref={listRef}
              role={searchable ? "listbox" : undefined}
              aria-label={searchable ? ariaLabel : undefined}
              className={cn(searchable && "relative max-h-[212px] overflow-y-auto p-1")}
            >
              {visibleOptions.length === 0 ? (
                <div className="px-2.5 py-4 text-center font-mono text-[11px] text-ink-mute">
                  {emptySearchText}
                </div>
              ) : (
                visibleOptions.map((opt, idx) => {
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
                })
              )}
            </div>
          </div>,
          portalContainer
        )}
    </div>
  );
}

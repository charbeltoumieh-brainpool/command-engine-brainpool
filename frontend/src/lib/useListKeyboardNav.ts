import { useEffect, useRef, type RefObject } from "react";

export interface UseListKeyboardNavOptions<T> {
  items: T[];
  getId: (item: T) => string | number;
  selectedId: string | number | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onSelect: (id: any) => void;
  onActivate?: (item: T) => void;
  onEscape?: () => void;
  searchInputRef?: RefObject<HTMLInputElement | null>;
  enabled?: boolean;
}

function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

export function useListKeyboardNav<T>(
  options: UseListKeyboardNavOptions<T>,
): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (options.enabled === false) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const current = optionsRef.current;
      if (current.enabled === false) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.isComposing) return;

      // Never intercept keys while a modal dialog is open
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) {
        return;
      }

      const activeEl = document.activeElement;
      const searchEl = current.searchInputRef?.current ?? null;
      const inSearchInput = searchEl !== null && activeEl === searchEl;

      if (isEditableElement(activeEl)) {
        if (event.key === "Escape" && inSearchInput) {
          event.preventDefault();
          searchEl.blur();
          current.onEscape?.();
        }
        return;
      }

      const { items, getId, selectedId, onSelect, onActivate, onEscape } =
        current;

      if (event.key === "/") {
        if (searchEl) {
          event.preventDefault();
          searchEl.focus();
        }
        return;
      }

      if (event.key === "Escape") {
        if (onEscape) {
          event.preventDefault();
          onEscape();
        }
        return;
      }

      if (event.key === "j" || event.key === "ArrowDown") {
        if (items.length === 0) return;
        event.preventDefault();
        const currentIndex =
          selectedId === null
            ? -1
            : items.findIndex((item) => getId(item) === selectedId);
        const nextIndex =
          currentIndex === -1
            ? 0
            : Math.min(currentIndex + 1, items.length - 1);
        onSelect(getId(items[nextIndex]));
        return;
      }

      if (event.key === "k" || event.key === "ArrowUp") {
        if (items.length === 0) return;
        event.preventDefault();
        const currentIndex =
          selectedId === null
            ? -1
            : items.findIndex((item) => getId(item) === selectedId);
        const prevIndex =
          currentIndex === -1 ? 0 : Math.max(currentIndex - 1, 0);
        onSelect(getId(items[prevIndex]));
        return;
      }

      if (event.key === "Enter" && onActivate && selectedId !== null) {
        const selectedItem = items.find((item) => getId(item) === selectedId);
        if (selectedItem) {
          event.preventDefault();
          onActivate(selectedItem);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [options.enabled]);
}

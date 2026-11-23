/**
 * Web-first platform adapter.
 *
 * Command Engine App is browser-only: UI code that originated in the native
 * desktop shell routes every optional desktop capability through this module so
 * the same React tree runs unchanged at http://127.0.0.1:5179.
 */

export type DesktopWindowLabel = "main";

/** The browser build never runs inside a native shell. */
export function isDesktopShell(): boolean {
  return false;
}

export function getDesktopWindowLabel(): DesktopWindowLabel {
  return "main";
}

export function isWidgetWindow(): boolean {
  return false;
}

export function isSpotlightWindow(): boolean {
  return false;
}

export function getDesktopPlatform(): string {
  if (typeof navigator !== "undefined" && navigator.platform) {
    const p = navigator.platform.toLowerCase();
    if (p.includes("mac")) return "macos";
    if (p.includes("linux")) return "linux";
  }
  return "windows";
}

/**
 * Browser builds talk to the local FastAPI backend either through the Vite dev
 * proxy (empty base, same-origin) or through an explicit override injected on
 * `window` by a deployment wrapper.
 */
export function getApiBaseUrl(): string {
  if (
    typeof window !== "undefined" &&
    typeof window.__COMMAND_ENGINE_API_BASE__ === "string"
  ) {
    return window.__COMMAND_ENGINE_API_BASE__.replace(/\/$/, "");
  }
  return "";
}
export function getDesktopSessionToken(): string {
  if (
    typeof window !== "undefined" &&
    typeof window.__COMMAND_ENGINE_TOKEN__ === "string"
  ) {
    return window.__COMMAND_ENGINE_TOKEN__;
  }
  return "";
}

const noop = async (): Promise<null> => null;

/**
 * Desktop capability shim. Every method is a safe no-op in the browser so views
 * that opportunistically call into the shell degrade gracefully.
 */
export const desktopBridge = {
  isNativeDesktop: isDesktopShell,
  getPlatform: getDesktopPlatform,

  startDragging: async (_label: string = "main"): Promise<void> => undefined,
  minimizeWindow: async (): Promise<void> => undefined,
  toggleMaximizeWindow: async (): Promise<void> => undefined,
  isMaximized: async (): Promise<boolean> => false,
  syncWindowAppearance: async (_theme: "dark" | "light"): Promise<void> => undefined,
  closeOrHideToTray: async (_closeToTray = true): Promise<void> => undefined,

  setLaunchOnLogin: async (_enabled: boolean): Promise<boolean> => false,

  registerGlobalShortcut: async (
    _shortcut: string,
    _enabled: boolean
  ): Promise<{ ok: boolean; conflict?: string }> => ({ ok: false }),

  notify: async (title: string, body: string): Promise<boolean> => {
    if (
      typeof Notification !== "undefined" &&
      Notification.permission === "granted"
    ) {
      try {
        new Notification(title, { body });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  },

  toggleWidgetWindow: async (): Promise<boolean> => false,
  showWidgetWindow: async (): Promise<boolean> => false,
  hideWidgetWindow: async (): Promise<boolean> => false,
  isWidgetVisible: async (): Promise<boolean> => false,
  setWidgetPinned: async (_pinned: boolean): Promise<boolean> => false,

  toggleSpotlightWindow: async (): Promise<boolean> => false,
  showSpotlightWindow: async (): Promise<boolean> => false,
  hideSpotlightWindow: async (): Promise<boolean> => false,

  getOsContext: noop,
  startNativeCallCapture: noop,
  getNativeCallCaptureStatus: noop,
  stopNativeCallCapture: noop,
  openMainWindow: noop,

  copyText: async (text: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  },
};

declare global {
  interface Window {
    __COMMAND_ENGINE_DESKTOP__?: boolean;
    __COMMAND_ENGINE_PLATFORM__?: string;
    __COMMAND_ENGINE_TOKEN__?: string;
    __COMMAND_ENGINE_API_BASE__?: string;
  }
}

import { useEffect, useRef, useState } from "react";
import type { MissionEvent } from "../types/api";

export function useEventStream(onEvent?: (evt: MissionEvent) => void) {
  const [connected, setConnected] = useState(false);
  const [recentEvents, setRecentEvents] = useState<MissionEvent[]>([]);
  const lastCursorRef = useRef<number>(0);
  const callbackRef = useRef(onEvent);
  callbackRef.current = onEvent;

  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: number | null = null;
    let cancelled = false;
    let attempt = 0;

    const connect = () => {
      if (cancelled || document.visibilityState === "hidden") return;
      const envBase =
        (import.meta as { env?: { VITE_API_BASE_URL?: string } }).env?.VITE_API_BASE_URL ?? "";
      const base = envBase.replace(/\/+$/, "");
      const qs = new URLSearchParams({ cursor: String(lastCursorRef.current) });

      es = new EventSource(`${base}/api/stream?${qs.toString()}`);

      es.onopen = () => {
        attempt = 0;
        setConnected(true);
      };

      const handleRawMessage = (raw: MessageEvent) => {
        try {
          const parsed = JSON.parse(raw.data) as MissionEvent;
          if (typeof parsed.id === "number" && parsed.id > lastCursorRef.current) {
            lastCursorRef.current = parsed.id;
          }
          setRecentEvents((prev) => {
            if (prev.some((x) => x.id === parsed.id)) return prev;
            return [parsed, ...prev].slice(0, 35);
          });
          callbackRef.current?.(parsed);
        } catch {
          // Ignore malformed keepalive frames
        }
      };

      es.onmessage = handleRawMessage;
      const knownTypes = [
        "mission.started",
        "mission.completed",
        "mission.paused",
        "mission.resumed",
        "mission.cancelled",
        "mission.recovered_after_restart",
        "agent.handoff",
        "approval.staged",
        "approval.queued_undo",
        "approval.undone",
        "approval.executed",
        "approval.rejected",
        "approval.failed",
        "sweep.delta_completed",
        "meeting.live_captured",
        "system.paused",
        "system.resumed",
      ];
      for (const t of knownTypes) {
        es.addEventListener(t, handleRawMessage as EventListener);
      }

      es.onerror = () => {
        setConnected(false);
        es?.close();
        es = null;
        if (!cancelled) {
          attempt = Math.min(attempt + 1, 5);
          const delay = Math.min(15000, 1500 * Math.pow(1.7, attempt));
          reconnectTimer = window.setTimeout(connect, delay);
        }
      };
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible" && !es) {
        connect();
      } else if (document.visibilityState === "hidden" && es) {
        es.close();
        es = null;
        setConnected(false);
      }
    };

    connect();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      es?.close();
    };
  }, []);

  return { streamConnected: connected, recentStreamEvents: recentEvents };
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  Cpu,
  Copy,
  ExternalLink,
  FileText,
  Maximize2,
  Minimize2,
  Orbit,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { api } from "../lib/api";
import { stripMarkdownExcerpt } from "../lib/markdown";
import type {
  CognitiveGraphResponse,
  GraphifyTarget,
  GraphLink,
  GraphNode,
} from "../types/api";
import { AgentBot, TaskAgentPerch } from "../components/AgentBot";
import { EmptyState, ErrorBanner } from "../components/Badges";
import { MarkdownRenderer } from "../components/MarkdownRenderer";
import { useToast } from "../components/ToastContext";

export interface NeuralGraphViewProps {
  refreshSignal: number;
  onGraphUpdated?: () => void;
  embedded?: boolean;
  onWikilinkClick?: (slug: string) => void;
}

interface DomainPaletteEntry {
  darkHex: string;
  darkHalo: string;
  lightHex: string;
  lightHalo: string;
  cssColorVar: string;
  pillClass: string;
  label: string;
}

const DOMAIN_PALETTE: Record<string, DomainPaletteEntry> = {
  wiki: {
    darkHex: "#c099ff",
    darkHalo: "rgba(192, 153, 255, 0.38)",
    lightHex: "#6d35b5",
    lightHalo: "rgba(109, 53, 181, 0.24)",
    cssColorVar: "var(--violet)",
    pillClass: "ce-pill-violet",
    label: "Wiki",
  },
  engineering: {
    darkHex: "#7da6ff",
    darkHalo: "rgba(125, 166, 255, 0.38)",
    lightHex: "#2554c7",
    lightHalo: "rgba(37, 84, 199, 0.24)",
    cssColorVar: "var(--accent)",
    pillClass: "ce-pill-accent",
    label: "Engineering",
  },
  code: {
    darkHex: "#ff917d",
    darkHalo: "rgba(255, 145, 125, 0.38)",
    lightHex: "#c93b2b",
    lightHalo: "rgba(201, 59, 43, 0.24)",
    cssColorVar: "var(--coral)",
    pillClass: "ce-pill-coral",
    label: "Code",
  },
  tasks: {
    darkHex: "#6be3b4",
    darkHalo: "rgba(107, 227, 180, 0.38)",
    lightHex: "#0f7656",
    lightHalo: "rgba(15, 118, 86, 0.24)",
    cssColorVar: "var(--sage)",
    pillClass: "ce-pill-sage",
    label: "Tasks",
  },
  meetings: {
    darkHex: "#f5bf60",
    darkHalo: "rgba(245, 191, 96, 0.38)",
    lightHex: "#a15c07",
    lightHalo: "rgba(161, 92, 7, 0.24)",
    cssColorVar: "var(--amber)",
    pillClass: "ce-pill-amber",
    label: "Meetings",
  },
  comms: {
    darkHex: "#7da6ff",
    darkHalo: "rgba(125, 166, 255, 0.34)",
    lightHex: "#2554c7",
    lightHalo: "rgba(37, 84, 199, 0.22)",
    cssColorVar: "var(--accent)",
    pillClass: "ce-pill-accent",
    label: "Comms",
  },
};

const DEFAULT_DOMAIN_PALETTE: DomainPaletteEntry = {
  darkHex: "#7da6ff",
  darkHalo: "rgba(125, 166, 255, 0.34)",
  lightHex: "#2554c7",
  lightHalo: "rgba(37, 84, 199, 0.22)",
  cssColorVar: "var(--accent)",
  pillClass: "ce-pill-accent",
  label: "Node",
};

function getDomainPalette(domain?: string): DomainPaletteEntry {
  const key = (domain ?? "").toLowerCase();
  return DOMAIN_PALETTE[key] ?? DEFAULT_DOMAIN_PALETTE;
}

const BASE_GRAPHIFY_TARGETS: Array<{ value: GraphifyTarget; label: string }> = [
  { value: "command-engine", label: "command-engine" },
  { value: "vault", label: "vault" },
];

const ZOOM_MIN = 0.55;
const ZOOM_MAX = 2.25;

function classifyConfidence(
  conf: string | number | undefined
): "EXTRACTED" | "INFERRED" | "AMBIGUOUS" {
  if (typeof conf === "string") {
    const up = conf.toUpperCase();
    if (up.includes("AMBIGUOUS") || up.includes("WEAK")) return "AMBIGUOUS";
    if (up.includes("INFERRED") || up.includes("SEMANTIC")) return "INFERRED";
    return "EXTRACTED";
  }
  if (typeof conf === "number") {
    if (conf >= 0.85) return "EXTRACTED";
    if (conf >= 0.5) return "INFERRED";
    return "AMBIGUOUS";
  }
  return "EXTRACTED";
}

function resolveLinkEndpoint(endpoint: string | { id?: string } | unknown): string {
  if (typeof endpoint === "string") return endpoint;
  if (endpoint && typeof endpoint === "object" && "id" in endpoint) {
    return String((endpoint as { id?: string }).id ?? "");
  }
  return "";
}

function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

interface PositionedNode {
  node: GraphNode;
  x: number;
  y: number;
  z: number;
  radius: number;
  degree: number;
  palette: DomainPaletteEntry;
}

interface ProjectedNode extends PositionedNode {
  sx: number;
  sy: number;
  pz: number;
  scale: number;
  alpha: number;
}

interface DustParticle {
  x: number;
  y: number;
  z: number;
  size: number;
  alpha: number;
}

const DOMAIN_CENTERS: Record<string, [number, number, number]> = {
  wiki: [108, 92, 96],
  engineering: [-114, 78, 92],
  code: [-98, -104, 88],
  meetings: [116, -82, 92],
  tasks: [0, 128, -96],
  comms: [0, -128, -96],
};

function buildSpherePositions(
  nodes: GraphNode[],
  links: GraphLink[]
): Map<string, PositionedNode> {
  const map = new Map<string, PositionedNode>();
  const n = nodes.length;
  if (n === 0) return map;

  const degreeMap = new Map<string, number>();
  const adjEdges: Array<[number, number]> = [];
  const indexById = new Map<string, number>();

  const sorted = [...nodes].sort((a, b) => {
    const da = (a.domain ?? "").localeCompare(b.domain ?? "");
    if (da !== 0) return da;
    const ca = String(a.community ?? "").localeCompare(String(b.community ?? ""));
    if (ca !== 0) return ca;
    return a.id.localeCompare(b.id);
  });

  sorted.forEach((node, idx) => {
    indexById.set(node.id, idx);
  });

  for (const l of links) {
    const s = resolveLinkEndpoint(l.source);
    const t = resolveLinkEndpoint(l.target);
    degreeMap.set(s, (degreeMap.get(s) ?? 0) + 1);
    degreeMap.set(t, (degreeMap.get(t) ?? 0) + 1);
    const si = indexById.get(s);
    const ti = indexById.get(t);
    if (si !== undefined && ti !== undefined && si !== ti) {
      adjEdges.push([si, ti]);
    }
  }

  // Compute deterministic cluster centroids (domain anchor + community offset)
  const clusterGroups = new Map<string, number[]>();
  sorted.forEach((node, idx) => {
    const key = `${(node.domain ?? "other").toLowerCase()}::${String(node.community ?? "0")}`;
    const arr = clusterGroups.get(key);
    if (arr) arr.push(idx);
    else clusterGroups.set(key, [idx]);
  });

  const clusterCentroids = new Map<string, [number, number, number]>();
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const clusterKeys = Array.from(clusterGroups.keys()).sort();
  clusterKeys.forEach((key, cIdx) => {
    const domainKey = key.split("::")[0];
    const anchor = DOMAIN_CENTERS[domainKey];
    const h = hashString(key);
    const t = clusterKeys.length <= 1 ? 0 : 1 - (cIdx / (clusterKeys.length - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - t * t));
    const theta = goldenAngle * cIdx + (h % 360) * (Math.PI / 180) * 0.25;
    const rx = Math.cos(theta) * r * 145;
    const ry = t * 145;
    const rz = Math.sin(theta) * r * 145;
    if (anchor) {
      clusterCentroids.set(key, [
        anchor[0] * 0.65 + rx * 0.35,
        anchor[1] * 0.65 + ry * 0.35,
        anchor[2] * 0.65 + rz * 0.35,
      ]);
    } else {
      clusterCentroids.set(key, [rx, ry, rz]);
    }
  });

  // Deterministic initial positions around each community/domain centroid
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const pz = new Float64Array(n);
  const vx = new Float64Array(n);
  const vy = new Float64Array(n);
  const vz = new Float64Array(n);
  const cxArr = new Float64Array(n);
  const cyArr = new Float64Array(n);
  const czArr = new Float64Array(n);

  sorted.forEach((node, idx) => {
    const key = `${(node.domain ?? "other").toLowerCase()}::${String(node.community ?? "0")}`;
    const centroid = clusterCentroids.get(key) ?? [0, 0, 0];
    cxArr[idx] = centroid[0];
    cyArr[idx] = centroid[1];
    czArr[idx] = centroid[2];

    const h = hashString(node.id);
    const phi = ((h % 1000) / 1000) * Math.PI * 2;
    const costh = (((h >> 10) % 1000) / 500) - 1;
    const sinth = Math.sqrt(Math.max(0, 1 - costh * costh));
    const spread = 26 + ((h >> 20) % 34);

    px[idx] = centroid[0] + sinth * Math.cos(phi) * spread;
    py[idx] = centroid[1] + costh * spread;
    pz[idx] = centroid[2] + sinth * Math.sin(phi) * spread;
  });

  // Deterministic 3D force-relaxation (repulsion + link spring attraction + cluster centroids)
  const iterations = n > 220 ? 32 : 52;
  const repulsionK = n > 140 ? 1150 : 1550;
  const springK = 0.045;
  const restLen = 46;
  const centroidK = 0.032;
  const shellPullK = 0.008;
  const damping = 0.72;
  const stride = n > 240 ? 2 : 1;

  for (let iter = 0; iter < iterations; iter++) {
    // 1. Pairwise node repulsion
    for (let i = 0; i < n; i++) {
      for (let j = i + stride; j < n; j += stride) {
        const dx = px[i] - px[j];
        const dy = py[i] - py[j];
        const dz = pz[i] - pz[j];
        const distSq = dx * dx + dy * dy + dz * dz + 36;
        const dist = Math.sqrt(distSq);
        const force = (repulsionK * stride) / distSq;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        const fz = (dz / dist) * force;
        vx[i] += fx;
        vy[i] += fy;
        vz[i] += fz;
        vx[j] -= fx;
        vy[j] -= fy;
        vz[j] -= fz;
      }
    }

    // 2. Link spring attraction
    for (let e = 0; e < adjEdges.length; e++) {
      const [si, ti] = adjEdges[e];
      const dx = px[ti] - px[si];
      const dy = py[ti] - py[si];
      const dz = pz[ti] - pz[si];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const disp = dist - restLen;
      const force = disp * springK;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      const fz = (dz / dist) * force;
      vx[si] += fx;
      vy[si] += fy;
      vz[si] += fz;
      vx[ti] -= fx;
      vy[ti] -= fy;
      vz[ti] -= fz;
    }

    // 3. Community/domain centroid attraction + gentle origin containment
    for (let i = 0; i < n; i++) {
      vx[i] += (cxArr[i] - px[i]) * centroidK - px[i] * shellPullK;
      vy[i] += (cyArr[i] - py[i]) * centroidK - py[i] * shellPullK;
      vz[i] += (czArr[i] - pz[i]) * centroidK - pz[i] * shellPullK;

      vx[i] *= damping;
      vy[i] *= damping;
      vz[i] *= damping;

      px[i] += Math.max(-18, Math.min(18, vx[i]));
      py[i] += Math.max(-18, Math.min(18, vy[i]));
      pz[i] += Math.max(-18, Math.min(18, vz[i]));
    }
  }

  // Normalize overall bounding radius softly to ~205px so celestial rings frame the constellation
  let maxR = 1;
  for (let i = 0; i < n; i++) {
    const r = Math.hypot(px[i], py[i], pz[i]);
    if (r > maxR) maxR = r;
  }
  const normScale = maxR > 210 ? 205 / maxR : maxR < 140 ? 175 / maxR : 1;

  sorted.forEach((node, idx) => {
    const deg = degreeMap.get(node.id) ?? 0;
    const valWeight = Math.max(1, Number(node.val || 1));
    const radius = Math.min(
      13,
      Math.max(3.8, 3.3 + Math.sqrt(valWeight + deg * 0.72) * 1.32)
    );

    map.set(node.id, {
      node,
      x: px[idx] * normScale,
      y: py[idx] * normScale,
      z: pz[idx] * normScale,
      radius,
      degree: deg,
      palette: getDomainPalette(node.domain),
    });
  });

  return map;
}

function shortestAngleDelta(current: number, target: number): number {
  let diff = ((target - current + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}

export function NeuralGraphView({
  refreshSignal,
  onGraphUpdated,
  embedded = false,
  onWikilinkClick,
}: NeuralGraphViewProps) {
  const { pushToast } = useToast();
  const prefersReducedMotion = useReducedMotion();

  const [graph, setGraph] = useState<CognitiveGraphResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [domainFilter, setDomainFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [zoomPercent, setZoomPercent] = useState(100);

  // Graphify Runner state
  const [scanTarget, setScanTarget] = useState<GraphifyTarget>("command-engine");
  const [graphifyTargets, setGraphifyTargets] = useState<
    Array<{ value: GraphifyTarget; label: string }>
  >(BASE_GRAPHIFY_TARGETS);
  const [exportWiki, setExportWiki] = useState(true);
  const [runningScan, setRunningScan] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getProfiles()
      .then((res) => {
        if (cancelled) return;
        const repoKeys = Object.keys(res?.active?.core_repos ?? {});
        if (repoKeys.length > 0) {
          setGraphifyTargets([
            ...BASE_GRAPHIFY_TARGETS,
            ...repoKeys.map((rk) => ({ value: rk, label: rk })),
          ]);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [refreshSignal]);

  // Report modal & Canvas controls (respect prefers-reduced-motion on initial auto-spin)
  const [reportOpen, setReportOpen] = useState(false);
  const [autoOrbit, setAutoOrbit] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return true;
    }
    return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  const [expandedCanvas, setExpandedCanvas] = useState(false);

  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const searchWrapRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const projectedRef = useRef<ProjectedNode[]>([]);
  const pendingFlyNodeIdRef = useRef<string | null>(null);

  const cameraRef = useRef({
    yaw: 0.45,
    pitch: 0.22,
    zoom: 1.0,
    panX: 0,
    panY: 0,
    velYaw: 0,
    velPitch: 0,
    targetRotX: null as number | null,
    targetRotY: null as number | null,
    targetPanX: null as number | null,
    targetPanY: null as number | null,
    dragging: false,
    dragMode: "orbit" as "orbit" | "pan",
    downX: 0,
    downY: 0,
    maxTravel: 0,
    lastX: 0,
    lastY: 0,
  });

  const dustRef = useRef<DustParticle[]>(
    Array.from({ length: 110 }, (_, i) => {
      const h1 = hashString(`dust-x-${i}`);
      const h2 = hashString(`dust-y-${i}`);
      const h3 = hashString(`dust-z-${i}`);
      return {
        x: ((h1 % 1000) / 500 - 1) * 420,
        y: ((h2 % 1000) / 500 - 1) * 420,
        z: ((h3 % 1000) / 500 - 1) * 420,
        size: (h1 % 3) * 0.5 + 0.55,
        alpha: ((h2 % 55) + 16) / 100,
      };
    })
  );

  // Sync reduced-motion preference dynamically
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (ev: MediaQueryListEvent) => {
      if (ev.matches) setAutoOrbit(false);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Close search dropdown on outside click
  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (searchWrapRef.current && !searchWrapRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
      }
    };
    window.addEventListener("mousedown", handleOutside);
    return () => window.removeEventListener("mousedown", handleOutside);
  }, []);

  // '/' shortcut focuses the floating graph search bar
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const el = document.activeElement;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          (el instanceof HTMLElement && el.isContentEditable))
      ) {
        return;
      }
      e.preventDefault();
      setSearchOpen(true);
      searchInputRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Escape handler for GRAPH_REPORT.md drawer
  useEffect(() => {
    if (!reportOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setReportOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [reportOpen]);

  const loadGraph = useCallback(async () => {
    setLoading(true);
    setGraphError(null);
    try {
      const res = await api.getCognitiveGraph();
      setGraph(res);
      setSelectedNodeId((prev) => {
        if (prev && res.nodes.some((n) => n.id === prev)) return prev;
        return res.god_nodes[0]?.id ?? res.nodes[0]?.id ?? null;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setGraphError(msg);
      pushToast(
        "error",
        "Failed to load 3D Knowledge Multisphere",
        msg
      );
    } finally {
      setLoading(false);
    }
  }, [pushToast]);

  useEffect(() => {
    void loadGraph();
  }, [loadGraph, refreshSignal]);

  const domains = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of graph?.nodes ?? []) {
      const d = (n.domain || "other").toLowerCase();
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [graph]);

  const godNodeIds = useMemo(
    () => new Set((graph?.god_nodes ?? []).map((gn) => gn.id)),
    [graph]
  );

  const filteredNodes = useMemo(() => {
    if (!graph) return [];
    const q = searchQuery.trim().toLowerCase();
    return graph.nodes.filter((n) => {
      const matchDomain =
        domainFilter === "all" || (n.domain || "other").toLowerCase() === domainFilter;
      const matchSearch =
        !q ||
        n.label.toLowerCase().includes(q) ||
        n.id.toLowerCase().includes(q) ||
        (n.kind || "").toLowerCase().includes(q);
      return matchDomain && matchSearch;
    });
  }, [graph, domainFilter, searchQuery]);

  const filteredNodeIdSet = useMemo(
    () => new Set(filteredNodes.map((n) => n.id)),
    [filteredNodes]
  );

  const filteredLinks = useMemo(() => {
    if (!graph) return [];
    return graph.links.filter((l) => {
      const s = resolveLinkEndpoint(l.source);
      const t = resolveLinkEndpoint(l.target);
      return filteredNodeIdSet.has(s) && filteredNodeIdSet.has(t);
    });
  }, [graph, filteredNodeIdSet]);

  const positionedMap = useMemo(
    () => buildSpherePositions(filteredNodes, filteredLinks),
    [filteredNodes, filteredLinks]
  );

  const selectedNode = useMemo(
    () => graph?.nodes.find((n) => n.id === selectedNodeId) ?? null,
    [graph, selectedNodeId]
  );

  const hoveredNode = useMemo(
    () => graph?.nodes.find((n) => n.id === hoveredNodeId) ?? null,
    [graph, hoveredNodeId]
  );

  const selectedNeighbors = useMemo(() => {
    if (!selectedNodeId || !graph) return [];
    const neighbors: Array<{ node: GraphNode; relation: string; confidence: string }> = [];
    const nodeLookup = new Map(graph.nodes.map((n) => [n.id, n]));
    for (const l of graph.links) {
      const s = resolveLinkEndpoint(l.source);
      const t = resolveLinkEndpoint(l.target);
      if (s === selectedNodeId && nodeLookup.has(t)) {
        neighbors.push({
          node: nodeLookup.get(t)!,
          relation: l.relation,
          confidence: classifyConfidence(l.confidence),
        });
      } else if (t === selectedNodeId && nodeLookup.has(s)) {
        neighbors.push({
          node: nodeLookup.get(s)!,
          relation: l.relation,
          confidence: classifyConfidence(l.confidence),
        });
      }
    }
    return neighbors.slice(0, 18);
  }, [selectedNodeId, graph]);

  const stateRef = useRef({
    positionedMap,
    filteredLinks,
    selectedNodeId,
    hoveredNodeId,
    autoOrbit,
    godNodeIds,
    prefersReducedMotion: Boolean(prefersReducedMotion),
  });
  stateRef.current = {
    positionedMap,
    filteredLinks,
    selectedNodeId,
    hoveredNodeId,
    autoOrbit,
    godNodeIds,
    prefersReducedMotion: Boolean(prefersReducedMotion),
  };

  const flyCameraToPositioned = useCallback((pos: PositionedNode) => {
    const cam = cameraRef.current;
    const rXZ = Math.hypot(pos.x, pos.z);
    const targetYaw = Math.atan2(pos.x, pos.z);
    const targetPitch = Math.max(-1.35, Math.min(1.35, Math.atan2(pos.y, rXZ)));
    cam.targetRotY = targetYaw;
    cam.targetRotX = targetPitch;
    cam.targetPanX = 0;
    cam.targetPanY = 0;
    cam.velYaw = 0;
    cam.velPitch = 0;
  }, []);

  const selectAndFlyToNode = useCallback(
    (nodeId: string) => {
      setSelectedNodeId(nodeId);
      const pos = positionedMap.get(nodeId);
      if (pos) {
        flyCameraToPositioned(pos);
        return;
      }
      // If node was hidden by active domain/search filters, reveal it and fly on next commit
      if (graph?.nodes.some((n) => n.id === nodeId)) {
        pendingFlyNodeIdRef.current = nodeId;
        setDomainFilter("all");
        setSearchQuery("");
      }
    },
    [flyCameraToPositioned, graph, positionedMap]
  );

  useEffect(() => {
    const pendingId = pendingFlyNodeIdRef.current;
    if (!pendingId) return;
    const pos = positionedMap.get(pendingId);
    if (pos) {
      pendingFlyNodeIdRef.current = null;
      flyCameraToPositioned(pos);
    }
  }, [positionedMap, flyCameraToPositioned]);

  // Theme-Adaptive 3D Constellation Multisphere RAF Loop (Always-Mounted Canvas)
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = canvasWrapRef.current;
    if (!canvas || !wrap) return;

    let rawWidth = wrap.clientWidth;
    let rawHeight = wrap.clientHeight;
    let width = Math.max(300, rawWidth);
    let height = Math.max(380, rawHeight);
    let lastDpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      if (!canvas || !wrap) return;
      rawWidth = wrap.clientWidth;
      rawHeight = wrap.clientHeight;
      width = Math.max(300, rawWidth);
      height = Math.max(380, rawHeight);
      lastDpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(width * lastDpr);
      canvas.height = Math.floor(height * lastDpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(wrap);

    let rafId = 0;
    let isMounted = true;

    const render = (now: number) => {
      if (!isMounted || document.hidden) {
        rafId = 0;
        return;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        rafId = window.requestAnimationFrame(render);
        return;
      }

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (
        width <= 0 ||
        height <= 0 ||
        wrap.clientWidth !== rawWidth ||
        wrap.clientHeight !== rawHeight ||
        dpr !== lastDpr
      ) {
        resize();
      }

      const isLight = document.documentElement.dataset.theme === "light";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const cam = cameraRef.current;
      const {
        positionedMap: posMap,
        filteredLinks: links,
        selectedNodeId: selId,
        hoveredNodeId: hovId,
        autoOrbit: orbitOn,
        godNodeIds: godSet,
        prefersReducedMotion: reducedMotion,
      } = stateRef.current;

      if (!cam.dragging) {
        const ease = reducedMotion ? 0.28 : 0.1;
        if (cam.targetRotX !== null && cam.targetRotY !== null) {
          const dYaw = shortestAngleDelta(cam.yaw, cam.targetRotY);
          const dPitch = cam.targetRotX - cam.pitch;
          cam.yaw += dYaw * ease;
          cam.pitch += dPitch * ease;
          if (Math.abs(dYaw) < 0.004 && Math.abs(dPitch) < 0.004) {
            cam.yaw = cam.targetRotY;
            cam.pitch = cam.targetRotX;
            cam.targetRotX = null;
            cam.targetRotY = null;
          }
        } else {
          if (orbitOn) {
            cam.yaw += 0.0022;
          }
          cam.yaw += cam.velYaw;
          cam.pitch += cam.velPitch;
          cam.velYaw *= 0.92;
          cam.velPitch *= 0.92;
        }
        if (cam.targetPanX !== null && cam.targetPanY !== null) {
          const dPanX = cam.targetPanX - cam.panX;
          const dPanY = cam.targetPanY - cam.panY;
          cam.panX += dPanX * ease;
          cam.panY += dPanY * ease;
          if (Math.abs(dPanX) < 0.4 && Math.abs(dPanY) < 0.4) {
            cam.panX = cam.targetPanX;
            cam.panY = cam.targetPanY;
            cam.targetPanX = null;
            cam.targetPanY = null;
          }
        }
        cam.pitch = Math.max(-1.35, Math.min(1.35, cam.pitch));
      }

      // 1. Studio Alabaster (#efede6) / Obsidian Carbon (#08080d) Background + Core Nebula
      ctx.fillStyle = isLight ? "#efede6" : "#08080d";
      ctx.fillRect(0, 0, width, height);

      const cx = width * 0.5 + cam.panX;
      const cy = height * 0.5 + cam.panY;
      const minDim = Math.min(width, height);
      const timeSec = now * 0.001;

      if (isLight) {
        // Warm Alabaster core luminescence + subtle sapphire central depth
        const coreNebula = ctx.createRadialGradient(cx, cy, 8, cx, cy, minDim * 0.44);
        coreNebula.addColorStop(0, "rgba(255, 255, 255, 0.78)");
        coreNebula.addColorStop(0.45, "rgba(37, 84, 199, 0.055)");
        coreNebula.addColorStop(0.78, "rgba(109, 53, 181, 0.03)");
        coreNebula.addColorStop(1, "rgba(239, 237, 230, 0)");
        ctx.fillStyle = coreNebula;
        ctx.fillRect(0, 0, width, height);
      } else {
        // Volumetric Obsidian core nebula + dual chromatic halo
        const coreNebula = ctx.createRadialGradient(cx, cy, 8, cx, cy, minDim * 0.46);
        coreNebula.addColorStop(0, "rgba(125, 166, 255, 0.14)");
        coreNebula.addColorStop(0.42, "rgba(192, 153, 255, 0.07)");
        coreNebula.addColorStop(0.76, "rgba(107, 227, 180, 0.025)");
        coreNebula.addColorStop(1, "rgba(8, 8, 13, 0)");
        ctx.fillStyle = coreNebula;
        ctx.fillRect(0, 0, width, height);

        const atmoLeft = ctx.createRadialGradient(
          cx - width * 0.18,
          cy + height * 0.12,
          10,
          cx - width * 0.18,
          cy + height * 0.12,
          minDim * 0.58
        );
        atmoLeft.addColorStop(0, "rgba(192, 153, 255, 0.055)");
        atmoLeft.addColorStop(1, "rgba(8, 8, 13, 0)");
        ctx.fillStyle = atmoLeft;
        ctx.fillRect(0, 0, width, height);
      }

      const cosY = Math.cos(cam.yaw);
      const sinY = Math.sin(cam.yaw);
      const cosP = Math.cos(cam.pitch);
      const sinP = Math.sin(cam.pitch);
      const fov = 560 * cam.zoom;
      const dist = 480;

      const project = (x: number, y: number, z: number) => {
        const x1 = x * cosY - z * sinY;
        const z1 = x * sinY + z * cosY;
        const y2 = y * cosP - z1 * sinP;
        const z2 = y * sinP + z1 * cosP;
        const denom = Math.max(85, dist - z2);
        const scale = fov / denom;
        return {
          sx: cx + x1 * scale,
          sy: cy + y2 * scale,
          pz: z2,
          scale,
        };
      };

      // 2. Ambient Celestial Motes / Archival Grain
      for (const s of dustRef.current) {
        const p = project(s.x, s.y, s.z);
        if (p.pz < -360) continue;
        ctx.fillStyle = isLight
          ? `rgba(52, 51, 62, ${s.alpha * 0.2})`
          : `rgba(244, 244, 247, ${s.alpha * 0.34})`;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, s.size, 0, Math.PI * 2);
        ctx.fill();
      }

      // 3. Two Delicate Tilted 3D Orbital Rings (Equatorial + Meridian Astrolabe)
      const ringRadius = 216;
      const drawOrbitalRing = (
        tiltX: number,
        tiltZ: number,
        stroke: string,
        dashed = false
      ) => {
        ctx.save();
        ctx.strokeStyle = stroke;
        ctx.lineWidth = isLight ? 1.05 : 0.95;
        if (dashed) ctx.setLineDash([4, 6]);
        ctx.beginPath();
        const steps = 72;
        for (let i = 0; i <= steps; i++) {
          const a = (i / steps) * Math.PI * 2;
          let rx = Math.cos(a) * ringRadius;
          let ry = Math.sin(a) * ringRadius * Math.sin(tiltX);
          const rz = Math.sin(a) * ringRadius * Math.cos(tiltX);
          if (tiltZ !== 0) {
            const nx = rx * Math.cos(tiltZ) - ry * Math.sin(tiltZ);
            const ny = rx * Math.sin(tiltZ) + ry * Math.cos(tiltZ);
            rx = nx;
            ry = ny;
          }
          const p = project(rx, ry, rz);
          if (i === 0) ctx.moveTo(p.sx, p.sy);
          else ctx.lineTo(p.sx, p.sy);
        }
        ctx.stroke();
        ctx.restore();
      };

      if (isLight) {
        // Equatorial & Meridian rings tuned for Studio Alabaster
        drawOrbitalRing(0.24, 0.14, "rgba(37, 84, 199, 0.22)");
        drawOrbitalRing(1.32, -0.52, "rgba(109, 53, 181, 0.16)", true);
      } else {
        // Equatorial & Meridian rings tuned for Obsidian Carbon
        drawOrbitalRing(0.24, 0.14, "rgba(125, 166, 255, 0.16)");
        drawOrbitalRing(1.32, -0.52, "rgba(192, 153, 255, 0.12)", true);
      }

      // 4. Project all nodes
      const projectedList: ProjectedNode[] = [];
      const projectedMap = new Map<string, ProjectedNode>();

      for (const item of posMap.values()) {
        const p = project(item.x, item.y, item.z);
        const depthAlpha = Math.max(0.22, Math.min(1, (p.pz + 230) / 420));
        const proj: ProjectedNode = {
          ...item,
          sx: p.sx,
          sy: p.sy,
          pz: p.pz,
          scale: p.scale,
          alpha: depthAlpha,
        };
        projectedList.push(proj);
        projectedMap.set(item.node.id, proj);
      }

      const focusId = hovId ?? selId;
      const connectedToFocus = new Set<string>();
      if (focusId) {
        connectedToFocus.add(focusId);
        for (const l of links) {
          const s = resolveLinkEndpoint(l.source);
          const t = resolveLinkEndpoint(l.target);
          if (s === focusId) connectedToFocus.add(t);
          if (t === focusId) connectedToFocus.add(s);
        }
      }

      // 5. Draw Edges + Traveling Photon Pulses
      for (let edgeIdx = 0; edgeIdx < links.length; edgeIdx++) {
        const l = links[edgeIdx];
        const sId = resolveLinkEndpoint(l.source);
        const tId = resolveLinkEndpoint(l.target);
        const ps = projectedMap.get(sId);
        const pt = projectedMap.get(tId);
        if (!ps || !pt) continue;

        const isFocusedEdge = Boolean(focusId && (sId === focusId || tId === focusId));
        const dimByFocus = Boolean(focusId && !isFocusedEdge);
        const conf = classifyConfidence(l.confidence);
        const avgAlpha = Math.min(ps.alpha, pt.alpha);

        const midX = (ps.sx + pt.sx) * 0.5;
        const midY = (ps.sy + pt.sy) * 0.5;
        const ctrlX = midX + (cx - midX) * 0.15;
        const ctrlY = midY + (cy - midY) * 0.15;

        ctx.save();
        if (conf === "INFERRED") {
          ctx.setLineDash([4, 4]);
        } else if (conf === "AMBIGUOUS") {
          ctx.setLineDash([2, 4]);
        }

        const baseOpacity = isFocusedEdge
          ? 0.88
          : dimByFocus
          ? 0.08
          : conf === "EXTRACTED"
          ? 0.38
          : conf === "INFERRED"
          ? 0.26
          : 0.24;

        const alpha = Math.max(0.04, baseOpacity * (isFocusedEdge ? 1 : avgAlpha));
        const sourceHex = isLight ? ps.palette.lightHex : ps.palette.darkHex;

        if (isFocusedEdge) {
          ctx.strokeStyle =
            conf === "AMBIGUOUS"
              ? isLight
                ? "#a15c07"
                : "#f5bf60"
              : sourceHex;
          ctx.globalAlpha = alpha;
          ctx.lineWidth = conf === "EXTRACTED" ? 1.8 : 1.35;
        } else {
          ctx.strokeStyle = isLight
            ? conf === "AMBIGUOUS"
              ? `rgba(161, 92, 7, ${alpha})`
              : conf === "INFERRED"
              ? `rgba(109, 53, 181, ${alpha})`
              : `rgba(52, 51, 62, ${alpha})`
            : conf === "AMBIGUOUS"
            ? `rgba(245, 191, 96, ${alpha})`
            : conf === "INFERRED"
            ? `rgba(192, 153, 255, ${alpha})`
            : `rgba(168, 166, 182, ${alpha})`;
          ctx.lineWidth = conf === "EXTRACTED" ? 1.0 : 0.82;
        }

        ctx.beginPath();
        ctx.moveTo(ps.sx, ps.sy);
        ctx.quadraticCurveTo(ctrlX, ctrlY, pt.sx, pt.sy);
        ctx.stroke();

        // Traveling Edge Photon Pulses (EXTRACTED edges, focused edges, + ~18% sample of visible links)
        const sample18 = (edgeIdx * 19) % 100 < 18;
        const shouldPulse =
          !reducedMotion &&
          (isFocusedEdge ||
            (!dimByFocus && conf === "EXTRACTED" && (links.length <= 240 || sample18)) ||
            (!dimByFocus && sample18));

        if (shouldPulse) {
          const speed = isFocusedEdge ? 0.44 : conf === "EXTRACTED" ? 0.28 : 0.21;
          const t = (timeSec * speed + edgeIdx * 0.19) % 1;
          const inv = 1 - t;
          const px = inv * inv * ps.sx + 2 * inv * t * ctrlX + t * t * pt.sx;
          const py = inv * inv * ps.sy + 2 * inv * t * ctrlY + t * t * pt.sy;

          ctx.setLineDash([]);
          const pulseAlpha = isFocusedEdge ? 0.95 : Math.max(0.32, avgAlpha * 0.78);
          // Outer photon halo
          ctx.fillStyle = sourceHex;
          ctx.globalAlpha = pulseAlpha * 0.34;
          ctx.beginPath();
          ctx.arc(px, py, isFocusedEdge ? 4.4 : 3.2, 0, Math.PI * 2);
          ctx.fill();

          // Luminous photon core
          ctx.fillStyle = isLight ? sourceHex : "#f8f8fc";
          ctx.globalAlpha = pulseAlpha;
          ctx.beginPath();
          ctx.arc(px, py, isFocusedEdge ? 1.9 : 1.35, 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.restore();
      }

      // 6. Sort Nodes back-to-front
      projectedList.sort((a, b) => a.pz - b.pz);
      projectedRef.current = projectedList;

      // 7. Draw Nodes back-to-front (spheres, halos, and rings)
      interface LabelCandidate {
        pn: ProjectedNode;
        drawR: number;
        hex: string;
        isSelected: boolean;
        isHovered: boolean;
        nodeAlpha: number;
        priority: number;
      }
      const labelCandidates: LabelCandidate[] = [];

      for (const pn of projectedList) {
        const isSelected = pn.node.id === selId;
        const isHovered = pn.node.id === hovId;
        const isGod = godSet.has(pn.node.id);
        const isNeighbor = focusId ? connectedToFocus.has(pn.node.id) : false;
        const dimmed = Boolean(focusId && !isNeighbor);

        const drawR = Math.max(
          2.5,
          pn.radius * Math.min(1.45, Math.max(0.56, pn.scale * 0.86))
        );
        const nodeAlpha = dimmed ? pn.alpha * 0.26 : pn.alpha;
        const hex = isLight ? pn.palette.lightHex : pn.palette.darkHex;
        const halo = isLight ? pn.palette.lightHalo : pn.palette.darkHalo;

        ctx.save();
        ctx.globalAlpha = nodeAlpha;

        // Soft radial aura
        const haloRadius = drawR * (isSelected || isHovered ? 3.2 : 2.15);
        const grad = ctx.createRadialGradient(
          pn.sx,
          pn.sy,
          drawR * 0.2,
          pn.sx,
          pn.sy,
          haloRadius
        );
        grad.addColorStop(0, halo);
        grad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(pn.sx, pn.sy, haloRadius, 0, Math.PI * 2);
        ctx.fill();

        // Core jewel sphere
        ctx.fillStyle = hex;
        ctx.beginPath();
        ctx.arc(pn.sx, pn.sy, drawR, 0, Math.PI * 2);
        ctx.fill();

        // Crisp rim in Light mode so jewel nodes stay razor-sharp against #efede6
        if (isLight) {
          ctx.strokeStyle = "rgba(17, 17, 22, 0.2)";
          ctx.lineWidth = 0.75;
          ctx.stroke();
        }

        // Specular core dot
        ctx.fillStyle = isLight ? "rgba(255, 255, 255, 0.9)" : "rgba(255, 255, 255, 0.88)";
        ctx.beginPath();
        ctx.arc(
          pn.sx - drawR * 0.24,
          pn.sy - drawR * 0.24,
          Math.max(0.9, drawR * 0.27),
          0,
          Math.PI * 2
        );
        ctx.fill();

        // God-node orbital ring
        if (isGod && !isSelected && !isHovered) {
          ctx.strokeStyle = hex;
          ctx.lineWidth = 1.05;
          ctx.globalAlpha = nodeAlpha * 0.72;
          ctx.beginPath();
          ctx.arc(pn.sx, pn.sy, drawR + 3.4, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = nodeAlpha;
        }

        // Selection / hover ring
        if (isSelected || isHovered) {
          ctx.strokeStyle = isSelected ? (isLight ? "#111116" : "#f4f4f7") : hex;
          ctx.lineWidth = isSelected ? 1.85 : 1.4;
          ctx.beginPath();
          ctx.arc(pn.sx, pn.sy, drawR + 4.8, 0, Math.PI * 2);
          ctx.stroke();
        }

        ctx.restore();

        const showLabel =
          isSelected ||
          isHovered ||
          (focusId && isNeighbor && pn.pz > -85) ||
          (!focusId && pn.pz > 35 && (pn.degree >= 2 || pn.radius >= 5.5 || isGod));

        if (showLabel) {
          const priority =
            (isSelected ? 100000 : 0) +
            (isHovered ? 50000 : 0) +
            (isGod ? 5000 : 0) +
            (isNeighbor ? 1200 : 0) +
            pn.degree * 40 +
            pn.pz * 0.2;
          labelCandidates.push({
            pn,
            drawR,
            hex,
            isSelected,
            isHovered,
            nodeAlpha,
            priority,
          });
        }
      }

      // 8. Second Pass: 2D Screen-Space AABB Collision Culling for Pill Labels
      labelCandidates.sort((a, b) => b.priority - a.priority);
      const placedBoxes: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
      const padMargin = 4;

      for (const cand of labelCandidates) {
        const { pn, drawR, hex, isSelected, isHovered, nodeAlpha } = cand;
        const text =
          pn.node.label.length > 26
            ? `${pn.node.label.slice(0, 24)}…`
            : pn.node.label;
        ctx.font =
          isSelected || isHovered
            ? "600 11px Inter, -apple-system, sans-serif"
            : "500 10.5px Inter, -apple-system, sans-serif";
        const tw = ctx.measureText(text).width;
        const lx = pn.sx + drawR + 8;
        const ly = pn.sy + 3.5;
        const boxX = lx - 5.5;
        const boxY = ly - 11;
        const boxW = tw + 11;
        const boxH = 16;

        // Skip labels clipped outside canvas bounds unless selected/hovered
        if (
          !isSelected &&
          !isHovered &&
          (boxX < 6 || boxX + boxW > width - 6 || boxY < 6 || boxY + boxH > height - 6)
        ) {
          continue;
        }

        const candRect = {
          x1: boxX - padMargin,
          y1: boxY - padMargin,
          x2: boxX + boxW + padMargin,
          y2: boxY + boxH + padMargin,
        };

        let overlaps = false;
        if (!isSelected && !isHovered) {
          for (const placed of placedBoxes) {
            if (
              candRect.x1 < placed.x2 &&
              candRect.x2 > placed.x1 &&
              candRect.y1 < placed.y2 &&
              candRect.y2 > placed.y1
            ) {
              overlaps = true;
              break;
            }
          }
        }
        if (overlaps) continue;

        placedBoxes.push({
          x1: boxX,
          y1: boxY,
          x2: boxX + boxW,
          y2: boxY + boxH,
        });

        ctx.save();
        ctx.globalAlpha = isSelected || isHovered ? 1 : Math.max(0.5, nodeAlpha);
        ctx.fillStyle = isLight ? "rgba(255, 255, 255, 0.94)" : "rgba(17, 17, 23, 0.9)";
        ctx.strokeStyle =
          isSelected || isHovered
            ? hex
            : isLight
            ? "#d2cec4"
            : "#2a2a38";
        ctx.lineWidth = isSelected || isHovered ? 1.2 : 1;
        ctx.beginPath();
        ctx.roundRect(boxX, boxY, boxW, boxH, 5);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle =
          isSelected || isHovered
            ? isLight
              ? "#111116"
              : "#f4f4f7"
            : isLight
            ? "#34333e"
            : "#c9c8d4";
        ctx.fillText(text, lx, ly);
        ctx.restore();
      }

      if (isMounted && !document.hidden) {
        rafId = window.requestAnimationFrame(render);
      } else {
        rafId = 0;
      }
    };

    const handleVisibilityChange = () => {
      if (!isMounted) return;
      if (document.hidden) {
        if (rafId) {
          window.cancelAnimationFrame(rafId);
          rafId = 0;
        }
      } else if (!rafId) {
        rafId = window.requestAnimationFrame(render);
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    if (!document.hidden) {
      rafId = window.requestAnimationFrame(render);
    }

    return () => {
      isMounted = false;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (rafId) window.cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, []);

  const hitTestNode = (clientX: number, clientY: number): ProjectedNode | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    const list = projectedRef.current;
    let bestNode: ProjectedNode | null = null;
    let bestDist = 24;

    // Iterate front-to-back so closer nodes take priority within hit tolerance
    for (let i = list.length - 1; i >= 0; i--) {
      const pn = list[i];
      const drawR = Math.max(
        2.5,
        pn.radius * Math.min(1.45, Math.max(0.56, pn.scale * 0.86))
      );
      const hitLimit = Math.max(12, Math.min(24, drawR + 8));
      const dist = Math.hypot(x - pn.sx, y - pn.sy);
      if (dist <= hitLimit && dist < bestDist) {
        bestDist = dist;
        bestNode = pn;
        if (dist <= drawR + 2) break;
      }
    }
    return bestNode;
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cam = cameraRef.current;
    const isPan = e.button === 2 || e.shiftKey;
    cam.dragging = true;
    cam.dragMode = isPan ? "pan" : "orbit";
    cam.targetRotX = null;
    cam.targetRotY = null;
    if (isPan) {
      cam.targetPanX = null;
      cam.targetPanY = null;
    }
    cam.downX = e.clientX;
    cam.downY = e.clientY;
    cam.maxTravel = 0;
    cam.lastX = e.clientX;
    cam.lastY = e.clientY;
    cam.velYaw = 0;
    cam.velPitch = 0;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cam = cameraRef.current;
    if (cam.dragging) {
      const dx = e.clientX - cam.lastX;
      const dy = e.clientY - cam.lastY;
      const totalTravel = Math.hypot(e.clientX - cam.downX, e.clientY - cam.downY);
      if (totalTravel > cam.maxTravel) {
        cam.maxTravel = totalTravel;
      }
      if (cam.dragMode === "pan") {
        cam.panX = Math.max(-420, Math.min(420, cam.panX + dx));
        cam.panY = Math.max(-320, Math.min(320, cam.panY + dy));
      } else {
        cam.yaw += dx * 0.0065;
        cam.pitch = Math.max(-1.35, Math.min(1.35, cam.pitch + dy * 0.0065));
        cam.velYaw = dx * 0.0022;
        cam.velPitch = dy * 0.0022;
      }
      cam.lastX = e.clientX;
      cam.lastY = e.clientY;
      return;
    }

    const hit = hitTestNode(e.clientX, e.clientY);
    setHoveredNodeId(hit ? hit.node.id : null);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cam = cameraRef.current;
    const wasClick = cam.maxTravel < 5 && e.button === 0;
    cam.dragging = false;
    cam.dragMode = "orbit";
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore if already released
    }
    if (wasClick) {
      const hit = hitTestNode(e.clientX, e.clientY);
      if (hit) {
        selectAndFlyToNode(hit.node.id);
      }
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const cam = cameraRef.current;
    const delta = e.deltaY > 0 ? -0.09 : 0.09;
    cam.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, cam.zoom + delta));
    setZoomPercent(Math.round(cam.zoom * 100));
  };

  const adjustZoom = (delta: number) => {
    const cam = cameraRef.current;
    cam.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, cam.zoom + delta));
    setZoomPercent(Math.round(cam.zoom * 100));
  };

  const resetCamera = () => {
    const cam = cameraRef.current;
    cam.targetRotY = 0.45;
    cam.targetRotX = 0.22;
    cam.targetPanX = 0;
    cam.targetPanY = 0;
    cam.zoom = 1.0;
    cam.velYaw = 0;
    cam.velPitch = 0;
    setZoomPercent(100);
  };

  const handleRunGraphify = async () => {
    if (runningScan) return;
    setRunningScan(true);
    try {
      await api.runGraphify({ target: scanTarget, export_wiki: exportWiki });
      pushToast(
        "success",
        `Graphify AST scan completed (${scanTarget})`,
        exportWiki
          ? "Nodes, edges, and Knowledge Vault exports refreshed."
          : "Knowledge multisphere refreshed."
      );
      await loadGraph();
      onGraphUpdated?.();
    } catch (err) {
      pushToast(
        "error",
        "Graphify scan failed",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setRunningScan(false);
    }
  };

  const searchMatches = useMemo(() => {
    if (!searchQuery.trim()) return [];
    return filteredNodes.slice(0, 6);
  }, [filteredNodes, searchQuery]);

  const isEmptyGraph = !loading && (!graph || graph.nodes.length === 0);

  const selectedVaultTarget = useMemo(() => {
    if (!selectedNode) return null;
    if (selectedNode.url && selectedNode.url.startsWith("vault://")) {
      return selectedNode.url.replace(/^vault:\/\//i, "");
    }
    if (selectedNode.domain?.toLowerCase() === "wiki" && !selectedNode.url) {
      return selectedNode.id.replace(/^wiki[:/]/i, "") || selectedNode.label;
    }
    return null;
  }, [selectedNode]);

  return (
    <div className={embedded ? "flex h-full min-h-0 flex-col gap-3" : "space-y-4"}>
      {/* Header (Standalone) OR Unified Compact Controls (Embedded) */}
      {!embedded ? (
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[var(--line)] pb-4">
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <p className="font-mono text-[10.5px] tracking-[0.22em] text-[var(--muted)] uppercase">
                TOPOLOGY &amp; AST
              </p>
              <h1 className="mt-1.5 text-[clamp(1.5rem,2.3vw,2.05rem)] leading-[1.1] tracking-[-0.025em] text-[var(--ink)]">
                <span className="font-semibold">Knowledge</span>{" "}
                <span className="font-editorial font-normal italic text-[var(--ink-secondary)]">
                  multisphere.
                </span>
              </h1>
              <div className="mt-2 flex flex-wrap items-center divide-x divide-[var(--line)] text-xs text-[var(--muted)] tabular-nums">
                <span className="pr-3">Nodes {graph?.nodes.length ?? 0}</span>
                <span className="px-3">Edges {graph?.links.length ?? 0}</span>
                <span className="px-3">God Nodes {graph?.god_nodes.length ?? 0}</span>
                <span className="pl-3">
                  Bridges {graph?.surprising_connections.length ?? 0}
                </span>
              </div>
            </div>

            <TaskAgentPerch
              state={runningScan ? "working" : "scouting"}
              agentName="Graphify"
              statusText={
                runningScan
                  ? "Scanning AST & Leiden…"
                  : `${graph?.nodes.length ?? 0} nodes live`
              }
              compact
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={scanTarget}
              onChange={(e) => setScanTarget(e.target.value as GraphifyTarget)}
              aria-label="Graphify scan target"
              className="ce-input h-[34px] w-auto py-0 font-mono text-xs"
            >
              {graphifyTargets.map((t) => (
                <option key={t.value} value={t.value}>
                  target: {t.label}
                </option>
              ))}
            </select>

            <label className="ce-btn ce-btn-ghost cursor-pointer select-none">
              <input
                type="checkbox"
                checked={exportWiki}
                onChange={(e) => setExportWiki(e.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--violet)]"
              />
              <span>Export Wiki</span>
            </label>

            <button
              type="button"
              onClick={handleRunGraphify}
              disabled={runningScan}
              className="ce-btn ce-btn-primary"
            >
              <Cpu className={`h-3.5 w-3.5 ${runningScan ? "animate-spin" : ""}`} />
              <span>{runningScan ? "Scanning AST…" : "Run Graphify AST"}</span>
            </button>

            <button
              type="button"
              onClick={() => setReportOpen(true)}
              disabled={!graph?.report_md}
              className="ce-btn ce-btn-ghost font-mono text-xs"
            >
              <FileText className="h-3.5 w-3.5 text-[var(--muted)]" />
              <span>GRAPH_REPORT.md</span>
            </button>

            <button
              type="button"
              onClick={() => void loadGraph()}
              disabled={loading}
              className="ce-btn ce-btn-ghost px-2.5"
              title="Refresh graph"
              aria-label="Refresh graph"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>
      ) : null}

      {graphError && (
        <ErrorBanner
          title="Unable to load Knowledge Graph"
          message={graphError}
          onRetry={() => void loadGraph()}
        />
      )}

      {/* Unified Controls, Domain Filter Chips & Precision Search Bar */}
      <div className="ce-card flex flex-col gap-2.5 px-3.5 py-2.5">
        {embedded && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] pb-2.5">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex flex-wrap items-center divide-x divide-[var(--line)] text-xs text-[var(--muted)] tabular-nums">
                <span className="pr-2.5">
                  <strong className="font-semibold text-[var(--ink)]">
                    {graph?.nodes.length ?? 0}
                  </strong>{" "}
                  nodes
                </span>
                <span className="px-2.5">
                  <strong className="font-semibold text-[var(--ink)]">
                    {graph?.links.length ?? 0}
                  </strong>{" "}
                  edges
                </span>
                <span className="px-2.5">
                  <strong className="font-semibold text-[var(--ink)]">
                    {graph?.god_nodes.length ?? 0}
                  </strong>{" "}
                  hubs
                </span>
                <span className="pl-2.5">
                  <strong className="font-semibold text-[var(--ink)]">
                    {graph?.surprising_connections.length ?? 0}
                  </strong>{" "}
                  bridges
                </span>
              </div>
              <TaskAgentPerch
                state={runningScan ? "working" : "scouting"}
                agentName="Graphify"
                statusText={
                  runningScan ? "Scanning AST & Leiden…" : "AST + Vault live"
                }
                compact
              />
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <select
                value={scanTarget}
                onChange={(e) => setScanTarget(e.target.value as GraphifyTarget)}
                aria-label="Graphify scan target"
                className="ce-input h-8 w-auto py-0 font-mono text-xs"
              >
                {graphifyTargets.map((t) => (
                  <option key={t.value} value={t.value}>
                    target: {t.label}
                  </option>
                ))}
              </select>

              <label className="ce-btn ce-btn-ghost h-8 cursor-pointer select-none px-2.5 text-xs">
                <input
                  type="checkbox"
                  checked={exportWiki}
                  onChange={(e) => setExportWiki(e.target.checked)}
                  className="h-3.5 w-3.5 accent-[var(--violet)]"
                />
                <span>Export Wiki</span>
              </label>

              <button
                type="button"
                onClick={handleRunGraphify}
                disabled={runningScan}
                className="ce-btn ce-btn-primary h-8 text-xs"
              >
                <Cpu className={`h-3.5 w-3.5 ${runningScan ? "animate-spin" : ""}`} />
                <span>{runningScan ? "Scanning AST…" : "Run Graphify AST"}</span>
              </button>

              <button
                type="button"
                onClick={() => setReportOpen(true)}
                disabled={!graph?.report_md}
                className="ce-btn ce-btn-ghost h-8 font-mono text-xs"
              >
                <FileText className="h-3.5 w-3.5 text-[var(--muted)]" />
                <span>GRAPH_REPORT.md</span>
              </button>

              <button
                type="button"
                onClick={() => void loadGraph()}
                disabled={loading}
                className="ce-btn ce-btn-ghost h-8 px-2"
                title="Refresh graph"
                aria-label="Refresh graph"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              </button>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setDomainFilter("all")}
              className={`ce-pill cursor-pointer transition tabular-nums ${
                domainFilter === "all"
                  ? "ce-pill-accent"
                  : "hover:border-[var(--line-strong)] hover:text-[var(--ink)]"
              }`}
            >
              <span>All</span>
              <span className="font-mono">{graph?.nodes.length ?? 0}</span>
            </button>

            {domains.map(([dom, count]) => {
              const pal = getDomainPalette(dom);
              const active = domainFilter === dom;
              return (
                <button
                  key={dom}
                  type="button"
                  onClick={() => setDomainFilter(active ? "all" : dom)}
                  className={`ce-pill cursor-pointer capitalize transition tabular-nums ${
                    active
                      ? pal.pillClass
                      : "hover:border-[var(--line-strong)] hover:text-[var(--ink)]"
                  }`}
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: pal.cssColorVar }}
                  />
                  <span>{dom}</span>
                  <span className="font-mono opacity-80">{count}</span>
                </button>
              );
            })}
          </div>
          <span className="font-mono text-[10.5px] text-[var(--muted)] tabular-nums">
            Showing {filteredNodes.length} / {graph?.nodes.length ?? 0} nodes
          </span>
        </div>
      </div>

      {/* Main Split: Always-Mounted 3D Constellation Stage + Node Inspector */}
      <div className="grid gap-4 lg:grid-cols-12">
        {/* 3D Canvas Stage (ALWAYS mounted in DOM so RAF + ResizeObserver attach immediately) */}
        <div
          className={`${
            expandedCanvas ? "lg:col-span-12" : "lg:col-span-8"
          } ce-card relative overflow-hidden bg-[var(--graph-bg)]`}
        >
          <div
            ref={canvasWrapRef}
            className={`relative w-full ${
              expandedCanvas ? "h-[74vh] min-h-[520px]" : "h-[640px]"
            }`}
          >
            <canvas
              ref={canvasRef}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerLeave={() => {
                cameraRef.current.dragging = false;
                cameraRef.current.dragMode = "orbit";
                setHoveredNodeId(null);
              }}
              onContextMenu={(e) => e.preventDefault()}
              onWheel={handleWheel}
              className={`block h-full w-full touch-none ${
                hoveredNodeId ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"
              }`}
            />

            {/* Top Floating HUD Bar (Edge Legend + Floating '/' Search + Zoom/Expand Pill) */}
            <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex flex-wrap items-start justify-between gap-2">
              <div className="ce-glass flex flex-wrap items-center gap-2.5 rounded-lg border px-3 py-1.5 font-mono text-[10.5px] text-[var(--ink-secondary)]">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-0.5 w-4 bg-[var(--ink-secondary)]" />
                  <span>EXTRACTED</span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-4 border-t border-dashed border-[var(--violet)]" />
                  <span>INFERRED</span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-4 border-t border-dotted border-[var(--amber)]" />
                  <span>AMBIGUOUS</span>
                </span>
                <span className="hidden font-sans text-[var(--muted)] xl:inline">
                  · Drag orbit · Shift/Right-drag pan · Scroll zoom
                </span>
              </div>

              <div className="pointer-events-auto flex flex-wrap items-center gap-2">
                <div ref={searchWrapRef} className="relative w-56 sm:w-64">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-[var(--muted)]" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={searchQuery}
                    onFocus={() => setSearchOpen(true)}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      setSearchOpen(true);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && searchMatches.length > 0) {
                        e.preventDefault();
                        selectAndFlyToNode(searchMatches[0].id);
                        setSearchOpen(false);
                      } else if (e.key === "Escape") {
                        setSearchOpen(false);
                        searchInputRef.current?.blur();
                      }
                    }}
                    placeholder="Jump to node…"
                    aria-label="Filter graph nodes"
                    className="ce-glass h-8 w-full rounded-lg border pl-8 pr-11 text-xs text-[var(--ink)] placeholder:text-[var(--muted)] focus:border-[var(--accent)] focus:outline-none"
                  />
                  {searchQuery ? (
                    <button
                      type="button"
                      onClick={() => {
                        setSearchQuery("");
                        setSearchOpen(false);
                      }}
                      aria-label="Clear search"
                      className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-[var(--muted)] transition hover:bg-[var(--surface-raised)] hover:text-[var(--ink)]"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  ) : (
                    <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border border-[var(--line-strong)] bg-[var(--surface-sunken)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--muted)]">
                      /
                    </kbd>
                  )}

                  {/* Search Quick-Jump Dropdown */}
                  <AnimatePresence>
                    {searchOpen && searchQuery.trim().length > 0 && (
                      <motion.div
                        initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.14 }}
                        className="ce-surface ce-float absolute top-9.5 right-0 left-0 z-30 overflow-hidden rounded-lg border border-[var(--line-strong)]"
                      >
                        {searchMatches.length === 0 ? (
                          <div className="px-3 py-2.5 text-xs text-[var(--muted)]">
                            No matching nodes in current view.
                          </div>
                        ) : (
                          <div className="divide-y divide-[var(--line)]">
                            {searchMatches.map((node) => {
                              const pal = getDomainPalette(node.domain);
                              return (
                                <button
                                  key={node.id}
                                  type="button"
                                  onClick={() => {
                                    selectAndFlyToNode(node.id);
                                    setSearchOpen(false);
                                  }}
                                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs transition hover:bg-[var(--surface-raised)]"
                                >
                                  <div className="flex min-w-0 items-center gap-2">
                                    <span
                                      className="h-2 w-2 shrink-0 rounded-full"
                                      style={{ backgroundColor: pal.cssColorVar }}
                                    />
                                    <span className="truncate font-medium text-[var(--ink)]">
                                      {node.label}
                                    </span>
                                  </div>
                                  <span className="shrink-0 font-mono text-[10.5px] text-[var(--muted)]">
                                    {node.kind}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                <div className="ce-glass flex items-center gap-1 rounded-lg border p-1">
                  <span className="px-2 font-mono text-[10.5px] text-[var(--muted)] tabular-nums">
                    {zoomPercent}%
                  </span>
                  <button
                    type="button"
                    onClick={() => setExpandedCanvas((v) => !v)}
                    title={expandedCanvas ? "Restore split view" : "Expand multisphere"}
                    aria-label={expandedCanvas ? "Restore split view" : "Expand multisphere"}
                    className="rounded-md p-1.5 text-[var(--ink-secondary)] transition hover:bg-[var(--surface-raised)] hover:text-[var(--ink)]"
                  >
                    {expandedCanvas ? (
                      <Minimize2 className="h-3.5 w-3.5" />
                    ) : (
                      <Maximize2 className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              </div>
            </div>

            {/* Bottom-left Floating Camera HUD */}
            <div className="ce-glass absolute bottom-3 left-3 flex flex-wrap items-center gap-1 rounded-lg border p-1">
              <button
                type="button"
                onClick={() => setAutoOrbit((v) => !v)}
                title={autoOrbit ? "Pause Auto-Orbit" : "Resume Auto-Orbit"}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
                  autoOrbit
                    ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                    : "text-[var(--muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--ink)]"
                }`}
              >
                {autoOrbit ? (
                  <Pause className="h-3 w-3" />
                ) : (
                  <Play className="h-3 w-3" />
                )}
                <span>Auto-Orbit</span>
              </button>

              <div className="mx-0.5 h-4 w-px bg-[var(--line)]" />

              <button
                type="button"
                onClick={() => adjustZoom(0.18)}
                title="Zoom +"
                aria-label="Zoom +"
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-[var(--ink-secondary)] transition hover:bg-[var(--surface-raised)] hover:text-[var(--ink)]"
              >
                <ZoomIn className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Zoom +</span>
              </button>

              <button
                type="button"
                onClick={() => adjustZoom(-0.18)}
                title="Zoom −"
                aria-label="Zoom −"
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-[var(--ink-secondary)] transition hover:bg-[var(--surface-raised)] hover:text-[var(--ink)]"
              >
                <ZoomOut className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Zoom −</span>
              </button>

              <button
                type="button"
                onClick={resetCamera}
                title="Reset Camera"
                aria-label="Reset Camera"
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-[var(--ink-secondary)] transition hover:bg-[var(--surface-raised)] hover:text-[var(--ink)]"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Reset Camera</span>
              </button>
            </div>

            {/* Bottom-right Hover Node Popover (Separate corner so it never overlaps Camera HUD) */}
            <AnimatePresence>
              {hoveredNode && !loading && !isEmptyGraph && (
                <motion.div
                  key={hoveredNode.id}
                  initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.14 }}
                  className="ce-glass ce-float pointer-events-none absolute right-3 bottom-3 max-w-xs rounded-lg border px-3.5 py-2.5"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`ce-pill capitalize ${
                        getDomainPalette(hoveredNode.domain).pillClass
                      }`}
                    >
                      {hoveredNode.domain}
                    </span>
                    <span className="font-mono text-[11px] text-[var(--muted)]">
                      {hoveredNode.kind}
                    </span>
                  </div>
                  <p className="mt-1 text-xs font-semibold text-[var(--ink)]">
                    {hoveredNode.label}
                  </p>
                  {hoveredNode.excerpt && (
                    <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-[var(--muted)]">
                      {stripMarkdownExcerpt(hoveredNode.excerpt, 120)}
                    </p>
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Initial Loading Overlay (Canvas stays mounted underneath) */}
            <AnimatePresence>
              {loading && !graph && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="absolute inset-0 z-20 flex items-center justify-center bg-[var(--graph-bg)]/55 p-6 backdrop-blur-md"
                >
                  <div className="ce-glass ce-float flex flex-col items-center gap-3 rounded-2xl border px-6 py-5 text-center">
                    <AgentBot state="scouting" size="md" label="Projecting 3D Knowledge Multisphere" />
                    <div>
                      <p className="text-sm font-semibold text-[var(--ink)]">
                        Projecting 3D Knowledge Multisphere…
                      </p>
                      <p className="mt-0.5 font-mono text-[11px] text-[var(--muted)]">
                        Loading Leiden communities, AST links &amp; bridge hubs
                      </p>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Empty State Overlay (Canvas stays mounted underneath) */}
            {isEmptyGraph && (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-[var(--graph-bg)]/70 p-6 backdrop-blur-md">
                <div className="ce-surface ce-float max-w-md rounded-2xl border border-[var(--line-strong)]">
                  <EmptyState
                    icon={Orbit}
                    title="Knowledge Multisphere is Empty"
                    description="Run a Graphify AST scan above to map code symbols, vault [[wikilinks]], repositories, meetings, and active obligations into a unified 3D constellation."
                    action={
                      <button
                        type="button"
                        onClick={handleRunGraphify}
                        disabled={runningScan}
                        className="ce-btn ce-btn-primary"
                      >
                        <Cpu className="h-3.5 w-3.5" />
                        <span>Run Graphify AST</span>
                      </button>
                    }
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right-Side Node Inspector Drawer (overscroll-contain) */}
        <aside
          aria-label="Node Inspector and Graph Telemetry"
          className={`${
            expandedCanvas ? "lg:col-span-12" : "lg:col-span-4"
          } ce-card divide-y divide-[var(--line)] overflow-hidden overscroll-contain lg:max-h-[642px] lg:overflow-y-auto`}
        >
          {/* 1. Selected Node Details & Neighbor Hopping */}
          <div className="p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-[14px] font-semibold text-[var(--ink)]">
                Node Inspector
              </h2>
              {selectedNode && (
                <span
                  className={`ce-pill capitalize ${
                    getDomainPalette(selectedNode.domain).pillClass
                  }`}
                >
                  {selectedNode.domain}
                </span>
              )}
            </div>

            {selectedNode ? (
              <div className="mt-3 space-y-3">
                <div>
                  <h3 className="text-sm font-semibold text-[var(--ink)]">
                    {selectedNode.label}
                  </h3>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-[var(--muted)]">
                    <span>{selectedNode.id}</span>
                    <span>·</span>
                    <span>{selectedNode.kind}</span>
                    <span>·</span>
                    <span>cluster {String(selectedNode.community)}</span>
                  </div>
                </div>

                {selectedNode.excerpt && (
                  <p className="border-l-2 border-[var(--line-strong)] pl-3 text-xs leading-relaxed text-[var(--ink-secondary)]">
                    {stripMarkdownExcerpt(selectedNode.excerpt, 280)}
                  </p>
                )}

                {selectedVaultTarget && onWikilinkClick ? (
                  <button
                    type="button"
                    onClick={() => onWikilinkClick(selectedVaultTarget)}
                    className="ce-btn ce-btn-ghost -ml-2 h-7 px-2 text-xs text-[var(--violet)]"
                  >
                    <ExternalLink className="h-3 w-3" />
                    <span>Open in Vault</span>
                  </button>
                ) : (
                  selectedNode.url &&
                  (selectedNode.url.startsWith("http://") ||
                    selectedNode.url.startsWith("https://")) && (
                    <a
                      href={selectedNode.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--accent)] hover:underline"
                    >
                      <span>Open Source Reference</span>
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )
                )}

                <div className="border-t border-[var(--line)] pt-2.5">
                  <div className="flex items-center justify-between text-xs font-medium text-[var(--ink-secondary)]">
                    <span>Connected Neighbors</span>
                    <span className="font-mono text-[11px] text-[var(--muted)] tabular-nums">
                      {selectedNeighbors.length}
                    </span>
                  </div>
                  {selectedNeighbors.length === 0 ? (
                    <p className="mt-1.5 text-xs text-[var(--muted)]">
                      No direct edges in current graph view.
                    </p>
                  ) : (
                    <div className="mt-1.5 max-h-44 divide-y divide-[var(--line)] overflow-y-auto overscroll-contain">
                      {selectedNeighbors.map((nb, idx) => (
                        <button
                          key={`${nb.node.id}-${idx}`}
                          type="button"
                          onClick={() => selectAndFlyToNode(nb.node.id)}
                          className="flex w-full items-center justify-between gap-2 px-1.5 py-1.5 text-left text-xs transition hover:bg-[var(--surface-raised)]"
                        >
                          <span className="truncate font-medium text-[var(--ink)]">
                            {nb.node.label}
                          </span>
                          <span className="shrink-0 font-mono text-[10.5px] text-[var(--muted)]">
                            {nb.relation}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <p className="mt-2 text-xs text-[var(--muted)]">
                Select any node on the 3D multisphere to inspect its edges, cluster, and provenance.
              </p>
            )}
          </div>

          {/* 2. God Nodes Bar (High Centrality Hubs) */}
          <div className="p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-[var(--violet)]" />
                <h2 className="text-[14px] font-semibold text-[var(--ink)]">
                  God Nodes
                </h2>
              </div>
              <span className="ce-pill font-mono tabular-nums">
                {graph?.god_nodes.length ?? 0}
              </span>
            </div>

            {!graph || graph.god_nodes.length === 0 ? (
              <p className="mt-2 text-xs text-[var(--muted)]">
                No centrality hubs calculated yet.
              </p>
            ) : (
              <div className="mt-2 max-h-44 divide-y divide-[var(--line)] overflow-y-auto overscroll-contain">
                {graph.god_nodes.map((gn) => {
                  const pal = getDomainPalette(gn.domain);
                  const isSelected = selectedNodeId === gn.id;
                  return (
                    <button
                      key={gn.id}
                      type="button"
                      onClick={() => selectAndFlyToNode(gn.id)}
                      className={`flex w-full items-center justify-between gap-2 px-2 py-2 text-left text-xs transition ${
                        isSelected
                          ? "bg-[var(--accent-soft)]"
                          : "hover:bg-[var(--surface-raised)]"
                      }`}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: pal.cssColorVar }}
                        />
                        <span className="truncate font-medium text-[var(--ink)]">
                          {gn.label}
                        </span>
                      </div>
                      <span className="shrink-0 font-mono text-[11px] text-[var(--muted)] tabular-nums">
                        deg {gn.degree}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* 3. Surprising Cross-Domain Bridges */}
          <div className="p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-[14px] font-semibold text-[var(--ink)]">
                Surprising Bridges
              </h2>
              <span className="ce-pill font-mono tabular-nums">
                {graph?.surprising_connections.length ?? 0}
              </span>
            </div>

            {!graph || graph.surprising_connections.length === 0 ? (
              <p className="mt-2 text-xs text-[var(--muted)]">
                No cross-domain bridges detected yet.
              </p>
            ) : (
              <div className="mt-2 max-h-48 divide-y divide-[var(--line)] overflow-y-auto overscroll-contain">
                {graph.surprising_connections.map((sc, i) => (
                  <div key={`${sc.source}-${sc.target}-${i}`} className="py-2.5 first:pt-1">
                    <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-[var(--violet)]">
                      <button
                        type="button"
                        onClick={() => selectAndFlyToNode(sc.source)}
                        className="cursor-pointer rounded px-1 py-0.5 transition hover:bg-[var(--violet-soft)] hover:underline"
                      >
                        {sc.source}
                      </button>
                      <span className="text-[var(--subtle)]">↔</span>
                      <button
                        type="button"
                        onClick={() => selectAndFlyToNode(sc.target)}
                        className="cursor-pointer rounded px-1 py-0.5 transition hover:bg-[var(--violet-soft)] hover:underline"
                      >
                        {sc.target}
                      </button>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
                      {sc.why}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 4. Graphify Suggested Synthesis Questions */}
          <div className="p-4">
            <h2 className="text-[14px] font-semibold text-[var(--ink)]">
              Suggested Synthesis Questions
            </h2>
            {!graph || graph.suggested_questions.length === 0 ? (
              <p className="mt-2 text-xs text-[var(--muted)]">
                Run a scan to generate synthesis prompts from cluster boundaries.
              </p>
            ) : (
              <div className="mt-2 divide-y divide-[var(--line)]">
                {graph.suggested_questions.map((q, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(q).catch(() => {});
                      pushToast("info", "Question copied to clipboard", q);
                    }}
                    className="group flex w-full items-start justify-between gap-2 py-2 text-left text-xs leading-relaxed text-[var(--ink-secondary)] transition hover:text-[var(--ink)]"
                  >
                    <span>{q}</span>
                    <Copy className="mt-0.5 h-3 w-3 shrink-0 text-[var(--subtle)] opacity-70 group-hover:text-[var(--accent)] group-hover:opacity-100" />
                  </button>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* Escape-Closable Architecture Synthesis Report Drawer (GRAPH_REPORT.md) */}
      <AnimatePresence>
        {reportOpen && graph && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            className="fixed inset-0 z-50 flex items-center justify-end bg-[var(--backdrop-scrim)] p-3 backdrop-blur-xs sm:p-4"
            onClick={(e) => {
              if (e.target === e.currentTarget) setReportOpen(false);
            }}
          >
            <motion.div
              initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, x: 24 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              className="ce-surface ce-float flex h-full max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--line-strong)]"
            >
              <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-3.5">
                <div className="flex items-center gap-2.5">
                  <FileText className="h-4 w-4 text-[var(--accent)]" />
                  <div>
                    <h3 className="font-mono text-sm font-semibold text-[var(--ink)]">
                      GRAPH_REPORT.md
                    </h3>
                    <p className="text-[11px] text-[var(--muted)]">
                      Architecture Synthesis &amp; Leiden Community Report
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setReportOpen(false)}
                  className="ce-btn ce-btn-ghost h-7 px-2"
                  aria-label="Close report drawer"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto overscroll-contain px-6 py-5">
                <div className="ce-prose-measure">
                  <MarkdownRenderer
                    content={graph.report_md}
                    onWikilinkClick={
                      onWikilinkClick
                        ? (target) => {
                            setReportOpen(false);
                            onWikilinkClick(target);
                          }
                        : undefined
                    }
                  />
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

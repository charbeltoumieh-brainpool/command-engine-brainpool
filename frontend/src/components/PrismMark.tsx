import type { PrismDomainState } from "../types/api";

export function PrismMark({
  size = 24,
  state = "quiet",
  className = "",
}: {
  size?: number;
  state?: PrismDomainState | string;
  className?: string;
}) {
  const cubeAccent =
    state === "blocked"
      ? "var(--coral)"
      : state === "awaiting_approval" || state === "paused"
      ? "var(--amber)"
      : state === "offline"
      ? "var(--muted)"
      : "var(--accent)";

  const orbitalNodeColor =
    state === "blocked"
      ? "var(--coral)"
      : state === "offline"
      ? "var(--muted)"
      : "var(--amber)";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 36 36"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {/* Back half of tilted -24 deg solar orbital halo (occluded behind cube) */}
      <path
        d="M 31.70 12.30 A 15.0 5.6 -24 0 0 4.30 24.50"
        stroke={orbitalNodeColor}
        strokeOpacity="0.34"
        strokeWidth="1.05"
        strokeLinecap="round"
      />

      {/* Isometric 3-face translucent crystal cube */}
      {/* Top diamond face (brightest pearlescent facet) */}
      <polygon
        points="18,7.5 27.09,12.75 18,18 8.91,12.75"
        fill={cubeAccent}
        fillOpacity="0.34"
      />
      {/* Left vertical face (radiant mid-tone facet) */}
      <polygon
        points="8.91,12.75 18,18 18,28.5 8.91,23.25"
        fill={cubeAccent}
        fillOpacity="0.22"
      />
      {/* Right vertical face (deepest amethyst shadow facet) */}
      <polygon
        points="18,18 27.09,12.75 27.09,23.25 18,28.5"
        fill={cubeAccent}
        fillOpacity="0.12"
      />

      {/* Subtle inner tesseract wireframe */}
      <polygon
        points="18,12.12 23.09,15.06 23.09,20.94 18,23.88 12.91,20.94 12.91,15.06"
        stroke={cubeAccent}
        strokeOpacity="0.42"
        strokeWidth="0.75"
        strokeLinejoin="round"
      />

      {/* Crisp specular facet ridges: outer hexagon + inner Y-junction */}
      <polygon
        points="18,7.5 27.09,12.75 27.09,23.25 18,28.5 8.91,23.25 8.91,12.75"
        stroke={cubeAccent}
        strokeOpacity="0.92"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <path
        d="M 18 18 L 8.91 12.75 M 18 18 L 27.09 12.75 M 18 18 L 18 28.5"
        stroke={cubeAccent}
        strokeOpacity="0.88"
        strokeWidth="1.15"
        strokeLinecap="round"
      />

      {/* Center Y-vertex focal aperture */}
      <circle cx="18" cy="18" r="1.55" fill={cubeAccent} fillOpacity="0.95" />

      {/* Front half of tilted -24 deg solar orbital halo (sweeps across cube) */}
      <path
        d="M 4.30 24.50 A 15.0 5.6 -24 0 0 31.70 12.30"
        stroke={orbitalNodeColor}
        strokeOpacity="0.90"
        strokeWidth="1.25"
        strokeLinecap="round"
      />

      {/* Radiant orbital satellite node */}
      <circle cx="30.23" cy="16.71" r="2.6" fill={orbitalNodeColor} fillOpacity="0.26" />
      <circle cx="30.23" cy="16.71" r="1.5" fill={orbitalNodeColor} />
    </svg>
  );
}

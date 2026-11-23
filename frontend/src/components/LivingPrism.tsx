import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type {
  ApprovalItem,
  MeetingItem,
  MissionItem,
  OrbitDomainNode,
  OrbitStrand,
  PrismDomainState,
} from "../types/api";

export interface LivingPrismProps {
  coreState: PrismDomainState | string;
  systemPaused: boolean;
  healthStatus: string;
  brandName: string;
  runningMissions: number;
  pendingApprovals: number;
  neededFromMe: number;
  resolvedTheme: "dark" | "light";
  domains: OrbitDomainNode[];
  strands: OrbitStrand[];
  approvalsList?: ApprovalItem[];
  scheduleList?: MeetingItem[];
  activeMissionsList?: MissionItem[];
  selectedId: string | null; // null | 'core' | domain.id
  externalHighlightId?: string | null;
  transitioningOut?: boolean;
  onSelect: (id: string | null) => void;
  onActivateDomain: (domain: OrbitDomainNode) => void;
  onOpenApprovals?: () => void;
}

interface HoverLensState {
  id: string;
  kind: "core" | "domain" | "approval";
  title: string;
  stateLabel: string;
  metric: string;
  preview?: string;
  hint: string;
  accentHex: string;
  x: number;
  y: number;
}

/* ============================================================================
   Linear-Space GLSL Shaders (Calibrated for ACESFilmicToneMapping + OutputPass)
   ============================================================================ */

const SKY_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform float uIsLight;
  uniform float uWarmth;
  uniform float uEnergy;
  uniform vec2 uAspect;

  float hash21(vec2 p) {
    p = fract(p * vec2(234.34, 435.345));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float amp = 0.5;
    mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
    for (int i = 0; i < 5; i++) {
      v += amp * noise(p);
      p = rot * p * 2.03 + vec2(1.7, 9.2);
      amp *= 0.5;
    }
    return v;
  }

  void main() {
    vec2 uv = vUv;
    vec2 centered = (uv - 0.5) * vec2(uAspect.x / max(uAspect.y, 0.001), 1.0);
    float t = uTime * 0.038;

    // Flowing cosmic silk filaments swept diagonally across the lower/mid spatial field
    vec2 warped = centered * vec2(1.42, 1.95) + vec2(centered.y * 0.42, -abs(centered.x) * 0.22);
    vec2 q = vec2(
      fbm(warped + vec2(t * 0.55, -t * 0.28)),
      fbm(warped + vec2(3.8, 1.4) - t * 0.30)
    );
    vec2 r = vec2(
      fbm(warped * 1.70 + 2.05 * q + vec2(1.7, 9.2) + t * 0.22),
      fbm(warped * 1.70 + 2.05 * q + vec2(8.3, 2.8) - t * 0.18)
    );
    float f = fbm(warped * 1.50 + 2.15 * r);

    // Razor-sharp luminous silk crests with pure obsidian troughs between folds (Category A ebd4a314)
    float filamentA = pow(clamp(1.0 - abs(f * 2.0 - 0.94), 0.0, 1.0), 5.4);
    float filamentB = pow(clamp(1.0 - abs(r.x * 2.0 - 1.04), 0.0, 1.0), 6.2);
    float veilFold  = pow(clamp(f * r.y * 1.55, 0.0, 1.0), 3.4);

    // Keep upper 46% zenith (uv.y > 0.54) pure cosmic void so typography & upper prism sit in pure black
    float centerDockQuiet = 1.0 - 0.55 * exp(-pow(centered.x * 2.2, 2.0)) * smoothstep(0.16, 0.02, uv.y);
    float bandMask = smoothstep(0.56, 0.16, uv.y) * centerDockQuiet;
    float coreGlow = exp(-dot(centered - vec2(0.0, -0.05), centered - vec2(0.0, -0.05)) * 7.2);

    if (uIsLight < 0.5) {
      // True linear obsidian (~#05060a after ACES + sRGB OutputPass)
      vec3 obsidian   = vec3(0.00038, 0.00046, 0.00088);
      vec3 cobaltSilk = vec3(0.014, 0.052, 0.245);
      vec3 violetSilk = vec3(0.068, 0.015, 0.205);
      vec3 amberCrest = vec3(0.215, 0.048, 0.014);

      vec3 ribbon = mix(cobaltSilk, violetSilk, smoothstep(0.24, 0.76, q.x)) * (filamentA * 1.32 + veilFold * 0.34);
      ribbon += amberCrest * (filamentB * (0.65 + 0.75 * uWarmth));
      ribbon *= (0.90 + 0.32 * uEnergy);

      vec3 coreHalo = mix(vec3(0.009, 0.005, 0.024), vec3(0.018, 0.007, 0.022), uWarmth) * coreGlow;

      vec3 col = obsidian + ribbon * bandMask + coreHalo;
      float dither = (hash21(uv * 1200.0 + fract(uTime)) - 0.5) * 0.00035;
      gl_FragColor = vec4(max(col + dither, 0.0), 1.0);
    } else {
      // Luminous Sunlit Warm-Ivory Field & Unmistakable Spectral Silk Atmosphere
      // Account for sky plane frustum coverage (44x28 at z=-18 -> visible uv.y ~ [0.27, 0.73], uv.x ~ [0.26, 0.74])
      float visY = clamp((uv.y - 0.27) / 0.46, 0.0, 1.0);
      float visX = clamp((uv.x - 0.26) / 0.48, 0.0, 1.0);
      float visCenterX = (visX - 0.5) * 2.0;

      // Calibrated for ACESFilmicToneMapping (exposure = 1.0, bloom = 0 in light)
      vec3 zenithLinear = vec3(1.76, 1.70, 1.58);
      vec3 basinLinear  = vec3(1.16, 1.22, 1.38);
      vec3 base = mix(basinLinear, zenithLinear, smoothstep(0.05, 0.62, visY));

      // Sculptural diagonal silk folds in lower-left / lower-right atmosphere
      float lightFilA = pow(clamp(1.0 - abs(f * 2.0 - 0.94), 0.0, 1.0), 1.75);
      float lightFilB = pow(clamp(1.0 - abs(r.x * 2.0 - 1.04), 0.0, 1.0), 1.95);
      float lightVeil = pow(clamp(f * r.y * 1.85, 0.0, 1.0), 1.40);

      // Mineral watercolor pigments calibrated so ACES outputs clear, luminous silk waves on ivory
      vec3 sapphireSilk = vec3(0.24, 0.38, 0.98);
      vec3 irisSilk     = vec3(0.46, 0.26, 0.92);
      vec3 amberSilk    = vec3(1.02, 0.44, 0.16);

      float dockMask = 1.0 - 0.55 * exp(-pow(visCenterX * 2.1, 2.0)) * smoothstep(0.26, 0.02, visY);
      float flankBoost = 0.58 + 0.42 * smoothstep(0.10, 0.85, abs(visCenterX));
      float lowerAtmosphere = smoothstep(0.56, 0.04, visY) * dockMask * flankBoost;
      vec3 causticTint = mix(sapphireSilk, irisSilk, smoothstep(0.22, 0.78, q.x));

      float coolMix = clamp((lightFilA * 0.66 + lightVeil * 0.50) * lowerAtmosphere, 0.0, 0.78);
      float warmMix = clamp(lightFilB * (0.58 + 0.32 * uWarmth) * lowerAtmosphere, 0.0, 0.72);
      vec3 col = mix(base, causticTint, coolMix);
      col = mix(col, amberSilk, warmMix);
      col = mix(col, vec3(0.84, 0.88, 1.22), clamp(coreGlow * 0.16, 0.0, 0.20));

      float dither = (hash21(uv * 1200.0 + fract(uTime)) - 0.5) * 0.00035;
      gl_FragColor = vec4(max(col + dither, 0.0), 1.0);
    }
  }
`;

const CRYSTAL_VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  varying vec3 vLocalPos;
  void main() {
    vLocalPos = position;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const CRYSTAL_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  varying vec3 vLocalPos;

  uniform float uTime;
  uniform float uIsLight;
  uniform float uShellAlpha;
  uniform float uInnerCore;
  uniform float uWarmth;
  uniform float uHighlight;
  uniform vec3 uPrimaryTint;
  uniform vec3 uSecondaryTint;
  uniform vec3 uWarmTint;

  void main() {
    vec3 N = normalize(vWorldNormal);
    if (!gl_FrontFacing) N = -N;
    vec3 V = normalize(cameraPosition - vWorldPos);

    float ndv = clamp(abs(dot(N, V)), 0.0, 1.0);
    float fresnel = pow(1.0 - ndv, 2.6);

    vec3 L1 = normalize(vec3(0.52, 0.80, 0.66));
    vec3 L2 = normalize(vec3(-0.65, -0.42, 0.58));
    float spec1 = pow(max(dot(N, normalize(L1 + V)), 0.0), 56.0);
    float spec2 = pow(max(dot(N, normalize(L2 + V)), 0.0), 28.0);

    float band = 0.5 + 0.5 * sin(vLocalPos.x * 2.8 + vLocalPos.y * 2.4 - uTime * 0.35);
    float topWarm = clamp(N.y * 0.55 + N.x * 0.25 + 0.35, 0.0, 1.0);
    vec3 spectral = mix(uPrimaryTint, uSecondaryTint, band * 0.75 + fresnel * 0.25);
    spectral = mix(spectral, uWarmTint, topWarm * (0.30 + 0.40 * uWarmth));

    // Inner nucleus has rich volumetric internal glow (matching Category A 12e6c82e)
    float corePulse = 0.92 + 0.08 * sin(uTime * 1.4);
    vec3 color;
    float alpha;

    if (uIsLight > 0.5) {
      // Crystal-clear outer optical glass + rich dichroic jewel inner nucleus
      if (uInnerCore > 0.5) {
        vec3 coreDichroic = mix(spectral * 0.78, vec3(0.16, 0.09, 0.58), fresnel * 0.65);
        coreDichroic = mix(coreDichroic, uWarmTint * 0.92, topWarm * (0.30 + 0.35 * uWarmth));
        color = coreDichroic * (0.85 * corePulse + 0.45 * fresnel);
        color += vec3(1.35, 1.30, 1.25) * (spec1 * 0.85) + vec3(0.78, 0.74, 0.98) * (spec2 * 0.32);

        float coreAlpha = (0.58 + uShellAlpha * 0.28 + fresnel * 0.20 + spec1 * 0.16) * (1.0 + 0.22 * uHighlight);
        alpha = clamp(coreAlpha, 0.56, 0.88);
      } else {
        vec3 shellRimColor = mix(vec3(0.16, 0.22, 0.58), spectral * 0.68, 0.45);
        color = shellRimColor * (0.36 + 0.78 * fresnel);
        color += vec3(1.25, 1.22, 1.18) * (spec1 * 0.55) + vec3(0.55, 0.64, 0.92) * (spec2 * 0.28);

        float shellAlpha = (uShellAlpha * (0.14 + 1.15 * fresnel) + 0.015 + spec1 * 0.18) * (1.0 + 0.28 * uHighlight);
        alpha = clamp(shellAlpha, 0.018, 0.38);
      }
    } else {
      color = spectral * (uInnerCore > 0.5 ? (0.72 * corePulse + 1.05 * fresnel) : (0.14 + 0.68 * fresnel));
      color += vec3(0.96, 0.92, 1.0) * (spec1 * 0.75 + spec2 * 0.26);

      alpha = uInnerCore > 0.5
        ? uShellAlpha * (0.58 + 0.48 * fresnel) + spec1 * 0.22
        : uShellAlpha * (0.10 + 0.88 * fresnel) + spec1 * 0.18;
      alpha *= (1.0 + 0.28 * uHighlight);
      alpha = clamp(alpha, 0.015, 0.68);
    }

    gl_FragColor = vec4(color, alpha);
  }
`;

const PLANET_VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  varying vec3 vLocalPos;
  void main() {
    vLocalPos = position;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const PLANET_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  varying vec3 vLocalPos;

  uniform vec3 uCorePos;
  uniform vec3 uRimColor;
  uniform vec3 uSurfaceColor;
  uniform float uIsLight;
  uniform float uHover;
  uniform float uTime;

  float hash31(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  float noise3(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(
        mix(hash31(i + vec3(0,0,0)), hash31(i + vec3(1,0,0)), f.x),
        mix(hash31(i + vec3(0,1,0)), hash31(i + vec3(1,1,0)), f.x),
        f.y
      ),
      mix(
        mix(hash31(i + vec3(0,0,1)), hash31(i + vec3(1,0,1)), f.x),
        mix(hash31(i + vec3(0,1,1)), hash31(i + vec3(1,1,1)), f.x),
        f.y
      ),
      f.z
    );
  }

  void main() {
    vec3 N = normalize(vWorldNormal);
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 toCore = normalize(uCorePos - vWorldPos);
    vec3 sunDir = normalize(vec3(0.55, 0.42, 0.35));

    float detail = noise3(vLocalPos * 7.5 + vec3(uTime * 0.02)) * 0.65
                 + noise3(vLocalPos * 18.0) * 0.35;

    float fresnel = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.4);
    float coreFacing = clamp(dot(N, toCore) * 0.55 + 0.45, 0.0, 1.0);
    float sunFacing = max(dot(N, sunDir), 0.0);

    // Razor-sharp astronomical eclipse crescent rim (Category A ebd4a314)
    float crescent = fresnel * (0.22 + 1.25 * pow(coreFacing, 1.4));
    float terminator = pow(max(dot(N, toCore), 0.0), 2.6) * 0.22;

    if (uIsLight < 0.5) {
      // Deep obsidian planetary body so only the incandescent rim & subtle surface texture read
      vec3 darkBody = uSurfaceColor * (0.35 + 0.65 * detail) * (0.18 + 0.55 * sunFacing);
      vec3 rim = uRimColor * (crescent * (1.85 + 0.95 * uHover) + terminator);
      gl_FragColor = vec4(darkBody + rim, 1.0);
    } else {
      // Optical Dichroic Glass-Lens / Translucent Mineral-Orb shading for Daylight Orbit
      float ndv = clamp(dot(N, V), 0.0, 1.0);
      float wrapDiffuse = clamp((dot(N, sunDir) + 0.48) / 1.48, 0.0, 1.0);
      float hemiLight = 0.58 + 0.42 * N.y;

      // Translucent optical lens transmission in center + rich jewel mid-band
      float lensTransmission = pow(ndv, 1.55);
      vec3 jewelMid = mix(uSurfaceColor * 0.52, uRimColor * 0.74, 0.48 + 0.28 * detail);
      vec3 lensCenter = mix(uRimColor * 0.72 + vec3(0.26, 0.25, 0.24), vec3(1.18, 1.15, 1.12), 0.46);
      vec3 litGlassBody = mix(jewelMid, lensCenter, lensTransmission * 0.72);
      litGlassBody *= (0.68 + 0.42 * wrapDiffuse) * (0.82 + 0.18 * hemiLight);

      // Internal opposite-side prism caustic focus arc + crescent refraction
      float causticFocus = pow(max(dot(-N, toCore), 0.0), 2.6);
      vec3 causticGlow = mix(uRimColor * 1.15, vec3(1.22, 1.16, 1.08), 0.35) * causticFocus * (0.72 + 0.38 * uHover);
      vec3 shaded = litGlassBody + causticGlow;
      shaded += uRimColor * (crescent * (0.48 + 0.35 * uHover));

      // Crisp dark-jewel Fresnel refraction edge so every orb reads cleanly against ivory
      float edgeOutline = pow(1.0 - ndv, 2.35);
      vec3 deepGemRim = mix(uRimColor * 0.55, uRimColor * 0.20, 0.48) * (0.95 + 0.28 * coreFacing + 0.30 * uHover);
      shaded = mix(shaded, deepGemRim, clamp(edgeOutline * 0.94, 0.0, 0.94));

      // Razor-sharp optical glass specular glint
      vec3 H = normalize(sunDir + V);
      float glassSpec = pow(max(dot(N, H), 0.0), 140.0) * 1.75;
      shaded += vec3(1.0, 0.99, 0.97) * (glassSpec * (1.0 + 0.25 * uHover));

      gl_FragColor = vec4(shaded, 1.0);
    }
  }
`;

const HALO_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  uniform vec3 uRimColor;
  uniform float uIntensity;
  uniform float uIsLight;

  void main() {
    vec3 N = normalize(vWorldNormal);
    vec3 V = normalize(cameraPosition - vWorldPos);
    // On BackSide sphere, ndv == 0 at outer silhouette and approaches 1 behind planet center.
    // Smoothly fade to exact 0 at outer silhouette so no hard ring outline ever forms!
    float ndv = clamp(dot(-N, V), 0.0, 1.0);
    float corona = pow(ndv, 3.6) * smoothstep(0.0, 0.44, ndv);
    float alpha = corona * uIntensity * (uIsLight > 0.5 ? 0.72 : 0.65);
    gl_FragColor = vec4(uRimColor, alpha);
  }
`;

const STAR_VERTEX_SHADER = /* glsl */ `
  attribute float aSize;
  attribute float aPhase;
  varying float vAlpha;
  uniform float uTime;
  uniform float uPixelRatio;

  void main() {
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    float twinkle = 0.65 + 0.35 * sin(uTime * 1.2 + aPhase);
    vAlpha = twinkle * smoothstep(-16.0, -5.0, mvPos.z);
    gl_PointSize = aSize * uPixelRatio * (7.5 / max(-mvPos.z, 1.5));
    gl_Position = projectionMatrix * mvPos;
  }
`;

const STAR_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  varying float vAlpha;
  uniform vec3 uColor;
  uniform float uBaseOpacity;

  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;
    float soft = pow(1.0 - d * 2.0, 2.2);
    gl_FragColor = vec4(uColor, soft * vAlpha * uBaseOpacity);
  }
`;

/* ============================================================================
   Linear Color & Keplerian Orbit Helpers
   ============================================================================ */

interface DomainSemanticStyle {
  rimHex: string;
  surfaceHex: string;
  lensHex: string;
  stateLabel: string;
}

function getDomainSemanticStyle(
  state: string,
  domainId: string,
  isLight: boolean
): DomainSemanticStyle {
  if (state === "blocked") {
    return isLight
      ? { rimHex: "#d12c1d", surfaceHex: "#b83a42", lensHex: "#c4281a", stateLabel: "Urgent / Blocked" }
      : { rimHex: "#ff7e5f", surfaceHex: "#0b0508", lensHex: "#f48973", stateLabel: "Urgent / Blocked" };
  }
  if (state === "awaiting_approval" || domainId === "approvals") {
    return isLight
      ? { rimHex: "#c46100", surfaceHex: "#c47725", lensHex: "#b55800", stateLabel: "Awaiting Approval" }
      : { rimHex: "#ffbe5c", surfaceHex: "#0c0805", lensHex: "#f3c169", stateLabel: "Awaiting Approval" };
  }
  if (state === "running") {
    return isLight
      ? { rimHex: "#1652cc", surfaceHex: "#2e67c9", lensHex: "#1950bf", stateLabel: "Active Mission" }
      : { rimHex: "#6cb2ff", surfaceHex: "#050914", lensHex: "#7db8ff", stateLabel: "Active Mission" };
  }
  if (state === "attention" || domainId === "knowledge") {
    return isLight
      ? { rimHex: "#6532d1", surfaceHex: "#6b48bd", lensHex: "#5f30c2", stateLabel: "Active Context" }
      : { rimHex: "#b48cff", surfaceHex: "#080612", lensHex: "#b695ff", stateLabel: "Active Context" };
  }
  if (state === "degraded") {
    return isLight
      ? { rimHex: "#a85808", surfaceHex: "#9c6b30", lensHex: "#9c5008", stateLabel: "Sign-In Needed" }
      : { rimHex: "#eba854", surfaceHex: "#0b0907", lensHex: "#e5b263", stateLabel: "Sign-In Needed" };
  }
  return isLight
    ? { rimHex: "#29577d", surfaceHex: "#4b7191", lensHex: "#2b5478", stateLabel: "Calm" }
    : { rimHex: "#8298cc", surfaceHex: "#060810", lensHex: "#9aa8cc", stateLabel: "Calm" };
}

// Calibrated 3D Keplerian orbits:
// - Every world maintains |x| >= 1.60 at rest so zero worlds ever occlude the central nested crystal
// - Bounded within rx <= 3.32 so every planet stays comfortably inside 1440x900 & 1920x1080 frames
const ORBITAL_SLOTS = [
  { rx: 2.34, rz: 1.58, inclX: 0.34, inclZ: -0.18, phase: -2.42, speed: 0.072 }, // Approvals (upper-left warm ringed world)
  { rx: 2.82, rz: 1.86, inclX: -0.28, inclZ: 0.16, phase: 0.42, speed: 0.056 },  // Work (upper-right eclipse world)
  { rx: 2.96, rz: 1.88, inclX: 0.28, inclZ: -0.12, phase: -2.86, speed: 0.064 }, // Communications (far-left iris world)
  { rx: 3.24, rz: 2.02, inclX: 0.22, inclZ: -0.10, phase: -0.14, speed: 0.048 }, // Meetings (far-right outer world)
  { rx: 2.68, rz: 1.82, inclX: -0.32, inclZ: -0.18, phase: -0.88, speed: 0.042 }, // Knowledge (lower-right foreground world)
  { rx: 2.48, rz: 1.66, inclX: 0.34, inclZ: 0.14, phase: 2.34, speed: 0.052 },  // Infrastructure (lower-left foreground world)
  { rx: 2.56, rz: 1.72, inclX: -0.36, inclZ: 0.15, phase: 0.96, speed: 0.080 },  // Executive (upper-right calm crown world)
];

const CORE_Y = -0.26;

function evalOrbitPoint(
  slot: (typeof ORBITAL_SLOTS)[number],
  theta: number,
  out: THREE.Vector3
): THREE.Vector3 {
  const x0 = Math.cos(theta) * slot.rx;
  const z0 = Math.sin(theta) * slot.rz;
  const y1 = -z0 * Math.sin(slot.inclX);
  const z1 = z0 * Math.cos(slot.inclX);
  const x2 = x0 * Math.cos(slot.inclZ) - y1 * Math.sin(slot.inclZ);
  const y2 = x0 * Math.sin(slot.inclZ) + y1 * Math.cos(slot.inclZ);
  return out.set(x2, CORE_Y + y2, z1);
}

export function LivingPrism({
  coreState,
  systemPaused,
  healthStatus,
  brandName,
  runningMissions,
  pendingApprovals,
  neededFromMe,
  resolvedTheme,
  domains,
  strands,
  approvalsList = [],
  scheduleList = [],
  selectedId,
  externalHighlightId = null,
  transitioningOut = false,
  onSelect,
  onActivateDomain,
  onOpenApprovals,
}: LivingPrismProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [hoverLens, setHoverLens] = useState<HoverLensState | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const latestPropsRef = useRef({
    coreState,
    systemPaused,
    healthStatus,
    runningMissions,
    pendingApprovals,
    neededFromMe,
    resolvedTheme,
    domains,
    strands,
    approvalsList,
    scheduleList,
    selectedId,
    externalHighlightId,
    transitioningOut,
    onSelect,
    onActivateDomain,
    onOpenApprovals,
  });
  latestPropsRef.current = {
    coreState,
    systemPaused,
    healthStatus,
    runningMissions,
    pendingApprovals,
    neededFromMe,
    resolvedTheme,
    domains,
    strands,
    approvalsList,
    scheduleList,
    selectedId,
    externalHighlightId,
    transitioningOut,
    onSelect,
    onActivateDomain,
    onOpenApprovals,
  };

  const cameraRigRef = useRef({
    yaw: 0.0,
    pitch: 0.06,
    velYaw: 0,
    velPitch: 0,
    zoomDist: 8.85,
    pointerNdcX: 0,
    pointerNdcY: 0,
    smoothPtrX: 0,
    smoothPtrY: 0,
    warpProgress: 0,
  });

  const pointerInteractionRef = useRef({
    down: false,
    moved: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    hoveredPickId: null as string | null,
  });

  const requestFrameRef = useRef<() => void>(() => {});

  const orderedDomains = useMemo(() => {
    const order = [
      "approvals",
      "engineering",
      "communications",
      "meetings",
      "knowledge",
      "infrastructure",
      "executive",
    ];
    return [...domains].sort((a, b) => {
      const ia = order.indexOf(a.id);
      const ib = order.indexOf(b.id);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  }, [domains]);

  useEffect(() => {
    const mountEl = mountRef.current;
    if (!mountEl) return;

    const disposables: Array<{ dispose: () => void }> = [];
    const track = <T extends { dispose: () => void }>(obj: T): T => {
      disposables.push(obj);
      return obj;
    };

    const initW = Math.max(mountEl.clientWidth, 320);
    const initH = Math.max(mountEl.clientHeight, 320);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: "high-performance",
      });
    } catch {
      return;
    }

    renderer.setPixelRatio(dpr);
    renderer.setSize(initW, initH);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.dataset.engine = "three-webgl-v3";
    mountEl.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, initW / initH, 0.1, 60);
    camera.position.set(0, 0.22, 8.85);

    let composer: EffectComposer | null = null;
    let bloomPass: UnrealBloomPass | null = null;
    try {
      composer = new EffectComposer(renderer);
      const renderPass = new RenderPass(scene, camera);
      bloomPass = new UnrealBloomPass(
        new THREE.Vector2(initW, initH),
        0.48,
        0.62,
        0.52
      );
      const outputPass = new OutputPass();
      composer.addPass(renderPass);
      composer.addPass(bloomPass);
      composer.addPass(outputPass);
    } catch {
      composer = null;
      bloomPass = null;
    }

    // 1. Backdrop Cosmic Silk / Sunlit Alabaster Dome
    const skyGeo = track(new THREE.PlaneGeometry(44, 28, 1, 1));
    const skyMat = track(
      new THREE.ShaderMaterial({
        vertexShader: SKY_VERTEX_SHADER,
        fragmentShader: SKY_FRAGMENT_SHADER,
        depthWrite: false,
        depthTest: false,
        uniforms: {
          uTime: { value: 0 },
          uIsLight: { value: latestPropsRef.current.resolvedTheme === "light" ? 1 : 0 },
          uWarmth: { value: 0.5 },
          uEnergy: { value: 0.25 },
          uAspect: { value: new THREE.Vector2(initW, initH) },
        },
      })
    );
    const skyMesh = new THREE.Mesh(skyGeo, skyMat);
    skyMesh.renderOrder = -100;
    camera.add(skyMesh);
    skyMesh.position.set(0, 0, -18);
    scene.add(camera);

    // 2. Fine Astronomical Starfield
    const starCount = 220;
    const starPositions = new Float32Array(starCount * 3);
    const starSizes = new Float32Array(starCount);
    const starPhases = new Float32Array(starCount);
    for (let i = 0; i < starCount; i++) {
      const u = ((i * 0.61803398875) % 1) * Math.PI * 2;
      const v = (((i * 0.38196601125) % 1) - 0.44) * 1.65;
      const rad = 5.4 + ((i * 0.754877666) % 1) * 8.0;
      starPositions[i * 3] = Math.cos(u) * Math.cos(v) * rad * 1.38;
      starPositions[i * 3 + 1] = Math.sin(v) * rad * 0.75 - 0.15;
      starPositions[i * 3 + 2] = Math.sin(u) * Math.cos(v) * rad - 2.4;
      starSizes[i] = 1.0 + ((i * 7) % 5) * 0.38;
      starPhases[i] = i * 1.37;
    }
    const starGeo = track(new THREE.BufferGeometry());
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    starGeo.setAttribute("aSize", new THREE.BufferAttribute(starSizes, 1));
    starGeo.setAttribute("aPhase", new THREE.BufferAttribute(starPhases, 1));
    const starMat = track(
      new THREE.ShaderMaterial({
        vertexShader: STAR_VERTEX_SHADER,
        fragmentShader: STAR_FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uTime: { value: 0 },
          uPixelRatio: { value: dpr },
          uColor: { value: new THREE.Color("#cfd9ff") },
          uBaseOpacity: { value: 0.55 },
        },
      })
    );
    scene.add(new THREE.Points(starGeo, starMat));

    // 3. Master Orbital Stage Group
    const worldGroup = new THREE.Group();
    scene.add(worldGroup);

    // 4. Central Nested Refractive Living Prism (Category A `12e6c82e` Golden-Ratio Hypercube)
    const prismAnchor = new THREE.Group();
    prismAnchor.position.set(0, CORE_Y, 0);
    worldGroup.add(prismAnchor);

    const makeCrystalShell = (
      halfSize: number,
      shellAlpha: number,
      isInnerCore: boolean,
      rotEuler: [number, number, number]
    ) => {
      const grp = new THREE.Group();
      grp.rotation.set(rotEuler[0], rotEuler[1], rotEuler[2]);

      const boxGeo = track(new THREE.BoxGeometry(halfSize * 2, halfSize * 2, halfSize * 2));
      const facetMat = track(
        new THREE.ShaderMaterial({
          vertexShader: CRYSTAL_VERTEX_SHADER,
          fragmentShader: CRYSTAL_FRAGMENT_SHADER,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
          uniforms: {
            uTime: { value: 0 },
            uIsLight: { value: 0 },
            uShellAlpha: { value: shellAlpha },
            uInnerCore: { value: isInnerCore ? 1.0 : 0.0 },
            uWarmth: { value: 0.45 },
            uHighlight: { value: 0 },
            uPrimaryTint: { value: new THREE.Color("#6b52eb") },
            uSecondaryTint: { value: new THREE.Color("#c87aff") },
            uWarmTint: { value: new THREE.Color("#f09b7c") },
          },
        })
      );
      grp.add(new THREE.Mesh(boxGeo, facetMat));

      const edgesGeo = track(new THREE.EdgesGeometry(boxGeo));
      const edgeMat = track(
        new THREE.LineBasicMaterial({
          color: new THREE.Color("#e8daff"),
          transparent: true,
          opacity: 0.78,
        })
      );
      grp.add(new THREE.LineSegments(edgesGeo, edgeMat));

      return { grp, facetMat, edgeMat, halfSize };
    };

    const coreShell = makeCrystalShell(0.43, 0.56, true, [0.34, 0.62, 0.14]);
    prismAnchor.add(coreShell.grp);

    const midShell1 = makeCrystalShell(0.65, 0.18, false, [0.46, 0.82, -0.18]);
    prismAnchor.add(midShell1.grp);

    const midShell2 = makeCrystalShell(0.89, 0.12, false, [0.28, 0.44, -0.34]);
    prismAnchor.add(midShell2.grp);

    const outerShell = makeCrystalShell(1.14, 0.075, false, [0.38, -0.32, 0.26]);
    prismAnchor.add(outerShell.grp);

    // 12 Radial Dispersion Light Rays emanating from the inner crystal center (Category A 12e6c82e)
    const rayDirs = [
      new THREE.Vector3(-1.0, 0.66, -0.22),
      new THREE.Vector3(-1.0, 0.14, 0.16),
      new THREE.Vector3(-0.92, -0.44, 0.20),
      new THREE.Vector3(-0.46, -0.88, -0.15),
      new THREE.Vector3(0.44, -0.90, 0.18),
      new THREE.Vector3(0.95, -0.42, -0.18),
      new THREE.Vector3(1.0, 0.12, 0.22),
      new THREE.Vector3(0.92, 0.64, -0.16),
      new THREE.Vector3(-0.34, 0.92, -0.26),
      new THREE.Vector3(0.36, 0.90, 0.20),
      new THREE.Vector3(-0.68, -0.18, 0.70),
      new THREE.Vector3(0.68, 0.22, -0.68),
    ].map((v) => v.normalize());

    const rayPositions = new Float32Array(rayDirs.length * 2 * 3);
    const rayColors = new Float32Array(rayDirs.length * 2 * 4);
    rayDirs.forEach((dir, idx) => {
      rayPositions[idx * 6 + 0] = 0.0;
      rayPositions[idx * 6 + 1] = 0.0;
      rayPositions[idx * 6 + 2] = 0.0;
      rayPositions[idx * 6 + 3] = dir.x * 5.8;
      rayPositions[idx * 6 + 4] = dir.y * 5.8;
      rayPositions[idx * 6 + 5] = dir.z * 5.8;
    });
    const rayGeo = track(new THREE.BufferGeometry());
    rayGeo.setAttribute("position", new THREE.BufferAttribute(rayPositions, 3));
    rayGeo.setAttribute("color", new THREE.BufferAttribute(rayColors, 4));
    const rayMat = track(
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      })
    );
    prismAnchor.add(new THREE.LineSegments(rayGeo, rayMat));

    const hitSphereUnitGeo = track(new THREE.SphereGeometry(1, 16, 16));
    const invisibleHitMat = track(new THREE.MeshBasicMaterial({ visible: false }));
    const coreHitMesh = new THREE.Mesh(hitSphereUnitGeo, invisibleHitMat);
    coreHitMesh.scale.setScalar(1.02);
    coreHitMesh.userData = { pickKind: "core", pickId: "core" };
    prismAnchor.add(coreHitMesh);

    // 5. Inner Sentinel Ring for Staged Pending Approvals (#1..#5)
    const sentinelGroup = new THREE.Group();
    sentinelGroup.position.set(0, CORE_Y, 0);
    sentinelGroup.rotation.set(0.32, 0.14, -0.18);
    worldGroup.add(sentinelGroup);

    const sentinelRingPts: THREE.Vector3[] = [];
    for (let i = 0; i <= 128; i++) {
      const a = (i / 128) * Math.PI * 2;
      sentinelRingPts.push(new THREE.Vector3(Math.cos(a) * 1.56, 0, Math.sin(a) * 1.56));
    }
    const sentinelRingGeo = track(new THREE.BufferGeometry().setFromPoints(sentinelRingPts));
    const sentinelRingMat = track(
      new THREE.LineBasicMaterial({
        color: new THREE.Color("#f3c169"),
        transparent: true,
        opacity: 0.28,
      })
    );
    sentinelGroup.add(new THREE.Line(sentinelRingGeo, sentinelRingMat));

    const keyDirLight = new THREE.DirectionalLight(0xffffff, 1.8);
    keyDirLight.position.set(3.5, 5.0, 4.5);
    scene.add(keyDirLight);
    const corePointLight = new THREE.PointLight(0xdca8ff, 2.4, 10);
    corePointLight.position.set(0, CORE_Y, 0.35);
    scene.add(corePointLight);

    const MAX_SENTINELS = 10;
    const gemGeo = track(new THREE.OctahedronGeometry(0.052, 0));
    const sentinelMeshes: Array<{
      pivot: THREE.Group;
      gem: THREE.Mesh;
      mat: THREE.MeshStandardMaterial;
      hit: THREE.Mesh;
    }> = [];

    for (let i = 0; i < MAX_SENTINELS; i++) {
      const pivot = new THREE.Group();
      const mat = track(
        new THREE.MeshStandardMaterial({
          color: new THREE.Color("#ffd485"),
          emissive: new THREE.Color("#e08b24"),
          emissiveIntensity: 0.85,
          roughness: 0.16,
          metalness: 0.5,
        })
      );
      const gem = new THREE.Mesh(gemGeo, mat);
      pivot.add(gem);
      const hit = new THREE.Mesh(hitSphereUnitGeo, invisibleHitMat);
      hit.scale.setScalar(0.22);
      hit.userData = { pickKind: "approval", pickIndex: i, pickId: `approval-${i}` };
      pivot.add(hit);
      sentinelGroup.add(pivot);
      sentinelMeshes.push({ pivot, gem, mat, hit });
    }

    // 6. Seven Eclipse Rim-Lit Celestial Worlds
    const planetSphereGeo = track(new THREE.SphereGeometry(1, 56, 56));
    const haloSphereGeo = track(new THREE.SphereGeometry(1.36, 36, 36));
    const hairlineRingPts: THREE.Vector3[] = [];
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      hairlineRingPts.push(new THREE.Vector3(Math.cos(a) * 1.58, 0, Math.sin(a) * 1.58));
    }
    const hairlineRingGeo = track(new THREE.BufferGeometry().setFromPoints(hairlineRingPts));
    const moonGeo = track(new THREE.SphereGeometry(0.015, 14, 14));

    interface DomainNodeRig {
      slotIndex: number;
      orbitLine: THREE.Line;
      orbitMat: THREE.LineBasicMaterial;
      bodyGroup: THREE.Group;
      planetMesh: THREE.Mesh;
      planetMat: THREE.ShaderMaterial;
      haloMesh: THREE.Mesh;
      haloMat: THREE.ShaderMaterial;
      eqRingLine: THREE.Line;
      eqRingMat: THREE.LineBasicMaterial;
      moons: THREE.Mesh[];
      moonMat: THREE.MeshBasicMaterial;
      spokeLine: THREE.Line;
      spokeGeo: THREE.BufferGeometry;
      spokeMat: THREE.LineBasicMaterial;
      hitMesh: THREE.Mesh;
      worldPos: THREE.Vector3;
    }

    const domainRigs: DomainNodeRig[] = ORBITAL_SLOTS.map((slot, idx) => {
      const pts: THREE.Vector3[] = [];
      const tmp = new THREE.Vector3();
      for (let s = 0; s <= 160; s++) {
        evalOrbitPoint(slot, (s / 160) * Math.PI * 2, tmp);
        pts.push(tmp.clone());
      }
      const orbitGeo = track(new THREE.BufferGeometry().setFromPoints(pts));
      const orbitMat = track(
        new THREE.LineBasicMaterial({
          color: new THREE.Color("#6e7ba8"),
          transparent: true,
          opacity: 0.14,
        })
      );
      const orbitLine = new THREE.Line(orbitGeo, orbitMat);
      worldGroup.add(orbitLine);

      const bodyGroup = new THREE.Group();
      worldGroup.add(bodyGroup);

      const planetMat = track(
        new THREE.ShaderMaterial({
          vertexShader: PLANET_VERTEX_SHADER,
          fragmentShader: PLANET_FRAGMENT_SHADER,
          uniforms: {
            uCorePos: { value: new THREE.Vector3(0, CORE_Y, 0) },
            uRimColor: { value: new THREE.Color("#7db8ff") },
            uSurfaceColor: { value: new THREE.Color("#070912") },
            uIsLight: { value: 0 },
            uHover: { value: 0 },
            uTime: { value: 0 },
          },
        })
      );
      const planetMesh = new THREE.Mesh(planetSphereGeo, planetMat);
      bodyGroup.add(planetMesh);

      const haloMat = track(
        new THREE.ShaderMaterial({
          vertexShader: PLANET_VERTEX_SHADER,
          fragmentShader: HALO_FRAGMENT_SHADER,
          transparent: true,
          depthWrite: false,
          side: THREE.BackSide,
          blending: THREE.AdditiveBlending,
          uniforms: {
            uRimColor: { value: new THREE.Color("#7db8ff") },
            uIntensity: { value: 0.58 },
            uIsLight: { value: 0 },
          },
        })
      );
      const haloMesh = new THREE.Mesh(haloSphereGeo, haloMat);
      bodyGroup.add(haloMesh);

      // Delicate 1px hairline ring (only shown on Approvals or hovered world)
      const eqRingMat = track(
        new THREE.LineBasicMaterial({
          color: new THREE.Color("#f3c169"),
          transparent: true,
          opacity: 0.45,
        })
      );
      const eqRingLine = new THREE.Line(hairlineRingGeo, eqRingMat);
      eqRingLine.rotation.set(0.38, 0.22, -0.24);
      bodyGroup.add(eqRingLine);

      const moonMat = track(
        new THREE.MeshBasicMaterial({
          color: new THREE.Color("#ff9d7a"),
          transparent: true,
          opacity: 0.92,
        })
      );
      const moons: THREE.Mesh[] = [];
      for (let m = 0; m < 5; m++) {
        const moon = new THREE.Mesh(moonGeo, moonMat);
        bodyGroup.add(moon);
        moons.push(moon);
      }

      const spokePts = new Float32Array([0, CORE_Y, 0, 0, CORE_Y, 0]);
      const spokeGeo = track(new THREE.BufferGeometry());
      spokeGeo.setAttribute("position", new THREE.BufferAttribute(spokePts, 3));
      const spokeMat = track(
        new THREE.LineBasicMaterial({
          color: new THREE.Color("#82b8ff"),
          transparent: true,
          opacity: 0.0,
          depthWrite: false,
        })
      );
      const spokeLine = new THREE.Line(spokeGeo, spokeMat);
      worldGroup.add(spokeLine);

      const hitMesh = new THREE.Mesh(hitSphereUnitGeo, invisibleHitMat);
      hitMesh.scale.setScalar(0.42);
      hitMesh.userData = { pickKind: "domain", slotIndex: idx, pickId: `domain-${idx}` };
      bodyGroup.add(hitMesh);

      return {
        slotIndex: idx,
        orbitLine,
        orbitMat,
        bodyGroup,
        planetMesh,
        planetMat,
        haloMesh,
        haloMat,
        eqRingLine,
        eqRingMat,
        moons,
        moonMat,
        spokeLine,
        spokeGeo,
        spokeMat,
        hitMesh,
        worldPos: new THREE.Vector3(),
      };
    });

    // 7. Curved Inter-Domain Photon Strands
    const MAX_STRANDS = 6;
    const strandRigs = Array.from({ length: MAX_STRANDS }, () => {
      const posArr = new Float32Array(41 * 3);
      const geo = track(new THREE.BufferGeometry());
      geo.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
      const mat = track(
        new THREE.LineBasicMaterial({
          color: new THREE.Color("#f3c169"),
          transparent: true,
          opacity: 0.36,
          depthWrite: false,
        })
      );
      const line = new THREE.Line(geo, mat);
      line.visible = false;
      worldGroup.add(line);

      const photonMat = track(
        new THREE.MeshBasicMaterial({
          color: new THREE.Color("#ffe09e"),
          transparent: true,
          opacity: 0.95,
        })
      );
      const photon = new THREE.Mesh(moonGeo, photonMat);
      photon.scale.setScalar(1.2);
      photon.visible = false;
      worldGroup.add(photon);

      return { line, geo, mat, photon, photonMat };
    });

    const pickTargets: THREE.Object3D[] = [
      coreHitMesh,
      ...sentinelMeshes.map((s) => s.hit),
      ...domainRigs.map((d) => d.hitMesh),
    ];
    const raycaster = new THREE.Raycaster();
    const pointerVec = new THREE.Vector2(-99, -99);

    const handleResize = () => {
      if (!mountEl) return;
      const w = Math.max(mountEl.clientWidth, 240);
      const h = Math.max(mountEl.clientHeight, 240);
      const nextDpr = Math.min(window.devicePixelRatio || 1, 2);
      renderer.setPixelRatio(nextDpr);
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.fov = w < 1050 ? 44 : w > 1700 ? 36 : 38;
      camera.updateProjectionMatrix();
      skyMat.uniforms.uAspect.value.set(w, h);
      starMat.uniforms.uPixelRatio.value = nextDpr;
      if (composer) composer.setSize(w, h);
      if (bloomPass) bloomPass.resolution.set(w, h);
      requestFrameRef.current();
    };
    handleResize();
    const ro = new ResizeObserver(handleResize);
    ro.observe(mountEl);

    const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let rafId = 0;
    let lastTs = performance.now();
    // Phase 0.0 keeps all 7 planets balanced across left & right wings with clear view of central nucleus!
    let elapsedSim = 0.0;
    let lensThrottle = 0;
    let lastProjectedTs = 0;
    let lastProjectedJson = "";

    const tmpMid = new THREE.Vector3();
    const tmpProj = new THREE.Vector3();
    const tmpColorInner = new THREE.Color();
    const tmpColorOuter = new THREE.Color();

    const orderedSortIds = [
      "approvals",
      "engineering",
      "communications",
      "meetings",
      "knowledge",
      "infrastructure",
      "executive",
    ];

    const renderLoop = (now: number) => {
      rafId = 0;
      const dt = Math.min(0.05, (now - lastTs) / 1000);
      lastTs = now;

      const props = latestPropsRef.current;
      const isHidden = document.visibilityState === "hidden";
      const reduced = reducedMotionQuery.matches;
      if (isHidden) {
        return;
      }
      const isLight = props.resolvedTheme === "light";
      const rig = cameraRigRef.current;
      const ptr = pointerInteractionRef.current;

      if (!reduced && !props.systemPaused && !isHidden) {
        const speedMult = props.runningMissions > 0 ? 1.55 : 1.0;
        elapsedSim += dt * speedMult;
      }

      renderer.toneMappingExposure = isLight ? 1.0 : 1.08;
      if (bloomPass) {
        bloomPass.strength = isLight ? 0.0 : 0.46;
        bloomPass.radius = isLight ? 0.0 : 0.64;
        bloomPass.threshold = isLight ? 1.2 : 0.48;
      }

      const totalUrgent = props.domains.reduce((acc, d) => acc + (d.urgent_count || 0), 0);
      const warmthTarget = Math.min(
        1.0,
        (props.pendingApprovals > 0 ? 0.55 : 0.14) + Math.min(totalUrgent, 6) * 0.07
      );
      const energyTarget = Math.min(
        1.0,
        (props.runningMissions > 0 ? 0.8 : 0.26) + (props.systemPaused ? -0.16 : 0)
      );

      skyMat.uniforms.uTime.value = elapsedSim;
      skyMat.uniforms.uIsLight.value = isLight ? 1.0 : 0.0;
      skyMat.uniforms.uWarmth.value += (warmthTarget - skyMat.uniforms.uWarmth.value) * 0.08;
      skyMat.uniforms.uEnergy.value += (energyTarget - skyMat.uniforms.uEnergy.value) * 0.08;

      starMat.uniforms.uTime.value = elapsedSim;
      starMat.uniforms.uColor.value.set(isLight ? "#5672a8" : "#d8e2ff");
      starMat.uniforms.uBaseOpacity.value = isLight ? 0.24 : 0.58;
      starMat.blending = isLight ? THREE.NormalBlending : THREE.AdditiveBlending;

      if (!ptr.down) {
        rig.yaw += rig.velYaw;
        rig.pitch = Math.max(-0.48, Math.min(0.52, rig.pitch + rig.velPitch));
        rig.velYaw *= 0.91;
        rig.velPitch *= 0.91;
      }
      rig.smoothPtrX += (rig.pointerNdcX - rig.smoothPtrX) * 0.065;
      rig.smoothPtrY += (rig.pointerNdcY - rig.smoothPtrY) * 0.065;

      const targetWarp = props.transitioningOut ? 1.0 : 0.0;
      rig.warpProgress += (targetWarp - rig.warpProgress) * (reduced ? 0.5 : 0.18);

      const driftX = reduced ? 0 : Math.sin(elapsedSim * 0.22) * 0.11;
      const driftY = reduced ? 0 : Math.cos(elapsedSim * 0.17) * 0.07;
      const camDist = rig.zoomDist * (1.0 - rig.warpProgress * 0.24);

      camera.position.set(
        driftX + rig.smoothPtrX * 0.32,
        0.20 + driftY + rig.smoothPtrY * 0.20,
        camDist
      );
      camera.lookAt(0, CORE_Y * 0.52, 0);

      worldGroup.rotation.y = rig.yaw + (reduced ? 0 : Math.sin(elapsedSim * 0.08) * 0.05);
      worldGroup.rotation.x = rig.pitch;

      const activeHighlightId = props.externalHighlightId || ptr.hoveredPickId || props.selectedId;
      const coreHighlighted = activeHighlightId === "core" ? 1.0 : 0.0;
      const breathe = reduced || props.systemPaused ? 1.0 : 1.0 + Math.sin(elapsedSim * 0.95) * 0.02;
      prismAnchor.scale.setScalar(breathe);

      coreShell.grp.rotation.y = 0.64 + elapsedSim * 0.11;
      coreShell.grp.rotation.x = 0.36 + Math.sin(elapsedSim * 0.24) * 0.07;

      midShell1.grp.rotation.y = 0.86 - elapsedSim * 0.068;
      midShell1.grp.rotation.z = -0.20 + Math.cos(elapsedSim * 0.19) * 0.05;

      midShell2.grp.rotation.y = 0.38 + elapsedSim * 0.044;
      midShell2.grp.rotation.x = -0.34 + Math.sin(elapsedSim * 0.15) * 0.04;

      outerShell.grp.rotation.y = -0.42 - elapsedSim * 0.028;

      const shells = [coreShell, midShell1, midShell2, outerShell];
      shells.forEach((sh, idx) => {
        sh.facetMat.uniforms.uTime.value = elapsedSim;
        sh.facetMat.uniforms.uIsLight.value = isLight ? 1.0 : 0.0;
        sh.facetMat.uniforms.uWarmth.value = warmthTarget;
        sh.facetMat.uniforms.uHighlight.value = coreHighlighted;

        if (props.systemPaused) {
          sh.facetMat.uniforms.uPrimaryTint.value.set(isLight ? "#50586c" : "#6c7691");
          sh.facetMat.uniforms.uSecondaryTint.value.set(isLight ? "#6e768c" : "#8f99b5");
          sh.edgeMat.color.set(isLight ? "#444c60" : "#9aa3bd");
        } else {
          sh.facetMat.uniforms.uPrimaryTint.value.set(
            idx === 0
              ? isLight
                ? "#4c35b5"
                : "#7c5cff"
              : isLight
              ? "#2c50ad"
              : "#6e8cff"
          );
          sh.facetMat.uniforms.uSecondaryTint.value.set(
            idx === 0
              ? isLight
                ? "#8c3fb5"
                : "#d98eff"
              : isLight
              ? "#5e38a8"
              : "#a97eff"
          );
          sh.facetMat.uniforms.uWarmTint.value.set(isLight ? "#c25b2e" : "#f5a484");
          sh.edgeMat.color.set(
            isLight
              ? idx === 0
                ? "#140e4d"
                : idx === 1
                ? "#1d388f"
                : idx === 2
                ? "#30478a"
                : "#475a8f"
              : idx === 0
              ? "#f2e6ff"
              : idx === 1
              ? "#bfaef8"
              : "#7f8cd4"
          );
        }
        const baseEdgeOpacity = isLight
          ? idx === 0
            ? 0.98
            : idx === 1
            ? 0.88
            : idx === 2
            ? 0.72
            : 0.56
          : idx === 0
          ? 0.88
          : idx === 1
          ? 0.56
          : idx === 2
          ? 0.36
          : 0.22;
        sh.edgeMat.opacity = Math.min(1.0, baseEdgeOpacity * (1.0 + coreHighlighted * 0.22));
      });

      // Update Radial Dispersion Rays
      rayMat.opacity = isLight ? 0.78 : 0.55;
      const rColAttr = rayGeo.getAttribute("color") as THREE.BufferAttribute;
      tmpColorInner.set(isLight ? "#1f3fa3" : "#dfcfff");
      tmpColorOuter.set(isLight ? "#f4f0e8" : "#05060a");
      for (let i = 0; i < rayDirs.length; i++) {
        rColAttr.setXYZW(i * 2, tmpColorInner.r, tmpColorInner.g, tmpColorInner.b, isLight ? 0.58 : 0.38);
        rColAttr.setXYZW(i * 2 + 1, tmpColorOuter.r, tmpColorOuter.g, tmpColorOuter.b, 0.0);
      }
      rColAttr.needsUpdate = true;

      // Update Inner Sentinel Ring (5 staged pending approvals)
      const approvalCount = Math.min(
        MAX_SENTINELS,
        Math.max(props.pendingApprovals, props.approvalsList.length)
      );
      sentinelRingMat.color.set(
        approvalCount > 0 ? (isLight ? "#b56808" : "#f3c169") : isLight ? "#6d7488" : "#5b6482"
      );
      sentinelRingMat.opacity = approvalCount > 0 ? (isLight ? 0.48 : 0.28) : isLight ? 0.18 : 0.08;

      sentinelMeshes.forEach((sm, idx) => {
        if (idx < approvalCount) {
          sm.pivot.visible = true;
          const a = (idx / Math.max(approvalCount, 1)) * Math.PI * 2 + elapsedSim * 0.20 + 0.35;
          sm.pivot.position.set(Math.cos(a) * 1.56, Math.sin(a * 2.0) * 0.05, Math.sin(a) * 1.56);
          sm.gem.rotation.y = elapsedSim * 0.9 + idx;
          sm.gem.rotation.x = 0.4 + idx * 0.3;
          const isHov = ptr.hoveredPickId === `approval-${idx}`;
          sm.gem.scale.setScalar(isHov ? 1.45 : 1.0);
          sm.mat.color.set(isLight ? "#c47108" : "#ffd685");
          sm.mat.emissive.set(isLight ? "#965304" : "#e39224");
          sm.mat.emissiveIntensity = isHov ? 1.35 : 0.82;
        } else {
          sm.pivot.visible = false;
        }
      });

      // Update 7 Celestial Domain Worlds
      const sortedDomains = [...props.domains].sort((a, b) => {
        const ia = orderedSortIds.indexOf(a.id);
        const ib = orderedSortIds.indexOf(b.id);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      });

      const domainPosMap = new Map<string, THREE.Vector3>();

      domainRigs.forEach((dRig, idx) => {
        const dom = sortedDomains[idx];
        if (!dom) {
          dRig.bodyGroup.visible = false;
          dRig.orbitLine.visible = false;
          dRig.spokeLine.visible = false;
          return;
        }

        dRig.bodyGroup.visible = true;
        dRig.orbitLine.visible = true;
        dRig.hitMesh.userData.domain = dom;
        dRig.hitMesh.userData.pickId = dom.id;

        const slot = ORBITAL_SLOTS[idx % ORBITAL_SLOTS.length];
        const theta = slot.phase + elapsedSim * slot.speed;
        evalOrbitPoint(slot, theta, dRig.worldPos);
        dRig.bodyGroup.position.copy(dRig.worldPos);
        domainPosMap.set(dom.id, dRig.worldPos);

        const isHighlighted =
          activeHighlightId === dom.id ||
          activeHighlightId === dom.target_view.toLowerCase();

        const baseRadius = Math.min(
          0.26,
          Math.max(0.115, 0.11 + Math.log2((dom.active_count || 0) + 1) * 0.028)
        );
        const targetScale = baseRadius * (isHighlighted ? 1.24 : 1.0);
        dRig.planetMesh.scale.setScalar(targetScale);
        dRig.haloMesh.scale.setScalar(targetScale);
        dRig.eqRingLine.scale.setScalar(targetScale);
        dRig.hitMesh.scale.setScalar(Math.max(0.42, targetScale * 2.1));

        const style = getDomainSemanticStyle(dom.state, dom.id, isLight);
        dRig.planetMat.uniforms.uRimColor.value.set(style.rimHex);
        dRig.planetMat.uniforms.uSurfaceColor.value.set(style.surfaceHex);
        dRig.planetMat.uniforms.uIsLight.value = isLight ? 1.0 : 0.0;
        dRig.planetMat.uniforms.uHover.value +=
          ((isHighlighted ? 1.0 : 0.0) - dRig.planetMat.uniforms.uHover.value) * 0.18;
        dRig.planetMat.uniforms.uTime.value = elapsedSim;

        dRig.haloMat.uniforms.uRimColor.value.set(style.rimHex);
        dRig.haloMat.uniforms.uIsLight.value = isLight ? 1.0 : 0.0;
        dRig.haloMat.uniforms.uIntensity.value = isHighlighted
          ? 0.92
          : dom.state === "quiet"
          ? 0.28
          : 0.56;
        dRig.haloMat.blending = isLight ? THREE.NormalBlending : THREE.AdditiveBlending;

        const showRing = dom.id === "approvals" || isHighlighted;
        dRig.eqRingLine.visible = showRing;
        if (showRing) {
          dRig.eqRingMat.color.set(style.rimHex);
          dRig.eqRingMat.opacity = isHighlighted ? 0.65 : isLight ? 0.42 : 0.38;
          dRig.eqRingLine.rotation.y = elapsedSim * 0.16 + idx;
        }

        const moonCount = Math.min(3, dom.urgent_count || 0);
        dRig.moonMat.color.set(style.rimHex);
        dRig.moonMat.opacity = isLight ? 0.65 : 0.85;
        dRig.moons.forEach((moon, mIdx) => {
          if (mIdx < moonCount) {
            moon.visible = true;
            // Keep moons along lateral orbital wings so they frame the crescent rather than sitting dead-center on dark planet disc
            const wingAngle = (mIdx === 0 ? 0.12 : mIdx === 1 ? Math.PI - 0.18 : 0.48) + elapsedSim * 0.45;
            const mr = targetScale * 1.92;
            moon.position.set(
              Math.cos(wingAngle) * mr,
              Math.sin(wingAngle * 1.3) * targetScale * 0.36,
              Math.sin(wingAngle) * mr * 0.35
            );
          } else {
            moon.visible = false;
          }
        });

        dRig.orbitMat.color.set(
          isHighlighted ? style.rimHex : isLight ? "#3e5388" : "#6c7aa6"
        );
        dRig.orbitMat.opacity = isHighlighted
          ? isLight
            ? 0.85
            : 0.45
          : isLight
          ? 0.40
          : 0.11;

        const showSpoke = isHighlighted || dom.state === "running";
        dRig.spokeLine.visible = showSpoke;
        if (showSpoke) {
          const sAttr = dRig.spokeGeo.getAttribute("position") as THREE.BufferAttribute;
          sAttr.setXYZ(0, 0, CORE_Y, 0);
          sAttr.setXYZ(1, dRig.worldPos.x, dRig.worldPos.y, dRig.worldPos.z);
          sAttr.needsUpdate = true;
          dRig.spokeMat.color.set(style.rimHex);
          dRig.spokeMat.opacity = isHighlighted ? 0.45 : 0.16;
        }
      });

      // Update Curved Inter-Domain Signal Strands
      strandRigs.forEach((sRig, sIdx) => {
        const strand = props.strands[sIdx];
        const fromPos = strand ? domainPosMap.get(strand.from) : undefined;
        const toPos = strand ? domainPosMap.get(strand.to) : undefined;
        if (!strand || !fromPos || !toPos) {
          sRig.line.visible = false;
          sRig.photon.visible = false;
          return;
        }
        sRig.line.visible = true;
        tmpMid.copy(fromPos).add(toPos).multiplyScalar(0.5);
        tmpMid.y += 0.52;
        tmpMid.z += 0.22;

        const posAttr = sRig.geo.getAttribute("position") as THREE.BufferAttribute;
        for (let k = 0; k <= 40; k++) {
          const t = k / 40;
          const inv = 1 - t;
          posAttr.setXYZ(
            k,
            inv * inv * fromPos.x + 2 * inv * t * tmpMid.x + t * t * toPos.x,
            inv * inv * fromPos.y + 2 * inv * t * tmpMid.y + t * t * toPos.y,
            inv * inv * fromPos.z + 2 * inv * t * tmpMid.z + t * t * toPos.z
          );
        }
        posAttr.needsUpdate = true;

        const sColor =
          strand.state === "awaiting_approval"
            ? isLight
              ? "#b56808"
              : "#f3c169"
            : isLight
            ? "#245fd1"
            : "#82b8ff";
        sRig.mat.color.set(sColor);
        sRig.mat.opacity = isLight ? 0.56 : 0.34;

        if (!reduced && !props.systemPaused) {
          sRig.photon.visible = true;
          const pt = (elapsedSim * 0.26 + sIdx * 0.33) % 1;
          const inv = 1 - pt;
          sRig.photon.position.set(
            inv * inv * fromPos.x + 2 * inv * pt * tmpMid.x + pt * pt * toPos.x,
            inv * inv * fromPos.y + 2 * inv * pt * tmpMid.y + pt * pt * toPos.y,
            inv * inv * fromPos.z + 2 * inv * pt * tmpMid.z + pt * pt * toPos.z
          );
          sRig.photonMat.color.set(sColor);
        } else {
          sRig.photon.visible = false;
        }
      });

      corePointLight.color.set(
        props.pendingApprovals > 0 ? "#e6b8ff" : props.runningMissions > 0 ? "#82b8ff" : "#c49eff"
      );

      // Raycasting & Projected Spatial Coordinates
      lensThrottle++;
      const shouldUpdateRaycast = reduced || lensThrottle % 2 === 0;
      if (shouldUpdateRaycast && mountEl) {
        const w = mountEl.clientWidth;
        const h = mountEl.clientHeight;
        let nextLens: HoverLensState | null = null;

        // Expose throttled projected 2D screen coordinates for direct 3D canvas inspection
        if (now - lastProjectedTs >= 250 || !lastProjectedJson) {
          lastProjectedTs = now;
          const projectedMap: Record<string, { x: number; y: number }> = {};
          coreHitMesh.getWorldPosition(tmpProj).project(camera);
          projectedMap.core = {
            x: Math.round((tmpProj.x * 0.5 + 0.5) * w),
            y: Math.round((-tmpProj.y * 0.5 + 0.5) * h),
          };
          domainRigs.forEach((r) => {
            const dom = r.hitMesh.userData.domain as OrbitDomainNode | undefined;
            if (dom && r.bodyGroup.visible) {
              r.hitMesh.getWorldPosition(tmpProj).project(camera);
              projectedMap[dom.id] = {
                x: Math.round((tmpProj.x * 0.5 + 0.5) * w),
                y: Math.round((-tmpProj.y * 0.5 + 0.5) * h),
              };
            }
          });
          const nextJson = JSON.stringify(projectedMap);
          if (nextJson !== lastProjectedJson) {
            lastProjectedJson = nextJson;
            renderer.domElement.dataset.projectedNodes = nextJson;
          }
        }

        if (!ptr.down && pointerVec.x >= -1 && pointerVec.x <= 1) {
          raycaster.setFromCamera(pointerVec, camera);
          const hits = raycaster.intersectObjects(pickTargets, false);
          const hit = hits.find((hItem) => {
            let cur: THREE.Object3D | null = hItem.object;
            while (cur) {
              if (!cur.visible) return false;
              cur = cur.parent;
            }
            return true;
          });

          if (hit) {
            const ud = hit.object.userData;
            ptr.hoveredPickId = ud.pickId as string;
            renderer.domElement.style.cursor = "pointer";

            hit.object.getWorldPosition(tmpProj).project(camera);
            const sx = (tmpProj.x * 0.5 + 0.5) * w;
            const sy = (-tmpProj.y * 0.5 + 0.5) * h;

            if (ud.pickKind === "core") {
              nextLens = {
                id: "core",
                kind: "core",
                title: props.systemPaused ? "Prism Core · Paused" : "Prism Core",
                stateLabel: props.healthStatus === "offline" ? "Offline Local" : "Live Engine",
                metric: `${props.neededFromMe} owned · ${props.pendingApprovals} gated · ${props.runningMissions} running`,
                preview:
                  props.pendingApprovals > 0
                    ? `${props.pendingApprovals} staged action(s) awaiting human sign-off`
                    : "All outbound guardrails enforced locally",
                hint: "Click to inspect · Double-click for Approvals",
                accentHex:
                  props.pendingApprovals > 0
                    ? isLight
                      ? "#c26a0a"
                      : "#f3c169"
                    : isLight
                    ? "#2059c9"
                    : "#8baeff",
                x: sx,
                y: sy,
              };
            } else if (ud.pickKind === "approval") {
              const appItem = props.approvalsList[ud.pickIndex as number];
              nextLens = {
                id: ud.pickId as string,
                kind: "approval",
                title: appItem ? `Approval #${appItem.id}` : "Staged Approval",
                stateLabel: "Awaiting Sign-Off",
                metric: appItem?.action_type || "outbound_gated",
                preview: appItem?.title || "Pending human review in Approvals",
                hint: "Click to review in Approvals",
                accentHex: isLight ? "#c26a0a" : "#f3c169",
                x: sx,
                y: sy,
              };
            } else if (ud.pickKind === "domain" && ud.domain) {
              const dom = ud.domain as OrbitDomainNode;
              const style = getDomainSemanticStyle(dom.state, dom.id, isLight);
              nextLens = {
                id: dom.id,
                kind: "domain",
                title: dom.label,
                stateLabel: style.stateLabel,
                metric: dom.summary,
                preview: dom.items[0]?.title,
                hint: `Click to inspect · Double-click for ${dom.target_view}`,
                accentHex: style.lensHex,
                x: sx,
                y: sy,
              };
            }
          } else {
            ptr.hoveredPickId = null;
            renderer.domElement.style.cursor = "grab";
          }
        } else if (!ptr.down && props.externalHighlightId) {
          const matchedRig = domainRigs.find((r) => {
            const d = r.hitMesh.userData.domain as OrbitDomainNode | undefined;
            return (
              d &&
              (d.id === props.externalHighlightId ||
                d.target_view.toLowerCase() === props.externalHighlightId)
            );
          });
          if (matchedRig && matchedRig.bodyGroup.visible) {
            const dom = matchedRig.hitMesh.userData.domain as OrbitDomainNode;
            const style = getDomainSemanticStyle(dom.state, dom.id, isLight);
            matchedRig.hitMesh.getWorldPosition(tmpProj).project(camera);
            nextLens = {
              id: dom.id,
              kind: "domain",
              title: dom.label,
              stateLabel: style.stateLabel,
              metric: dom.summary,
              preview: dom.items[0]?.title,
              hint: `Click to open ${dom.target_view}`,
              accentHex: style.lensHex,
              x: (tmpProj.x * 0.5 + 0.5) * w,
              y: (-tmpProj.y * 0.5 + 0.5) * h,
            };
          }
        }

        // Suppress duplicate hover tooltip when the same orbital node is already open in the right-hand inspector
        if (nextLens && props.selectedId && nextLens.id === props.selectedId) {
          nextLens = null;
        }

        setHoverLens((prev) => {
          if (!prev && !nextLens) return prev;
          if (
            prev &&
            nextLens &&
            prev.id === nextLens.id &&
            Math.abs(prev.x - nextLens.x) < 2 &&
            Math.abs(prev.y - nextLens.y) < 2
          ) {
            return prev;
          }
          return nextLens;
        });
      }

      if (composer) {
        composer.render();
      } else {
        renderer.render(scene, camera);
      }

      if (!isHidden && !reduced) {
        rafId = window.requestAnimationFrame(renderLoop);
      }
    };

    const scheduleSingleFrame = () => {
      if (document.visibilityState === "hidden") return;
      if (rafId === 0) {
        lastTs = performance.now();
        rafId = window.requestAnimationFrame(renderLoop);
      }
    };
    requestFrameRef.current = scheduleSingleFrame;

    scheduleSingleFrame();

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        scheduleSingleFrame();
      } else if (rafId !== 0) {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    const onReducedMotionChange = () => {
      if (reducedMotionQuery.matches) {
        if (rafId !== 0) {
          window.cancelAnimationFrame(rafId);
          rafId = 0;
        }
        scheduleSingleFrame();
      } else {
        scheduleSingleFrame();
      }
    };
    reducedMotionQuery.addEventListener("change", onReducedMotionChange);

    const domCanvas = renderer.domElement;

    const updateNdcFromEvent = (clientX: number, clientY: number) => {
      const rect = domCanvas.getBoundingClientRect();
      const nx = ((clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
      const ny = -((clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1;
      pointerVec.set(nx, ny);
      cameraRigRef.current.pointerNdcX = nx;
      cameraRigRef.current.pointerNdcY = ny;
      if (reducedMotionQuery.matches) {
        requestFrameRef.current();
      }
    };

    const onPointerDown = (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      updateNdcFromEvent(ev.clientX, ev.clientY);
      pointerInteractionRef.current.down = true;
      pointerInteractionRef.current.moved = false;
      pointerInteractionRef.current.startX = ev.clientX;
      pointerInteractionRef.current.startY = ev.clientY;
      pointerInteractionRef.current.lastX = ev.clientX;
      pointerInteractionRef.current.lastY = ev.clientY;
      setIsDragging(true);
      domCanvas.style.cursor = "grabbing";
      try {
        domCanvas.setPointerCapture(ev.pointerId);
      } catch {
        // ignore
      }
    };

    const onPointerMove = (ev: PointerEvent) => {
      updateNdcFromEvent(ev.clientX, ev.clientY);
      const ptr = pointerInteractionRef.current;
      if (!ptr.down) return;

      const dx = ev.clientX - ptr.lastX;
      const dy = ev.clientY - ptr.lastY;
      if (Math.hypot(ev.clientX - ptr.startX, ev.clientY - ptr.startY) > 5) {
        ptr.moved = true;
      }
      ptr.lastX = ev.clientX;
      ptr.lastY = ev.clientY;

      cameraRigRef.current.yaw += dx * 0.0048;
      cameraRigRef.current.pitch = Math.max(
        -0.48,
        Math.min(0.52, cameraRigRef.current.pitch + dy * 0.0038)
      );
      cameraRigRef.current.velYaw = dx * 0.00065;
      cameraRigRef.current.velPitch = dy * 0.00045;
    };

    const resolveRaycastClick = (isDoubleClick: boolean) => {
      raycaster.setFromCamera(pointerVec, camera);
      const hits = raycaster.intersectObjects(pickTargets, false);
      const hit = hits.find((hItem) => {
        let cur: THREE.Object3D | null = hItem.object;
        while (cur) {
          if (!cur.visible) return false;
          cur = cur.parent;
        }
        return true;
      });

      const props = latestPropsRef.current;
      if (!hit) {
        if (!isDoubleClick) props.onSelect(null);
        return;
      }

      const ud = hit.object.userData;
      if (ud.pickKind === "approval") {
        if (props.onOpenApprovals) props.onOpenApprovals();
      } else if (ud.pickKind === "core") {
        if (isDoubleClick && props.onOpenApprovals) {
          props.onOpenApprovals();
        } else {
          props.onSelect(props.selectedId === "core" ? null : "core");
        }
      } else if (ud.pickKind === "domain" && ud.domain) {
        const dom = ud.domain as OrbitDomainNode;
        if (isDoubleClick) {
          props.onActivateDomain(dom);
        } else {
          props.onSelect(props.selectedId === dom.id ? null : dom.id);
        }
      }
    };

    const onPointerUp = (ev: PointerEvent) => {
      const ptr = pointerInteractionRef.current;
      const wasClick = ptr.down && !ptr.moved;
      ptr.down = false;
      setIsDragging(false);
      domCanvas.style.cursor = ptr.hoveredPickId ? "pointer" : "grab";
      try {
        domCanvas.releasePointerCapture(ev.pointerId);
      } catch {
        // ignore
      }
      if (wasClick) {
        updateNdcFromEvent(ev.clientX, ev.clientY);
        resolveRaycastClick(false);
      }
    };

    const onDoubleClick = (ev: MouseEvent) => {
      updateNdcFromEvent(ev.clientX, ev.clientY);
      resolveRaycastClick(true);
    };

    const onPointerLeave = () => {
      pointerVec.set(-99, -99);
      cameraRigRef.current.pointerNdcX = 0;
      cameraRigRef.current.pointerNdcY = 0;
      pointerInteractionRef.current.hoveredPickId = null;
      setHoverLens(null);
      if (reducedMotionQuery.matches) {
        requestFrameRef.current();
      }
    };

    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      cameraRigRef.current.zoomDist = Math.max(
        6.8,
        Math.min(11.2, cameraRigRef.current.zoomDist + ev.deltaY * 0.0032)
      );
      if (reducedMotionQuery.matches) {
        requestFrameRef.current();
      }
    };

    domCanvas.addEventListener("pointerdown", onPointerDown);
    domCanvas.addEventListener("pointermove", onPointerMove);
    domCanvas.addEventListener("pointerup", onPointerUp);
    domCanvas.addEventListener("dblclick", onDoubleClick);
    domCanvas.addEventListener("pointerleave", onPointerLeave);
    domCanvas.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      if (rafId !== 0) window.cancelAnimationFrame(rafId);
      requestFrameRef.current = () => {};
      document.removeEventListener("visibilitychange", onVisibilityChange);
      reducedMotionQuery.removeEventListener("change", onReducedMotionChange);
      ro.disconnect();
      domCanvas.removeEventListener("pointerdown", onPointerDown);
      domCanvas.removeEventListener("pointermove", onPointerMove);
      domCanvas.removeEventListener("pointerup", onPointerUp);
      domCanvas.removeEventListener("dblclick", onDoubleClick);
      domCanvas.removeEventListener("pointerleave", onPointerLeave);
      domCanvas.removeEventListener("wheel", onWheel);
      if (composer) composer.dispose();
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      if (domCanvas.parentNode === mountEl) {
        mountEl.removeChild(domCanvas);
      }
    };
  }, []);

  useEffect(() => {
    requestFrameRef.current();
  }, [
    coreState,
    systemPaused,
    healthStatus,
    runningMissions,
    pendingApprovals,
    neededFromMe,
    resolvedTheme,
    domains,
    strands,
    approvalsList,
    selectedId,
    externalHighlightId,
    transitioningOut,
  ]);

  return (
    <div
      role="region"
      aria-label={`${brandName} Living Prism operational orbit`}
      className="relative h-full w-full select-none overflow-hidden"
    >
      {/* Dedicated WebGL Mount Layer */}
      <div
        ref={mountRef}
        className={`h-full w-full ${isDragging ? "cursor-grabbing" : "cursor-grab"}`}
      />

      {/* Floating Spatial Hover Lens — projects above hovered 3D body */}
      {hoverLens && !isDragging && (
        <div
          role="status"
          aria-live="polite"
          style={{
            left: `clamp(160px, ${Math.round(hoverLens.x)}px, calc(100% - 160px))`,
            top: `clamp(96px, ${Math.round(hoverLens.y - 24)}px, calc(100% - 130px))`,
          }}
          className="ce-spatial-capsule pointer-events-none absolute z-20 w-[268px] -translate-x-1/2 -translate-y-full rounded-2xl px-3.5 py-2.5 transition-opacity duration-150"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-xs font-semibold text-[var(--ink)]">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: hoverLens.accentHex }}
              />
              <span>{hoverLens.title}</span>
            </span>
            <span className="font-mono text-[10px] text-[var(--muted)]">
              {hoverLens.stateLabel}
            </span>
          </div>
          <p className="mt-1 font-mono text-[11px] text-[var(--ink-secondary)] tabular-nums">
            {hoverLens.metric}
          </p>
          {hoverLens.preview && (
            <p className="mt-1 line-clamp-1 text-[11.5px] text-[var(--muted)]">
              {hoverLens.preview}
            </p>
          )}
          <p className="mt-1.5 text-[10px] text-[var(--subtle)]">{hoverLens.hint}</p>
        </div>
      )}

      {/* Keyboard & Screen-Reader Accessible Orbital Nodes (Separate from canvas hit layer) */}
      <div className="pointer-events-none absolute inset-x-0 top-14 z-20 flex flex-wrap justify-center gap-2 px-6">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSelect(selectedId === "core" ? null : "core");
          }}
          aria-pressed={selectedId === "core"}
          aria-label={`Orchestrator Core: ${neededFromMe} owned items, ${pendingApprovals} pending approvals, ${runningMissions} active missions`}
          className="ce-spatial-capsule pointer-events-auto sr-only focus:not-sr-only focus:rounded-full focus:border focus:px-3.5 focus:py-1.5 focus:text-xs focus:font-medium focus:text-[var(--ink)]"
        >
          Prism Core ({pendingApprovals} gated)
        </button>

        {orderedDomains.map((domain) => (
          <button
            key={domain.id}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelect(selectedId === domain.id ? null : domain.id);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onActivateDomain(domain);
            }}
            aria-pressed={selectedId === domain.id}
            aria-label={`${domain.label}: ${domain.summary}. Press Enter to inspect, double-click to open ${domain.target_view}.`}
            className="ce-spatial-capsule pointer-events-auto sr-only focus:not-sr-only focus:rounded-full focus:border focus:px-3.5 focus:py-1.5 focus:text-xs focus:font-medium focus:text-[var(--ink)]"
          >
            {domain.label} ({domain.active_count})
          </button>
        ))}
      </div>
    </div>
  );
}

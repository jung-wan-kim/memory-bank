import { CSSProperties } from "react";

export const colors = {
  bg: "#06090f",
  surface: "#0d1117",
  surface2: "#161b22",
  border: "#21262d",
  text: "#e6edf3",
  muted: "#8b949e",
  accent: "#a78bfa",   // purple
  blue: "#60a5fa",
  green: "#4ade80",
  orange: "#fb923c",
  red: "#f87171",
  cyan: "#22d3ee",
  yellow: "#fbbf24",
};

export const fullScreen: CSSProperties = {
  width: "100%",
  height: "100%",
  position: "absolute",
  top: 0,
  left: 0,
};

export const centered: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexDirection: "column",
};

export const mono = "'SF Mono', Menlo, 'Courier New', monospace";
export const sans = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { colors, sans, mono } from "../styles";

interface Node {
  id: string;
  label: string;
  x: number;
  y: number;
  color: string;
  category: string;
}

interface Edge {
  from: string;
  to: string;
  type: string;
}

const graphNodes: Node[] = [
  { id: "a", label: "TypeScript strict mode", x: 960, y: 360, color: colors.accent, category: "preference" },
  { id: "b", label: "ESM modules only", x: 640, y: 240, color: colors.green, category: "decision" },
  { id: "c", label: "Vitest for testing", x: 1280, y: 240, color: colors.purple, category: "decision" },
  { id: "d", label: "better-sqlite3 + sqlite-vec", x: 640, y: 500, color: colors.orange, category: "knowledge" },
  { id: "e", label: "384-dim embeddings", x: 1280, y: 500, color: colors.cyan, category: "pattern" },
  { id: "f", label: "try-finally DB close", x: 400, y: 380, color: colors.yellow, category: "pattern" },
  { id: "g", label: "Zod input validation", x: 1520, y: 380, color: colors.red, category: "constraint" },
];

const graphEdges: Edge[] = [
  { from: "a", to: "b", type: "SUPPORTS" },
  { from: "a", to: "c", type: "INFLUENCES" },
  { from: "d", to: "e", type: "SUPPORTS" },
  { from: "d", to: "f", type: "INFLUENCES" },
  { from: "a", to: "g", type: "SUPPORTS" },
  { from: "b", to: "d", type: "INFLUENCES" },
];

export const GraphScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleOpacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ background: colors.bg, fontFamily: sans }}>
      <div style={{ position: "absolute", top: 48, left: 0, right: 0, textAlign: "center" }}>
        <div style={{ fontSize: 14, fontWeight: 600, textTransform: "uppercase", letterSpacing: 3, color: colors.purple, fontFamily: mono, opacity: titleOpacity, marginBottom: 8 }}>
          knowledge graph
        </div>
        <div style={{ fontSize: 40, fontWeight: 600, color: colors.text, opacity: titleOpacity }}>
          Multi-hop Graph Exploration
        </div>
      </div>

      {/* SVG Edges */}
      <svg style={{ position: "absolute", top: 0, left: 0, width: 1920, height: 1080 }}>
        {graphEdges.map((edge, i) => {
          const fromNode = graphNodes.find(n => n.id === edge.from)!;
          const toNode = graphNodes.find(n => n.id === edge.to)!;
          const delay = 40 + i * 12;
          const edgeOpacity = interpolate(frame, [delay, delay + 15], [0, 0.4], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

          return (
            <line
              key={`${edge.from}-${edge.to}`}
              x1={fromNode.x}
              y1={fromNode.y}
              x2={toNode.x}
              y2={toNode.y}
              stroke={colors.accent}
              strokeWidth={2}
              opacity={edgeOpacity}
              strokeDasharray="6,4"
            />
          );
        })}
      </svg>

      {/* Nodes */}
      {graphNodes.map((node, i) => {
        const delay = 20 + i * 10;
        const nodeScale = spring({ frame: Math.max(0, frame - delay), fps, config: { damping: 12, stiffness: 100 } });

        return (
          <div
            key={node.id}
            style={{
              position: "absolute",
              left: node.x - 100,
              top: node.y - 32,
              width: 200,
              transform: `scale(${nodeScale})`,
              textAlign: "center",
            }}
          >
            <div style={{
              background: `${node.color}18`,
              border: `1.5px solid ${node.color}50`,
              borderRadius: 12,
              padding: "12px 16px",
              backdropFilter: "blur(8px)",
            }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: node.color }}>{node.label}</div>
              <div style={{ fontSize: 11, color: colors.muted, marginTop: 2, fontFamily: mono }}>{node.category}</div>
            </div>
          </div>
        );
      })}

      {/* Legend */}
      <div style={{
        position: "absolute",
        bottom: 48,
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "center",
        gap: 32,
        opacity: interpolate(frame, [100, 120], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
      }}>
        {["SUPPORTS", "INFLUENCES"].map(type => (
          <div key={type} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 24, height: 2, background: colors.accent, opacity: 0.5 }} />
            <span style={{ fontSize: 13, color: colors.muted, fontFamily: mono }}>{type}</span>
          </div>
        ))}
        <div style={{ fontSize: 13, color: colors.muted }}>
          Up to <span style={{ color: colors.orange, fontWeight: 600 }}>3-hop</span> depth traversal
        </div>
      </div>
    </AbsoluteFill>
  );
};

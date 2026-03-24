import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { colors, sans, mono } from "../styles";

const nodes = [
  { label: "Conversations", sub: "JSONL", color: colors.accent },
  { label: "Fact Extraction", sub: "Haiku LLM", color: colors.green },
  { label: "Ontology", sub: "Domain > Category", color: colors.purple },
  { label: "Relations", sub: "INFLUENCES / SUPPORTS", color: colors.orange },
  { label: "Knowledge Graph", sub: "9 MCP Tools", color: colors.cyan },
];

export const PipelineScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleOpacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ background: colors.bg, fontFamily: sans, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
      <div style={{ fontSize: 14, fontWeight: 600, textTransform: "uppercase", letterSpacing: 3, color: colors.accent, fontFamily: mono, opacity: titleOpacity, marginBottom: 8 }}>
        architecture
      </div>
      <div style={{ fontSize: 40, fontWeight: 600, color: colors.text, opacity: titleOpacity, marginBottom: 56 }}>
        Knowledge Graph Pipeline
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
        {nodes.map((node, i) => {
          const delay = 20 + i * 22;
          const nodeScale = spring({ frame: Math.max(0, frame - delay), fps, config: { damping: 12, stiffness: 90 } });
          const arrowOpacity = i < nodes.length - 1
            ? interpolate(frame, [delay + 10, delay + 22], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
            : 0;

          return (
            <div key={node.label} style={{ display: "flex", alignItems: "center" }}>
              <div style={{
                transform: `scale(${nodeScale})`,
                padding: "20px 28px",
                borderRadius: 14,
                background: `${node.color}12`,
                border: `1.5px solid ${node.color}40`,
                textAlign: "center",
                minWidth: 160,
              }}>
                <div style={{ fontSize: 18, fontWeight: 600, color: node.color, marginBottom: 4 }}>{node.label}</div>
                <div style={{ fontSize: 13, color: colors.muted }}>{node.sub}</div>
              </div>
              {i < nodes.length - 1 && (
                <div style={{ fontSize: 28, color: colors.muted, opacity: arrowOpacity, margin: "0 8px" }}>&#x2192;</div>
              )}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

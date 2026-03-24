import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { colors, sans, mono } from "../styles";

const tools = [
  { name: "search", desc: "RAG-enhanced search", badge: "Enhanced", color: colors.accent },
  { name: "search_facts", desc: "Ontology + graph relations", badge: "Enhanced", color: colors.purple },
  { name: "trace_fact", desc: "Fact → Exchange provenance", badge: "New", color: colors.green },
  { name: "graph_stats", desc: "Knowledge graph statistics", badge: "New", color: colors.green },
  { name: "cross_project_insights", desc: "Cross-project knowledge", badge: "New", color: colors.green },
  { name: "explore_graph", desc: "Multi-hop graph traversal", badge: "New", color: colors.green },
];

export const ToolsScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleOpacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ background: colors.bg, fontFamily: sans, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
      <div style={{ fontSize: 14, fontWeight: 600, textTransform: "uppercase", letterSpacing: 3, color: colors.accent, fontFamily: mono, opacity: titleOpacity, marginBottom: 8 }}>
        mcp tools
      </div>
      <div style={{ fontSize: 40, fontWeight: 600, color: colors.text, opacity: titleOpacity, marginBottom: 48 }}>
        Knowledge Graph Tools
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 20, width: 1200 }}>
        {tools.map((tool, i) => {
          const delay = 15 + i * 15;
          const cardScale = spring({ frame: Math.max(0, frame - delay), fps, config: { damping: 14, stiffness: 100 } });
          const isNew = tool.badge === "New";

          return (
            <div key={tool.name} style={{
              transform: `scale(${cardScale})`,
              background: colors.surface,
              border: `1px solid ${colors.border}`,
              borderRadius: 14,
              padding: "24px 28px",
            }}>
              <div style={{
                display: "inline-block",
                fontSize: 11,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: 1,
                padding: "3px 10px",
                borderRadius: 20,
                background: isNew ? `${colors.green}22` : `${colors.purple}22`,
                color: isNew ? colors.green : colors.purple,
                marginBottom: 12,
              }}>
                {tool.badge}
              </div>
              <div style={{ fontSize: 20, fontWeight: 600, fontFamily: mono, color: tool.color, marginBottom: 8 }}>
                {tool.name}
              </div>
              <div style={{ fontSize: 15, color: colors.muted, lineHeight: 1.4 }}>
                {tool.desc}
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

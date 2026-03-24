import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { colors, sans, mono } from "../styles";

const useCases = [
  { icon: "\u{1F680}", title: "New Project Bootstrap", desc: "cross_project_insights\u2192 leverage past decisions from other projects", color: colors.green },
  { icon: "\u{1F3D7}\uFE0F", title: "Architecture Decisions", desc: "explore_graph \u2192 trace impact chains (A\u2192B\u2192C) up to 3 hops", color: colors.purple },
  { icon: "\u{1F50D}", title: "Context-Aware Search", desc: "search + RAG \u2192 auto-attach related facts & ontology context", color: colors.accent },
  { icon: "\u{1F4DC}", title: "Decision Provenance", desc: "trace_fact \u2192 restore original conversations & revision history", color: colors.orange },
  { icon: "\u{1F4CA}", title: "Knowledge Monitoring", desc: "graph_stats \u2192 track growth, domain distribution, relation types", color: colors.cyan },
];

export const UseCasesScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleOpacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ background: colors.bg, fontFamily: sans, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
      <div style={{ fontSize: 14, fontWeight: 600, textTransform: "uppercase", letterSpacing: 3, color: colors.orange, fontFamily: mono, opacity: titleOpacity, marginBottom: 8 }}>
        use cases
      </div>
      <div style={{ fontSize: 40, fontWeight: 600, color: colors.text, opacity: titleOpacity, marginBottom: 48 }}>
        How It Works in Practice
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 16, width: 1000 }}>
        {useCases.map((uc, i) => {
          const delay = 15 + i * 18;
          const slideX = interpolate(frame, [delay, delay + 18], [80, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          const itemOpacity = interpolate(frame, [delay, delay + 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

          return (
            <div key={uc.title} style={{
              display: "flex",
              alignItems: "center",
              gap: 20,
              background: colors.surface,
              border: `1px solid ${colors.border}`,
              borderRadius: 14,
              padding: "20px 28px",
              opacity: itemOpacity,
              transform: `translateX(${slideX}px)`,
            }}>
              <div style={{ fontSize: 32, minWidth: 48, textAlign: "center" }}>{uc.icon}</div>
              <div>
                <div style={{ fontSize: 18, fontWeight: 600, color: uc.color, marginBottom: 4 }}>{uc.title}</div>
                <div style={{ fontSize: 15, color: colors.muted }}>{uc.desc}</div>
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

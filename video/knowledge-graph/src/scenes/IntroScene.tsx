import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { colors, sans, mono } from "../styles";

export const IntroScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const tagOpacity = interpolate(frame, [5, 20], [0, 1], { extrapolateRight: "clamp" });
  const titleScale = spring({ frame: Math.max(0, frame - 10), fps, config: { damping: 14, stiffness: 80 } });
  const lineWidth = interpolate(frame, [20, 60], [0, 700], { extrapolateRight: "clamp" });
  const subtitleOpacity = interpolate(frame, [40, 58], [0, 1], { extrapolateRight: "clamp" });
  const badgesOpacity = interpolate(frame, [60, 78], [0, 1], { extrapolateRight: "clamp" });
  const bgGlow = interpolate(frame, [0, 105], [0, 0.18], { extrapolateRight: "clamp" });

  const fullText = "Knowledge Graph System";
  const charsShown = Math.floor(interpolate(frame, [40, 72], [0, fullText.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  const typedText = fullText.slice(0, charsShown);
  const cursorOpacity = frame > 40 && frame < 85 ? (Math.floor(frame / 8) % 2 === 0 ? 1 : 0) : 0;

  return (
    <AbsoluteFill style={{
      background: `radial-gradient(circle at 50% 40%, rgba(210,168,255,${bgGlow}) 0%, ${colors.bg} 70%)`,
      ...centered,
      fontFamily: sans,
    }}>
      <div style={{ fontSize: 14, color: colors.accent, fontWeight: 600, textTransform: "uppercase", letterSpacing: 4, opacity: tagOpacity, marginBottom: 16, fontFamily: mono }}>
        claude code plugin
      </div>
      <div style={{ fontSize: 78, fontWeight: 700, color: colors.text, transform: `scale(${titleScale})`, letterSpacing: -2 }}>
        <span style={{ color: colors.purple }}>Memory</span> Bank
      </div>
      <div style={{ width: lineWidth, height: 2, background: `linear-gradient(90deg, transparent, ${colors.purple}, ${colors.accent}, transparent)`, marginTop: 28, marginBottom: 28, borderRadius: 2 }} />
      <div style={{ fontSize: 32, color: colors.cyan, opacity: subtitleOpacity, fontWeight: 500, height: 40 }}>
        {typedText}<span style={{ opacity: cursorOpacity, color: colors.cyan }}>|</span>
      </div>
      <div style={{ display: "flex", gap: 24, marginTop: 28, opacity: badgesOpacity }}>
        {[
          { text: "RAG-enhanced search", color: colors.green },
          { text: "Ontology classification", color: colors.purple },
          { text: "Multi-hop traversal", color: colors.orange },
        ].map(({ text, color }) => (
          <div key={text} style={{ fontSize: 16, color, padding: "8px 20px", background: `${color}14`, border: `1px solid ${color}33`, borderRadius: 8 }}>
            {text}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

const centered = { display: "flex" as const, alignItems: "center" as const, justifyContent: "center" as const, flexDirection: "column" as const };

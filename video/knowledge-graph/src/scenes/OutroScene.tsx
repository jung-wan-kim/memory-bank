import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { colors, sans, mono } from "../styles";

export const OutroScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleScale = spring({ frame: Math.max(0, frame - 5), fps, config: { damping: 14, stiffness: 80 } });
  const statsOpacity = interpolate(frame, [25, 45], [0, 1], { extrapolateRight: "clamp" });
  const linkOpacity = interpolate(frame, [50, 65], [0, 1], { extrapolateRight: "clamp" });
  const bgGlow = interpolate(frame, [0, 60], [0, 0.15], { extrapolateRight: "clamp" });

  const stats = [
    { value: "9", label: "MCP Tools", color: colors.accent },
    { value: "+4", label: "New Tools", color: colors.green },
    { value: "3", label: "Max Hops", color: colors.purple },
    { value: "115", label: "Tests Pass", color: colors.orange },
  ];

  return (
    <AbsoluteFill style={{
      background: `radial-gradient(circle at 50% 50%, rgba(88,166,255,${bgGlow}) 0%, ${colors.bg} 70%)`,
      display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column",
      fontFamily: sans,
    }}>
      <div style={{ fontSize: 56, fontWeight: 700, color: colors.text, transform: `scale(${titleScale})`, letterSpacing: -1, marginBottom: 40 }}>
        <span style={{ color: colors.purple }}>Memory</span> Bank
      </div>

      <div style={{ display: "flex", gap: 48, opacity: statsOpacity, marginBottom: 40 }}>
        {stats.map(({ value, label, color }) => (
          <div key={label} style={{ textAlign: "center" }}>
            <div style={{ fontSize: 42, fontWeight: 700, color, fontFamily: mono }}>{value}</div>
            <div style={{ fontSize: 13, color: colors.muted, textTransform: "uppercase", letterSpacing: 1, marginTop: 4 }}>{label}</div>
          </div>
        ))}
      </div>

      <div style={{ opacity: linkOpacity, textAlign: "center" }}>
        <div style={{ fontSize: 18, color: colors.accent, fontFamily: mono }}>
          github.com/jung-wan-kim/memory-bank
        </div>
        <div style={{ fontSize: 14, color: colors.muted, marginTop: 8 }}>
          Knowledge Graph System &middot; 2026-03-24
        </div>
      </div>
    </AbsoluteFill>
  );
};

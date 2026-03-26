import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { colors, sans, mono } from "../styles";

const STATS = [
  { value: "30",    label: "Hooks",         color: colors.blue   },
  { value: "65",    label: "Skills",        color: colors.green  },
  { value: "2,600+", label: "Facts",        color: colors.accent },
  { value: "50K+",  label: "Conversations", color: colors.cyan   },
];

export const OutroScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Fade the bg glow in
  const bgGlow = interpolate(frame, [0, 180], [0, 0.18], { extrapolateRight: "clamp" });

  // Title springs in
  const titleScale = spring({
    frame: Math.max(0, frame - 8),
    fps,
    config: { damping: 14, stiffness: 80 },
  });

  // Divider line expands
  const lineWidth = interpolate(frame, [20, 70], [0, 900], { extrapolateRight: "clamp" });

  // Stats fade in
  const statsOpacity = interpolate(frame, [50, 80], [0, 1], { extrapolateRight: "clamp" });

  // Quote fades in with slight slide
  const quoteOpacity = interpolate(frame, [110, 145], [0, 1], { extrapolateRight: "clamp" });
  const quoteY = interpolate(frame, [110, 145], [18, 0], { extrapolateRight: "clamp" });

  // Final fade-out at end
  const sceneOpacity = interpolate(frame, [260, 300], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(ellipse at 50% 50%, rgba(167,139,250,${bgGlow}) 0%, ${colors.bg} 65%)`,
        fontFamily: sans,
        opacity: sceneOpacity,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
      }}
    >
      {/* Title */}
      <div
        style={{
          fontSize: 72,
          fontWeight: 800,
          transform: `scale(${titleScale})`,
          letterSpacing: -2,
          background: `linear-gradient(135deg, ${colors.accent} 0%, ${colors.blue} 50%, ${colors.cyan} 100%)`,
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
          marginBottom: 0,
        }}
      >
        Loopy Era
      </div>

      {/* Gradient underline */}
      <div
        style={{
          width: lineWidth,
          height: 2,
          background: `linear-gradient(90deg, transparent, ${colors.accent}, ${colors.blue}, ${colors.cyan}, transparent)`,
          marginTop: 20,
          marginBottom: 48,
          borderRadius: 1,
        }}
      />

      {/* Stats row */}
      <div
        style={{
          display: "flex",
          gap: 64,
          opacity: statsOpacity,
          marginBottom: 56,
        }}
      >
        {STATS.map(({ value, label, color }) => (
          <div key={label} style={{ textAlign: "center" }}>
            <div style={{ fontSize: 44, fontWeight: 700, color, fontFamily: mono, lineHeight: 1 }}>
              {value}
            </div>
            <div
              style={{
                fontSize: 13,
                color: colors.muted,
                textTransform: "uppercase",
                letterSpacing: 2,
                marginTop: 6,
              }}
            >
              {label}
            </div>
          </div>
        ))}
      </div>

      {/* Quote */}
      <div
        style={{
          opacity: quoteOpacity,
          transform: `translateY(${quoteY}px)`,
          textAlign: "center",
          maxWidth: 780,
        }}
      >
        <div
          style={{
            fontSize: 24,
            color: colors.text,
            fontWeight: 300,
            letterSpacing: 0.3,
            lineHeight: 1.55,
            fontStyle: "italic",
          }}
        >
          "The human sets direction. The system builds itself."
        </div>
        <div
          style={{
            fontSize: 13,
            color: colors.muted,
            marginTop: 20,
            fontFamily: mono,
            letterSpacing: 2,
            textTransform: "uppercase",
          }}
        >
          Loopy Era &middot; 2026
        </div>
      </div>
    </AbsoluteFill>
  );
};

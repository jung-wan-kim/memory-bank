import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { colors, sans, mono } from "../styles";

export const IntroScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Background glow pulses in
  const bgGlow = interpolate(frame, [0, 120], [0, 0.22], { extrapolateRight: "clamp" });

  // Tag line fades in early
  const tagOpacity = interpolate(frame, [8, 25], [0, 1], { extrapolateRight: "clamp" });

  // Title springs in
  const titleScale = spring({
    frame: Math.max(0, frame - 15),
    fps,
    config: { damping: 14, stiffness: 80 },
  });

  // Underline expands
  const lineWidth = interpolate(frame, [25, 70], [0, 680], { extrapolateRight: "clamp" });

  // Subtitle fades in
  const subtitleOpacity = interpolate(frame, [50, 70], [0, 1], { extrapolateRight: "clamp" });

  // Bottleneck quote fades in first
  const quoteOpacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: "clamp" });

  // Particles — 12 circles with deterministic positions
  const particles = [
    { x: 120, y: 200, r: 3, delay: 0 },
    { x: 340, y: 80,  r: 2, delay: 5 },
    { x: 580, y: 320, r: 4, delay: 10 },
    { x: 820, y: 150, r: 2, delay: 3 },
    { x: 1100, y: 90, r: 3, delay: 8 },
    { x: 1380, y: 260, r: 2, delay: 15 },
    { x: 1600, y: 130, r: 4, delay: 6 },
    { x: 1780, y: 380, r: 2, delay: 12 },
    { x: 200, y: 800,  r: 3, delay: 20 },
    { x: 700, y: 920,  r: 2, delay: 7 },
    { x: 1200, y: 860, r: 4, delay: 18 },
    { x: 1700, y: 950, r: 3, delay: 2 },
  ];

  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(ellipse at 50% 45%, rgba(167,139,250,${bgGlow}) 0%, ${colors.bg} 65%)`,
        fontFamily: sans,
        overflow: "hidden",
      }}
    >
      {/* Floating particles */}
      {particles.map((p, i) => {
        const yOffset = interpolate(
          frame,
          [p.delay, p.delay + 150],
          [0, -30],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
        );
        const pOpacity = interpolate(
          frame,
          [p.delay, p.delay + 20],
          [0, 0.5],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
        );
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: p.x - p.r,
              top: p.y - p.r + yOffset,
              width: p.r * 2,
              height: p.r * 2,
              borderRadius: "50%",
              background: colors.accent,
              opacity: pOpacity,
            }}
          />
        );
      })}

      {/* Centered content */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
          width: "100%",
          height: "100%",
        }}
      >
        {/* Bottleneck quote — appears first */}
        <div
          style={{
            fontSize: 22,
            color: colors.orange,
            opacity: quoteOpacity,
            fontWeight: 500,
            fontStyle: "italic",
            marginBottom: 40,
            letterSpacing: 0.5,
          }}
        >
          "The biggest bottleneck is human."
        </div>

        {/* Tag */}
        <div
          style={{
            fontSize: 14,
            color: colors.cyan,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 5,
            opacity: tagOpacity,
            marginBottom: 18,
            fontFamily: mono,
          }}
        >
          autonomous self-improving architecture
        </div>

        {/* Main title with gradient */}
        <div
          style={{
            fontSize: 96,
            fontWeight: 800,
            transform: `scale(${titleScale})`,
            letterSpacing: -3,
            background: `linear-gradient(135deg, ${colors.accent} 0%, ${colors.blue} 50%, ${colors.cyan} 100%)`,
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            lineHeight: 1.05,
          }}
        >
          Loopy Era
        </div>

        {/* Gradient underline */}
        <div
          style={{
            width: lineWidth,
            height: 3,
            background: `linear-gradient(90deg, transparent, ${colors.accent}, ${colors.blue}, ${colors.cyan}, transparent)`,
            marginTop: 24,
            marginBottom: 28,
            borderRadius: 2,
          }}
        />

        {/* Subtitle */}
        <div
          style={{
            fontSize: 28,
            color: colors.muted,
            opacity: subtitleOpacity,
            fontWeight: 400,
            letterSpacing: 0.5,
          }}
        >
          Autonomous Self-Improving Architecture
        </div>

        {/* removed — quote moved to top */}
        <div
          style={{
            display: "none",
            fontStyle: "italic",
            marginTop: 32,
            letterSpacing: 0.5,
          }}
        >
          "The biggest bottleneck is human."
        </div>
      </div>
    </AbsoluteFill>
  );
};

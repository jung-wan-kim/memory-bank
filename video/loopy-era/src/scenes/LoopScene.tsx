import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { colors, sans, mono } from "../styles";

interface LoopNode {
  label: string;
  color: string;
  angle: number; // degrees, 0 = top
}

const LOOP_NODES: LoopNode[] = [
  { label: "Code",     color: colors.blue,   angle: 0   },
  { label: "Validate", color: colors.accent, angle: 60  },
  { label: "Auto-Fix", color: colors.green,  angle: 120 },
  { label: "Ship",     color: colors.orange, angle: 180 },
  { label: "Learn",    color: colors.red,    angle: 240 },
  { label: "Stronger", color: colors.cyan,   angle: 300 },
];

const RADIUS = 280;
const CX = 960;
const CY = 560;

function degToRad(deg: number) {
  return (deg - 90) * (Math.PI / 180);
}

function nodePosition(angle: number) {
  const rad = degToRad(angle);
  return {
    x: CX + RADIUS * Math.cos(rad),
    y: CY + RADIUS * Math.sin(rad),
  };
}

export const LoopScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleOpacity = interpolate(frame, [0, 18], [0, 1], { extrapolateRight: "clamp" });

  // Orbiting dot: one full revolution over 300 frames
  const orbitAngle = interpolate(frame, [60, 300], [0, 360], { extrapolateRight: "clamp" });
  const orbitRad = degToRad(orbitAngle);
  const orbitX = CX + RADIUS * Math.cos(orbitRad);
  const orbitY = CY + RADIUS * Math.sin(orbitRad);
  const orbitOpacity = interpolate(frame, [55, 75], [0, 1], { extrapolateRight: "clamp" });

  // Center infinity symbol
  const infinityScale = spring({
    frame: Math.max(0, frame - 30),
    fps,
    config: { damping: 12, stiffness: 70 },
  });

  // Ring draw (stroke-dashoffset animation)
  const ringCircumference = 2 * Math.PI * RADIUS;
  const ringProgress = interpolate(frame, [20, 90], [0, 1], { extrapolateRight: "clamp" });
  const ringDash = ringCircumference * ringProgress;

  return (
    <AbsoluteFill style={{ background: colors.bg, fontFamily: sans }}>
      {/* Title */}
      <div
        style={{
          position: "absolute",
          top: 52,
          left: 0,
          right: 0,
          textAlign: "center",
          opacity: titleOpacity,
        }}
      >
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 4,
            color: colors.accent,
            fontFamily: mono,
            marginBottom: 8,
          }}
        >
          the loop
        </div>
        <div style={{ fontSize: 38, fontWeight: 700, color: colors.text }}>
          Continuous Improvement Cycle
        </div>
      </div>

      {/* SVG — ring + edges + orbit dot */}
      <svg
        style={{ position: "absolute", top: 0, left: 0, width: 1920, height: 1080 }}
      >
        {/* Background ring */}
        <circle
          cx={CX}
          cy={CY}
          r={RADIUS}
          fill="none"
          stroke={colors.border}
          strokeWidth={2}
        />

        {/* Animated ring draw */}
        <circle
          cx={CX}
          cy={CY}
          r={RADIUS}
          fill="none"
          stroke={`url(#ringGrad)`}
          strokeWidth={3}
          strokeDasharray={`${ringDash} ${ringCircumference}`}
          strokeLinecap="round"
          style={{ transform: "rotate(-90deg)", transformOrigin: `${CX}px ${CY}px` }}
        />

        {/* Gradient definition for ring */}
        <defs>
          <linearGradient id="ringGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={colors.accent} />
            <stop offset="50%" stopColor={colors.blue} />
            <stop offset="100%" stopColor={colors.cyan} />
          </linearGradient>
        </defs>

        {/* Connector lines between adjacent nodes */}
        {LOOP_NODES.map((node, i) => {
          const next = LOOP_NODES[(i + 1) % LOOP_NODES.length];
          const from = nodePosition(node.angle);
          const to = nodePosition(next.angle);
          const lineDelay = 60 + i * 18;
          const lineOpacity = interpolate(
            frame,
            [lineDelay, lineDelay + 15],
            [0, 0.25],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
          );
          return (
            <line
              key={i}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke={node.color}
              strokeWidth={1.5}
              opacity={lineOpacity}
              strokeDasharray="5,4"
            />
          );
        })}

        {/* Orbiting dot */}
        <circle cx={orbitX} cy={orbitY} r={8} fill={colors.cyan} opacity={orbitOpacity} />
        <circle cx={orbitX} cy={orbitY} r={16} fill={colors.cyan} opacity={orbitOpacity * 0.2} />
      </svg>

      {/* Node cards */}
      {LOOP_NODES.map((node, i) => {
        const pos = nodePosition(node.angle);
        const delay = 30 + i * 20;
        const nodeScale = spring({
          frame: Math.max(0, frame - delay),
          fps,
          config: { damping: 13, stiffness: 90 },
        });
        const CARD_W = 160;
        const CARD_H = 64;

        return (
          <div
            key={node.label}
            style={{
              position: "absolute",
              left: pos.x - CARD_W / 2,
              top: pos.y - CARD_H / 2,
              width: CARD_W,
              height: CARD_H,
              transform: `scale(${nodeScale})`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: `${node.color}18`,
              border: `2px solid ${node.color}55`,
              borderRadius: 14,
              fontFamily: sans,
            }}
          >
            {/* Step number */}
            <div
              style={{
                position: "absolute",
                top: -10,
                right: -10,
                width: 22,
                height: 22,
                borderRadius: "50%",
                background: node.color,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 11,
                fontWeight: 700,
                color: colors.bg,
              }}
            >
              {i + 1}
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: node.color }}>
              {node.label}
            </div>
          </div>
        );
      })}

      {/* Center infinity symbol */}
      <div
        style={{
          position: "absolute",
          left: CX - 60,
          top: CY - 44,
          width: 120,
          height: 88,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transform: `scale(${infinityScale})`,
        }}
      >
        <div
          style={{
            fontSize: 72,
            fontWeight: 700,
            background: `linear-gradient(135deg, ${colors.accent}, ${colors.cyan})`,
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            lineHeight: 1,
          }}
        >
          ∞
        </div>
      </div>
    </AbsoluteFill>
  );
};

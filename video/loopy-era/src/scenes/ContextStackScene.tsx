import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { colors, sans, mono } from "../styles";

interface ContextLayer {
  label: string;
  desc: string;
  color: string;
  delay: number;
}

const LAYERS: ContextLayer[] = [
  {
    label: "CLAUDE.md",
    desc: "Project rules, build commands",
    color: colors.orange,
    delay: 0,
  },
  {
    label: "Skills & Scaffold",
    desc: "NEVER DO rules, patterns",
    color: colors.green,
    delay: 20,
  },
  {
    label: "Hook Injections",
    desc: "inject-context.sh → top facts",
    color: colors.blue,
    delay: 40,
  },
  {
    label: "Memory Bank",
    desc: "Semantic search → past decisions",
    color: "#a78bfa",
    delay: 60,
  },
  {
    label: "User Prompt",
    desc: "Your actual request",
    color: colors.cyan,
    delay: 80,
  },
];

const LAYER_H = 90;
const LAYER_GAP = 10;
const LAYER_W = 980;
const START_X = 200;

export const ContextStackScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleOpacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" });

  const totalH = LAYERS.length * LAYER_H + (LAYERS.length - 1) * LAYER_GAP;
  const startY = (1080 - totalH) / 2 + 30;

  // Arrow on the right side — appears after layer 4 (Memory Bank) slides in
  const arrowOpacity = interpolate(frame, [90, 115], [0, 1], { extrapolateRight: "clamp" });
  // Layer 4 (Memory Bank) is index 3, its Y position
  const memBankY = startY + 3 * (LAYER_H + LAYER_GAP);
  const arrowX = START_X + LAYER_W + 40;

  // Animated bracket/arrow pointing into Memory Bank layer
  const arrowScale = spring({
    frame: Math.max(0, frame - 90),
    fps,
    config: { damping: 14, stiffness: 90 },
  });

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
            color: colors.cyan,
            fontFamily: mono,
            marginBottom: 8,
          }}
        >
          context assembly
        </div>
        <div style={{ fontSize: 38, fontWeight: 700, color: colors.text }}>
          How Prompts Are Built
        </div>
      </div>

      {/* Layer stack — bottom layer first (index 0 = bottom) */}
      {LAYERS.map((layer, i) => {
        // Render bottom-to-top: i=0 is at the bottom visually
        const reverseIdx = LAYERS.length - 1 - i;
        const layerY = startY + reverseIdx * (LAYER_H + LAYER_GAP);

        const slideX = interpolate(
          frame,
          [layer.delay + 10, layer.delay + 38],
          [-120, 0],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
        );
        const layerOpacity = interpolate(
          frame,
          [layer.delay + 10, layer.delay + 32],
          [0, 1],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
        );

        // Left number label
        const numOpacity = interpolate(
          frame,
          [layer.delay + 22, layer.delay + 40],
          [0, 1],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
        );

        return (
          <div
            key={layer.label}
            style={{
              position: "absolute",
              left: START_X + slideX,
              top: layerY,
              width: LAYER_W,
              height: LAYER_H,
              opacity: layerOpacity,
              display: "flex",
              alignItems: "center",
              background: `${layer.color}10`,
              border: `2px solid ${layer.color}50`,
              borderRadius: 12,
              overflow: "hidden",
            }}
          >
            {/* Left accent bar */}
            <div
              style={{
                width: 5,
                height: "100%",
                background: layer.color,
                flexShrink: 0,
              }}
            />

            {/* Layer number */}
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: "50%",
                border: `2px solid ${layer.color}55`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 16,
                fontWeight: 700,
                color: layer.color,
                margin: "0 20px",
                flexShrink: 0,
                opacity: numOpacity,
              }}
            >
              {i + 1}
            </div>

            {/* Labels */}
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: layer.color }}>
                {layer.label}
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: colors.muted,
                  marginTop: 4,
                  fontFamily: mono,
                }}
              >
                {layer.desc}
              </div>
            </div>

            {/* Stack indicator badge on right */}
            {i === LAYERS.length - 1 && (
              <div
                style={{
                  marginRight: 28,
                  padding: "4px 14px",
                  border: `1px solid ${layer.color}40`,
                  borderRadius: 20,
                  fontSize: 11,
                  fontWeight: 600,
                  color: layer.color,
                  fontFamily: mono,
                  textTransform: "uppercase",
                  letterSpacing: 1,
                  opacity: interpolate(frame, [layer.delay + 40, layer.delay + 60], [0, 1], {
                    extrapolateRight: "clamp",
                  }),
                }}
              >
                top
              </div>
            )}
            {i === 0 && (
              <div
                style={{
                  marginRight: 28,
                  padding: "4px 14px",
                  border: `1px solid ${layer.color}40`,
                  borderRadius: 20,
                  fontSize: 11,
                  fontWeight: 600,
                  color: layer.color,
                  fontFamily: mono,
                  textTransform: "uppercase",
                  letterSpacing: 1,
                  opacity: interpolate(frame, [layer.delay + 40, layer.delay + 60], [0, 1], {
                    extrapolateRight: "clamp",
                  }),
                }}
              >
                base
              </div>
            )}
          </div>
        );
      })}

      {/* Right side annotation — arrow + label pointing at Memory Bank */}
      <div
        style={{
          position: "absolute",
          left: arrowX,
          top: memBankY,
          opacity: arrowOpacity,
          transform: `scale(${arrowScale})`,
          transformOrigin: "left center",
        }}
      >
        {/* Arrow line */}
        <svg width={260} height={LAYER_H} style={{ overflow: "visible" }}>
          {/* Horizontal line from left edge to label */}
          <line
            x1={0}
            y1={LAYER_H / 2}
            x2={32}
            y2={LAYER_H / 2}
            stroke={colors.accent}
            strokeWidth={2}
            strokeDasharray="5,4"
          />
          {/* Arrowhead pointing left (into the layer) */}
          <polygon
            points={`4,${LAYER_H / 2 - 5} 4,${LAYER_H / 2 + 5} -4,${LAYER_H / 2}`}
            fill={colors.accent}
          />
        </svg>
        {/* Label box */}
        <div
          style={{
            position: "absolute",
            left: 36,
            top: LAYER_H / 2 - 22,
            background: `${colors.accent}15`,
            border: `1px solid ${colors.accent}40`,
            borderRadius: 8,
            padding: "6px 14px",
            fontSize: 13,
            fontWeight: 600,
            color: colors.accent,
            fontFamily: mono,
            whiteSpace: "nowrap",
          }}
        >
          Memory Bank feeds context
        </div>
      </div>

      {/* Bottom caption */}
      <div
        style={{
          position: "absolute",
          bottom: 44,
          left: 0,
          right: 0,
          textAlign: "center",
          opacity: interpolate(frame, [160, 190], [0, 1], { extrapolateRight: "clamp" }),
        }}
      >
        <div style={{ fontSize: 14, color: colors.muted }}>
          Every request carries all 5 layers — Claude never starts from scratch
        </div>
      </div>
    </AbsoluteFill>
  );
};

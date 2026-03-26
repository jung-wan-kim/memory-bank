import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { colors, sans, mono } from "../styles";

interface Layer {
  label: string;
  sublabel: string;
  stat: string;
  statLabel: string;
  color: string;
  enterDelay: number;
}

const LAYERS: Layer[] = [
  {
    label: "Infrastructure",
    sublabel: "Docker · Vercel · CI/CD",
    stat: "100%",
    statLabel: "automated",
    color: colors.orange,
    enterDelay: 200,
  },
  {
    label: "Memory",
    sublabel: "SQLite · sqlite-vec · Facts",
    stat: "2,600+",
    statLabel: "facts",
    color: colors.green,
    enterDelay: 155,
  },
  {
    label: "Hooks",
    sublabel: "auto-validate · self-improve · notify",
    stat: "30",
    statLabel: "hooks",
    color: colors.blue,
    enterDelay: 110,
  },
  {
    label: "Claude",
    sublabel: "Opus 4.6 · Sonnet · Haiku",
    stat: "Opus 4.6",
    statLabel: "primary",
    color: colors.accent,
    enterDelay: 65,
  },
  {
    label: "Human",
    sublabel: "Vision · Direction · Goals",
    stat: "1",
    statLabel: "direction",
    color: colors.red,
    enterDelay: 20,
  },
];

const LAYER_H = 110;
const LAYER_GAP = 14;
const LAYER_W = 1200;

export const LayersScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleOpacity = interpolate(frame, [0, 18], [0, 1], { extrapolateRight: "clamp" });

  const totalH = LAYERS.length * LAYER_H + (LAYERS.length - 1) * LAYER_GAP;
  const startY = (1080 - totalH) / 2 + 50;
  const startX = (1920 - LAYER_W) / 2;

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
            color: colors.blue,
            fontFamily: mono,
            marginBottom: 8,
          }}
        >
          architecture layers
        </div>
        <div style={{ fontSize: 38, fontWeight: 700, color: colors.text }}>
          System Stack
        </div>
      </div>

      {/* Layer stack — bottom-up rendering (LAYERS[0] is bottom visually) */}
      {LAYERS.map((layer, i) => {
        // i=0 is Infrastructure (bottom), i=4 is Human (top)
        const reverseIdx = LAYERS.length - 1 - i;
        const layerY = startY + reverseIdx * (LAYER_H + LAYER_GAP);

        const slideX = interpolate(
          frame,
          [layer.enterDelay, layer.enterDelay + 35],
          [-80, 0],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
        );
        const cardOpacity = interpolate(
          frame,
          [layer.enterDelay, layer.enterDelay + 28],
          [0, 1],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
        );

        // Stat counter animation
        const statDelay = layer.enterDelay + 30;
        const statProgress = interpolate(
          frame,
          [statDelay, statDelay + 45],
          [0, 1],
          { extrapolateRight: "clamp" }
        );

        // Parse numeric stat for counter, fallback to text
        const numericMatch = layer.stat.replace(/,/g, "").match(/^(\d+)/);
        let displayStat = layer.stat;
        if (numericMatch) {
          const maxVal = parseInt(numericMatch[1]);
          const currentVal = Math.floor(maxVal * statProgress);
          // Re-format with comma for thousands
          displayStat = layer.stat.replace(/^\d[\d,]*/, currentVal.toLocaleString());
        }

        // Left accent bar width
        const accentW = interpolate(
          frame,
          [layer.enterDelay + 10, layer.enterDelay + 35],
          [0, 5],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
        );

        return (
          <div
            key={layer.label}
            style={{
              position: "absolute",
              left: startX + slideX,
              top: layerY,
              width: LAYER_W,
              height: LAYER_H,
              opacity: cardOpacity,
              display: "flex",
              alignItems: "center",
              background: `${layer.color}0d`,
              border: `1px solid ${layer.color}35`,
              borderLeft: `none`,
              borderRadius: 14,
              overflow: "hidden",
            }}
          >
            {/* Left color accent */}
            <div
              style={{
                width: accentW,
                height: "100%",
                background: layer.color,
                flexShrink: 0,
              }}
            />

            {/* Content */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                flex: 1,
                padding: "0 32px",
                gap: 0,
              }}
            >
              {/* Layer number badge */}
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: "50%",
                  border: `2px solid ${layer.color}60`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 16,
                  fontWeight: 700,
                  color: layer.color,
                  marginRight: 24,
                  flexShrink: 0,
                }}
              >
                {i + 1}
              </div>

              {/* Label block */}
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 24, fontWeight: 700, color: layer.color }}>
                  {layer.label}
                </div>
                <div style={{ fontSize: 14, color: colors.muted, marginTop: 4, fontFamily: mono }}>
                  {layer.sublabel}
                </div>
              </div>

              {/* Stat */}
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 28, fontWeight: 700, color: layer.color, fontFamily: mono }}>
                  {displayStat}
                </div>
                <div style={{ fontSize: 12, color: colors.muted, textTransform: "uppercase", letterSpacing: 1 }}>
                  {layer.statLabel}
                </div>
              </div>
            </div>
          </div>
        );
      })}

      {/* Legend on bottom */}
      <div
        style={{
          position: "absolute",
          bottom: 44,
          left: 0,
          right: 0,
          textAlign: "center",
          opacity: interpolate(frame, [240, 270], [0, 1], { extrapolateRight: "clamp" }),
        }}
      >
        <div style={{ fontSize: 14, color: colors.muted }}>
          Layers build on each other — each strengthens what's below
        </div>
      </div>
    </AbsoluteFill>
  );
};

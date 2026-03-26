import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { colors, sans, mono } from "../styles";

interface BranchNode {
  label: string;
  sublabel: string;
  color: string;
  delay: number;
  side: "left" | "right";
  /** vertical offset from center, in px */
  offsetY: number;
}

const BRANCHES: BranchNode[] = [
  // Left side
  {
    label: "CLAUDE.md",
    sublabel: "빌드 명령",
    color: colors.blue,
    delay: 30,
    side: "left",
    offsetY: -130,
  },
  {
    label: "backend-patterns.md",
    sublabel: "API 패턴",
    color: colors.green,
    delay: 50,
    side: "left",
    offsetY: 0,
  },
  {
    label: "frontend-patterns.md",
    sublabel: "컴포넌트",
    color: colors.cyan,
    delay: 70,
    side: "left",
    offsetY: 130,
  },
  // Right side
  {
    label: "qa-strategy.md",
    sublabel: "테스트 전략",
    color: colors.orange,
    delay: 90,
    side: "right",
    offsetY: -130,
  },
  {
    label: "{project}-scaffold",
    sublabel: "NEVER DO 규칙",
    color: colors.red,
    delay: 110,
    side: "right",
    offsetY: 0,
  },
  {
    label: "auto-issue",
    sublabel: "GitHub 자동화",
    color: colors.yellow,
    delay: 130,
    side: "right",
    offsetY: 130,
  },
];

const CENTER_X = 960;
const CENTER_Y = 460;
const CENTER_R = 58;
const NODE_W = 240;
const NODE_H = 66;
const BRANCH_GAP = 200; // horizontal distance from center to node center

// Feedback loop bottom constants
const LOOP_Y = 820;

export const InitProjectScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleOpacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" });

  // Center node spring
  const centerScale = spring({
    frame: Math.max(0, frame - 5),
    fps,
    config: { damping: 14, stiffness: 90 },
  });

  // Feedback loop opacity
  const loopOpacity = interpolate(frame, [210, 240], [0, 1], { extrapolateRight: "clamp" });

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
          project bootstrap
        </div>
        <div style={{ fontSize: 38, fontWeight: 700, color: colors.text }}>
          What /init-project Creates
        </div>
      </div>

      {/* SVG connecting lines */}
      <svg
        style={{ position: "absolute", top: 0, left: 0, width: 1920, height: 1080 }}
      >
        {BRANCHES.map((branch, i) => {
          const nodeX =
            branch.side === "left"
              ? CENTER_X - BRANCH_GAP - NODE_W / 2
              : CENTER_X + BRANCH_GAP + NODE_W / 2;
          const nodeY = CENTER_Y + branch.offsetY;

          // From center node edge to node center
          const fromX = branch.side === "left" ? CENTER_X - CENTER_R : CENTER_X + CENTER_R;
          const fromY = CENTER_Y;

          const lineOpacity = interpolate(
            frame,
            [branch.delay + 8, branch.delay + 28],
            [0, 0.65],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
          );

          return (
            <line
              key={`line-${i}`}
              x1={fromX}
              y1={fromY}
              x2={nodeX}
              y2={nodeY}
              stroke={branch.color}
              strokeWidth={1.5}
              strokeDasharray="6,4"
              opacity={lineOpacity}
            />
          );
        })}

        {/* Feedback loop arrow at bottom */}
        <g opacity={loopOpacity}>
          {/* scaffold-violation-check.sh → detects → /self-improve → adds rules → scaffold */}
          {/* Curved arrow path along the bottom */}
          <path
            d={`M ${CENTER_X - 300} ${LOOP_Y} C ${CENTER_X - 300} ${LOOP_Y + 40}, ${CENTER_X + 300} ${LOOP_Y + 40}, ${CENTER_X + 300} ${LOOP_Y}`}
            fill="none"
            stroke={colors.accent}
            strokeWidth={2}
            strokeDasharray="8,5"
            opacity={0.6}
          />
          {/* Left arrowhead (going back) */}
          <polygon
            points={`${CENTER_X - 300},${LOOP_Y - 6} ${CENTER_X - 300},${LOOP_Y + 6} ${CENTER_X - 314},${LOOP_Y}`}
            fill={colors.accent}
            opacity={0.7}
          />
        </g>
      </svg>

      {/* Center node: /init-project */}
      <div
        style={{
          position: "absolute",
          left: CENTER_X - CENTER_R,
          top: CENTER_Y - CENTER_R,
          width: CENTER_R * 2,
          height: CENTER_R * 2,
          transform: `scale(${centerScale})`,
          transformOrigin: "center center",
          background: `${colors.accent}20`,
          border: `2.5px solid ${colors.accent}80`,
          borderRadius: "50%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            fontSize: 13,
            fontWeight: 800,
            color: colors.accent,
            fontFamily: mono,
            textAlign: "center",
            lineHeight: 1.2,
          }}
        >
          /init
          <br />
          project
        </div>
      </div>

      {/* Branch nodes */}
      {BRANCHES.map((branch, i) => {
        const nodeX =
          branch.side === "left"
            ? CENTER_X - BRANCH_GAP - NODE_W
            : CENTER_X + BRANCH_GAP;
        const nodeY = CENTER_Y + branch.offsetY - NODE_H / 2;

        const nodeScale = spring({
          frame: Math.max(0, frame - branch.delay),
          fps,
          config: { damping: 14, stiffness: 90 },
        });

        return (
          <div
            key={branch.label}
            style={{
              position: "absolute",
              left: nodeX,
              top: nodeY,
              width: NODE_W,
              height: NODE_H,
              transform: `scale(${nodeScale})`,
              transformOrigin: branch.side === "left" ? "right center" : "left center",
              background: `${branch.color}13`,
              border: `1.5px solid ${branch.color}55`,
              borderRadius: 10,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
            }}
          >
            <div
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: branch.color,
                fontFamily: mono,
                textAlign: "center",
              }}
            >
              {branch.label}
            </div>
            <div style={{ fontSize: 12, color: colors.muted, textAlign: "center" }}>
              {branch.sublabel}
            </div>
          </div>
        );
      })}

      {/* Feedback loop labels */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: LOOP_Y + 48,
          display: "flex",
          justifyContent: "center",
          gap: 0,
          opacity: loopOpacity,
        }}
      >
        {[
          { text: "scaffold-violation-check.sh", color: colors.red },
          { text: " → 위반 감지 → ", color: colors.muted },
          { text: "/self-improve", color: colors.accent },
          { text: " → adds rules → ", color: colors.muted },
          { text: "scaffold", color: colors.green },
        ].map((seg, i) => (
          <span
            key={i}
            style={{
              fontSize: 13,
              color: seg.color,
              fontFamily: mono,
              fontWeight: seg.color === colors.muted ? 400 : 600,
            }}
          >
            {seg.text}
          </span>
        ))}
      </div>

      {/* Bottom caption */}
      <div
        style={{
          position: "absolute",
          bottom: 44,
          left: 0,
          right: 0,
          textAlign: "center",
          opacity: interpolate(frame, [240, 268], [0, 1], { extrapolateRight: "clamp" }),
        }}
      >
        <div style={{ fontSize: 14, color: colors.muted }}>
          One command — full project context, rules, and automation in place
        </div>
      </div>
    </AbsoluteFill>
  );
};

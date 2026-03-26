import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { colors, sans, mono } from "../styles";

interface Phase {
  id: number;
  label: string;
  title: string;
  color: string;
  parallel: boolean;
  parallelLanes?: string[];
}

const PHASES: Phase[] = [
  { id: 0, label: "Phase 0", title: "Plan",    color: colors.muted,   parallel: false },
  { id: 1, label: "Phase 1", title: "Design",  color: colors.blue,    parallel: false },
  { id: 2, label: "Phase 2", title: "DB/API",  color: colors.green,   parallel: false },
  {
    id: 3,
    label: "Phase 3",
    title: "Implement",
    color: colors.accent,
    parallel: true,
    parallelLanes: ["Frontend", "Backend"],
  },
  { id: 4, label: "Phase 4", title: "Test",    color: colors.orange,  parallel: false },
  { id: 5, label: "Phase 5", title: "Ship",    color: colors.cyan,    parallel: false },
];

const BLOCK_W = 220;
const BLOCK_H = 90;
const PARALLEL_BLOCK_H = 55;
const BLOCK_GAP = 32;
const TOTAL_W = PHASES.length * BLOCK_W + (PHASES.length - 1) * BLOCK_GAP;
const START_X = (1920 - TOTAL_W) / 2;
const BASE_Y = 480;

export const TeamFlowScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleOpacity = interpolate(frame, [0, 18], [0, 1], { extrapolateRight: "clamp" });

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
          team flow
        </div>
        <div style={{ fontSize: 38, fontWeight: 700, color: colors.text }}>
          6-Phase Delivery Pipeline
        </div>
      </div>

      {/* SVG connector lines between blocks */}
      <svg
        style={{ position: "absolute", top: 0, left: 0, width: 1920, height: 1080 }}
      >
        {PHASES.map((phase, i) => {
          if (i >= PHASES.length - 1) return null;
          const fromX = START_X + i * (BLOCK_W + BLOCK_GAP) + BLOCK_W;
          const toX = START_X + (i + 1) * (BLOCK_W + BLOCK_GAP);
          const midY = BASE_Y + BLOCK_H / 2;

          const lineDelay = 30 + i * 35;
          const lineOpacity = interpolate(
            frame,
            [lineDelay + 20, lineDelay + 38],
            [0, 0.6],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
          );

          return (
            <g key={`line-${i}`}>
              <line
                x1={fromX + 2}
                y1={midY}
                x2={toX - 2}
                y2={midY}
                stroke={colors.border}
                strokeWidth={2}
                opacity={lineOpacity}
              />
              {/* Arrowhead */}
              <polygon
                points={`${toX - 2},${midY} ${toX - 12},${midY - 5} ${toX - 12},${midY + 5}`}
                fill={colors.muted}
                opacity={lineOpacity * 0.8}
              />
            </g>
          );
        })}
      </svg>

      {/* Phase blocks */}
      {PHASES.map((phase, i) => {
        const blockX = START_X + i * (BLOCK_W + BLOCK_GAP);
        const delay = 30 + i * 35;

        const blockScale = spring({
          frame: Math.max(0, frame - delay),
          fps,
          config: { damping: 13, stiffness: 85 },
        });

        const isParallel = phase.parallel && phase.parallelLanes;

        return (
          <div key={phase.id} style={{ position: "absolute" }}>
            {isParallel ? (
              /* Parallel lanes block */
              <div
                style={{
                  position: "absolute",
                  left: blockX,
                  top: BASE_Y - PARALLEL_BLOCK_H - 8,
                  width: BLOCK_W,
                  transform: `scale(${blockScale})`,
                  transformOrigin: "center center",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                {/* Phase label */}
                <div
                  style={{
                    textAlign: "center",
                    fontSize: 11,
                    color: phase.color,
                    fontFamily: mono,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: 2,
                    marginBottom: 4,
                  }}
                >
                  {phase.label}
                </div>

                {/* Parallel swimlanes */}
                {phase.parallelLanes!.map((lane, li) => {
                  const laneDelay = delay + li * 20;
                  const laneOpacity = interpolate(
                    frame,
                    [laneDelay, laneDelay + 20],
                    [0, 1],
                    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
                  );
                  const laneColor = li === 0 ? colors.blue : colors.green;
                  return (
                    <div
                      key={lane}
                      style={{
                        height: PARALLEL_BLOCK_H,
                        background: `${laneColor}15`,
                        border: `1.5px solid ${laneColor}45`,
                        borderRadius: 10,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexDirection: "column",
                        opacity: laneOpacity,
                      }}
                    >
                      <div style={{ fontSize: 15, fontWeight: 700, color: laneColor }}>
                        {lane}
                      </div>
                      <div style={{ fontSize: 11, color: colors.muted, marginTop: 2 }}>
                        parallel
                      </div>
                    </div>
                  );
                })}

                {/* Parallel indicator */}
                <div
                  style={{
                    textAlign: "center",
                    fontSize: 11,
                    color: phase.color,
                    opacity: 0.7,
                    fontFamily: mono,
                  }}
                >
                  &#8741; concurrent
                </div>
              </div>
            ) : (
              /* Normal block */
              <div
                style={{
                  position: "absolute",
                  left: blockX,
                  top: BASE_Y,
                  width: BLOCK_W,
                  height: BLOCK_H,
                  transform: `scale(${blockScale})`,
                  transformOrigin: "center center",
                  background: `${phase.color}12`,
                  border: `1.5px solid ${phase.color}45`,
                  borderRadius: 14,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    color: phase.color,
                    fontFamily: mono,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: 2,
                  }}
                >
                  {phase.label}
                </div>
                <div style={{ fontSize: 22, fontWeight: 700, color: phase.color }}>
                  {phase.title}
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* Timeline bar */}
      <div
        style={{
          position: "absolute",
          left: START_X,
          top: BASE_Y + BLOCK_H + 40,
          width: TOTAL_W,
          opacity: interpolate(frame, [220, 260], [0, 1], { extrapolateRight: "clamp" }),
        }}
      >
        <div
          style={{
            height: 2,
            background: `linear-gradient(90deg, ${colors.blue}, ${colors.accent}, ${colors.cyan})`,
            borderRadius: 1,
            opacity: 0.4,
          }}
        />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: 8,
            fontSize: 12,
            color: colors.muted,
            fontFamily: mono,
          }}
        >
          <span>start</span>
          <span>end</span>
        </div>
      </div>

      {/* Bottom note */}
      <div
        style={{
          position: "absolute",
          bottom: 52,
          left: 0,
          right: 0,
          textAlign: "center",
          opacity: interpolate(frame, [350, 390], [0, 1], { extrapolateRight: "clamp" }),
        }}
      >
        <div style={{ fontSize: 15, color: colors.muted }}>
          Phase 3 parallelizes Frontend + Backend — cutting implementation time in half
        </div>
      </div>
    </AbsoluteFill>
  );
};

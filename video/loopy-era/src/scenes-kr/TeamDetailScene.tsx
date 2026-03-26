import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { colors, sans, mono } from "../styles";

interface SwimlaneRow {
  role: string;
  activePhase: number;
  color: string;
}

const ROWS: SwimlaneRow[] = [
  { role: "Team Lead",  activePhase: 0, color: colors.muted },
  { role: "Architect",  activePhase: 1, color: colors.blue },
  { role: "DB Admin",   activePhase: 2, color: colors.green },
  { role: "Frontend",   activePhase: 3, color: colors.cyan },
  { role: "Backend",    activePhase: 3, color: colors.accent },
  { role: "QA Tester",  activePhase: 4, color: colors.orange },
];

// Phase 5 (Ship) — Team Lead is also active
const PHASE5_ACTIVE_ROWS = [0]; // Team Lead row index

const COL_HEADERS = ["P0 분석", "P1 설계", "P2 DB", "P3 구현", "P4 QA", "P5 Ship"];

const ROLE_COL_W = 148;
const CELL_W = 168;
const CELL_H = 64;
const CELL_GAP_X = 12;
const CELL_GAP_Y = 10;
const NUM_COLS = COL_HEADERS.length;
const NUM_ROWS = ROWS.length;

const TABLE_W = ROLE_COL_W + NUM_COLS * (CELL_W + CELL_GAP_X) - CELL_GAP_X;
const TABLE_H = NUM_ROWS * (CELL_H + CELL_GAP_Y) - CELL_GAP_Y;
const HEADER_H = 44;

const TABLE_X = (1920 - TABLE_W) / 2;
const TABLE_Y = (1080 - TABLE_H - HEADER_H) / 2 + 60;

export const TeamDetailScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleOpacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" });

  // Header row fade in
  const headerOpacity = interpolate(frame, [15, 35], [0, 1], { extrapolateRight: "clamp" });

  // Pulse animation for Phase 3 병렬 cells (Frontend + Backend)
  // Sine-wave pulse cycling after frame 140 (when both cells are visible)
  const pulseRaw = Math.sin((frame - 140) * 0.12);
  const pulseBrightness = interpolate(pulseRaw, [-1, 1], [0.6, 1.0], { extrapolateRight: "clamp" });
  const phase3Visible = frame > 140;

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
          team execution
        </div>
        <div style={{ fontSize: 38, fontWeight: 700, color: colors.text }}>
          /team Swimlane Timeline
        </div>
      </div>

      {/* Column headers */}
      <div
        style={{
          position: "absolute",
          left: TABLE_X + ROLE_COL_W + CELL_GAP_X,
          top: TABLE_Y,
          display: "flex",
          gap: CELL_GAP_X,
          opacity: headerOpacity,
        }}
      >
        {COL_HEADERS.map((header, ci) => (
          <div
            key={header}
            style={{
              width: CELL_W,
              height: HEADER_H,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              fontWeight: 700,
              color: ci === 3 ? colors.cyan : colors.muted,
              fontFamily: mono,
              textTransform: "uppercase",
              letterSpacing: 1.5,
              borderBottom: `1px solid ${ci === 3 ? colors.cyan + "50" : colors.border}`,
            }}
          >
            {header}
          </div>
        ))}
      </div>

      {/* Swimlane rows */}
      {ROWS.map((row, ri) => {
        const rowY = TABLE_Y + HEADER_H + CELL_GAP_Y + ri * (CELL_H + CELL_GAP_Y);

        // Row label delay — stagger by 20 frames each
        const rowDelay = 30 + ri * 20;
        const labelOpacity = interpolate(
          frame,
          [rowDelay, rowDelay + 20],
          [0, 1],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
        );

        return (
          <div key={row.role} style={{ position: "absolute" }}>
            {/* Role label */}
            <div
              style={{
                position: "absolute",
                left: TABLE_X,
                top: rowY,
                width: ROLE_COL_W - 8,
                height: CELL_H,
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
                paddingRight: 16,
                opacity: labelOpacity,
              }}
            >
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: row.color,
                  fontFamily: mono,
                  textAlign: "right",
                }}
              >
                {row.role}
              </div>
            </div>

            {/* Phase cells */}
            {COL_HEADERS.map((_, ci) => {
              const isActive =
                ci === row.activePhase ||
                (ci === 5 && PHASE5_ACTIVE_ROWS.includes(ri));
              const isParallel = ci === 3 && (ri === 3 || ri === 4);

              // Active cell entry animation
              const cellDelay = rowDelay + ci * 12 + 8;
              const cellScale = spring({
                frame: Math.max(0, frame - cellDelay),
                fps,
                config: { damping: 15, stiffness: 100 },
              });

              const cellX = TABLE_X + ROLE_COL_W + CELL_GAP_X + ci * (CELL_W + CELL_GAP_X);
              const activeBg = isActive ? `${row.color}22` : `${colors.border}18`;
              const activeBorder = isActive ? `${row.color}60` : `${colors.border}40`;

              // Pulse for 병렬 cells
              const pulseAlpha =
                isParallel && phase3Visible
                  ? pulseBrightness
                  : 1.0;

              return (
                <div
                  key={`${ri}-${ci}`}
                  style={{
                    position: "absolute",
                    left: cellX,
                    top: rowY,
                    width: CELL_W,
                    height: CELL_H,
                    transform: isActive ? `scale(${cellScale})` : "scale(1)",
                    transformOrigin: "center center",
                    background: activeBg,
                    border: `1.5px solid ${activeBorder}`,
                    borderRadius: 8,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 3,
                    opacity: isActive
                      ? interpolate(
                          frame,
                          [cellDelay, cellDelay + 18],
                          [0, pulseAlpha],
                          { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
                        )
                      : interpolate(frame, [35, 55], [0, 0.25], {
                          extrapolateRight: "clamp",
                        }),
                  }}
                >
                  {isActive && (
                    <>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 700,
                          color: row.color,
                          fontFamily: mono,
                        }}
                      >
                        {row.role}
                      </div>
                      {isParallel && (
                        <div
                          style={{
                            fontSize: 10,
                            color: colors.muted,
                            fontFamily: mono,
                            textTransform: "uppercase",
                            letterSpacing: 1,
                          }}
                        >
                          병렬
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}

      {/* Phase 3 "병렬" bracket/annotation */}
      {(() => {
        const frontendRowY = TABLE_Y + HEADER_H + CELL_GAP_Y + 3 * (CELL_H + CELL_GAP_Y);
        const backendRowY = TABLE_Y + HEADER_H + CELL_GAP_Y + 4 * (CELL_H + CELL_GAP_Y);
        const p3CellX = TABLE_X + ROLE_COL_W + CELL_GAP_X + 3 * (CELL_W + CELL_GAP_X) + CELL_W + 8;
        const annotOpacity = interpolate(frame, [200, 225], [0, 1], { extrapolateRight: "clamp" });

        return (
          <div style={{ position: "absolute", opacity: annotOpacity }}>
            <svg
              style={{ position: "absolute", top: 0, left: 0, width: 1920, height: 1080 }}
            >
              {/* Bracket spanning both rows */}
              <line
                x1={p3CellX + 4}
                y1={frontendRowY + 6}
                x2={p3CellX + 4}
                y2={backendRowY + CELL_H - 6}
                stroke={colors.cyan}
                strokeWidth={2}
                opacity={0.7}
              />
              <line
                x1={p3CellX + 4}
                y1={frontendRowY + 6}
                x2={p3CellX + 14}
                y2={frontendRowY + 6}
                stroke={colors.cyan}
                strokeWidth={2}
                opacity={0.7}
              />
              <line
                x1={p3CellX + 4}
                y1={backendRowY + CELL_H - 6}
                x2={p3CellX + 14}
                y2={backendRowY + CELL_H - 6}
                stroke={colors.cyan}
                strokeWidth={2}
                opacity={0.7}
              />
            </svg>
            <div
              style={{
                position: "absolute",
                left: p3CellX + 22,
                top: (frontendRowY + backendRowY + CELL_H) / 2 - 14,
                fontSize: 11,
                fontWeight: 700,
                color: colors.cyan,
                fontFamily: mono,
                textTransform: "uppercase",
                letterSpacing: 1,
                background: `${colors.cyan}12`,
                border: `1px solid ${colors.cyan}40`,
                borderRadius: 6,
                padding: "4px 10px",
                whiteSpace: "nowrap",
              }}
            >
              concurrent
            </div>
          </div>
        );
      })()}

      {/* Team Lead Phase 5 annotation */}
      {(() => {
        const tlRowY = TABLE_Y + HEADER_H + CELL_GAP_Y; // row 0
        const p5CellX = TABLE_X + ROLE_COL_W + CELL_GAP_X + 5 * (CELL_W + CELL_GAP_X);
        const shipScale = spring({
          frame: Math.max(0, frame - 148),
          fps,
          config: { damping: 14, stiffness: 90 },
        });
        const shipOpacity = interpolate(frame, [148, 168], [0, 1], { extrapolateRight: "clamp" });

        return (
          <div
            style={{
              position: "absolute",
              left: p5CellX,
              top: tlRowY,
              width: CELL_W,
              height: CELL_H,
              transform: `scale(${shipScale})`,
              transformOrigin: "center center",
              background: `${colors.muted}22`,
              border: `1.5px solid ${colors.muted}60`,
              borderRadius: 8,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 3,
              opacity: shipOpacity,
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 700, color: colors.muted, fontFamily: mono }}>
              Team Lead
            </div>
            <div style={{ fontSize: 10, color: colors.muted, fontFamily: mono }}>
              ship
            </div>
          </div>
        );
      })()}

      {/* Bottom note */}
      <div
        style={{
          position: "absolute",
          bottom: 44,
          left: 0,
          right: 0,
          textAlign: "center",
          opacity: interpolate(frame, [300, 330], [0, 1], { extrapolateRight: "clamp" }),
        }}
      >
        <div style={{ fontSize: 14, color: colors.muted }}>
          Phase 3 병렬izes Frontend + Backend — cutting delivery time in half
        </div>
      </div>
    </AbsoluteFill>
  );
};

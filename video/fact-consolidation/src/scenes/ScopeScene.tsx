import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { colors, sansFont, monoFont } from "../styles";

export const ScopeScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleOpacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: "clamp" });

  // Phase 1: Show the problem - what happens WITHOUT scope isolation
  const problemOpacity = interpolate(frame, [10, 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const problemFade = interpolate(frame, [40, 50], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  // Phase 2: Show the solution - scope isolation
  const solutionOpacity = interpolate(frame, [45, 55], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  // Global scope
  const globalOpacity = interpolate(frame, [50, 60], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const globalScale = spring({ frame: Math.max(0, frame - 50), fps, config: { damping: 14 } });

  // Project scopes
  const projAOpacity = interpolate(frame, [62, 72], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const projBOpacity = interpolate(frame, [68, 78], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const projAScale = spring({ frame: Math.max(0, frame - 62), fps, config: { damping: 14 } });
  const projBScale = spring({ frame: Math.max(0, frame - 68), fps, config: { damping: 14 } });

  // Arrows and X
  const arrowOpacity = interpolate(frame, [78, 88], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const xOpacity = interpolate(frame, [90, 100], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const xScale = spring({ frame: Math.max(0, frame - 90), fps, config: { damping: 10, stiffness: 150 } });

  // "What each project sees" section
  const seesOpacity = interpolate(frame, [105, 115], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  const FactTag = ({ text, color, scope, delay }: { text: string; color: string; scope: string; delay: number }) => {
    const o = interpolate(frame, [delay, delay + 8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    return (
      <div style={{
        opacity: o,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        background: `${color}10`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 4,
        fontSize: 14,
        fontFamily: monoFont,
        color: colors.text,
      }}>
        <span style={{
          fontSize: 10,
          fontWeight: 700,
          color: scope === "global" ? colors.purple : colors.accent,
          background: scope === "global" ? `${colors.purple}20` : `${colors.accent}20`,
          padding: "1px 6px",
          borderRadius: 3,
        }}>
          {scope}
        </span>
        {text}
      </div>
    );
  };

  return (
    <AbsoluteFill style={{ background: colors.bg, fontFamily: sansFont }}>
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", height: "100%", padding: "0 80px" }}>
        <div style={{
          fontSize: 14,
          color: colors.orange,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: 3,
          opacity: titleOpacity,
          marginBottom: 6,
        }}>
          Memory Architecture
        </div>
        <div style={{
          fontSize: 44,
          fontWeight: 700,
          color: colors.text,
          opacity: titleOpacity,
          marginBottom: 30,
        }}>
          Scope <span style={{ color: colors.orange }}>Isolation</span>
        </div>

        {/* Phase 1: Problem - shown briefly */}
        {frame < 55 && (
          <div style={{
            opacity: problemOpacity * problemFade,
            background: `${colors.red}08`,
            border: `1px solid ${colors.red}30`,
            borderRadius: 12,
            padding: "24px 32px",
            marginBottom: 20,
          }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: colors.red, marginBottom: 12 }}>
              Without scope isolation:
            </div>
            <div style={{ fontSize: 16, color: colors.text, lineHeight: 1.6 }}>
              Flutter project sees <span style={{ color: colors.red }}>"Use Redux Toolkit"</span> from React project
            </div>
            <div style={{ fontSize: 16, color: colors.text, lineHeight: 1.6 }}>
              React project sees <span style={{ color: colors.red }}>"Use Riverpod"</span> from Flutter project
            </div>
            <div style={{ fontSize: 14, color: colors.textMuted, marginTop: 8 }}>
              Claude gets confused by contradicting technology decisions from different projects
            </div>
          </div>
        )}

        {/* Phase 2: Solution */}
        <div style={{ opacity: solutionOpacity, position: "relative" }}>
          {/* Global scope - centered at top */}
          <div style={{
            opacity: globalOpacity,
            transform: `scale(${globalScale})`,
            display: "flex",
            justifyContent: "center",
            marginBottom: 20,
          }}>
            <div style={{
              width: 700,
              background: colors.surface,
              border: `2px solid ${colors.purple}`,
              borderRadius: 16,
              padding: "16px 24px",
            }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: colors.purple, marginBottom: 10, textAlign: "center" }}>
                GLOBAL SCOPE (User-wide preferences)
              </div>
              <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
                <FactTag text='"Named exports only"' color={colors.purple} scope="global" delay={55} />
                <FactTag text='"Korean responses"' color={colors.purple} scope="global" delay={58} />
                <FactTag text='"Prefer Tailwind"' color={colors.purple} scope="global" delay={61} />
              </div>
              <div style={{ fontSize: 12, color: colors.textMuted, textAlign: "center", marginTop: 8, fontFamily: monoFont }}>
                Shared to ALL projects automatically
              </div>
            </div>
          </div>

          {/* Arrows: Global to projects */}
          <svg style={{ position: "absolute", width: "100%", height: 40, top: 130, left: 0, pointerEvents: "none" }}>
            <line x1="35%" y1="0" x2="25%" y2="35" stroke={colors.green} strokeWidth={2} strokeDasharray="6,4" opacity={arrowOpacity} />
            <text x="28%" y="20" fill={colors.green} fontSize="12" fontFamily="system-ui, sans-serif" fontWeight="bold" opacity={arrowOpacity}>shared</text>
            <line x1="65%" y1="0" x2="75%" y2="35" stroke={colors.green} strokeWidth={2} strokeDasharray="6,4" opacity={arrowOpacity} />
            <text x="68%" y="20" fill={colors.green} fontSize="12" fontFamily="system-ui, sans-serif" fontWeight="bold" opacity={arrowOpacity}>shared</text>
          </svg>

          {/* Two project scopes side by side */}
          <div style={{ display: "flex", gap: 40, marginTop: 40, justifyContent: "center" }}>
            {/* Project A: Flutter */}
            <div style={{
              opacity: projAOpacity,
              transform: `scale(${projAScale})`,
              flex: 1,
              maxWidth: 420,
            }}>
              <div style={{
                background: colors.surface,
                border: `2px solid ${colors.accent}`,
                borderRadius: 16,
                padding: "16px 24px",
              }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: colors.accent, marginBottom: 10 }}>
                  PROJECT: Flutter App
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <FactTag text='"Use Riverpod"' color={colors.accent} scope="project" delay={65} />
                  <FactTag text='"GoRouter navigation"' color={colors.accent} scope="project" delay={68} />
                  <FactTag text='"Feature-first arch"' color={colors.accent} scope="project" delay={71} />
                </div>
              </div>
            </div>

            {/* X mark */}
            <div style={{
              display: "flex",
              alignItems: "center",
              opacity: xOpacity,
              transform: `scale(${xScale})`,
            }}>
              <div style={{
                background: `${colors.red}15`,
                border: `2px solid ${colors.red}`,
                borderRadius: 12,
                padding: "12px 16px",
                textAlign: "center",
              }}>
                <div style={{ fontSize: 32, color: colors.red, fontWeight: 700, lineHeight: 1 }}>X</div>
                <div style={{ fontSize: 11, color: colors.red, fontFamily: monoFont, marginTop: 4 }}>NEVER</div>
                <div style={{ fontSize: 11, color: colors.red, fontFamily: monoFont }}>shared</div>
              </div>
            </div>

            {/* Project B: React */}
            <div style={{
              opacity: projBOpacity,
              transform: `scale(${projBScale})`,
              flex: 1,
              maxWidth: 420,
            }}>
              <div style={{
                background: colors.surface,
                border: `2px solid ${colors.orange}`,
                borderRadius: 16,
                padding: "16px 24px",
              }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: colors.orange, marginBottom: 10 }}>
                  PROJECT: React Dashboard
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <FactTag text='"Use Redux Toolkit"' color={colors.orange} scope="project" delay={72} />
                  <FactTag text='"React Router v6"' color={colors.orange} scope="project" delay={75} />
                  <FactTag text='"Zustand for UI state"' color={colors.orange} scope="project" delay={78} />
                </div>
              </div>
            </div>
          </div>

          {/* What each project sees */}
          <div style={{
            opacity: seesOpacity,
            display: "flex",
            gap: 24,
            marginTop: 30,
            justifyContent: "center",
          }}>
            <div style={{
              background: colors.surface2,
              borderRadius: 8,
              padding: "10px 20px",
              fontFamily: monoFont,
              fontSize: 13,
              color: colors.textMuted,
            }}>
              Flutter sees: <span style={{ color: colors.accent }}>Flutter facts</span> + <span style={{ color: colors.purple }}>Global facts</span>
            </div>
            <div style={{
              background: colors.surface2,
              borderRadius: 8,
              padding: "10px 20px",
              fontFamily: monoFont,
              fontSize: 13,
              color: colors.textMuted,
            }}>
              React sees: <span style={{ color: colors.orange }}>React facts</span> + <span style={{ color: colors.purple }}>Global facts</span>
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

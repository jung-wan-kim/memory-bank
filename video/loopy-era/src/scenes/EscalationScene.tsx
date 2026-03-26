import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { colors, sans, mono } from "../styles";

interface Stage {
  number: number;
  label: string;
  title: string;
  description: string;
  detail: string;
  color: string;
  enterDelay: number;
}

const STAGES: Stage[] = [
  {
    number: 1,
    label: "Stage 1",
    title: "Soft Nudge",
    description: "additionalContext injection",
    detail: "Hook injects guidance\ninto next prompt context",
    color: colors.green,
    enterDelay: 20,
  },
  {
    number: 2,
    label: "Stage 2",
    title: "Agent Fix",
    description: "Opus agent auto-repair",
    detail: "bug-fixer agent called\nup to 3 retry attempts",
    color: colors.accent,
    enterDelay: 80,
  },
  {
    number: 3,
    label: "Stage 3",
    title: "Hard Block",
    description: "exit 2 + Telegram alert",
    detail: "Commit gated\nUser notified immediately",
    color: colors.red,
    enterDelay: 140,
  },
];

export const EscalationScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleOpacity = interpolate(frame, [0, 18], [0, 1], { extrapolateRight: "clamp" });

  const CARD_W = 420;
  const CARD_H = 340;
  const totalW = STAGES.length * CARD_W + (STAGES.length - 1) * 48;
  const startX = (1920 - totalW) / 2;

  return (
    <AbsoluteFill style={{ background: colors.bg, fontFamily: sans }}>
      {/* Background subtle gradient */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(ellipse at 50% 80%, rgba(248,113,113,0.06) 0%, transparent 60%)`,
        }}
      />

      {/* Title */}
      <div
        style={{
          position: "absolute",
          top: 60,
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
            color: colors.red,
            fontFamily: mono,
            marginBottom: 8,
          }}
        >
          error escalation
        </div>
        <div style={{ fontSize: 38, fontWeight: 700, color: colors.text }}>
          Three-Stage Recovery Protocol
        </div>
      </div>

      {/* Stage cards */}
      {STAGES.map((stage, i) => {
        const cardX = startX + i * (CARD_W + 48);
        const cardY = (1080 - CARD_H) / 2 + 30;

        const slideY = interpolate(
          frame,
          [stage.enterDelay, stage.enterDelay + 30],
          [60, 0],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
        );
        const cardOpacity = interpolate(
          frame,
          [stage.enterDelay, stage.enterDelay + 25],
          [0, 1],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
        );

        // Progress bar fill
        const barDelay = stage.enterDelay + 40;
        const barWidth = interpolate(
          frame,
          [barDelay, barDelay + 60],
          [0, 100],
          { extrapolateRight: "clamp" }
        );

        // Arrow between cards
        const arrowOpacity = i < STAGES.length - 1
          ? interpolate(frame, [stage.enterDelay + 50, stage.enterDelay + 70], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            })
          : 0;

        return (
          <div key={stage.label}>
            {/* Card */}
            <div
              style={{
                position: "absolute",
                left: cardX,
                top: cardY + slideY,
                width: CARD_W,
                height: CARD_H,
                opacity: cardOpacity,
                background: `${stage.color}0e`,
                border: `2px solid ${stage.color}40`,
                borderRadius: 20,
                padding: 36,
                display: "flex",
                flexDirection: "column",
                gap: 16,
              }}
            >
              {/* Stage badge */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: "50%",
                    background: stage.color,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 16,
                    fontWeight: 800,
                    color: colors.bg,
                  }}
                >
                  {stage.number}
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: stage.color,
                    fontFamily: mono,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: 2,
                  }}
                >
                  {stage.label}
                </div>
              </div>

              {/* Title */}
              <div style={{ fontSize: 28, fontWeight: 700, color: stage.color }}>
                {stage.title}
              </div>

              {/* Description */}
              <div
                style={{
                  fontSize: 16,
                  color: colors.muted,
                  fontFamily: mono,
                  background: `${colors.surface}`,
                  padding: "8px 14px",
                  borderRadius: 8,
                  border: `1px solid ${colors.border}`,
                }}
              >
                {stage.description}
              </div>

              {/* Detail text */}
              <div
                style={{
                  fontSize: 14,
                  color: colors.muted,
                  lineHeight: 1.6,
                  whiteSpace: "pre-line",
                }}
              >
                {stage.detail}
              </div>

              {/* Progress bar */}
              <div
                style={{
                  marginTop: "auto",
                }}
              >
                <div
                  style={{
                    height: 4,
                    background: colors.border,
                    borderRadius: 2,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${barWidth}%`,
                      height: "100%",
                      background: `linear-gradient(90deg, ${stage.color}80, ${stage.color})`,
                      borderRadius: 2,
                    }}
                  />
                </div>
              </div>
            </div>

            {/* Arrow connector */}
            {i < STAGES.length - 1 && (
              <div
                style={{
                  position: "absolute",
                  left: cardX + CARD_W + 10,
                  top: cardY + CARD_H / 2 - 16,
                  width: 28,
                  fontSize: 28,
                  color: colors.muted,
                  opacity: arrowOpacity,
                  textAlign: "center",
                }}
              >
                &#x203A;
              </div>
            )}
          </div>
        );
      })}

      {/* Bottom label */}
      <div
        style={{
          position: "absolute",
          bottom: 52,
          left: 0,
          right: 0,
          textAlign: "center",
          opacity: interpolate(frame, [200, 230], [0, 1], { extrapolateRight: "clamp" }),
        }}
      >
        <div style={{ fontSize: 15, color: colors.muted, fontFamily: mono }}>
          Max 3 retries per task &middot; Strategy rotates each attempt &middot; Escalate on 3rd failure
        </div>
      </div>
    </AbsoluteFill>
  );
};

import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { colors, sans, mono } from "../styles";

interface PipelineNode {
  label: string;
  sublabel: string;
  color: string;
}

const PIPELINE1: PipelineNode[] = [
  { label: "Conversations", sublabel: "JSONL", color: colors.blue },
  { label: "Parser", sublabel: "extract exchanges", color: colors.blue },
  { label: "Embeddings", sublabel: "384-dim", color: colors.cyan },
  { label: "SQLite+vec", sublabel: "vector store", color: colors.accent },
  { label: "Semantic Search", sublabel: "cosine similarity", color: colors.green },
];

const PIPELINE2: PipelineNode[] = [
  { label: "Session End", sublabel: "hook trigger", color: colors.orange },
  { label: "Haiku LLM", sublabel: "fact extraction", color: colors.orange },
  { label: "Consolidation", sublabel: "dedup + merge", color: colors.red },
  { label: "Facts DB", sublabel: "2,600+", color: colors.accent },
  { label: "Ontology", sublabel: "domain graph", color: colors.yellow },
];

const CONSOLIDATION_TYPES = [
  { label: "DUPLICATE", action: "merge", color: colors.blue },
  { label: "CONTRADICTION", action: "replace", color: colors.red },
  { label: "EVOLUTION", action: "update", color: colors.green },
  { label: "INDEPENDENT", action: "keep", color: colors.muted },
];

const NODE_W = 168;
const NODE_H = 72;
const NODE_GAP = 44;
const PIPE_ROW1_Y = 280;
const PIPE_ROW2_Y = 580;
const TOTAL_W = 5 * NODE_W + 4 * NODE_GAP;
const START_X = (1920 - TOTAL_W) / 2;

// Dot animation: 3 dots travel along each pipeline
const NUM_DOTS = 3;
const DOT_SPACING = 60; // frames between dots

function getDotX(frame: number, nodeCount: number, dotIndex: number): number {
  const segmentW = NODE_W + NODE_GAP;
  const totalTravel = (nodeCount - 1) * segmentW;
  const offset = ((frame - dotIndex * DOT_SPACING) % (totalTravel + DOT_SPACING));
  const clamped = Math.max(0, Math.min(totalTravel, offset));
  return clamped;
}

export const DataPipelineScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleOpacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: "clamp" });

  // Pipeline 1 entry: frames 20-80
  // Pipeline 2 entry: frames 120-180
  const pipe1Opacity = interpolate(frame, [20, 45], [0, 1], { extrapolateRight: "clamp" });
  const pipe2Opacity = interpolate(frame, [120, 145], [0, 1], { extrapolateRight: "clamp" });

  // Consolidation labels appear at frame 200
  const consolOpacity = interpolate(frame, [200, 230], [0, 1], { extrapolateRight: "clamp" });

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
          data pipeline
        </div>
        <div style={{ fontSize: 38, fontWeight: 700, color: colors.text }}>
          Memory Bank Internals
        </div>
      </div>

      {/* Pipeline 1 label */}
      <div
        style={{
          position: "absolute",
          left: START_X,
          top: PIPE_ROW1_Y - 40,
          opacity: pipe1Opacity,
          fontSize: 13,
          fontWeight: 600,
          color: colors.blue,
          fontFamily: mono,
          textTransform: "uppercase",
          letterSpacing: 3,
        }}
      >
        Pipeline 1 — Conversation Indexing
      </div>

      {/* Pipeline 2 label */}
      <div
        style={{
          position: "absolute",
          left: START_X,
          top: PIPE_ROW2_Y - 40,
          opacity: pipe2Opacity,
          fontSize: 13,
          fontWeight: 600,
          color: colors.orange,
          fontFamily: mono,
          textTransform: "uppercase",
          letterSpacing: 3,
        }}
      >
        Pipeline 2 — Fact Extraction
      </div>

      {/* SVG layer: connecting lines + animated dots */}
      <svg
        style={{ position: "absolute", top: 0, left: 0, width: 1920, height: 1080 }}
      >
        {/* Pipeline 1 connecting lines */}
        {PIPELINE1.map((_, i) => {
          if (i >= PIPELINE1.length - 1) return null;
          const x1 = START_X + i * (NODE_W + NODE_GAP) + NODE_W;
          const x2 = START_X + (i + 1) * (NODE_W + NODE_GAP);
          const y = PIPE_ROW1_Y + NODE_H / 2;
          const lineDelay = 25 + i * 12;
          const lineOpacity = interpolate(
            frame,
            [lineDelay, lineDelay + 18],
            [0, 0.7],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
          );
          return (
            <g key={`p1-line-${i}`}>
              <line
                x1={x1} y1={y} x2={x2} y2={y}
                stroke={colors.blue}
                strokeWidth={2}
                opacity={lineOpacity}
              />
              {/* Arrowhead */}
              <polygon
                points={`${x2},${y} ${x2 - 9},${y - 4} ${x2 - 9},${y + 4}`}
                fill={colors.blue}
                opacity={lineOpacity}
              />
            </g>
          );
        })}

        {/* Pipeline 1 animated dots */}
        {frame > 60 &&
          Array.from({ length: NUM_DOTS }).map((_, di) => {
            const rawOffset = (frame - 60 - di * DOT_SPACING);
            if (rawOffset < 0) return null;
            const totalTravel = (PIPELINE1.length - 1) * (NODE_W + NODE_GAP);
            const cycleLen = totalTravel + DOT_SPACING;
            const pos = rawOffset % cycleLen;
            if (pos > totalTravel) return null;
            const dotX = START_X + NODE_W + pos; // starts after first node
            const dotY = PIPE_ROW1_Y + NODE_H / 2;
            return (
              <circle
                key={`p1-dot-${di}`}
                cx={dotX}
                cy={dotY}
                r={5}
                fill={colors.cyan}
                opacity={0.85}
              />
            );
          })}

        {/* Pipeline 2 connecting lines */}
        {PIPELINE2.map((_, i) => {
          if (i >= PIPELINE2.length - 1) return null;
          const x1 = START_X + i * (NODE_W + NODE_GAP) + NODE_W;
          const x2 = START_X + (i + 1) * (NODE_W + NODE_GAP);
          const y = PIPE_ROW2_Y + NODE_H / 2;
          const lineDelay = 125 + i * 12;
          const lineOpacity = interpolate(
            frame,
            [lineDelay, lineDelay + 18],
            [0, 0.7],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
          );
          return (
            <g key={`p2-line-${i}`}>
              <line
                x1={x1} y1={y} x2={x2} y2={y}
                stroke={colors.orange}
                strokeWidth={2}
                opacity={lineOpacity}
              />
              <polygon
                points={`${x2},${y} ${x2 - 9},${y - 4} ${x2 - 9},${y + 4}`}
                fill={colors.orange}
                opacity={lineOpacity}
              />
            </g>
          );
        })}

        {/* Pipeline 2 animated dots */}
        {frame > 160 &&
          Array.from({ length: NUM_DOTS }).map((_, di) => {
            const rawOffset = (frame - 160 - di * DOT_SPACING);
            if (rawOffset < 0) return null;
            const totalTravel = (PIPELINE2.length - 1) * (NODE_W + NODE_GAP);
            const cycleLen = totalTravel + DOT_SPACING;
            const pos = rawOffset % cycleLen;
            if (pos > totalTravel) return null;
            const dotX = START_X + NODE_W + pos;
            const dotY = PIPE_ROW2_Y + NODE_H / 2;
            return (
              <circle
                key={`p2-dot-${di}`}
                cx={dotX}
                cy={dotY}
                r={5}
                fill={colors.yellow}
                opacity={0.85}
              />
            );
          })}
      </svg>

      {/* Pipeline 1 nodes */}
      {PIPELINE1.map((node, i) => {
        const delay = 25 + i * 14;
        const nodeScale = spring({
          frame: Math.max(0, frame - delay),
          fps,
          config: { damping: 14, stiffness: 95 },
        });
        return (
          <div
            key={`p1-node-${i}`}
            style={{
              position: "absolute",
              left: START_X + i * (NODE_W + NODE_GAP),
              top: PIPE_ROW1_Y,
              width: NODE_W,
              height: NODE_H,
              transform: `scale(${nodeScale})`,
              transformOrigin: "center center",
              background: `${node.color}15`,
              border: `1.5px solid ${node.color}55`,
              borderRadius: 10,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 700, color: node.color }}>
              {node.label}
            </div>
            <div style={{ fontSize: 11, color: colors.muted, fontFamily: mono }}>
              {node.sublabel}
            </div>
          </div>
        );
      })}

      {/* Pipeline 2 nodes */}
      {PIPELINE2.map((node, i) => {
        const delay = 125 + i * 14;
        const nodeScale = spring({
          frame: Math.max(0, frame - delay),
          fps,
          config: { damping: 14, stiffness: 95 },
        });
        return (
          <div
            key={`p2-node-${i}`}
            style={{
              position: "absolute",
              left: START_X + i * (NODE_W + NODE_GAP),
              top: PIPE_ROW2_Y,
              width: NODE_W,
              height: NODE_H,
              transform: `scale(${nodeScale})`,
              transformOrigin: "center center",
              background: `${node.color}15`,
              border: `1.5px solid ${node.color}55`,
              borderRadius: 10,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 700, color: node.color }}>
              {node.label}
            </div>
            <div style={{ fontSize: 11, color: colors.muted, fontFamily: mono }}>
              {node.sublabel}
            </div>
          </div>
        );
      })}

      {/* Consolidation type labels below pipeline 2 */}
      <div
        style={{
          position: "absolute",
          left: START_X,
          top: PIPE_ROW2_Y + NODE_H + 32,
          display: "flex",
          gap: 24,
          opacity: consolOpacity,
        }}
      >
        {CONSOLIDATION_TYPES.map((ct) => (
          <div
            key={ct.label}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 16px",
              background: `${ct.color}12`,
              border: `1px solid ${ct.color}40`,
              borderRadius: 20,
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: ct.color,
                fontFamily: mono,
                textTransform: "uppercase",
                letterSpacing: 1,
              }}
            >
              {ct.label}
            </div>
            <div style={{ fontSize: 11, color: colors.muted }}>
              ({ct.action})
            </div>
          </div>
        ))}
      </div>

      {/* Bottom note */}
      <div
        style={{
          position: "absolute",
          bottom: 44,
          left: 0,
          right: 0,
          textAlign: "center",
          opacity: interpolate(frame, [280, 310], [0, 1], { extrapolateRight: "clamp" }),
        }}
      >
        <div style={{ fontSize: 14, color: colors.muted }}>
          Two pipelines run in parallel — every session grows the knowledge base
        </div>
      </div>
    </AbsoluteFill>
  );
};

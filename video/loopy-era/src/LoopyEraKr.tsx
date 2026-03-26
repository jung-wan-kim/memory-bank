import { AbsoluteFill, Sequence } from "remotion";
import { IntroScene } from "./scenes-kr/IntroScene";
import { LoopScene } from "./scenes-kr/LoopScene";
import { EscalationScene } from "./scenes-kr/EscalationScene";
import { ContextStackScene } from "./scenes-kr/ContextStackScene";
import { DataPipelineScene } from "./scenes-kr/DataPipelineScene";
import { InitProjectScene } from "./scenes-kr/InitProjectScene";
import { LayersScene } from "./scenes-kr/LayersScene";
import { TeamDetailScene } from "./scenes-kr/TeamDetailScene";
import { OutroScene } from "./scenes-kr/OutroScene";

export const LoopyEraKr = () => {
  return (
    <AbsoluteFill>
      {/* Scene 1: Intro — 0-5s, frames 0-150 */}
      <Sequence from={0} durationInFrames={150}>
        <IntroScene />
      </Sequence>

      {/* Scene 2: The Loop — 5-15s, frames 150-450 */}
      <Sequence from={150} durationInFrames={300}>
        <LoopScene />
      </Sequence>

      {/* Scene 3: Error Escalation — 15-25s, frames 450-750 */}
      <Sequence from={450} durationInFrames={300}>
        <EscalationScene />
      </Sequence>

      {/* Scene 4: Context Stack — 25-35s, frames 750-1050 */}
      <Sequence from={750} durationInFrames={300}>
        <ContextStackScene />
      </Sequence>

      {/* Scene 5: Data Pipeline — 35-47s, frames 1050-1410 */}
      <Sequence from={1050} durationInFrames={360}>
        <DataPipelineScene />
      </Sequence>

      {/* Scene 6: Init Project — 47-57s, frames 1410-1710 */}
      <Sequence from={1410} durationInFrames={300}>
        <InitProjectScene />
      </Sequence>

      {/* Scene 7: Architecture Layers — 57-67s, frames 1710-2010 */}
      <Sequence from={1710} durationInFrames={300}>
        <LayersScene />
      </Sequence>

      {/* Scene 8: Team Detail — 67-80s, frames 2010-2400 */}
      <Sequence from={2010} durationInFrames={390}>
        <TeamDetailScene />
      </Sequence>

      {/* Scene 9: Outro — 80-100s, frames 2400-3000 */}
      <Sequence from={2400} durationInFrames={600}>
        <OutroScene />
      </Sequence>
    </AbsoluteFill>
  );
};

import { AbsoluteFill, Sequence } from "remotion";
import { IntroScene } from "./scenes/IntroScene";
import { LoopScene } from "./scenes/LoopScene";
import { EscalationScene } from "./scenes/EscalationScene";
import { LayersScene } from "./scenes/LayersScene";
import { TeamFlowScene } from "./scenes/TeamFlowScene";
import { OutroScene } from "./scenes/OutroScene";

export const LoopyEra = () => {
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

      {/* Scene 4: Architecture Layers — 25-35s, frames 750-1050 */}
      <Sequence from={750} durationInFrames={300}>
        <LayersScene />
      </Sequence>

      {/* Scene 5: Team Flow — 35-50s, frames 1050-1500 */}
      <Sequence from={1050} durationInFrames={450}>
        <TeamFlowScene />
      </Sequence>

      {/* Scene 6: Outro — 50-60s, frames 1500-1800 */}
      <Sequence from={1500} durationInFrames={300}>
        <OutroScene />
      </Sequence>
    </AbsoluteFill>
  );
};

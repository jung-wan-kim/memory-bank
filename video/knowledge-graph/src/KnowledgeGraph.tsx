import { AbsoluteFill, Sequence } from "remotion";
import { IntroScene } from "./scenes/IntroScene";
import { PipelineScene } from "./scenes/PipelineScene";
import { ToolsScene } from "./scenes/ToolsScene";
import { GraphScene } from "./scenes/GraphScene";
import { UseCasesScene } from "./scenes/UseCasesScene";
import { OutroScene } from "./scenes/OutroScene";

export const KnowledgeGraph = () => {
  return (
    <AbsoluteFill>
      <Sequence from={0} durationInFrames={150}>
        <IntroScene />
      </Sequence>
      <Sequence from={150} durationInFrames={180}>
        <PipelineScene />
      </Sequence>
      <Sequence from={330} durationInFrames={180}>
        <ToolsScene />
      </Sequence>
      <Sequence from={510} durationInFrames={180}>
        <GraphScene />
      </Sequence>
      <Sequence from={690} durationInFrames={120}>
        <UseCasesScene />
      </Sequence>
      <Sequence from={810} durationInFrames={90}>
        <OutroScene />
      </Sequence>
    </AbsoluteFill>
  );
};

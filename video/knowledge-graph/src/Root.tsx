import { Composition } from "remotion";
import { KnowledgeGraph } from "./KnowledgeGraph";

export const RemotionRoot = () => {
  return (
    <Composition
      id="KnowledgeGraph"
      component={KnowledgeGraph}
      durationInFrames={900}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};

import { Composition } from "remotion";
import { LoopyEra } from "./LoopyEra";

export const RemotionRoot = () => {
  return (
    <Composition
      id="LoopyEra"
      component={LoopyEra}
      durationInFrames={1800}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};

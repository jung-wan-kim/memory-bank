import { Composition } from "remotion";
import { LoopyEra } from "./LoopyEra";
import { LoopyEraKr } from "./LoopyEraKr";

export const RemotionRoot = () => {
  return (
    <>
      <Composition
        id="LoopyEra"
        component={LoopyEra}
        durationInFrames={3000}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="LoopyEraKr"
        component={LoopyEraKr}
        durationInFrames={3000}
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
};

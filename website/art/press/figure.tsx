import { Plate } from "../kit/react/draw";
import { PressArt } from "./art";
import { DONE_AT, poseAt, readoutOf } from "./model";
import "../kit/iso.css";
import "./press.css";

export function PressFigure() {
  return (
    <div className="iso press" data-theme="light">
      <Plate fig="Fig 1" title="Story to page" hint="Hover to scrub the stages" readout={readoutOf(poseAt(DONE_AT))}>
        <PressArt />
      </Plate>
    </div>
  );
}

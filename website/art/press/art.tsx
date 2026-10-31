// Server component: the static parts of the hero figure as JSX, handed to the live component as element props.
import * as React from "react";
import { Dots, FaceText, Line, Solid } from "../kit/react/draw";
import { BASE_ART, BED, BUBBLE_ART, GANTRY, HEAD, PANEL_ART, RAILS, TRAYS } from "./geometry";
import { PressLive } from "./live";

const BASE = (
  <g key="base">
    <path className="iso-halo" d={BASE_ART.halo} />
    {BASE_ART.feet.map((parts, index) => (
      <g key={index}>
        {parts.map((paths, part) => (
          <Solid key={part} paths={paths} tone={part ? "mid" : "lo"} />
        ))}
      </g>
    ))}
    <Solid paths={BASE_ART.slab} tone="mid" />
    <Line d={BASE_ART.groove} tone="faint" />
    <Line d={BASE_ART.screwRings} tone="lo" />
    <Dots points={BASE_ART.screws} size={0.55} tone="mid" />
    <Solid paths={BASE_ART.ruler} tone="lo" crease="none" />
    <Line d={BASE_ART.rulerMinor} tone="lo" />
    <Line d={BASE_ART.rulerMajor} tone="mid" />
    <Dots points={BASE_ART.rulerScrews} size={0.45} tone="mid" />
    <Solid paths={BASE_ART.label} tone="lo" crease="none" />
    <FaceText transform={BASE_ART.labelText} size={3.6} tone="lo" anchor="middle">
      QWEN-IMAGE 2.1
    </FaceText>
    <Dots points={BASE_ART.labelScrews} size={0.45} tone="mid" />
  </g>
);

function railArt(rail: (typeof RAILS)["far"], key: string) {
  return (
    <g key={key}>
      <Solid paths={rail.rail} tone="mid" />
      <Line d={rail.groove} tone="faint" />
      <Dots points={rail.screws} size={0.45} tone="mid" />
      {rail.stops.map((paths, index) => (
        <Solid key={index} paths={paths} tone="mid" />
      ))}
      <Dots points={rail.stopScrews} size={0.45} tone="mid" />
    </g>
  );
}

function carriageArt(car: (typeof GANTRY)["far"], key: string) {
  return (
    <g key={key}>
      <path className="iso-halo" d={car.halo} style={{ filter: "blur(4px)" }} />
      {car.bush.map((paths, index) => (
        <Solid key={index} paths={paths} tone="lo" crease="none" />
      ))}
      <Solid paths={car.body} tone="mid" />
      <Line d={car.seam} tone="faint" />
      <Dots points={car.screws} size={0.45} tone="mid" />
      <Solid paths={car.upright} tone="mid" />
      {car.knob ? (
        <g>
          <Solid paths={car.knob.body} tone="mid" />
          <Line d={car.knob.knurl} tone="lo" />
          <Line d={car.knob.mark} tone="hi" free="end" />
        </g>
      ) : null}
    </g>
  );
}

function trayArt(tray: (typeof TRAYS)["in"] | (typeof TRAYS)["out"], extra: React.ReactNode, key: string) {
  return (
    <g key={key}>
      <path className="iso-halo" d={tray.halo} />
      <Solid paths={tray.floor} tone="lo" />
      {tray.back.map((paths, index) => (
        <Solid key={index} paths={paths} tone="mid" />
      ))}
      {tray.sheets.map((paths, index) => (
        <Solid key={index} paths={paths} tone="hi" crease="none" />
      ))}
      {extra}
      {tray.front.map((paths, index) => (
        <Solid key={index} paths={paths} tone="mid" />
      ))}
      <Dots points={tray.screws} size={0.4} tone="mid" />
    </g>
  );
}

const FAR_RAIL = railArt(RAILS.far, "far-rail");
const NEAR_RAIL = railArt(RAILS.near, "near-rail");
const FAR_GANTRY = carriageArt(GANTRY.far, "far-gantry");
const TRAY_IN = trayArt(TRAYS.in, <Line d={TRAYS.in.text} tone="mid" free />, "tray-in");
const TRAY_OUT = trayArt(TRAYS.out, <Line d={TRAYS.out.grid} tone="mid" />, "tray-out");

const BED_UNDER = (
  <g key="bed">
    <path className="iso-halo" d={BED.halo} />
    <Solid paths={BED.platen} tone="mid" />
    <Line d={BED.groove} tone="faint" />
    <Dots points={BED.screws} size={0.45} tone="mid" />
    {BED.pins.map((paths, index) => (
      <Solid key={index} paths={paths} tone="mid" />
    ))}
    <Solid paths={BED.page} tone="hi" crease="none" />
  </g>
);

const BED_OVER = (
  <g key="clips">
    {BED.clips.map((clip, index) => (
      <g key={index}>
        <Solid paths={clip.body} tone="mid" />
        <Dots points={[clip.screw]} size={0.4} tone="mid" />
      </g>
    ))}
  </g>
);

// Page art, one group per panel and per bubble, so the live component can fade them in.
const BORDERS = PANEL_ART.map((panel, index) => (
  <path key={`border-${index}`} className="iso-line press-border" data-tone="hi" d={panel.border} />
));
const ARTS = PANEL_ART.map((panel, index) => (
  <g key={`art-${index}`}>
    {panel.tone.length ? <Dots points={panel.tone} size={0.42} tone="mid" /> : null}
    <Line d={panel.lines} tone="mid" />
  </g>
));
const BUBBLES = BUBBLE_ART.map((bubble, index) => (
  <g key={`bubble-${index}`}>
    <path className="press-bubble" d={bubble.outline} />
    <path className="iso-line" data-tone="lo" data-free="" d={bubble.text} />
  </g>
));

const NEAR_GANTRY = (
  <g key="near-gantry">
    {carriageArt(GANTRY.near, "near-carriage")}
    <Solid paths={GANTRY.bridge} tone="mid" />
    <Line d={GANTRY.bridgeGroove} tone="faint" />
    <Dots points={GANTRY.bridgeScrews} size={0.42} tone="mid" />
    <Solid paths={GANTRY.strip} tone="lo" crease="none" />
    <Dots points={GANTRY.stripScrews} size={0.4} tone="mid" />
  </g>
);

const PEN_HEAD = (
  <g key="head">
    <Solid paths={HEAD.plate} tone="mid" />
    <Dots points={HEAD.plateScrews} size={0.42} tone="mid" />
    <Solid paths={HEAD.nib} tone="hi" lit crease="none" />
    <Solid paths={HEAD.cone} tone="hi" lit crease="none" />
    <Solid paths={HEAD.barrel} tone="hi" lit crease="none" />
    <Line d={HEAD.grip} tone="lit" />
    <Solid paths={HEAD.holder} tone="mid" />
    <Line d={HEAD.holderSeam} tone="faint" />
    <Dots points={HEAD.holderScrews} size={0.42} tone="mid" />
    <Solid paths={HEAD.upper} tone="hi" lit crease="none" />
    <Solid paths={HEAD.cap} tone="mid" />
    <Line d={HEAD.capRing} tone="lo" />
    <Solid paths={HEAD.solenoid} tone="mid" />
    <Line d={HEAD.solenoidTop} tone="lo" />
  </g>
);

export function PressArt() {
  return (
    <PressLive
      base={BASE}
      farRail={FAR_RAIL}
      farGantry={FAR_GANTRY}
      trayIn={TRAY_IN}
      bedUnder={BED_UNDER}
      borders={BORDERS}
      arts={ARTS}
      bubbles={BUBBLES}
      bedOver={BED_OVER}
      trayOut={TRAY_OUT}
      nearRail={NEAR_RAIL}
      nearGantry={NEAR_GANTRY}
      head={PEN_HEAD}
    />
  );
}

"use client";

// The one client component of the hero figure: places the static art in painter's order, moves the gantry
// and pen, fades page art in as the pipeline reaches it, and writes the readout. No React state per frame.
import * as React from "react";
import { translateAlong } from "../kit/iso-kit";
import { asksForStillness, useInView, useReadout } from "../kit/react/live";
import { BUBBLES, DONE_AT, LOOP, PANELS, STAGE_STARTS, poseAt, readoutOf, type Pose } from "./model";
import { HEIGHT, LIFT, P, WIDTH } from "./view";

interface Props {
  base: React.ReactNode;
  farRail: React.ReactNode;
  farGantry: React.ReactNode;
  trayIn: React.ReactNode;
  bedUnder: React.ReactNode;
  borders: React.ReactNode[];
  arts: React.ReactNode[];
  bubbles: React.ReactNode[];
  bedOver: React.ReactNode;
  trayOut: React.ReactNode;
  nearRail: React.ReactNode;
  nearGantry: React.ReactNode;
  head: React.ReactNode;
}

const HEAD_TAU = 0.32;
const LIFT_TAU = 0.09;
const FADE_TAU = 0.14;
const TOUR_BACK = 3600;
const LABEL =
  "A small pen plotter on a bench. On the left, a tray of story pages; in the middle, a page on the bed; on the right, a tray of finished pages. A gantry carries a vermilion pen that reads the story, lays out five panels right to left, draws them, adds three speech bubbles and checks the page.";

const follow = (value: number, target: number, dt: number, tau: number) => {
  const next = value + (target - value) * (1 - Math.exp(-dt / tau));
  return Math.abs(target - next) < 1e-3 ? target : next;
};

interface Shown {
  gx: number;
  hy: number;
  lift: number;
  borders: number[];
  art: number[];
  bubbles: number[];
}

const shownOf = (pose: Pose): Shown => ({ gx: pose.gx, hy: pose.hy, lift: pose.lift, borders: [...pose.borders], art: [...pose.art], bubbles: [...pose.bubbles] });
const REST = poseAt(DONE_AT);

export function PressLive(props: Props) {
  const stage = React.useRef<HTMLDivElement>(null);
  const far = React.useRef<SVGGElement>(null);
  const near = React.useRef<SVGGElement>(null);
  const head = React.useRef<SVGGElement>(null);
  const borderRefs = React.useRef<(SVGGElement | null)[]>([]);
  const artRefs = React.useRef<(SVGGElement | null)[]>([]);
  const bubbleRefs = React.useRef<(SVGGElement | null)[]>([]);
  const inView = useInView(stage);
  const { anchor, say } = useReadout<HTMLDivElement>();
  const [described, setDescribed] = React.useState(readoutOf(REST));

  const sim = React.useRef({ clock: DONE_AT, touring: false, shown: shownOf(REST), frame: 0, last: 0, timer: 0 as unknown as ReturnType<typeof setTimeout>, stage: REST.stage as string });

  const draw = React.useCallback(() => {
    const s = sim.current.shown;
    const move = translateAlong(P, [s.gx, 0, 0]);
    far.current?.setAttribute("transform", move);
    near.current?.setAttribute("transform", move);
    head.current?.setAttribute("transform", translateAlong(P, [0, s.hy, s.lift * LIFT]));
    const fade = (nodes: (SVGGElement | null)[], values: number[]) =>
      nodes.forEach((node, index) => {
        if (!node) return;
        const value = values[index];
        node.style.opacity = value >= 0.999 ? "" : value.toFixed(3);
        node.style.visibility = value <= 0.001 ? "hidden" : "";
      });
    fade(borderRefs.current, s.borders);
    fade(artRefs.current, s.art);
    fade(bubbleRefs.current, s.bubbles);
  }, []);

  const tick = React.useCallback(
    (now: number) => {
      const state = sim.current;
      const dt = state.last ? Math.min((now - state.last) / 1000, 1 / 30) : 1 / 60;
      state.last = now;
      const calm = asksForStillness();
      if (state.touring && !calm) state.clock = (state.clock + dt) % LOOP;
      const pose = poseAt(state.clock);
      const s = state.shown;
      if (calm) state.shown = shownOf(pose);
      else {
        s.gx = follow(s.gx, pose.gx, dt, HEAD_TAU);
        s.hy = follow(s.hy, pose.hy, dt, HEAD_TAU);
        s.lift = follow(s.lift, pose.lift, dt, LIFT_TAU);
        pose.borders.forEach((v, i) => (s.borders[i] = follow(s.borders[i], v, dt, FADE_TAU)));
        pose.art.forEach((v, i) => (s.art[i] = follow(s.art[i], v, dt, FADE_TAU)));
        pose.bubbles.forEach((v, i) => (s.bubbles[i] = follow(s.bubbles[i], v, dt, FADE_TAU)));
      }
      draw();
      say(readoutOf(pose));
      if (pose.stage !== state.stage) {
        state.stage = pose.stage;
        setDescribed(readoutOf(pose));
      }
      const now2 = state.shown;
      const settled =
        !state.touring &&
        now2.gx === pose.gx &&
        now2.hy === pose.hy &&
        now2.lift === pose.lift &&
        now2.borders.every((v, i) => v === pose.borders[i]) &&
        now2.art.every((v, i) => v === pose.art[i]) &&
        now2.bubbles.every((v, i) => v === pose.bubbles[i]);
      state.frame = !settled ? requestAnimationFrame(tick) : 0;
    },
    [draw, say],
  );

  const run = React.useCallback(() => {
    const state = sim.current;
    if (!state.frame) {
      state.last = 0;
      state.frame = requestAnimationFrame(tick);
    }
  }, [tick]);

  const stop = React.useCallback(() => {
    cancelAnimationFrame(sim.current.frame);
    sim.current.frame = 0;
  }, []);

  // Start the tour from the beginning once the figure is first seen; stop when offscreen.
  const started = React.useRef(false);
  React.useEffect(() => {
    if (!inView) {
      stop();
      return;
    }
    if (!started.current) {
      started.current = true;
      if (!asksForStillness()) {
        const state = sim.current;
        state.clock = 0;
        state.touring = true;
        state.shown = shownOf(poseAt(0));
        // Begin from an empty page; the parked head eases over to the story tray.
        state.shown.gx = REST.gx;
        state.shown.hy = REST.hy;
      }
    }
    run();
    return stop;
  }, [inView, run, stop]);

  React.useEffect(() => () => clearTimeout(sim.current.timer), []);

  const steer = React.useCallback(
    (clock: number) => {
      const state = sim.current;
      state.touring = false;
      state.clock = clock;
      clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        if (asksForStillness()) return;
        state.touring = true;
        run();
      }, TOUR_BACK);
      run();
    },
    [run],
  );

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    const box = event.currentTarget.getBoundingClientRect();
    const share = Math.min(1, Math.max(0, ((event.clientX - box.left) / box.width - 0.12) / 0.76));
    steer(share * DONE_AT);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const clock = sim.current.clock % LOOP;
    let index = STAGE_STARTS.findIndex((start, i) => clock >= start && clock < (STAGE_STARTS[i + 1] ?? Infinity));
    if (index < 0) index = STAGE_STARTS.length - 1;
    let to: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") to = Math.min(STAGE_STARTS.length - 1, index + 1);
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") to = Math.max(0, index - 1);
    if (event.key === "Home") to = 0;
    if (event.key === "End") to = STAGE_STARTS.length - 1;
    if (to === null) return;
    event.preventDefault();
    const end = (STAGE_STARTS[to + 1] ?? DONE_AT + 0.01) - 0.05;
    steer(to === STAGE_STARTS.length - 1 ? DONE_AT : end);
  };

  const s = REST;
  const restMove = translateAlong(P, [s.gx, 0, 0]);
  return (
    <div
      ref={(node) => {
        stage.current = node;
        anchor.current = node;
      }}
      className="iso-stage press-stage"
      tabIndex={0}
      role="slider"
      aria-label="Pipeline figure. Arrow keys step through the six stages."
      aria-valuemin={1}
      aria-valuemax={7}
      aria-valuenow={Math.max(1, ["analysis", "script", "layout", "artwork", "lettering", "qa", "done"].indexOf(sim.current.stage) + 1)}
      aria-valuetext={described}
      onPointerMove={onPointerMove}
      onKeyDown={onKeyDown}
    >
      <svg className="iso-svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={LABEL} focusable="false">
        <defs>
          <filter id="hand-hero" x="-5%" y="-5%" width="110%" height="110%">
            <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="3" />
            <feDisplacementMap in="SourceGraphic" scale="1.6" />
          </filter>
        </defs>
        <g filter="url(#hand-hero)">
          {props.base}
          {props.farRail}
          <g ref={far} transform={restMove}>
            {props.farGantry}
          </g>
          {props.trayIn}
          {props.bedUnder}
          {props.arts.map((node, index) => (
            <g key={`a${index}`} ref={(el) => void (artRefs.current[index] = el)}>
              {node}
            </g>
          ))}
          {props.borders.map((node, index) => (
            <g key={`b${index}`} ref={(el) => void (borderRefs.current[index] = el)}>
              {node}
            </g>
          ))}
          {props.bubbles.map((node, index) => (
            <g key={`u${index}`} ref={(el) => void (bubbleRefs.current[index] = el)}>
              {node}
            </g>
          ))}
          {props.bedOver}
          {props.trayOut}
          {props.nearRail}
          <g ref={near} transform={restMove}>
            {props.nearGantry}
            <g ref={head} transform={translateAlong(P, [0, s.hy, s.lift * LIFT])}>
              {props.head}
            </g>
          </g>
        </g>
      </svg>
    </div>
  );
}

export const PANEL_COUNT = PANELS.length;
export const BUBBLE_COUNT = BUBBLES.length;

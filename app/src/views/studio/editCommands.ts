// The command bar's grammar. Plain text is a fix ("show the girl's legs"); a leading "/" names a command.

export type Side = "up" | "down" | "left" | "right";

export type Command =
  | { kind: "fix"; prompt: string }
  | { kind: "redraw"; prompt: string }
  | { kind: "extend"; side: Side; amount: number; prompt: string }
  | { kind: "tool"; tool: "select" | "lasso" | "brush" | "move" | "crop" }
  | { kind: "erase"; ai: boolean }
  | { kind: "flip"; axis: "h" | "v" }
  | { kind: "rotate"; deg: number }
  | { kind: "adjust"; brightness?: number; contrast?: number; saturation?: number }
  | { kind: "simple"; name: "undo" | "redo" | "apply" | "cancel" | "deselect" | "invert" | "all" | "bubbles" | "lift" }
  | { kind: "error"; message: string };

export const COMMANDS: { name: string; args?: string; desc: string }[] = [
  { name: "fix", args: "<what to change>", desc: "Repaint the selection, or rework the whole picture" },
  { name: "extend", args: "<up|down|left|right> <20%> [what to show]", desc: "Grow the canvas and paint the new part" },
  { name: "redraw", args: "[direction]", desc: "Strong rework of the whole picture" },
  { name: "segment", desc: "Click a thing to select it (W)" },
  { name: "lasso", desc: "Draw around an area to select it (L)" },
  { name: "brush", desc: "Paint the selection by hand (B)" },
  { name: "move", desc: "Lift the selection and rearrange it (M)" },
  { name: "erase", args: "[ai]", desc: "Remove the selection and fill the gap" },
  { name: "crop", desc: "Drag a frame to keep (C)" },
  { name: "rotate", args: "[90|180|270|left]", desc: "Turn the picture" },
  { name: "flip", args: "[h|v]", desc: "Mirror the selection, or the picture" },
  { name: "adjust", args: "[brightness 1.1] [contrast 1] [saturation 0.9]", desc: "Tone of the selection or picture" },
  { name: "invert", desc: "Swap selected and unselected" },
  { name: "all", desc: "Select everything" },
  { name: "deselect", desc: "Clear the selection" },
  { name: "bubbles", desc: "Show or hide the lettering while editing" },
  { name: "undo", desc: "Step back (⌘Z)" },
  { name: "redo", desc: "Step forward (⇧⌘Z)" },
  { name: "apply", desc: "Save the edits as a new version" },
  { name: "cancel", desc: "Leave without saving (Esc)" },
];

const SIDES: Record<string, Side> = { up: "up", top: "up", down: "down", bottom: "down", left: "left", right: "right" };

export function parseCommand(input: string): Command | null {
  const raw = input.trim();
  if (!raw) return null;
  if (!raw.startsWith("/")) return { kind: "fix", prompt: raw };
  const [head = "", ...rest] = raw.slice(1).trim().split(/\s+/);
  const cmd = head.toLowerCase();
  const arg = rest.join(" ").trim();
  switch (cmd) {
    case "fix":
      return arg ? { kind: "fix", prompt: arg } : { kind: "error", message: "Say what to fix, for example: /fix show her legs" };
    case "redraw":
      return { kind: "redraw", prompt: arg };
    case "extend":
    case "outpaint": {
      let side: Side | undefined;
      let amount = 0.2;
      const words: string[] = [];
      for (const w of rest) {
        const lw = w.toLowerCase();
        if (!side && SIDES[lw]) side = SIDES[lw];
        else if (/^\d+(\.\d+)?%$/.test(lw)) amount = parseFloat(lw) / 100;
        else if (/^0?\.\d+$/.test(lw)) amount = parseFloat(lw);
        else words.push(w);
      }
      if (!side) return { kind: "error", message: "Which side? /extend down 20%" };
      if (!(amount >= 0.02 && amount <= 1)) return { kind: "error", message: "Extend by 2% to 100%" };
      return { kind: "extend", side, amount, prompt: words.join(" ") };
    }
    case "segment":
    case "select":
    case "wand":
      return { kind: "tool", tool: "select" };
    case "lasso":
    case "brush":
    case "crop":
      return { kind: "tool", tool: cmd };
    case "move":
    case "rearrange":
      return { kind: "tool", tool: "move" };
    case "lift":
      return { kind: "simple", name: "lift" };
    case "erase":
    case "remove":
    case "delete":
      return { kind: "erase", ai: /^(ai|model|smart)$/i.test(arg) };
    case "flip":
    case "mirror":
      return { kind: "flip", axis: /^(v|vertical|y)/i.test(arg) ? "v" : "h" };
    case "rotate": {
      const a = arg.toLowerCase();
      const deg = a === "left" || a === "ccw" ? 270 : a === "right" || a === "cw" || !a ? 90 : parseInt(a, 10);
      if (!Number.isFinite(deg) || deg % 90) return { kind: "error", message: "Rotate by 90, 180 or 270" };
      return { kind: "rotate", deg: ((deg % 360) + 360) % 360 };
    }
    case "adjust": {
      const out: { kind: "adjust"; brightness?: number; contrast?: number; saturation?: number } = { kind: "adjust" };
      for (let i = 0; i < rest.length - 1; i += 2) {
        const k = rest[i].toLowerCase();
        const v = parseFloat(rest[i + 1]);
        if (!Number.isFinite(v)) continue;
        if (k.startsWith("bright")) out.brightness = v;
        else if (k.startsWith("contr")) out.contrast = v;
        else if (k.startsWith("sat")) out.saturation = v;
      }
      return out;
    }
    case "undo":
    case "redo":
    case "apply":
    case "cancel":
    case "deselect":
    case "invert":
    case "all":
    case "bubbles":
      return { kind: "simple", name: cmd };
    case "save":
      return { kind: "simple", name: "apply" };
    case "exit":
      return { kind: "simple", name: "cancel" };
    case "clear":
      return { kind: "simple", name: "deselect" };
    case "letters":
    case "lettering":
      return { kind: "simple", name: "bubbles" };
    default:
      return { kind: "error", message: `No command /${head}. Type / to see them all.` };
  }
}

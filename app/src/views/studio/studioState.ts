import { create } from "zustand";
import type { LayerToggles } from "../../ui/PanelView";

// Studio-local UI state (tools, layer toggles, selection inside a panel). Panel selection itself
// lives in the app store (useApp.panel) so other views can deep-link into it.

export type Tool = "select" | "bubble" | "sfx" | "pan";
export type Sel = { kind: "bubble" | "sfx"; i: number } | null;

interface StudioState {
  tool: Tool;
  layers: LayerToggles;
  layoutMode: boolean;
  /** Edit image mode: the selected panel's picture fills the canvas with pixel tools and the fix bar. */
  editImage: boolean;
  /** Refine sketch: the selected panel's drawing beside its refined versions. */
  refine: boolean;
  /** Draw mode: pens, pencil and layers on the selected panel. */
  draw: boolean;
  inspector: boolean;
  sel: Sel;
  editing: number | null; // bubble index with the inline text editor open
  spaceHeld: boolean;
  /** A Bubble/SFX click that landed on an unselected panel: the editor places it once mounted. */
  pendingAdd: { pid: string; x: number; y: number } | null;
  /** Layout mode: the page slot being edited (index into the page's panels). */
  slotSel: number | null;
  /** Layout mode: waiting for a click on the character of this slot to cut it out. */
  pickSubject: number | null;
  setTool: (t: Tool) => void;
  toggleLayer: (k: keyof LayerToggles) => void;
  setLayoutMode: (v: boolean) => void;
  setEditImage: (v: boolean) => void;
  setRefine: (v: boolean) => void;
  setDraw: (v: boolean) => void;
  setInspector: (v: boolean) => void;
  setSel: (s: Sel) => void;
  setEditing: (i: number | null) => void;
  setSpace: (v: boolean) => void;
  setPendingAdd: (p: StudioState["pendingAdd"]) => void;
  setSlotSel: (i: number | null) => void;
  setPickSubject: (i: number | null) => void;
}

export const useStudio = create<StudioState>((set, get) => ({
  tool: "select",
  layers: { background: true, art: true, fx: true, lettering: true },
  layoutMode: false,
  editImage: false,
  refine: false,
  draw: false,
  inspector: true,
  sel: null,
  editing: null,
  spaceHeld: false,
  pendingAdd: null,
  slotSel: null,
  pickSubject: null,
  setTool: (tool) => set({ tool, ...(tool !== "select" ? { editing: null } : {}) }),
  toggleLayer: (k) => set({ layers: { ...get().layers, [k]: !get().layers[k] } }),
  setLayoutMode: (layoutMode) => set({ layoutMode, sel: null, editing: null, slotSel: null, pickSubject: null, ...(layoutMode ? { editImage: false, draw: false, refine: false } : {}) }),
  setEditImage: (editImage) => set({ editImage, sel: null, editing: null, ...(editImage ? { layoutMode: false, draw: false, refine: false } : {}) }),
  setRefine: (refine) => set({ refine, sel: null, editing: null, ...(refine ? { editImage: false, layoutMode: false, draw: false } : {}) }),
  setDraw: (draw) => set({ draw, sel: null, editing: null, ...(draw ? { editImage: false, layoutMode: false, refine: false } : {}) }),
  setInspector: (inspector) => set({ inspector }),
  setSel: (sel) => set({ sel, ...(sel?.kind !== "bubble" || sel.i !== get().editing ? { editing: null } : {}) }),
  setEditing: (editing) => set({ editing }),
  setSpace: (spaceHeld) => set({ spaceHeld }),
  setPendingAdd: (pendingAdd) => set({ pendingAdd }),
  setSlotSel: (slotSel) => set({ slotSel, pickSubject: null }),
  setPickSubject: (pickSubject) => set({ pickSubject }),
}));

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
  inspector: boolean;
  sel: Sel;
  editing: number | null; // bubble index with the inline text editor open
  spaceHeld: boolean;
  /** A Bubble/SFX click that landed on an unselected panel: the editor places it once mounted. */
  pendingAdd: { pid: string; x: number; y: number } | null;
  setTool: (t: Tool) => void;
  toggleLayer: (k: keyof LayerToggles) => void;
  setLayoutMode: (v: boolean) => void;
  setEditImage: (v: boolean) => void;
  setInspector: (v: boolean) => void;
  setSel: (s: Sel) => void;
  setEditing: (i: number | null) => void;
  setSpace: (v: boolean) => void;
  setPendingAdd: (p: StudioState["pendingAdd"]) => void;
}

export const useStudio = create<StudioState>((set, get) => ({
  tool: "select",
  layers: { background: true, art: true, fx: true, lettering: true },
  layoutMode: false,
  editImage: false,
  inspector: true,
  sel: null,
  editing: null,
  spaceHeld: false,
  pendingAdd: null,
  setTool: (tool) => set({ tool, ...(tool !== "select" ? { editing: null } : {}) }),
  toggleLayer: (k) => set({ layers: { ...get().layers, [k]: !get().layers[k] } }),
  setLayoutMode: (layoutMode) => set({ layoutMode, sel: null, editing: null, ...(layoutMode ? { editImage: false } : {}) }),
  setEditImage: (editImage) => set({ editImage, sel: null, editing: null, ...(editImage ? { layoutMode: false } : {}) }),
  setInspector: (inspector) => set({ inspector }),
  setSel: (sel) => set({ sel, ...(sel?.kind !== "bubble" || sel.i !== get().editing ? { editing: null } : {}) }),
  setEditing: (editing) => set({ editing }),
  setSpace: (spaceHeld) => set({ spaceHeld }),
  setPendingAdd: (pendingAdd) => set({ pendingAdd }),
}));

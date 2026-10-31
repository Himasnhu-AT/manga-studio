// Selection mask helpers for the image editor. The selection is a canvas at the image's native size:
// white, opaque where selected, transparent elsewhere. That is exactly what the backend's mask decoder
// reads (alpha = mask), so `toDataURL()` goes straight into an edit op.

export type Combine = "replace" | "add" | "subtract";

export function newCanvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((ok, fail) => {
    const im = new Image();
    im.decoding = "async";
    im.onload = () => ok(im);
    im.onerror = () => fail(new Error("couldn't load image"));
    im.src = src;
  });
}

const g = (c: HTMLCanvasElement) => c.getContext("2d", { willReadFrequently: true })!;

/** Combine a source mask canvas (alpha) into the selection. */
export function combine(sel: HTMLCanvasElement, src: CanvasImageSource, mode: Combine) {
  const ctx = g(sel);
  if (mode === "replace") ctx.clearRect(0, 0, sel.width, sel.height);
  ctx.globalCompositeOperation = mode === "subtract" ? "destination-out" : "source-over";
  ctx.drawImage(src, 0, 0, sel.width, sel.height);
  ctx.globalCompositeOperation = "source-over";
}

/** A white-on-black mask PNG (what /segment returns) -> white-on-transparent canvas. */
export async function lumToAlpha(url: string, w: number, h: number) {
  const im = await loadImage(url);
  const c = newCanvas(w, h);
  const ctx = g(c);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(im, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < d.data.length; i += 4) {
    const on = d.data[i] > 127;
    d.data[i] = d.data[i + 1] = d.data[i + 2] = 255;
    d.data[i + 3] = on ? 255 : 0;
  }
  ctx.putImageData(d, 0, 0);
  return c;
}

export function polygonMask(w: number, h: number, pts: [number, number][]) {
  const c = newCanvas(w, h);
  const ctx = g(c);
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h)));
  ctx.closePath();
  ctx.fill();
  return c;
}

export function brushDab(sel: HTMLCanvasElement, from: [number, number], to: [number, number], radius: number, erase: boolean) {
  const ctx = g(sel);
  ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
  ctx.strokeStyle = "#fff";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = radius * 2;
  ctx.beginPath();
  ctx.moveTo(from[0], from[1]);
  ctx.lineTo(to[0], to[1]);
  ctx.stroke();
  ctx.globalCompositeOperation = "source-over";
}

export function invert(sel: HTMLCanvasElement) {
  const ctx = g(sel);
  const d = ctx.getImageData(0, 0, sel.width, sel.height);
  for (let i = 0; i < d.data.length; i += 4) {
    d.data[i] = d.data[i + 1] = d.data[i + 2] = 255;
    d.data[i + 3] = 255 - d.data[i + 3];
  }
  ctx.putImageData(d, 0, 0);
}

export function fillAll(sel: HTMLCanvasElement) {
  const ctx = g(sel);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, sel.width, sel.height);
}

export function clear(sel: HTMLCanvasElement) {
  g(sel).clearRect(0, 0, sel.width, sel.height);
}

/** Bounding box of the selected pixels (alpha > 127), or null when empty. */
export function bbox(sel: HTMLCanvasElement): { x: number; y: number; w: number; h: number } | null {
  const { width: w, height: h } = sel;
  const a = g(sel).getImageData(0, 0, w, h).data;
  let x0 = w,
    y0 = h,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (a[row + x * 4 + 3] > 127) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export function hit(sel: HTMLCanvasElement, x: number, y: number) {
  if (x < 0 || y < 0 || x >= sel.width || y >= sel.height) return false;
  return g(sel).getImageData(Math.floor(x), Math.floor(y), 1, 1).data[3] > 127;
}

/** The selected pixels of `img`, cropped to the selection's box (a floating piece). */
export function cutout(img: CanvasImageSource, sel: HTMLCanvasElement, b: { x: number; y: number; w: number; h: number }) {
  const c = newCanvas(b.w, b.h);
  const ctx = g(c);
  ctx.drawImage(img, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(sel, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
  return c;
}

/** Draw the selection as a tint plus a crisp edge into a display-sized canvas. */
export function paintTint(out: HTMLCanvasElement, sel: HTMLCanvasElement, tint: string, edge: string) {
  const { width: w, height: h } = out;
  const ctx = out.getContext("2d")!;
  ctx.clearRect(0, 0, w, h);
  const m = newCanvas(w, h);
  m.getContext("2d")!.drawImage(sel, 0, 0, w, h);
  // erode by ~1.5 display px: intersect four shifted copies
  const er = newCanvas(w, h);
  const ec = er.getContext("2d")!;
  ec.drawImage(m, 0, 0);
  ec.globalCompositeOperation = "destination-in";
  const k = Math.max(1, Math.round(w / 600));
  for (const [dx, dy] of [
    [k, 0],
    [-k, 0],
    [0, k],
    [0, -k],
  ])
    ec.drawImage(m, dx, dy);
  // tint
  ctx.drawImage(m, 0, 0);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, w, h);
  // edge = mask minus eroded mask
  const e = newCanvas(w, h);
  const xc = e.getContext("2d")!;
  xc.drawImage(m, 0, 0);
  xc.globalCompositeOperation = "destination-out";
  xc.drawImage(er, 0, 0);
  xc.globalCompositeOperation = "source-in";
  xc.fillStyle = edge;
  xc.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(e, 0, 0);
}

// Images in and out of canvases: what documents keep as media, and what models are shown.

import { api } from "./api";
import { newId } from "./text";

export type Canvas = HTMLCanvasElement;

export function createCanvas(width: number, height: number): Canvas {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

/** Frees a canvas's pixels now rather than whenever it's collected; pages of a PDF are large. */
export function releaseCanvas(canvas: Canvas) {
  canvas.width = 0;
  canvas.height = 0;
}

export function canvasToBlob(canvas: Canvas, type = "image/png", quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Couldn't encode the image."))), type, quality),
  );
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Couldn't read the image."));
    reader.readAsDataURL(blob);
  });
}

/** A rectangle in pixels of some canvas or image. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Copies `rect` (clamped to the canvas) into a new canvas. */
export function cropCanvas(source: Canvas, rect: Rect): Canvas {
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const width = Math.min(source.width - x, Math.ceil(rect.width));
  const height = Math.min(source.height - y, Math.ceil(rect.height));
  const out = createCanvas(width, height);
  out.getContext("2d")!.drawImage(source, x, y, width, height, 0, 0, width, height);
  return out;
}

/** A copy no larger than `maxSide` on its longest side. */
export function downscale(source: Canvas, maxSide: number): Canvas {
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
  const out = createCanvas(source.width * scale, source.height * scale);
  const ctx = out.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, out.width, out.height);
  return out;
}

/**
 * How a page or photo is shown to a model: at most 1800 px on a side as JPEG, on white
 * (transparent scans would otherwise turn black). Labelled boxes can be drawn over it.
 */
export async function modelImage(source: Canvas, boxes: { rect: Rect; label: string }[] = []): Promise<string> {
  return blobToDataUrl(await modelImageBlob(source, boxes));
}

/** {@link modelImage} as a JPEG file. */
export async function modelImageBlob(source: Canvas, boxes: { rect: Rect; label: string }[] = []): Promise<Blob> {
  const scaled = createCanvas(0, 0);
  const scale = Math.min(1, 1800 / Math.max(source.width, source.height));
  scaled.width = Math.max(1, Math.round(source.width * scale));
  scaled.height = Math.max(1, Math.round(source.height * scale));
  const ctx = scaled.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, scaled.width, scaled.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, scaled.width, scaled.height);
  const font = Math.max(12, Math.round(scaled.width / 70));
  for (const { rect, label } of boxes) {
    const r = { x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale };
    ctx.strokeStyle = "#d62f6a";
    ctx.lineWidth = Math.max(2, font / 6);
    ctx.setLineDash([font / 2, font / 3]);
    ctx.strokeRect(r.x, r.y, r.width, r.height);
    ctx.setLineDash([]);
    ctx.font = `bold ${font}px sans-serif`;
    const pad = font / 4;
    const w = ctx.measureText(label).width + pad * 2;
    ctx.fillStyle = "#d62f6a";
    ctx.fillRect(r.x, Math.max(0, r.y - font - pad * 2), w, font + pad * 2);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, r.x + pad, Math.max(font, r.y - pad * 1.5));
  }
  try {
    return await canvasToBlob(scaled, "image/jpeg", 0.86);
  } finally {
    releaseCanvas(scaled);
  }
}

/** Decodes an image file (PNG, JPEG, WebP, GIF, SVG, …) onto a canvas, capped at `maxSide`. */
export async function imageFileToCanvas(blob: Blob, maxSide = 4000): Promise<Canvas> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    const width = image.naturalWidth || 1600;
    const height = image.naturalHeight || 1200;
    const scale = Math.min(1, maxSide / Math.max(width, height));
    const canvas = createCanvas(width * scale, height * scale);
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } catch {
    throw new Error("Theoremis couldn't open this image. Try PNG, JPEG or WebP.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/x-tex": "tex",
};

/** A fresh media file name for a document, e.g. `fig-3f2a….png`. */
export function mediaName(prefix: string, type: string): string {
  const ext = EXTENSIONS[type.split(";")[0].trim()] ?? "bin";
  return `${prefix}-${newId()}.${ext}`;
}

/** Keeps `blob` with the document and returns its file name. */
export async function saveMedia(documentId: string, blob: Blob, prefix = "media"): Promise<string> {
  const name = mediaName(prefix, blob.type || "application/octet-stream");
  await api.saveAsset(documentId, name, new Uint8Array(await blob.arrayBuffer()));
  return name;
}

/** Keeps a crop of `canvas` as a PNG with the document and returns its file name. */
export async function saveCrop(documentId: string, canvas: Canvas, rect: Rect, prefix = "fig"): Promise<string> {
  const crop = cropCanvas(canvas, rect);
  try {
    return await saveMedia(documentId, await canvasToBlob(crop, "image/png"), prefix);
  } finally {
    releaseCanvas(crop);
  }
}

const SHOWN_AS_IS = /^image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml)$/;

/** Keeps an image with the document in a format the app shows, converting HEIC, TIFF and the like to PNG. */
export async function saveImage(documentId: string, image: Blob, prefix = "img"): Promise<string> {
  if (SHOWN_AS_IS.test(image.type)) return saveMedia(documentId, image, prefix);
  const canvas = await imageFileToCanvas(image);
  try {
    return await saveMedia(documentId, await canvasToBlob(canvas, "image/png"), prefix);
  } finally {
    releaseCanvas(canvas);
  }
}

/** Whether a file is an image (by type, or by name when the type is missing). */
export const isImageFile = (file: File) => file.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic|heif|tiff?)$/i.test(file.name);

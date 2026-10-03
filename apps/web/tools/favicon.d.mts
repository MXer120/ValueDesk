/** Types for tools/favicon.mjs (imported by src/favicon.test.ts). */
export interface FaviconShapes {
  width: number;
  height: number;
  rects: Array<{ x: number; y: number; w: number; h: number; r: number; rgb: number[] }>;
}
export const ICO_SIZES: number[];
export const SVG_PATH: string;
export const ICO_PATH: string;
export function shapesOf(svg: string): FaviconShapes;
export function rasterise(shapes: FaviconShapes, size: number): Uint8Array;
export function icoFromSvg(svg: string): Buffer;

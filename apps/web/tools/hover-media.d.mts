/** Types for tools/hover-media.mjs (imported by vite.config.ts). */
import type { PluginCreator } from 'postcss';
export function hoverOnly(selector: string): boolean;
export const hoverMedia: PluginCreator<{ stats?: { wrapped: number; kept: number } }>;

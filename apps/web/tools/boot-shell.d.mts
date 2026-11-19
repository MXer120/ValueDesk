/** Types for tools/boot-shell.mjs (imported by vite.config.ts and its test). */
import type { Plugin } from 'vite';
export const TOUCH_QUERY: string;
export const HELPER_LINE: string;
export const HELPER_FIX: string;
export function palettePreload(files: string[], base?: string): string;
export function moveStylesheet(html: string): string;
export function slimHtml(html: string): string;
export function patchPreloadHelper(code: string): string;
export function bootShell(o: { webRoot: string }): Plugin;

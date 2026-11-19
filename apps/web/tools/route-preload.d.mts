/** Types for tools/route-preload.mjs (imported by vite.config.ts and its test). */
import type { Plugin } from 'vite';
export const ROUTE_PAGES: Record<string, RegExp>;
export const PERSONAL_SRC: string;
export const READS_MAX: number;
export const READS_BUDGET: number;
export function partOf(code: string): string | null;
export interface TextFile { f: string; ids: string[] }
export function preloadScript(
  map: Record<string, string[]>,
  base?: string,
  parts?: Record<string, string>,
  first?: Record<string, TextFile>,
  opts?: { shell?: TextFile | null; reads?: Record<string, string[]>; ahead?: Record<string, string[]>; hints?: Record<string, Array<[rel: string, href: string, crossorigin: 0 | 1]>>; langs?: readonly string[] },
): string;
export function loadFirstReads(file: string, alias?: Record<string, string>): Promise<{ reads: Record<string, string[]>; ahead: Record<string, string[]> }>;
export function routePreload(o?: { i18n?: Plugin; firstReads?: Record<string, string[]>; aheadReads?: Record<string, string[]>; firstReadsModule?: string | null; liveSocket?: string | null }): Plugin;
export function browserPick(langs: readonly string[]): string;

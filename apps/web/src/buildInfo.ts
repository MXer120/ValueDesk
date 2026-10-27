/**
 * Which build this is, for client error reports and the feedback form's page
 * info: the commit Vercel built, or the minute of a local build (vite.config.ts
 * buildId). "dev" under the dev server's first start and in tests, where the
 * define is not applied.
 */
export const BUILD_ID: string = typeof __VS_BUILD__ === 'string' && __VS_BUILD__ ? __VS_BUILD__ : 'dev';

/**
 * The admin suite's page (admin.html, src/admin/), built after the site and into the same dist:
 * `npm run build` runs it after `vite build`. A build of its own because one build of both pages
 * shares their CSS in a chunk that loads before the site's own and breaks the site's cascade
 * order (vite.config.ts, owner 2026-11-01).
 */
import { build } from 'vite';

process.env.VS_WEB_PAGE = 'admin';
await build({ logLevel: 'warn' });

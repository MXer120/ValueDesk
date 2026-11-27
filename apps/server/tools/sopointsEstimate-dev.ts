/**
 * Dev only: the SoPoints estimate (src/routes/sopointsEstimate.ts) in-process for the web dev server, so localhost on
 * production's data has estimates before the route and its private model file are released. The model is read from
 * VS_SOPOINTS_MODEL, else ~/ValueDesk-private/sopoints/model.json (never in the repository). apps/web/vite.config.ts
 * devSopointsEstimate loads this with ssrLoadModule and hands it the POST. Never in a build.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { sopointsEstimateRoutes } from '../src/routes/sopointsEstimate.js';
import { loadParams } from '../src/valuedesk/sodex/sopointsModel.js';

export const devModelPath = (): string => process.env.VS_SOPOINTS_MODEL?.trim() || join(homedir(), 'ValueDesk-private', 'sopoints', 'model.json');
export const hasModel = (): boolean => existsSync(devModelPath());

const app = Fastify();
const ready = app.register(sopointsEstimateRoutes({ params: () => loadParams(devModelPath()) })).then(() => app.ready());

export async function handle(url: string, body: string, ip: string): Promise<{ status: number; body: string }> {
  await ready;
  const r = await app.inject({ method: 'POST', url, payload: body || '{}', headers: { 'content-type': 'application/json' }, remoteAddress: ip });
  return { status: r.statusCode, body: r.body };
}

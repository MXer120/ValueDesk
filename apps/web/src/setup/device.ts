/**
 * A capability check, not a guess at the device's age.
 * Potato when it looks very weak: <= 4 cores AND <= 4 GB, or frames under ~30fps.
 * Missing deviceMemory is not treated as weak — only Chrome reports it.
 */
export interface DeviceProbe {
  cores: number;
  /** navigator.deviceMemory, in GB. null when the browser does not report it. */
  memoryGb: number | null;
  /** Sampled from a few animation frames. null when the tab never painted. */
  fps: number | null;
}

export function suggestPotato(p: DeviceProbe): boolean {
  const weakBox = p.cores <= 4 && p.memoryGb !== null && p.memoryGb <= 4;
  const slow = p.fps !== null && p.fps < 30;
  return weakBox || slow;
}

function sampleFps(): Promise<number | null> {
  return new Promise((resolve) => {
    let frames = 0;
    let start = 0;
    let last = 0;
    const timer = setTimeout(() => {
      if (frames < 2 || last <= start) resolve(null);
      else resolve(((frames - 1) * 1000) / (last - start));
    }, 800);
    const tick = (t: number) => {
      if (frames === 0) start = t;
      last = t;
      frames += 1;
      if (frames >= 8) {
        clearTimeout(timer);
        resolve(last > start ? ((frames - 1) * 1000) / (last - start) : null);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

export async function probeDevice(): Promise<DeviceProbe> {
  const rawCores = Number(navigator.hardwareConcurrency);
  // Unknown is not "weak". A missing count must not trip the 4-core test.
  const cores = Number.isFinite(rawCores) && rawCores > 0 ? rawCores : 8;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const memoryGb = typeof mem === 'number' && Number.isFinite(mem) && mem > 0 ? mem : null;
  const fps = await sampleFps();
  return { cores, memoryGb, fps };
}

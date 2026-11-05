/**
 * A feature clip, 14 s, silent (X autoplays muted): the liquidation heatmap, all of it real footage.
 *
 *   0-3.2 s   macro: the map under a low camera, shallow focus, the title
 *   3.2-8 s   the real pointer reads the map and zooms, on a tilted plane
 *   8-11 s    the live view rises in front of the history
 *   11-14 s   the mark and the address
 */
import React, { useEffect, useState } from 'react';
import { AbsoluteFill, Img, continueRender, delayRender, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { BrandMark, Floor, Footage, MUTED, Plane, TEXT, Title, Vignette, smooth } from './kit';

export const HEATMAP_CLIP_FRAMES = 14 * 30;

type Index = Array<{ f: string; t: number }>;

function useIndex(shot: string): Index | null {
  const [index, setIndex] = useState<Index | null>(null);
  const [handle] = useState(() => delayRender(`footage ${shot}`));
  useEffect(() => {
    fetch(staticFile(`footage/${shot}/index.json`)).then((r) => r.json()).then((j) => { setIndex(j); continueRender(handle); });
  }, [handle, shot]);
  return index;
}

export const HeatmapClip: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const index = useIndex('heatmap');
  if (!index) return null;
  const t = frame / fps;
  const shotLen = (index.at(-1)?.t ?? 0) / 1000;

  /* Scene 1: macro over the still, the camera sliding along the levels. */
  const s1 = t < 3.4;
  const s1x = smooth(frame, 0, 102, 320, -260);
  const s1z = smooth(frame, 0, 102, 780, 900);
  /* Scene 2: back to the plane; the pointer footage plays in real time. */
  const s2Rot = smooth(frame, 96, 240, 24, 9);
  const s2z = smooth(frame, 96, 240, 40, 210);
  const s2y = smooth(frame, 96, 240, 40, 0);
  const s2ms = Math.min(shotLen * 1000, Math.max(0, (t - 3.3) * 1000));
  /* Scene 3: the live view rises in front. */
  const s3 = smooth(frame, 236, 268, 0, 1);
  const s3Out = smooth(frame, 322, 340, 1, 0);
  /* The end card. */
  const end = smooth(frame, 334, 356, 0, 1);

  return (
    <AbsoluteFill>
      <Floor />
      {s1 && (
        <Plane width={1500} height={900} rotateX={58} rotateY={0} rotateZ={-16} x={s1x} y={40} z={s1z} focus={{ at: 56, half: 12 }} blur={9} opacity={smooth(frame, 0, 18, 0, 1)}>
          {() => <Img src={staticFile('stills/heatmap-history.png')} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
        </Plane>
      )}
      {!s1 && frame < 345 && (
        <Plane width={1600} height={900} rotateX={s2Rot} rotateY={smooth(frame, 96, 240, -14, -5)} rotateZ={smooth(frame, 96, 240, 3, 1)} x={smooth(frame, 96, 240, 90, 0)} y={s2y} z={s2z} opacity={smooth(frame, 96, 112, 0, 1) * (1 - end)}>
          {() => <Footage shot="heatmap" index={index} ms={s2ms} style={{ transform: 'scale(1.72)', transformOrigin: '4% 18%' }} />}
        </Plane>
      )}
      {s3 > 0 && s3Out > 0 && (
        <Plane width={860} height={500} rotateX={6} rotateY={smooth(frame, 236, 330, -20, -13)} rotateZ={2} x={smooth(frame, 236, 268, 720, 430)} y={smooth(frame, 236, 268, 200, 60)} z={320} opacity={s3 * s3Out}>
          {() => <Img src={staticFile('stills/heatmap-live.png')} style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'left top' }} />}
        </Plane>
      )}
      <Vignette strength={s1 ? 0.95 : 0.55} />
      <Title text="See where liquidations sit" from={8} to={94} />
      <Title text="Back in time" line="The levels over time, on the chart." from={118} to={228} size={68} align="left" style={{ justifyContent: 'flex-end', paddingBottom: 70 }} />
      <Title text="Live" line="Down to the wallets behind a level." from={244} to={330} size={68} align="left" style={{ justifyContent: 'flex-end', paddingBottom: 70 }} />
      {end > 0 && (
        <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', opacity: end, transform: `scale(${0.985 + end * 0.015})` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 26 }}>
            <BrandMark size={92} />
            <span style={{ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: 84, letterSpacing: '-0.02em', color: TEXT }}>ValueDesk</span>
          </div>
          <div style={{ marginTop: 26, fontFamily: 'IBM Plex Sans', fontSize: 30, color: MUTED }}>valuedesk.so</div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};

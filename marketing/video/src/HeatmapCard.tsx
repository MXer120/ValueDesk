/**
 * A 16:9 card for a post on X, the same parts as the clips: a title, one line, and real captures on a
 * tilted stage (the structure of the first-signup flow's feature screens).
 */
import React from 'react';
import { AbsoluteFill, Img, staticFile } from 'remotion';
import { BrandMark, Floor, MUTED, TEXT, Vignette } from './kit';

export const HeatmapCard: React.FC = () => (
  <AbsoluteFill>
    <Floor />
    <AbsoluteFill style={{ perspective: 1800, perspectiveOrigin: '50% 30%' }}>
      <Img
        src={staticFile('stills/heatmap-history.png')}
        style={{
          position: 'absolute', left: 170, top: 330, width: 1100, borderRadius: 14,
          transform: 'rotateX(7deg) rotateY(-5deg)',
          boxShadow: '0 0 0 1px rgba(255,255,255,0.1), 0 50px 120px rgba(0,0,0,0.75)',
        }}
      />
      <Img
        src={staticFile('stills/heatmap-live.png')}
        style={{
          position: 'absolute', left: 980, top: 420, width: 540, borderRadius: 12,
          transform: 'rotateY(-16deg) rotateX(3deg) rotateZ(2deg) translateZ(80px)',
          boxShadow: '0 0 0 1px rgba(255,255,255,0.14), 0 40px 90px rgba(0,0,0,0.85)',
        }}
      />
    </AbsoluteFill>
    <Vignette strength={0.5} />
    <AbsoluteFill style={{ alignItems: 'center', paddingTop: 92, textAlign: 'center' }}>
      <div style={{ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: 78, lineHeight: 1.08, letterSpacing: '-0.02em', color: TEXT }}>See where liquidations sit</div>
      <div style={{ marginTop: 20, fontFamily: 'IBM Plex Sans', fontSize: 28, lineHeight: 1.4, color: MUTED }}>Every level on the chart, live and back in time, down to the wallets.</div>
    </AbsoluteFill>
    <div style={{ position: 'absolute', left: 44, top: 36, display: 'flex', alignItems: 'center', gap: 12 }}>
      <BrandMark size={36} />
      <span style={{ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: 28, color: TEXT }}>ValueDesk</span>
    </div>
  </AbsoluteFill>
);

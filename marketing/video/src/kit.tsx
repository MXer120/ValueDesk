/**
 * The look: the dark terminal shot like an object. A tilted plane under a slow camera, shallow focus
 * (a sharp band over a blurred copy), one glow that follows what matters, the app's monotone palette
 * and its own type. Footage is the app's; these parts only frame it.
 */
import React, { useMemo } from 'react';
import { AbsoluteFill, Img, continueRender, delayRender, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';

export const BG = '#0b0b0b';
export const TEXT = '#f7f7f7';
export const MUTED = '#a8a8a8';
export const POS = '#00b481';

/* The app's own faces, self-hosted. */
const fontHandle = delayRender('fonts');
const faces = [
  new FontFace('Space Grotesk', `url(${staticFile('fonts/space-grotesk-latin-600-normal.woff2')})`, { weight: '600' }),
  new FontFace('IBM Plex Sans', `url(${staticFile('fonts/ibm-plex-sans-latin-400-normal.woff2')})`, { weight: '400' }),
];
Promise.all(faces.map((f) => f.load().then((l) => document.fonts.add(l)))).finally(() => continueRender(fontHandle));

export const smooth = (frame: number, from: number, to: number, a: number, b: number): number =>
  interpolate(frame, [from, to], [a, b], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: (t) => t * t * (3 - 2 * t) });

/** The ValueDesk mark, as in the app (components/BrandMark.tsx). */
export const BrandMark: React.FC<{ size: number }> = ({ size }) => {
  const COLS = [0, 4, 1, 3, 2];
  const ROWS = [0, 0, 1, 1, 2];
  return (
    <svg width={size} height={size} viewBox="0 0 32 32">
      {COLS.map((c, i) => (
        <rect key={i} x={c * 6.6} y={4.2 + ROWS[i]! * 8.2} width={5.6} height={7.2} rx={1.5} fill={ROWS[i] === 2 ? POS : '#f4f4f4'} />
      ))}
    </svg>
  );
};

/** A plane in space under the camera: `at` moves it, a sharp band over a blurred copy is the focus. */
export const Plane: React.FC<{
  children: (blurred: boolean) => React.ReactNode;
  width: number;
  height: number;
  rotateX: number;
  rotateY: number;
  rotateZ: number;
  x: number;
  y: number;
  z: number;
  /** The sharp band: its centre and half-height, in % of the plane; null: all sharp. */
  focus?: { at: number; half: number } | null;
  blur?: number;
  opacity?: number;
}> = ({ children, width, height, rotateX, rotateY, rotateZ, x, y, z, focus, blur = 7, opacity = 1 }) => {
  const mask = focus
    ? `linear-gradient(180deg, transparent ${focus.at - focus.half * 1.7}%, #000 ${focus.at - focus.half}%, #000 ${focus.at + focus.half}%, transparent ${focus.at + focus.half * 1.7}%)`
    : undefined;
  const plane: React.CSSProperties = { position: 'absolute', inset: 0, borderRadius: 18, overflow: 'hidden' };
  return (
    <AbsoluteFill style={{ perspective: 1500, perspectiveOrigin: '50% 45%' }}>
      <div
        style={{
          position: 'absolute', left: '50%', top: '50%', width, height, marginLeft: -width / 2, marginTop: -height / 2, opacity,
          transform: `translate3d(${x}px, ${y}px, ${z}px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) rotateZ(${rotateZ}deg)`,
          transformStyle: 'preserve-3d',
          boxShadow: '0 0 0 1px rgba(255,255,255,0.09), 0 60px 160px rgba(0,0,0,0.75)',
          borderRadius: 18,
          willChange: 'transform',
        }}
      >
        {focus && <div style={{ ...plane, filter: `blur(${blur}px)` }}>{children(true)}</div>}
        <div style={{ ...plane, ...(mask ? { WebkitMaskImage: mask, maskImage: mask } : {}) }}>{children(false)}</div>
      </div>
    </AbsoluteFill>
  );
};

/** The frame of the app's footage at this moment of the shot (by the time each was painted). */
export const Footage: React.FC<{ shot: string; index: Array<{ f: string; t: number }>; ms: number; style?: React.CSSProperties }> = ({ shot, index, ms, style }) => {
  const frame = useMemo(() => {
    let lo = 0;
    let hi = index.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (index[mid]!.t <= ms) lo = mid;
      else hi = mid - 1;
    }
    return index[lo]!;
  }, [index, ms]);
  return <Img src={staticFile(`footage/${shot}/${frame.f}`)} style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover', ...style }} />;
};

/** A title: rises in, holds, leaves. Display face, as the app's page headlines. */
export const Title: React.FC<{ text: string; line?: string; from: number; to: number; size?: number; align?: 'center' | 'left'; style?: React.CSSProperties }> = ({ text, line, from, to, size = 92, align = 'center', style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const inn = spring({ frame: frame - from, fps, config: { damping: 200, mass: 0.8 } });
  const out = smooth(frame, to - 10, to, 1, 0);
  if (frame < from || frame > to) return null;
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: align === 'center' ? 'center' : 'flex-start', textAlign: align, padding: 120, ...style }}>
      <div style={{ opacity: inn * out, transform: `translateY(${(1 - inn) * 22}px)`, filter: `blur(${(1 - inn) * 8}px)` }}>
        <div style={{ fontFamily: 'Space Grotesk', fontWeight: 600, fontSize: size, lineHeight: 1.08, letterSpacing: '-0.02em', color: TEXT, textShadow: '0 4px 60px rgba(0,0,0,0.9)' }}>{text}</div>
        {line && <div style={{ marginTop: 22, fontFamily: 'IBM Plex Sans', fontSize: size * 0.33, lineHeight: 1.4, color: MUTED, textShadow: '0 2px 24px rgba(0,0,0,0.95)' }}>{line}</div>}
      </div>
    </AbsoluteFill>
  );
};

/** The floor: near-black with a soft light from above, a little grain-free depth. */
export const Floor: React.FC = () => (
  <AbsoluteFill style={{ background: `radial-gradient(70% 55% at 50% 22%, #1c1c1c 0%, ${BG} 70%)` }} />
);

/** Fade the picture's far edges into the floor, so a plane has no hard frame. */
export const Vignette: React.FC<{ strength?: number }> = ({ strength = 0.85 }) => (
  <AbsoluteFill style={{ background: `radial-gradient(75% 70% at 50% 50%, transparent 45%, rgba(11,11,11,${strength}) 100%)`, pointerEvents: 'none' }} />
);

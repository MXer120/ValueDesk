import React from 'react';
import { Composition, Still } from 'remotion';
import { HeatmapClip, HEATMAP_CLIP_FRAMES } from './HeatmapClip';
import { HeatmapCard } from './HeatmapCard';

/** 1080p 30 fps: X plays 1080p for Premium accounts and needs at most 60 fps, H.264 High, AAC LC. */
export const Root: React.FC = () => (
  <>
    <Composition id="heatmap-clip" component={HeatmapClip} durationInFrames={HEATMAP_CLIP_FRAMES} fps={30} width={1920} height={1080} />
    <Still id="heatmap-card" component={HeatmapCard} width={1600} height={900} />
  </>
);

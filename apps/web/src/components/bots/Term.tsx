import type { ReactNode } from 'react';
import { InfoDot } from '../InfoDot';
import { GLOSSARY, type GlossaryTerm } from '../../bots/glossary';

/** A bot word with its glossary line beside it (owner 2026-11-08). */
export function Term({ t, children }: { t: GlossaryTerm; children: ReactNode }) {
  return <span className="bots-term">{children}<InfoDot title={GLOSSARY[t]} /></span>;
}

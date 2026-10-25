/**
 * The words a press conference moves markets with, marked in the Fed live
 * transcript (FedLive.tsx): dovish green, hawkish red, the rest neutral. The
 * first match of a span wins, so longer phrases are listed before their parts.
 */
export type Tone = 'dove' | 'hawk' | 'neutral';

const TERMS: Array<[RegExp, Tone]> = [
  // The decision itself, as the statement words it.
  [/\b(?:raise|raised|increase|increased) the target range\b/gi, 'hawk'],
  [/\b(?:lower|lowered|reduce|reduced|cut) the target range\b/gi, 'dove'],
  [/\b(?:maintain|maintained|keep|kept|leave|left) the target range\b/gi, 'neutral'],
  [/\brate cuts?\b|\bcut(?:ting)? (?:interest )?rates?\b|\blower(?:ing)? (?:interest )?rates\b|\beasing\b|\bless restrictive\b|\bcooling\b|\bsoftening\b|\bdisinflation\b/gi, 'dove'],
  [/\brate hikes?\b|\braise (?:interest )?rates\b|\bhik(?:e|ing)\b|\btightening\b|\bmore restrictive\b|\binflation (?:remains |is )?(?:elevated|too high|sticky|persistent)\b|\bupside risks?\b/gi, 'hawk'],
  [/\bpause\b|\bhold(?:ing)? (?:rates )?steady\b|\bdata[- ]dependent\b|\bmeeting by meeting\b|\bbalance sheet\b|\bquantitative tightening\b|\bQT\b|\btariffs?\b|\blabor market\b|\bunemployment\b|\brecession\b|\bfederal funds rate\b|\btarget range\b|\bdissent(?:ed|s)?\b|\bneutral rate\b|\bbasis points?\b/gi, 'neutral'],
];

export interface Span { text: string; tone: Tone | null }

/** The text cut into plain and marked spans. */
export function markTerms(text: string): Span[] {
  const hits: Array<{ start: number; end: number; tone: Tone }> = [];
  for (const [re, tone] of TERMS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const start = m.index;
      const end = start + m[0].length;
      if (!hits.some((h) => start < h.end && end > h.start)) hits.push({ start, end, tone });
    }
  }
  hits.sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  let at = 0;
  for (const h of hits) {
    if (h.start > at) out.push({ text: text.slice(at, h.start), tone: null });
    out.push({ text: text.slice(h.start, h.end), tone: h.tone });
    at = h.end;
  }
  if (at < text.length) out.push({ text: text.slice(at), tone: null });
  return out;
}

/** The marked words of a line, for the widget's running tally. */
export function termsIn(text: string): Array<{ term: string; tone: Tone }> {
  return markTerms(text).filter((s) => s.tone).map((s) => ({ term: s.text.toLowerCase(), tone: s.tone! }));
}

/** A legal text as data (the web's legal/model.ts LegalDoc, structurally): what a follower reads and signs. */
export type TermsBlock = { p: string } | { ul: string[] } | { lines: string[] };
export interface TermsDoc {
  page: string;
  title: string;
  lang: 'de' | 'en';
  updated: string;
  intro?: TermsBlock[];
  sections: Array<{ title: string; lang?: 'de' | 'en'; blocks: TermsBlock[] }>;
}

/**
 * The languages of the language menu (owner 2026-11-06), each under its own name, with its flag from
 * public/flags. A language can be picked once its catalogue is in public/i18n and its code in READY
 * (i18n.test.ts holds the two together); until then the menu lists it as not ready.
 */
export interface Language {
  code: string;
  /** Its own name, as the menu shows it. */
  name: string;
  /** The name in English, which the menu's search also finds. */
  english: string;
  flag: string;
}

export const LANGUAGES: readonly Language[] = [
  { code: 'en', name: 'English', english: 'English', flag: 'gb' },
  { code: 'de', name: 'Deutsch', english: 'German', flag: 'de' },
  { code: 'fr', name: 'Français', english: 'French', flag: 'fr' },
  { code: 'es', name: 'Español', english: 'Spanish', flag: 'es' },
  { code: 'pt', name: 'Português', english: 'Portuguese', flag: 'pt' },
  { code: 'it', name: 'Italiano', english: 'Italian', flag: 'it' },
  { code: 'nl', name: 'Nederlands', english: 'Dutch', flag: 'nl' },
  { code: 'pl', name: 'Polski', english: 'Polish', flag: 'pl' },
  { code: 'tr', name: 'Türkçe', english: 'Turkish', flag: 'tr' },
  { code: 'ru', name: 'Русский', english: 'Russian', flag: 'ru' },
  { code: 'uk', name: 'Українська', english: 'Ukrainian', flag: 'ua' },
  { code: 'ko', name: '한국어', english: 'Korean', flag: 'kr' },
  { code: 'ja', name: '日本語', english: 'Japanese', flag: 'jp' },
  { code: 'zh-CN', name: '简体中文', english: 'Chinese (Simplified)', flag: 'cn' },
  { code: 'zh-TW', name: '繁體中文', english: 'Chinese (Traditional)', flag: 'tw' },
  { code: 'vi', name: 'Tiếng Việt', english: 'Vietnamese', flag: 'vn' },
  { code: 'id', name: 'Bahasa Indonesia', english: 'Indonesian', flag: 'id' },
  { code: 'th', name: 'ไทย', english: 'Thai', flag: 'th' },
];

/** The languages with a finished catalogue. English needs none. */
export const READY: ReadonlySet<string> = new Set(['en', 'de']);

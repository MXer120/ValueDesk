/**
 * The language menu (owner 2026-11-06): a globe in the top bar, and a row in Settings > Profile. Both are
 * the app's own searchable dropdown (FxSelect): flags left, a search on top, a list that scrolls. A language
 * whose catalogue is not finished is listed, not selectable.
 */
import { useMemo } from 'react';
import { LANGUAGES, READY } from '../i18n/languages';
import { setLanguage, useLanguage } from '../i18n/store';
import { FxSelect, type FxOption } from './funds/ui';

const Flag = ({ flag }: { flag: string }) => <img className="langflag" src={`/flags/${flag}.svg`} alt="" width="20" height="15" loading="lazy" decoding="async" draggable={false} />;

function useOptions(): FxOption[] {
  return useMemo(() => LANGUAGES.map((l) => ({
    value: l.code,
    label: l.name,
    iconNode: <Flag flag={l.flag} />,
    hint: READY.has(l.code) ? (l.name === l.english ? undefined : l.english) : `${l.english} · soon`,
    disabled: !READY.has(l.code),
  })), []);
}

/** The globe in the top bar. */
export function LanguageGlobe() {
  const lang = useLanguage();
  const options = useOptions();
  return (
    <FxSelect
      value={lang}
      options={options}
      onChange={(v) => void setLanguage(v)}
      label="Language"
      searchable
      searchPlaceholder="Search languages"
      triggerClassName="navicon navlang__btn"
      listMinWidth={270}
      listAlign="end"
      trigger={() => (
        <svg className="navlang__globe" viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="10" cy="10" r="8" />
          <path d="M2 10h16M10 2c2.4 2.2 3.6 4.9 3.6 8s-1.2 5.8-3.6 8c-2.4-2.2-3.6-4.9-3.6-8s1.2-5.800 3.6-8Z" />
        </svg>
      )}
    />
  );
}

/** The row in Settings > Profile. */
export function LanguageRow() {
  const lang = useLanguage();
  const options = useOptions();
  return <FxSelect compact value={lang} options={options} onChange={(v) => void setLanguage(v)} label="Language" searchable searchPlaceholder="Search languages" listMinWidth={270} />;
}

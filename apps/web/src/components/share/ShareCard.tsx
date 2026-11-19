/**
 * The share dialog for every card (owner 2026-11-14; the owner's mock marketing/video/capture/shareDialog.mjs): the
 * card as it will look, Wide or Square, what it shows (dollar amounts, prices or the second figure, the wallet's
 * address - off unless turned on), and Post on X, Copy image and Download (on a phone: Save and Share). Drawn in the
 * browser (card.ts): nothing is uploaded.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '../Modal';
import { DlgFoot, DlgRow, DlgSeg, DlgSwitch } from '../dialogParts';
import { track } from '../../analytics/usage';
import { cardPng, xIntent, type CardData, type CardOpts, type Ratio } from './card';
import { prefersNativeShare, shareNative } from '../../share/nativeShare';
import './share.css';

const NOUN: Record<CardData['kind'], string> = { trade: 'trade', position: 'position', portfolio: 'portfolio', copy: 'copy', bot: 'bot', botvol: 'bot' };

const ICON = {
  down: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>,
  copy: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>,
  x: <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.8 3h3.1l-6.8 7.8L22 21h-6.3l-4.9-6.4L5.2 21H2.1l7.3-8.3L1.8 3h6.4l4.4 5.9L17.8 3Zm-1.1 16.2h1.7L7.4 4.7H5.6l11.1 14.5Z" /></svg>,
  share: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" /></svg>,
};

/** A phone with the share sheet (share/nativeShare.ts): Save and Share instead of Copy and X. */
const isPhone = (): boolean => prefersNativeShare();

export function ShareCard({ card, code, onClose }: { card: CardData; code: string | null; onClose: () => void }) {
  const [ratio, setRatio] = useState<Ratio>('wide');
  const [amounts, setAmounts] = useState(true);
  const [second, setSecond] = useState(true);
  const [wallet, setWallet] = useState(false);
  const opts: CardOpts = useMemo(() => ({ ratio, amounts, second, wallet, code }), [ratio, amounts, second, wallet, code]);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const phone = useMemo(isPhone, []);
  useEffect(() => {
    let live = true;
    setBusy(true);
    cardPng(card, opts)
      .then((b) => {
        if (!live) return;
        setBlob(b);
        setUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(b); });
        setBusy(false);
      })
      .catch((e) => { if (live) { setBusy(false); setNote(e instanceof Error ? e.message : String(e)); } });
    return () => { live = false; };
  }, [card, opts]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  const noteTimer = useRef(0);
  const say = (t: string) => { setNote(t); window.clearTimeout(noteTimer.current); noteTimer.current = window.setTimeout(() => setNote(null), 5_000); };
  useEffect(() => () => window.clearTimeout(noteTimer.current), []);

  const name = `valuedesk-${card.kind}-${ratio}.png`;
  const file = blob ? new File([blob], name, { type: 'image/png' }) : null;
  const did = (how: string) => track('share.card', { kind: card.kind, how });

  const copyImage = async (): Promise<boolean> => {
    if (!blob) return false;
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return true;
    } catch {
      return false;
    }
  };
  const copy = async () => {
    const ok = await copyImage();
    say(ok ? 'Image copied.' : 'This browser did not allow copying. Download it instead.');
    if (ok) did('copy');
  };
  const download = (how: 'download' | 'save') => {
    if (!url) return;
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    did(how);
  };
  // X takes no image by link: the image goes on the clipboard first, so it pastes straight into the post.
  const postX = async () => {
    const ok = await copyImage();
    window.open(xIntent(card, { amounts }), '_blank', 'noopener,noreferrer');
    say(ok ? 'Image copied: paste it into your post.' : 'Download the image and add it to your post.');
    did('x');
  };
  /* The sheet, with the picture where the browser hands files on (WhatsApp, Telegram take it as an image). */
  const share = async () => {
    if (!file) return;
    const r = await shareNative({ text: card.post({ amounts }), url: card.link, file });
    if (r === 'shared' || r === 'shared-text') did('share');
    if (r === 'shared-text') say('This browser shared the link only: Save adds the picture.');
    if (r === 'failed' || r === 'unsupported') { download('save'); say('Sharing was not allowed here: the picture was saved instead.'); }
  };

  const foot = (
    <DlgFoot left={<span className="share-made" role="status">{note ?? <><i aria-hidden="true" />Made on this device, nothing is uploaded</>}</span>}>
      {phone ? (
        <>
          <button type="button" className="dlg-btn" disabled={!blob || busy} onClick={() => download('save')}>{ICON.down}Save</button>
          <button type="button" className="dlg-btn is-go" disabled={!blob || busy} onClick={() => void share()}>{ICON.share}Share</button>
        </>
      ) : (
        <>
          <button type="button" className="dlg-btn" disabled={!blob || busy} onClick={() => download('download')}>{ICON.down}Download</button>
          <button type="button" className="dlg-btn" disabled={!blob || busy} onClick={() => void copy()}>{ICON.copy}Copy image</button>
          <button type="button" className="dlg-btn is-go" disabled={!blob || busy} onClick={() => void postX()}>{ICON.x}Post on X</button>
        </>
      )}
    </DlgFoot>
  );

  return (
    <Modal open size="md" title={`Share ${NOUN[card.kind]}`} className="fx share-dlg" onClose={onClose} footer={foot}>
      <div className="dlg">
        <div className={`share-stage${busy ? ' is-busy' : ''}`}>
          {url && <img className={`share-preview${ratio === 'square' ? ' is-square' : ''}`} src={url} alt={`Share card: ${card.title}`} />}
          {!url && <span className={`share-preview share-wait${ratio === 'square' ? ' is-square' : ''}`}>Drawing…</span>}
        </div>
        <div className="dlg-label"><span>Picture</span><DlgSeg label="Picture" value={ratio} onChange={setRatio} options={[{ value: 'wide', label: 'Wide' }, { value: 'square', label: 'Square' }]} /></div>
        <div className="dlg-card">
          <DlgRow title="Dollar amounts" line="Hidden shows returns in % only">
            <DlgSwitch on={amounts} onChange={setAmounts} label="Dollar amounts" onWord="Shown" offWord="Hidden" />
          </DlgRow>
          {card.second && (
            <DlgRow title={card.second.title} line={card.second.line} off={!second}>
              <DlgSwitch on={second} onChange={setSecond} label={card.second.title} onWord="Shown" offWord="Hidden" />
            </DlgRow>
          )}
          {card.wallet && (
            <DlgRow title={card.kind === 'copy' ? 'My wallet address' : 'Wallet address'} line="Hidden unless you show it" off={!wallet}>
              <DlgSwitch on={wallet} onChange={setWallet} label="Wallet address" onWord="Shown" offWord="Hidden" />
            </DlgRow>
          )}
        </div>
      </div>
    </Modal>
  );
}

export default ShareCard;

/**
 * THE PHONE'S OWN SHARE SHEET (phone pass, 2026-11-18): `navigator.share`, so a card or a referral link goes
 * straight to WhatsApp, Telegram or wherever the visitor's phone sends things. Every caller keeps its copy and
 * download buttons for a browser without it.
 *
 * `prefersNativeShare`: a touch phone that has the sheet - there the sheet is the first button. A desktop browser
 * may have `navigator.share` too (Edge, Safari) but keeps its own buttons first: copying is what a desk does.
 */

type Nav = Pick<Navigator, 'share' | 'canShare'> | undefined;

const nav = (): Nav => (typeof navigator !== 'undefined' ? navigator : undefined);

export function canShareNative(n: Nav = nav()): boolean {
  return !!n && typeof n.share === 'function';
}

export function prefersNativeShare(n: Nav = nav(), coarse: boolean = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true): boolean {
  return coarse && canShareNative(n);
}

/**
 * shared       the sheet took it, file included when one was given
 * shared-text  the sheet took the text and the link, but this browser cannot hand it the file
 * closed       the visitor closed the sheet: nothing to say
 * unsupported  no sheet here
 * failed       the browser refused (not allowed, a file it will not take): the caller falls back to its buttons
 */
export type ShareResult = 'shared' | 'shared-text' | 'closed' | 'unsupported' | 'failed';

export async function shareNative(data: { text?: string; url?: string; title?: string; file?: File | null }, n: Nav = nav()): Promise<ShareResult> {
  if (!n || !canShareNative(n)) return 'unsupported';
  const base: ShareData = {};
  if (data.title) base.title = data.title;
  if (data.text) base.text = data.text;
  if (data.url) base.url = data.url;
  const withFile = !!data.file && typeof n.canShare === 'function' && n.canShare({ files: [data.file] });
  try {
    await n.share!(withFile ? { ...base, files: [data.file!] } : base);
    return withFile || !data.file ? 'shared' : 'shared-text';
  } catch (e) {
    return e instanceof DOMException && e.name === 'AbortError' ? 'closed' : 'failed';
  }
}

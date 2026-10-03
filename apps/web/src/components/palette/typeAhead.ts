/**
 * Keys typed between "open the palette" and its search box taking the focus.
 *
 * The box is focused a frame after the palette opens (CommandPalette.tsx, the
 * focus effect). On a busy main thread the keys typed in that frame are
 * dispatched before it: they went to whatever had the focus - the page, where
 * a printable key re-opens the palette with that key as its seed (dropped,
 * since the palette is already open), a digit switches page and `c` asks to
 * cancel every order. So from the moment an open is asked for until the box
 * has the focus, the palette takes those keys here, and hands them to the box
 * when it gets the focus: the whole word arrives, in order, and nothing behind
 * the palette sees it.
 *
 * Pure: CommandPalette.tsx owns the listener and the box.
 */

/** The parts of a KeyboardEvent this looks at. */
export interface KeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
}

/** What was typed: `back` Backspaces into what the box already holds, then `text`. */
export interface Typed {
  back: number;
  text: string;
}

/** One character - including one outside the BMP (an emoji is two code units). */
const isCharacter = (key: string): boolean => key.length > 0 && [...key].length === 1;

export class TypeAhead {
  private typed: Typed | null = null;

  /** Taking keys now. */
  get active(): boolean {
    return this.typed !== null;
  }

  /** An open was asked for. A second request while taking keys keeps what was typed. */
  begin(): void {
    this.typed ??= { back: 0, text: '' };
  }

  /**
   * Offer a key. True when it was taken - the caller then stops it, so it
   * neither types into another field nor fires a page shortcut.
   * Taken: characters, Backspace, and Enter (dropped - the results it would
   * pick are not there yet, and the page behind must not get it). Not taken:
   * anything with Ctrl/Cmd/Alt (Cmd/Ctrl+K closes the palette, Alt/Ctrl+1..4
   * switch its sections), Escape, arrows, Tab, and keys of an IME composition.
   */
  key(e: KeyLike): boolean {
    const t = this.typed;
    if (!t || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return false;
    if (e.key === 'Backspace') {
      if (t.text) t.text = [...t.text].slice(0, -1).join('');
      else t.back += 1;
      return true;
    }
    if (e.key === 'Enter') return true;
    if (isCharacter(e.key)) {
      t.text += e.key;
      return true;
    }
    return false;
  }

  /** Stop taking keys and hand over what was typed. */
  take(): Typed {
    const t = this.typed ?? { back: 0, text: '' };
    this.typed = null;
    return t;
  }

  /** Stop taking keys and forget them (the palette closed). */
  cancel(): void {
    this.typed = null;
  }
}

/** The box's text once what was typed ahead is applied to it. */
export function applyTyped(query: string, t: Typed): string {
  const chars = [...query];
  return chars.slice(0, Math.max(0, chars.length - t.back)).join('') + t.text;
}

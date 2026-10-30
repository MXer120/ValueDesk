/**
 * The order ticket (src/components/OrderEntry.tsx) as the specs drive it: by its
 * ARIA roles and labels, the names a screen reader hears.
 */
import type { Locator, Page } from 'playwright-core';
import { dec, num, readValue, typeInto, until, waitValue } from './harness';

export type OrderType = 'Market' | 'Limit' | 'Stop' | 'Algo';

/** oot: where the ticket is - the desktop panel Order entry by default; at phone width the carousel's Trade page. */
export function ticket(page: Page, root?: Locator) {
  // "Order entry": the desktop panel (a group), or on a phone the carousel's page of that name (a tabpanel).
  const g = root ?? page.getByRole('group', { name: 'Order entry' }).or(page.getByRole('tabpanel', { name: 'Order entry' }));
  const box = (name: string) => g.getByRole('textbox', { name, exact: true });
  const t = {
    g,
    tab: (name: OrderType) => g.getByRole('tablist', { name: 'Order type' }).getByRole('tab', { name, exact: true }),
    direction: (name: 'Long' | 'Short') => g.getByRole('radiogroup', { name: 'Direction' }).getByRole('radio', { name, exact: true }),
    price: box('Price'),
    amount: box('Amount'),
    trigger: box('Trigger'),
    /** The unit toggle: its accessible name is the unit it switches TO ("Size in USDC" while it shows BTC). */
    unit: g.getByRole('button', { name: /^Size in / }),
    max: g.getByRole('button', { name: 'MAX', exact: true }),
    mid: g.getByRole('button', { name: 'MID', exact: true }),
    pct: g.getByRole('textbox', { name: 'Size as a percentage of available balance' }),
    slider: g.getByRole('slider', { name: 'Size as a percentage of available balance' }),
    tif: g.getByRole('button', { name: /^TIF / }),
    reduceOnly: g.getByRole('switch', { name: 'Reduce only' }),
    exits: g.getByRole('switch', { name: 'Take Profit / Stop Loss' }),
    tp: box('TP Price'),
    gain: box('Gain'),
    sl: box('SL Price'),
    loss: box('Loss'),
    toPct: g.getByRole('button', { name: 'Show as a percentage' }),
    toUsd: g.getByRole('button', { name: 'Show as an amount' }),
    kind: g.getByRole('combobox', { name: 'Kind' }),
    executesAs: g.getByRole('combobox', { name: 'Executes as' }),
    leverage: g.getByRole('button', { name: /^\d+x$/ }),
    /** The lines under the amount (TIF notes, size bounds) - the ticket's own text, not notifications. */
    hints: g.locator('.oe-hint'),

    /**
     * The ticket has its market's rules (tick, step, units) and has put the last price in
     * the Limit price box - its own first fill, which would overwrite a price typed before it.
     * Returns that last price. Leaves the ticket on Limit.
     */
    /**
     * The ticket on screen: on a phone the trade page is a carousel (Chart / Order Book / Trade)
     * and the ticket its Trade page, brought in by that tab as a person taps it.
     */
    async show(): Promise<void> {
      const tab = page.locator('.mcarousel').getByRole('tab', { name: 'Trade', exact: true });
      let tapped = 0;
      await until(page, async () => {
        if (!root && (await tab.isVisible().catch(() => false)) && (await tab.getAttribute('aria-selected')) !== 'true') {
          // A tap scrolls the carousel smoothly; tapped again only if it did not get there.
          if (Date.now() - tapped > 2_500) {
            await tab.click();
            tapped = Date.now();
          }
          return false;
        }
        return t.g.isVisible();
      }, 'the order ticket on screen', 30_000);
    },

    async ready(): Promise<number> {
      await t.show();
      await until(page, async () => (await t.unit.isEnabled()) && /^Size in \S+/.test((await t.unit.getAttribute('aria-label')) ?? ''), 'the market rules to load', 30_000);
      await t.type('Limit');
      return num(await waitValue(t.price, (v) => num(v) > 0, 'the last price in the Price box', 30_000));
    },
    async type(kind: OrderType): Promise<void> {
      await t.tab(kind).click();
      await until(page, async () => (await t.tab(kind).getAttribute('aria-selected')) === 'true', `the ${kind} tab`);
    },
    /** The unit the amount is in now (the visible label, not the toggle's name). */
    async unitNow(): Promise<string> {
      return (await t.unit.locator('.oe-unitlabel').textContent())?.trim() ?? '';
    },
    async setUnit(unit: string): Promise<void> {
      if ((await t.unitNow()) !== unit) await t.unit.click();
      await until(page, async () => (await t.unitNow()) === unit, `the amount in ${unit}`);
    },
    async pickTif(code: 'GTC' | 'IOC' | 'GTX'): Promise<void> {
      await t.tif.click();
      const list = page.getByRole('listbox', { name: 'Time in force' });
      await list.getByRole('option', { name: new RegExp(`^${code} ·`) }).click();
      await waitValue(t.tif, (v) => v === code, `TIF ${code}`);
    },
    /** One of the popover's presets (1, 2, 5, 10, 20, ... up to the market's maximum), then Confirm. */
    async setLeverage(n: number): Promise<void> {
      await t.leverage.click();
      const pop = page.getByRole('dialog', { name: 'Leverage' });
      await pop.getByRole('button', { name: `${n}x`, exact: true }).click();
      await waitValue(pop.getByRole('textbox', { name: 'Leverage multiplier' }), (v) => v === String(n), `the draft at ${n}x`);
      await pop.getByRole('button', { name: `Confirm ${n}x` }).click();
      await waitValue(t.leverage, (v) => v === `${n}x`, `${n}x leverage`);
    },
    /** A limit order of `amount` (in the market's base coin) at `price` (whole numbers: no grouping is typed). */
    async limit(price: number, amount: number, side: 'Long' | 'Short' = 'Long'): Promise<void> {
      await t.type('Limit');
      await t.direction(side).check();
      await t.setUnit(await baseUnit(t.unit));
      await typeInto(t.price, dec(price));
      await waitValue(t.price, (v) => num(v) === price, `the price ${price}`);
      await typeInto(t.amount, dec(amount));
      await waitValue(t.amount, (v) => num(v) === amount, `the amount ${amount}`);
    },
    value: readValue,
  };
  return t;
}

/** The base coin's label: the unit the toggle does NOT name while it shows the quote, and vice versa. */
async function baseUnit(unit: Locator): Promise<string> {
  const shown = (await unit.locator('.oe-unitlabel').textContent())?.trim() ?? '';
  const other = ((await unit.getAttribute('aria-label')) ?? '').replace(/^Size in /, '');
  return /^(USDC|USD|USDT|vUSDC)$/i.test(shown) ? other : shown;
}

/** A toast (toast.tsx: role status, or alert for an error) saying `text`. */
export const toast = (page: Page, text: string | RegExp) => page.locator('.toasts .toast').filter({ hasText: text });

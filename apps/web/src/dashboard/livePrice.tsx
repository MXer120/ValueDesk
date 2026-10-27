/**
 * The three trade panels that read the market's last price (lastPrice.ts),
 * each subscribed on its own. The panel registry and the chart card render
 * these instead of passing a `lastPrice` down from TradeContext, so a ticker
 * push re-renders the ticket, the chart and the size calculator - and nothing
 * else on the page.
 */
import type { ComponentProps } from 'react';
import { Chart } from '../components/Chart';
import { OrderEntry } from '../components/OrderEntry';
import { useLastPrice } from '../lastPrice';
import { SizeCalc } from './sourceWidgets';

export function LiveOrderEntry(props: Omit<ComponentProps<typeof OrderEntry>, 'lastPrice'>) {
  return <OrderEntry {...props} lastPrice={useLastPrice()} />;
}

/** `noPrice`: another market's chart, which never gets the market on screen's price. */
export function LiveChart({ noPrice = false, ...props }: Omit<ComponentProps<typeof Chart>, 'lastPrice'> & { noPrice?: boolean }) {
  return <Chart {...props} lastPrice={useLastPrice(noPrice)} />;
}

/** The calculator values at the last price, or at the ticket's price before one has arrived. */
export function LiveSizeCalc({ price }: { price: string }) {
  const last = useLastPrice();
  return <SizeCalc price={last || price} />;
}

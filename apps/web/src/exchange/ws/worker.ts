/**
 * SharedWorker entry: one socket host for every tab of this origin.
 *
 * Each tab connects a MessagePort; the SocketHub behind it holds the actual
 * SoDEX connections, so ten tabs still open two market connections, not
 * twenty. A tab says `bye` when it goes (pagehide); one that just vanishes
 * (crash, killed) stops pinging and is swept after CLIENT_TIMEOUT_MS.
 */
import { SocketHub, asToHost } from './socketHub';
import type { ClientPort, ToTab } from './messages';

interface SharedWorkerScope {
  onconnect: ((ev: MessageEvent) => void) | null;
}

const scope = globalThis as unknown as SharedWorkerScope;
const hub = new SocketHub({ host: 'worker' });

setInterval(() => hub.sweep(), 10_000);

scope.onconnect = (ev: MessageEvent) => {
  const port = ev.ports[0];
  if (!port) return;
  let id: string | null = null;
  const client = (clientId: string): ClientPort => ({
    id: clientId,
    send: (msg: ToTab) => {
      try {
        port.postMessage(msg);
      } catch {
        /* the tab is gone; the sweep removes it */
      }
    },
  });
  port.onmessage = (e: MessageEvent) => {
    const msg = asToHost(e.data);
    if (!msg) return;
    if (msg.op === 'hello') id = msg.client;
    hub.handle(msg, client(id ?? msg.client));
  };
  port.start();
};

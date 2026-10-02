// Who a page talks to. Records every HTTP request and WebSocket of a page session
// and of the SharedWorker socket host, classed as
//   site    the build's own files (document, JS, CSS, fonts, logos)
//   api     OUR server: /api/* (and /ws) on the page's origin
//   direct  everything else - the exchanges and chain hosts, straight from the browser
// Times are seconds since the page's navigation request.

/** Values that differ per wallet or search are folded, so one endpoint is one row. */
const foldPath = (path) => path.replace(/([?&](address|q|coin|id|account|accountId)=)[^&]+/g, '$1*');

export function createTraffic(origin) {
  const requests = new Map();
  const sockets = new Map();
  let base = null;

  const classOf = (url) => {
    if (!url.startsWith(origin + '/') && url !== origin) return 'direct';
    const path = url.slice(origin.length);
    return path.startsWith('/api/') || path.startsWith('/ws') ? 'api' : 'site';
  };
  const hostOf = (url) => { try { return new URL(url).host; } catch { return url; } };

  /** Subscribe on a page or worker session. `where` is 'page' or 'worker'. */
  async function attach(session, where) {
    const key = (id) => `${where}:${id}`;
    session.on('Network.requestWillBeSent', (p) => {
      const url = p.request.url;
      if (!/^https?:/.test(url)) return;
      if (where === 'page' && base === null && p.type === 'Document') base = p.timestamp;
      requests.set(key(p.requestId), {
        url, cls: classOf(url), host: hostOf(url), where, method: p.request.method, type: p.type,
        t: p.timestamp, bytes: 0, status: null, netStatus: null, cached: false, done: false, failed: null,
      });
    });
    session.on('Network.responseReceived', (p) => {
      const r = requests.get(key(p.requestId));
      if (!r) return;
      r.status = p.response.status;
      r.type = p.type || r.type;
      if (p.response.fromDiskCache || p.response.fromPrefetchCache) r.cached = true;
    });
    // What the NETWORK answered. For a revalidated cache entry responseReceived says
    // 200 (the cached body) and this says 304.
    session.on('Network.responseReceivedExtraInfo', (p) => {
      const r = requests.get(key(p.requestId));
      if (r) r.netStatus = p.statusCode;
    });
    session.on('Network.requestServedFromCache', (p) => {
      const r = requests.get(key(p.requestId));
      if (r) r.cached = true;
    });
    session.on('Network.loadingFinished', (p) => {
      const r = requests.get(key(p.requestId));
      if (r) { r.bytes = p.encodedDataLength; r.done = true; }
    });
    session.on('Network.loadingFailed', (p) => {
      const r = requests.get(key(p.requestId));
      if (r) { r.failed = p.canceled ? 'canceled' : p.errorText; r.done = true; }
    });
    session.on('Network.webSocketCreated', (p) => {
      sockets.set(key(p.requestId), { url: p.url, cls: classOf(p.url.replace(/^ws/, 'http')), host: hostOf(p.url), where, t: null, closed: null, in: [], out: 0 });
    });
    session.on('Network.webSocketWillSendHandshakeRequest', (p) => {
      const s = sockets.get(key(p.requestId));
      if (s && s.t === null) s.t = p.timestamp;
    });
    session.on('Network.webSocketFrameReceived', (p) => {
      const s = sockets.get(key(p.requestId));
      if (!s) return;
      const d = p.response.payloadData ?? '';
      s.in.push([p.timestamp, p.response.opcode === 2 ? Math.floor((d.length * 3) / 4) : Buffer.byteLength(d)]);
    });
    session.on('Network.webSocketFrameSent', (p) => {
      const s = sockets.get(key(p.requestId));
      if (s) s.out++;
    });
    session.on('Network.webSocketClosed', (p) => {
      const s = sockets.get(key(p.requestId));
      if (s) s.closed = p.timestamp;
    });
    await session.send('Network.enable', {});
  }

  /**
   * Totals for the requests STARTED in [from, to) seconds after navigation, and for
   * the socket frames received in it.
   */
  function summary(from = 0, to = Infinity) {
    const zero = base ?? 0;
    const inWindow = (t) => t !== null && t - zero >= from && t - zero < to;
    const out = {
      site: { n: 0, bytes: 0, cached: 0 },
      api: { n: 0, bytes: 0, n304: 0, cached: 0, failed: 0, byPath: {} },
      direct: { n: 0, bytes: 0, failed: 0, byHost: {} },
      ws: { opened: 0, open: 0, frames: 0, bytes: 0, byHost: {} },
    };
    for (const r of requests.values()) {
      if (!inWindow(r.t)) continue;
      const c = out[r.cls];
      c.n++;
      c.bytes += r.bytes;
      if (r.cls === 'site') { if (r.cached) c.cached++; continue; }
      if (r.failed && r.failed !== 'canceled') c.failed++;
      if (r.cls === 'api') {
        // Answered by the HTTP cache without the network: no bytes, no network status.
        const fromCache = r.cached && r.netStatus === null;
        if (r.netStatus === 304 || r.status === 304) c.n304++;
        if (fromCache) c.cached++;
        const path = foldPath(r.url.slice(origin.length));
        const e = (c.byPath[path] ??= { n: 0, bytes: 0, n304: 0, cached: 0 });
        e.n++; e.bytes += r.bytes;
        if (r.netStatus === 304 || r.status === 304) e.n304++;
        if (fromCache) e.cached++;
      } else {
        const e = (c.byHost[r.host] ??= { n: 0, bytes: 0 });
        e.n++; e.bytes += r.bytes;
      }
    }
    for (const s of sockets.values()) {
      const e = (out.ws.byHost[`${s.host} (${s.where})`] ??= { opened: 0, open: 0, frames: 0, bytes: 0 });
      if (inWindow(s.t)) { out.ws.opened++; e.opened++; }
      // Open at any moment of the window.
      if (s.t !== null && s.t - zero < to && (s.closed === null || s.closed - zero >= from)) { out.ws.open++; e.open++; }
      for (const [t, len] of s.in) {
        if (!inWindow(t)) continue;
        out.ws.frames++; out.ws.bytes += len;
        e.frames++; e.bytes += len;
      }
    }
    return out;
  }

  return { attach, summary, requests, sockets, get base() { return base; } };
}

/**
 * A very busy SoDEX account, simulated INSIDE the page (an init script): the wallet's REST reads answered by a
 * patched fetch, its account stream by a patched WebSocket, so the harness adds no routing cost per frame and
 * no account frame or order ever leaves the browser. Market data stays SoDEX's own.
 *
 * Installed with window.__VS_FAKE = { owner, prices }. __vsLoad.set({ updatesPerSec, fillsPerSec, openOrders,
 * positions, stateHz }) moves the load; __vsLoad.stats() says how much was sent and what the generator cost.
 *
 * A SharedWorker cannot be patched from here, so the page runs without one: the socket host then runs in this
 * tab (exchange/ws/link.ts, leader mode, as on Android). JSON.parse of the frames lands on this thread where a
 * desktop browser has it in the worker, so these figures are on the high side of a desktop's.
 */
(() => {
  const cfg = window.__VS_FAKE;
  if (!cfg) return;
  const owner = cfg.owner.toLowerCase();
  const prices = cfg.prices;
  const symbols = Object.keys(prices);
  const AID = 987654;

  delete window.SharedWorker;
  try { window.SharedWorker = undefined; } catch { /* read-only */ }

  let seq = 1;
  const rnd = (() => { let s = 12345; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; })();
  const load = { updatesPerSec: 0, fillsPerSec: 0, openOrders: 20, positions: 5, stateHz: 1 };
  const stats = { frames: 0, updates: 0, fills: 0, genMs: 0 };

  /** 40% of the orders rest on the first market (the chart's), the rest spread over the others. */
  const symbolAt = () => (rnd() < 0.4 ? symbols[0] : symbols[Math.floor(rnd() * symbols.length)]);
  const newOrder = () => {
    const s = symbolAt();
    const buy = rnd() < 0.5;
    const off = (buy ? -1 : 1) * (0.0005 + rnd() * 0.02);
    const t = Date.now();
    return {
      s, i: ++seq + 50_000_000, c: `bot-${seq}`, S: buy ? 'BUY' : 'SELL', o: 'LIMIT', f: 'GTX',
      p: (prices[s] * (1 + off)).toPrecision(6), q: (10 / prices[s] + rnd() * (20 / prices[s])).toPrecision(4), X: 'NEW',
      z: '0', v: '0', M: '1.5', ct: t, ut: t,
    };
  };
  const orders = [];
  const trades = [];
  const doneOrders = [];
  const positions = [];
  const HISTORY_MAX = 5000;

  function fit() {
    while (orders.length < load.openOrders) orders.push(newOrder());
    orders.length = Math.min(orders.length, load.openOrders);
    while (positions.length < load.positions) {
      const s = symbols[positions.length % symbols.length];
      const long = positions.length % 2 === 0;
      const size = ((long ? 1 : -1) * (500 / prices[s])).toPrecision(4);
      positions.push({ id: 700_000 + positions.length, symbol: s, marginMode: 'CROSS', positionSide: 'BOTH', size, initialMargin: '50', avgEntryPrice: String(prices[s]), cumOpenCost: '500', cumTradingFee: '0.1', cumClosedSize: '0', avgClosePrice: '0', maxSize: size, realizedPnL: '0', leverage: 10, active: true, isTakenOver: false, takeOverPrice: '0', createdAt: Date.now() - 3_600_000, updatedAt: Date.now() });
    }
    positions.length = Math.min(positions.length, load.positions);
  }

  const restOrder = (o) => ({
    symbol: o.s, orderID: o.i, clOrdID: o.c, side: o.S, type: o.o, timeInForce: o.f, price: o.p, origQty: o.q, status: o.X,
    executedQty: o.z, executedValue: o.v, marginFrozen: o.M, createdAt: o.ct, updatedAt: o.ut,
  });
  const restTrade = (t) => ({ symbol: t.s, tradeID: t.t, orderID: t.i, clOrdID: t.c, side: t.S, price: t.p, quantity: t.q, fee: t.fee, feeCoin: 'vUSDC', time: t.T, isMaker: true });
  const stateRow = () => ({
    user: owner, aid: AID, uid: AID, av: '100000', mm: '100', mmr: '0.001', am: '90000', ami: '5000', amw: '90000', im: '5000', cm: '0', oim: '0', ocm: '0',
    B: [{ i: 0, a: 'vUSDC', wb: '100000', co: '0', mr: '0', px: '1', aw: '100000', at: '100000', wm: '0', am: '90000' }],
    // /state carries the latest 100 open orders at most.
    O: orders.slice(-100),
    P: positions.map((p) => ({ i: p.id, s: p.symbol, m: p.marginMode, ps: p.positionSide, sz: p.size, ep: p.avgEntryPrice, co: p.cumOpenCost, cf: p.cumTradingFee, cc: p.cumClosedSize, l: p.leverage })),
    TO: [], S: [],
  });

  // --- the wallet's REST reads ------------------------------------------------------------------------------
  const page = (rows, url, timeOf) => {
    const limit = Number(url.searchParams.get('limit')) || 100;
    const end = Number(url.searchParams.get('endTime')) || Infinity;
    return rows.filter((r) => timeOf(r) <= end).slice(0, limit);
  };
  function answer(url) {
    const p = url.pathname.toLowerCase();
    if (!p.includes(owner)) return undefined;
    const e = p.includes('/spot/') ? 'spot' : 'perps';
    if (p.endsWith('/subaccounts')) return { userID: AID, primaryAccountID: AID, subaccounts: [] };
    if (p.endsWith('/builders')) return { spot: [], perps: [] };
    if (p.endsWith('/api-keys')) return e === 'perps' && p.includes('/user/') ? { spot: [], perps: [] } : [];
    if (p.endsWith('/state')) return e === 'perps' ? stateRow() : { user: owner, aid: AID, uid: AID, B: [{ i: 0, a: 'vUSDC', t: '5000', l: '0' }], O: [], TO: [] };
    if (p.endsWith('/orders/history')) return e === 'perps' ? page(doneOrders, url, (r) => r.createdAt) : [];
    if (p.endsWith('/orders')) return e === 'perps' ? orders.map(restOrder).reverse() : [];
    if (p.endsWith('/positions/history') || p.endsWith('/fundings')) return [];
    if (p.endsWith('/positions')) return e === 'perps' ? positions : [];
    if (p.endsWith('/trades')) return e === 'perps' ? page(trades, url, (r) => r.time) : [];
    if (p.endsWith('/balances')) return [];
    if (p.includes('/fee')) return { makerFee: '0.0001', takerFee: '0.0004' };
    return undefined;
  }
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let url = null;
    try { url = new URL(href, location.href); } catch { /* not a url */ }
    if (url && /-gw\.sodex\.dev$/.test(url.hostname)) {
      const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') return new Response(JSON.stringify({ code: 400, error: 'fake account: no writes' }), { status: 400 });
      const data = answer(url);
      if (data !== undefined) return new Response(JSON.stringify({ code: 0, data }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(input, init);
  };

  // --- the account stream ------------------------------------------------------------------------------------
  const Real = window.WebSocket;
  const fakes = new Set();
  class Socket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      this.real = null;
      this.channels = new Set();
      this.queue = [];
      this.engine = /perps/.test(url) ? 'perps' : 'spot';
      setTimeout(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.onopen?.({});
      }, 0);
    }
    send(raw) {
      if (this.real) {
        if (this.real.readyState === 1) this.real.send(raw);
        else this.queue.push(raw);
        return;
      }
      const m = JSON.parse(raw);
      if (m.op === 'ping') { setTimeout(() => this.onmessage?.({ data: JSON.stringify({ op: 'pong' }) }), 0); return; }
      if (m.params?.user) {
        const ch = m.params.channel;
        if (m.op === 'subscribe') { this.channels.add(ch); fakes.add(this); }
        else this.channels.delete(ch);
        setTimeout(() => {
          this.onmessage?.({ data: JSON.stringify({ op: m.op, success: true, result: {}, connID: 1 }) });
          if (m.op === 'subscribe' && ch === 'accountState' && this.engine === 'perps') this.push(ch, 'snapshot', stateRow());
        }, 0);
        return;
      }
      // Market data: SoDEX's own.
      this.real = new Real(this.url);
      this.queue.push(raw);
      this.real.onopen = () => { for (const q of this.queue.splice(0)) this.real.send(q); };
      this.real.onmessage = (ev) => this.onmessage?.(ev);
      this.real.onclose = (ev) => { this.readyState = 3; this.onclose?.(ev); };
      this.real.onerror = (ev) => this.onerror?.(ev);
    }
    push(channel, type, data) {
      if (!this.channels.has(channel) || this.readyState !== 1 || this.engine !== 'perps') return;
      stats.frames++;
      this.onmessage?.({ data: JSON.stringify({ channel, type, data }) });
    }
    close() {
      this.readyState = 3;
      fakes.delete(this);
      this.real?.close();
      setTimeout(() => this.onclose?.({}), 0);
    }
  }
  window.WebSocket = new Proxy(Real, {
    construct(T, args) {
      return /-gw\.sodex\.dev/.test(String(args[0])) ? new Socket(String(args[0])) : new T(...args);
    },
  });
  const broadcast = (channel, data, type = 'update') => { for (const s of fakes) s.push(channel, type, data); };

  // --- the activity ------------------------------------------------------------------------------------------
  let carryU = 0;
  let carryF = 0;
  let stateAt = 0;
  const TICK = 50;
  function tick() {
    const t0 = performance.now();
    const now = Date.now();
    fit();
    carryU += (load.updatesPerSec * TICK) / 1000;
    carryF += (load.fillsPerSec * TICK) / 1000;
    while (carryU >= 2 && orders.length > 0) {
      carryU -= 2;
      // A bot's re-quote: one order cancelled, its replacement placed. Each is one update.
      const at = Math.floor(rnd() * orders.length);
      const old = orders[at];
      const gone = { ...old, X: 'CANCELED', ut: now };
      doneOrders.unshift(restOrder(gone));
      if (doneOrders.length > HISTORY_MAX) doneOrders.length = HISTORY_MAX;
      broadcast('accountOrderUpdate', [gone]);
      const fresh = newOrder();
      orders[at] = fresh;
      broadcast('accountOrderUpdate', [fresh]);
      stats.updates += 2;
    }
    while (carryF >= 1 && orders.length > 0) {
      carryF -= 1;
      const at = Math.floor(rnd() * orders.length);
      const o = orders[at];
      const t = { s: o.s, t: ++seq + 90_000_000, i: o.i, c: o.c, S: o.S, p: o.p, q: o.q, T: now, m: true, fee: '0.001', e: 'trade' };
      trades.unshift(restTrade(t));
      if (trades.length > HISTORY_MAX) trades.length = HISTORY_MAX;
      broadcast('accountTrade', [t]);
      const done = { ...o, X: 'FILLED', z: o.q, ut: now };
      doneOrders.unshift(restOrder(done));
      if (doneOrders.length > HISTORY_MAX) doneOrders.length = HISTORY_MAX;
      broadcast('accountOrderUpdate', [done]);
      orders[at] = newOrder();
      stats.fills++;
    }
    if (load.stateHz > 0 && now - stateAt >= 1000 / load.stateHz) {
      stateAt = now;
      if (load.updatesPerSec > 0 || load.fillsPerSec > 0) broadcast('accountUpdate', stateRow());
      broadcast('accountState', stateRow());
    }
    stats.genMs += performance.now() - t0;
  }
  setInterval(tick, TICK);

  // --- what the page feels ------------------------------------------------------------------------------------
  const probe = { frames: [], longTasks: [], lags: [] };
  let lastFrame = 0;
  const onFrame = (t) => { if (lastFrame) probe.frames.push(t - lastFrame); lastFrame = t; requestAnimationFrame(onFrame); };
  requestAnimationFrame(onFrame);
  new PerformanceObserver((l) => { for (const e of l.getEntries()) probe.longTasks.push(e.duration); }).observe({ entryTypes: ['longtask'] });
  let lagAt = performance.now();
  setInterval(() => { const n = performance.now(); probe.lags.push(n - lagAt - 50); lagAt = n; }, 50);

  const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))]; };
  window.__vsLoad = {
    set(o) { Object.assign(load, o); fit(); },
    reset() { probe.frames = []; probe.longTasks = []; probe.lags = []; Object.assign(stats, { frames: 0, updates: 0, fills: 0, genMs: 0 }); },
    stats() {
      const f = probe.frames;
      return {
        ...stats,
        frameCount: f.length, frameP50: pct(f, 50), frameP95: pct(f, 95), frameP99: pct(f, 99), frameMax: pct(f, 100),
        over33: f.filter((x) => x > 33.4).length, over50: f.filter((x) => x > 50).length,
        longTasks: probe.longTasks.length, longTaskMs: probe.longTasks.reduce((a, b) => a + b, 0), longTaskMax: pct(probe.longTasks, 100),
        lagP95: pct(probe.lags, 95), lagMax: pct(probe.lags, 100),
        nodes: document.getElementsByTagName('*').length,
      };
    },
    /** A click to the next painted frame. */
    async clickToPaint(el) {
      const t0 = performance.now();
      el.click();
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      return performance.now() - t0;
    },
  };
})();

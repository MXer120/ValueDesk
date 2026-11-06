/**
 * Who traded on its own, for flowCoverage.spec.ts: the real panel with the app's stylesheets, as wide as the chart gives it
 * (.kc-flow-wrap), fed by the spec's mocked /api/vs/flow. Reached only through a page the spec itself answers.
 */
import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/asap/400.css';
import '@fontsource/asap/500.css';
import '../../src/cssOrder';
import '../../src/styles.css';
import '../../src/theme-light.css';
import '../../src/theme';
import { TradeFlowView } from '../../src/components/flow/TradeFlow';

const q = new URLSearchParams(location.search);
const at = Number(q.get('at'));
createRoot(document.getElementById('root')!).render(
  <div id="panel" className="kc-flow-wrap" style={{ width: q.get('w') ? `${q.get('w')}px` : '100%', height: '100vh', borderLeft: 0, animation: 'none' }}>
    <TradeFlowView symbol="BTC-USD" spot={false} interval={q.get('i') ?? '1h'} at={at} end={null} onPick={() => {}} onClose={() => {}} />
  </div>,
);

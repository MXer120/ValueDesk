import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// IBM Plex Sans, self-hosted (SIL OFL). Only the two weights the UI actually
// uses - 400 for labels, 500 for values. `body` in styles.css has named this
// family all along; until now nothing loaded it and every glyph fell through
// to the system sans, which is why the type never matched the reference.
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
// Asap carries the NUMERALS. The reference terminal runs two families - IBM
// Plex Sans for text (48 elements) and a DIN face for numbers (107 elements) -
// and numbers are the majority of a trading screen. Rendering them in Plex made
// every figure ~11% wider, which three separate reviews reported as three
// unrelated symptoms before it resolved to this one cause. DIN Alternate is
// commercially licensed; Asap is SIL OFL and the closest open match by measured
// advance width (digit run 64.20 vs DIN's 63.98, against Plex's 72.00).
import '@fontsource/asap/400.css';
import '@fontsource/asap/500.css';
import { App } from './App';
import { installGlobalLogging } from './log';
import './styles.css';

// Before the first render, so an error thrown while mounting is logged too.
// See log.ts for levels, ?debug=<ns>, and the __vs console handle.
installGlobalLogging();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

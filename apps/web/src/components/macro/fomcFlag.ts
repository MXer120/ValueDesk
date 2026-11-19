/**
 * The FOMC rate odds widget's switch, on its own: the terminal's panel list and tab menus read it to offer the
 * widget or not, and importing it from FedWatch.tsx put the widget's code (and its chart) in /trade's first
 * render. FedWatch.tsx explains why it is off and re-exports it.
 */
export const FOMC_ODDS_ON = false;

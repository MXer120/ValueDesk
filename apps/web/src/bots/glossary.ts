/**
 * The bot words a beta user may not know, in one place (owner 2026-11-08: glossary tooltips). Shown by Term (an info
 * dot beside the word) and as the title of Explore's column heads. Numbers here are the engine's (packages/copy-engine
 * algo/runtime.ts, bots.ts); keep them in step.
 */
export const GLOSSARY = {
  bp: 'Basis point: 0.01% of the price. 1 bp of $1M traded is $100.',
  oracle: "Binance futures' price of the same coin, used as the fair price. The bot pulls a quote the oracle moved through, and never quotes the side that adds past it.",
  touch: 'The best price on SoDEX right now: the highest bid or the lowest ask.',
  tick: "The market's smallest price step. Distances in ticks scale with the market.",
  skew: 'As it holds more, the side that would add to the position steps back from the best price: this many ticks at full holding, fewer below it.',
  spread: 'The gap between the best bid and the best ask, in bp of the price. Wide spreads mean thin books and sudden moves.',
  postOnly: 'An order that may only rest in the book (maker). If it would trade at once, SoDEX refuses it. Every bot quote is post-only.',
  ioc: 'Immediate-or-cancel: trades what it can at once and cancels the rest. A bot uses it only to close when it stops, at most 30 bp through the price, reduce-only.',
  maker: 'The side that rested in the book. Bots always make, so they pay the maker fee.',
  uninformed: 'Flow from SoDEX account 1002: large and steady, and it does not foretell the price. Being filled by it is cheap for a maker.',
  informed: 'Flow from SoDEX account 23342: it takes quotes just before the price moves. Each fill costs a small maker about 0.86 bp.',
  perMillion: 'What $1M of the bot\'s volume cost (or earned, in green) after every fee and price move, the open position counted at the price now.',
  holding: 'What the bot holds from its own fills. A position you hold yourself on the market is not counted and never touched.',
  margin: "What the bot sets aside of your futures account: (max holding + 2 quotes × levels) ÷ leverage. A start is refused when all your bots, copies and positions would need more than the account holds.",
  reduceOnly: 'An order that can only make a position smaller. A bot unwinds and closes only what it bought or sold itself.',
} as const;

export type GlossaryTerm = keyof typeof GLOSSARY;

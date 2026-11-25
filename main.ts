// Tiny Bot: dip-buy + trend rider for the bars-replay/v1 harness.
//
// One program, no outside data, no network. It reads the hourly bars the
// harness streams on stdin and answers each batch with the orders decided
// on that bar's close (they fill at the next bar's open).
//
// Two ways in, long only, one symbol at a time:
//   1. Dip-buy: the symbol is oversold (RSI(14) under 25) and its close sits
//      more than half a standard deviation under its 20-bar mean. Mean
//      reversion does the work in choppy and falling markets, where a plain
//      trend bot bleeds: it buys the dip and sells the bounce.
//   2. Trend ride: EMA(8) crosses above EMA(21) while RSI(14) is still
//      under 55, so it does not chase an already overbought move. This leg
//      keeps the bot in the game when the market runs up instead of down.
//
// One way out, whole position, first reason that fires:
//   - stop-loss: the position is worth 5% under its cost;
//   - RSI(14) over 70 (overbought);
//   - a dip-buy whose close climbed back above its 20-bar mean;
//   - a trend ride whose EMA(8) crossed back under EMA(21).
// Exit signals are levels, not one-bar events, so an order the market
// refuses is sent again on the next bar while its reason still holds.
//
// Stake: equity over the number of symbols, capped at the harness's
// per-symbol max weight (25% of equity) and at the cash on hand. Sells go
// out before buys in every reply. Every order caps slippage at 1% past the
// close it was decided on. Fully deterministic: no clock, no environment,
// no randomness.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const RSI_BARS = 14;
const RSI_BUY = 25;
const RSI_EXIT = 70;
const RSI_TREND_MAX = 55;
const MEAN_BARS = 20;
const MEAN_DIP_SIGMAS = 0.5;
const FAST_BARS = 8;
const SLOW_BARS = 21;
/** Stop-loss: sell when the position is worth 19/20 of its cost. */
const STOP_NUM = 19n;
const STOP_DEN = 20n;
const MAX_SLIPPAGE_BPS = 100;

interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

interface Series {
  closes: number[];
  fast: Ema;
  slow: Ema;
  /** fast - slow after the previous bar, once both EMAs are seeded. */
  gapPrev: number | null;
  gapNow: number | null;
  /** Where this position came from, while one is held. */
  origin: 'dip' | 'trend' | null;
}

const series = new Map<string, Series>();
/** Entry kind of a buy just sent, applied once its fill shows in the account. */
const pendingOrigin = new Map<string, 'dip' | 'trend'>();

function stepEma(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

function push(bar: Bar): Series {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    s = {
      closes: [],
      fast: { span: FAST_BARS, warm: [], value: null },
      slow: { span: SLOW_BARS, warm: [], value: null },
      gapPrev: null,
      gapNow: null,
      origin: null,
    };
    series.set(bar.symbol, s);
  }
  const c = Number(bar.c);
  s.closes.push(c);
  stepEma(s.fast, c);
  stepEma(s.slow, c);
  s.gapPrev = s.gapNow;
  s.gapNow = s.fast.value !== null && s.slow.value !== null ? s.fast.value - s.slow.value : null;
  return s;
}

/** RSI(14) over the closes seen so far, or null before 15 closes. */
function rsi(s: Series): number | null {
  const n = s.closes.length;
  if (n < RSI_BARS + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let k = n - RSI_BARS; k < n; k++) {
    const d = s.closes[k]! - s.closes[k - 1]!;
    if (d > 0) gains += d;
    else losses -= d;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
}

/** Mean and standard deviation of the last MEAN_BARS closes, or null before 20 closes. */
function meanBand(s: Series): { mean: number; sd: number } | null {
  const n = s.closes.length;
  if (n < MEAN_BARS) return null;
  const window = s.closes.slice(n - MEAN_BARS);
  const mean = window.reduce((a, x) => a + x, 0) / MEAN_BARS;
  const sd = Math.sqrt(window.reduce((a, x) => a + (x - mean) * (x - mean), 0) / MEAN_BARS);
  return { mean, sd };
}

await runBars({
  onBatch(state, batch) {
    const fresh = new Set<string>();
    for (const bar of batch.bars) {
      push(bar);
      fresh.add(bar.symbol);
    }
    if (state.warmingUp) return [];

    // Reconcile each position's origin with the account: a buy just filled
    // takes its pending origin; a position that is gone loses its origin.
    for (const { symbol } of state.hello.symbols) {
      const s = series.get(symbol);
      if (s === undefined) continue;
      if (state.positions.has(symbol)) {
        const org = pendingOrigin.get(symbol);
        if (org !== undefined) {
          s.origin = org;
          pendingOrigin.delete(symbol);
        }
      } else {
        s.origin = null;
      }
    }

    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    const entries: { symbol: string; origin: 'dip' | 'trend' }[] = [];

    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const s = series.get(symbol)!;
      const r = rsi(s);
      const band = meanBand(s);
      if (r === null || band === null || s.gapNow === null || s.gapPrev === null) continue;
      const close = s.closes[s.closes.length - 1]!;
      const held = state.positions.get(symbol);

      if (held !== undefined) {
        const value = state.value(symbol, held.qty);
        const stopped = value * STOP_DEN <= held.cost * STOP_NUM;
        const overbought = r > RSI_EXIT;
        const bounced = s.origin === 'dip' && close > band.mean;
        const trendBroken = s.origin === 'trend' && s.gapNow < 0 && s.gapPrev >= 0;
        if (stopped || overbought || bounced || trendBroken) {
          sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
        continue;
      }

      const dip = r < RSI_BUY && close < band.mean - MEAN_DIP_SIGMAS * band.sd;
      const trendUp = s.gapNow > 0 && s.gapPrev <= 0 && r < RSI_TREND_MAX;
      if (dip) entries.push({ symbol, origin: 'dip' });
      else if (trendUp) entries.push({ symbol, origin: 'trend' });
    }

    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    const slots = Math.min(state.hello.symbols.length, caps.max_open_positions);
    const stake = state.equity / BigInt(slots);
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let cash = state.cash;
    for (const { symbol, origin } of entries) {
      if (orders.length >= caps.max_orders_per_bar) break;
      let slice = stake < byWeight ? stake : byWeight;
      if (cash < slice) slice = cash;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) break;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      pendingOrigin.set(symbol, origin);
      cash -= slice;
    }
    return orders;
  },
});

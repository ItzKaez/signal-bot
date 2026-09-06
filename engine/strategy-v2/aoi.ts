/**
 * AOI « ATR adaptatif » — port de quant-research (strategy.py::_atr_series +
 * calculate_aoi). ATR Wilder seedé sur la moyenne simple des `length` premiers
 * true ranges (identique au runtime FVDB), multiplicateur dynamique
 * clamp(ratio × gain, 1, 3) avec ratio = ATR / SMA(ATR, 50).
 */

import type { Bar } from './peaks';
import type { StrategyV2Config } from './config';

export function atrWilderSeries(bars: Bar[], length: number): (number | null)[] {
  const atr: (number | null)[] = new Array(bars.length).fill(null);
  if (bars.length <= length) return atr;
  const trueRanges = bars.map((bar, i) =>
    i === 0
      ? bar.high - bar.low
      : Math.max(bar.high - bar.low, Math.abs(bar.high - bars[i - 1].close), Math.abs(bar.low - bars[i - 1].close))
  );
  let seed = 0;
  for (let i = 0; i < length; i++) seed += trueRanges[i];
  atr[length - 1] = seed / length;
  for (let i = length; i < bars.length; i++) {
    atr[i] = ((atr[i - 1] as number) * (length - 1) + trueRanges[i]) / length;
  }
  return atr;
}

/**
 * AOI (fraction du prix) ancrée à la bougie du peak sur le timeframe
 * d'exécution. Retourne null si l'ATR n'est pas encore disponible.
 */
export function calculateAoi(
  bars: Bar[],
  peakIndex: number,
  config: StrategyV2Config,
  atr?: (number | null)[]
): number | null {
  const series = atr ?? atrWilderSeries(bars, config.aoiAtrLength);
  const lastAtr = series[peakIndex];
  if (lastAtr === null || lastAtr === undefined) return null;
  const close = bars[peakIndex].close;
  if (close <= 0) return null;
  const from = Math.max(0, peakIndex - config.aoiAtmAdaptiveWindow + 1);
  let sum = 0;
  let count = 0;
  for (let i = from; i <= peakIndex; i++) {
    const value = series[i];
    if (value !== null && value !== undefined) {
      sum += value;
      count++;
    }
  }
  const baseline = count > 0 ? sum / count : lastAtr;
  const ratio = baseline > 0 ? lastAtr / baseline : 1;
  const multiplier = Math.min(3, Math.max(1, ratio * config.aoiAtmAdaptiveGain));
  return (lastAtr / close) * multiplier;
}

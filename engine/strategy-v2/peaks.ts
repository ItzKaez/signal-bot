/**
 * Machine à états RSI peaks/divergences/invalidations — port fidèle et
 * INCREMENTAL de quant-research/indicators.py (lui-même issu de rsipeaks.ts).
 *
 * Les événements sont émis sur la bougie où ils deviennent connaissables ;
 * le prix du peak est stocké comme métadonnée mais jamais utilisé avant
 * confirmation. Times = labels de CLÔTURE sur le timeframe de la frame.
 */

export interface Bar {
  time: number; // secondes UNIX (label d'ouverture pour la frame de base)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Side = 'LONG' | 'SHORT';

export interface PeakEvent {
  confirmedAt: number;
  peakAt: number;
  peakRsi: number;
  peakPrice: number;
  side: Side;
}

export interface DivergenceEvent {
  confirmedAt: number;
  peakAt: number;
  divergenceAt: number;
  divergenceWick: number;
  side: Side;
  directionCandleConfirmed: boolean;
}

export interface InvalidationEvent {
  at: number;
  side: Side;
  reason: 'rsi_breakout' | 'midline' | 'age';
}

export interface ZoneThresholds {
  overbought: number;
  oversold: number;
  midline: number;
  maxPeakAgeBars: number;
  rsiPeriod: number;
}

/** RSI Wilder batch (seed SMA sur `period`, récursion RMA ensuite). Tests/parité. */
export function rsiWilder(closes: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(closes.length).fill(null);
  if (period < 1 || closes.length <= period) return result;
  let averageGain = 0;
  let averageLoss = 0;
  for (let i = 1; i <= period; i++) {
    const delta = closes[i] - closes[i - 1];
    averageGain += Math.max(delta, 0);
    averageLoss += Math.max(-delta, 0);
  }
  averageGain /= period;
  averageLoss /= period;
  for (let i = period; i < closes.length; i++) {
    if (i > period) {
      const delta = closes[i] - closes[i - 1];
      averageGain = (averageGain * (period - 1) + Math.max(delta, 0)) / period;
      averageLoss = (averageLoss * (period - 1) + Math.max(-delta, 0)) / period;
    }
    result[i] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  }
  return result;
}

/** Accumulateur RSI Wilder incrémental (un par frame). */
class IncrementalWilderRsi {
  private averageGain = 0;
  private averageLoss = 0;
  private seedCount = 0;
  private lastClose = NaN;

  push(close: number): number | null {
    if (Number.isNaN(this.lastClose)) {
      this.lastClose = close;
      return null;
    }
    const delta = close - this.lastClose;
    const gain = Math.max(delta, 0);
    const loss = Math.max(-delta, 0);
    this.lastClose = close;
    this.seedCount++;
    if (this.seedCount < this.period) {
      this.averageGain += gain;
      this.averageLoss += loss;
      return null;
    }
    if (this.seedCount === this.period) {
      this.averageGain = (this.averageGain + gain) / this.period;
      this.averageLoss = (this.averageLoss + loss) / this.period;
    } else {
      this.averageGain = (this.averageGain * (this.period - 1) + gain) / this.period;
      this.averageLoss = (this.averageLoss * (this.period - 1) + loss) / this.period;
    }
    if (this.averageLoss === 0) return 100;
    return 100 - 100 / (1 + this.averageGain / this.averageLoss);
  }

  constructor(private readonly period: number) {}
}

/** Machine d'une zone (OB ou OS). push() par bougie clôturée → événements. */
class ZoneMachine {
  private state: 'idle' | 'tracking' | 'active' = 'idle';
  private peakIdx: number | null = null;
  private climbLast: number | null = null;
  private divergenceEnd: number | null = null;
  private zonePeak: number | null = null;
  private priceExceeded = false;
  private rsiHistory: (number | null)[] = [];

  constructor(
    private readonly isOverbought: boolean,
    private readonly thresholds: ZoneThresholds
  ) {}

  private zoneLevel(): number {
    return this.isOverbought ? this.thresholds.overbought : this.thresholds.oversold;
  }

  private priceAt(bars: Bar[], index: number): number {
    return this.isOverbought ? bars[index].high : bars[index].low;
  }

  private resetActive(): void {
    this.state = 'idle';
    this.peakIdx = null;
    this.divergenceEnd = null;
    this.zonePeak = null;
    this.priceExceeded = false;
  }

  push(bars: Bar[], index: number, rsi: number | null): (PeakEvent | DivergenceEvent | InvalidationEvent)[] {
    this.rsiHistory[index] = rsi;
    const events: (PeakEvent | DivergenceEvent | InvalidationEvent)[] = [];
    if (rsi === null || index === 0) return events;
    const previous = this.rsiHistory[index - 1];
    if (previous === null || previous === undefined) return events;

    const zone = this.zoneLevel();
    const isOverbought = this.isOverbought;
    const inZone = isOverbought ? rsi >= zone : rsi <= zone;
    const towardZone = isOverbought ? rsi > previous : rsi < previous;
    const awayFromZone = isOverbought ? rsi < previous : rsi > previous;
    const side: Side = isOverbought ? 'SHORT' : 'LONG';
    let resolved = false;

    if (this.state === 'active' && this.peakIdx !== null) {
      const peakValue = this.rsiHistory[this.peakIdx]!;
      const peakPrice = this.priceAt(bars, this.peakIdx);
      if (isOverbought ? rsi >= peakValue : rsi <= peakValue) {
        events.push({ at: bars[index].time, side, reason: 'rsi_breakout' });
        this.resetActive();
        resolved = true;
      }

      if (!resolved && this.state === 'active' && this.peakIdx !== null) {
        const currentPrice = this.priceAt(bars, index);
        if (isOverbought ? currentPrice > peakPrice : currentPrice < peakPrice) {
          this.priceExceeded = true;
        }
        if (
          this.divergenceEnd === null ||
          (isOverbought
            ? currentPrice > this.priceAt(bars, this.divergenceEnd)
            : currentPrice < this.priceAt(bars, this.divergenceEnd))
        ) {
          this.divergenceEnd = index;
        }
        if (
          inZone &&
          (this.zonePeak === null ||
            (isOverbought ? rsi > this.rsiHistory[this.zonePeak]! : rsi < this.rsiHistory[this.zonePeak]!))
        ) {
          this.zonePeak = index;
        }

        if (awayFromZone && this.priceExceeded && this.divergenceEnd !== null) {
          const endpointRsi = this.rsiHistory[this.divergenceEnd]!;
          const rsiDivergence = isOverbought ? endpointRsi < peakValue : endpointRsi > peakValue;
          const priceDivergence = isOverbought
            ? this.priceAt(bars, this.divergenceEnd) > peakPrice
            : this.priceAt(bars, this.divergenceEnd) < peakPrice;
          if (rsiDivergence && priceDivergence) {
            const inTradeDirection = isOverbought
              ? bars[index].close < bars[index].open
              : bars[index].close > bars[index].open;
            events.push({
              confirmedAt: bars[index].time,
              peakAt: bars[this.peakIdx].time,
              divergenceAt: bars[this.divergenceEnd].time,
              divergenceWick: this.priceAt(bars, this.divergenceEnd),
              side,
              directionCandleConfirmed: inTradeDirection,
            });
            const endpointInZone = isOverbought ? endpointRsi >= zone : endpointRsi <= zone;
            if (endpointInZone) {
              this.peakIdx = this.divergenceEnd;
              events.push({
                confirmedAt: bars[index].time,
                peakAt: bars[this.peakIdx].time,
                peakRsi: endpointRsi,
                peakPrice: this.priceAt(bars, this.peakIdx),
                side,
              });
              this.divergenceEnd = null;
              this.zonePeak = null;
              this.priceExceeded = false;
            } else if (this.zonePeak !== null && this.zonePeak >= this.divergenceEnd - 1) {
              this.peakIdx = this.zonePeak;
              events.push({
                confirmedAt: bars[index].time,
                peakAt: bars[this.peakIdx].time,
                peakRsi: this.rsiHistory[this.peakIdx]!,
                peakPrice: this.priceAt(bars, this.peakIdx),
                side,
              });
              this.divergenceEnd = null;
              this.zonePeak = null;
              this.priceExceeded = false;
            } else {
              this.resetActive();
            }
            resolved = true;
          }
        }
      }

      if (!resolved && this.state === 'active' && this.peakIdx !== null) {
        if (isOverbought ? rsi < this.thresholds.midline : rsi > this.thresholds.midline) {
          events.push({ at: bars[index].time, side, reason: 'midline' });
          this.resetActive();
          resolved = true;
        } else if (index - this.peakIdx >= this.thresholds.maxPeakAgeBars) {
          events.push({ at: bars[index].time, side, reason: 'age' });
          this.resetActive();
          resolved = true;
        }
      }
    }

    if (this.state === 'idle') {
      if (inZone && towardZone) {
        this.state = 'tracking';
        this.climbLast = index;
      }
    } else if (this.state === 'tracking') {
      if (towardZone && inZone) {
        this.climbLast = index;
      } else if (awayFromZone && this.climbLast !== null) {
        this.peakIdx = this.climbLast;
        events.push({
          confirmedAt: bars[index].time,
          peakAt: bars[this.peakIdx].time,
          peakRsi: this.rsiHistory[this.peakIdx]!,
          peakPrice: this.priceAt(bars, this.peakIdx),
          side,
        });
        this.state = 'active';
        this.climbLast = null;
        this.divergenceEnd = null;
        this.zonePeak = null;
        this.priceExceeded = false;
      } else if (!inZone) {
        this.state = 'idle';
        this.climbLast = null;
      }
    }

    return events;
  }
}

/** Détecteur deux zones (OB + OS) sur une frame, incrémental. */
export class RsiPeakDetector {
  private readonly overbought: ZoneMachine;
  private readonly oversold: ZoneMachine;
  private readonly rsi: IncrementalWilderRsi;
  public readonly peaks: PeakEvent[] = [];
  public readonly divergences: DivergenceEvent[] = [];
  public readonly invalidations: InvalidationEvent[] = [];
  private processed = 0;

  constructor(private readonly thresholds: ZoneThresholds) {
    this.overbought = new ZoneMachine(true, thresholds);
    this.oversold = new ZoneMachine(false, thresholds);
    this.rsi = new IncrementalWilderRsi(thresholds.rsiPeriod);
  }

  push(bars: Bar[], index: number): void {
    if (index !== this.processed) throw new Error(`push() expects index ${this.processed}, got ${index}`);
    const value = this.rsi.push(bars[index].close);
    for (const event of this.overbought.push(bars, index, value)) this.classify(event);
    for (const event of this.oversold.push(bars, index, value)) this.classify(event);
    this.processed++;
  }

  private classify(event: PeakEvent | DivergenceEvent | InvalidationEvent): void {
    if ('peakRsi' in event) this.peaks.push(event);
    else if ('divergenceWick' in event) this.divergences.push(event);
    else this.invalidations.push(event);
  }
}

/**
 * Resample close-time : la barre étiquetée T agrège les bougies de base dont
 * l'ouverture est dans [T − step, T). Port de fibonacci.resample_ohlcv.
 */
export function resampleCloseTime(source: Bar[], stepSeconds: number): Bar[] {
  const out: Bar[] = [];
  let current: Bar | null = null;
  let currentBoundary = -1;
  for (const candle of source) {
    const boundary = Math.ceil((candle.time + 1) / stepSeconds) * stepSeconds;
    if (!current || boundary !== currentBoundary) {
      if (current) out.push(current);
      current = {
        time: boundary,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      };
      currentBoundary = boundary;
    } else {
      current.high = Math.max(current.high, candle.high);
      current.low = Math.min(current.low, candle.low);
      current.close = candle.close;
      current.volume += candle.volume;
    }
  }
  if (current) out.push(current);
  return out;
}

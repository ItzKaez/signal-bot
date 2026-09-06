/**
 * POCs multi-périodes avec cycle de vie — port direct de
 * quant-research/poc.py (profil de volume 24 bins par période, états
 * fresh/untapped/tapped, touches détectées à J-1, suppression wick 1D/2D/3D
 * et corps traversé au changement de période, concentration du niveau).
 *
 * Le « minute frame » = la frame de base de la stratégie (le TF du graphique).
 */

import type { Bar } from './peaks';

interface PocSpec {
  code: string;
  seconds: number;
  maxRegular: number;
  maxTapped: number;
  kind: 'fixed' | 'week' | 'biweek' | 'month';
}

const SPECS: PocSpec[] = [
  { code: '1D', seconds: 86400, maxRegular: 3, maxTapped: 0, kind: 'fixed' },
  { code: '2D', seconds: 172800, maxRegular: 3, maxTapped: 0, kind: 'fixed' },
  { code: '3D', seconds: 259200, maxRegular: 3, maxTapped: 0, kind: 'fixed' },
  { code: '5D', seconds: 432000, maxRegular: 3, maxTapped: 1, kind: 'fixed' },
  { code: '1W', seconds: 604800, maxRegular: 3, maxTapped: 1, kind: 'week' },
  { code: '2W', seconds: 1209600, maxRegular: 3, maxTapped: 1, kind: 'biweek' },
  { code: '1M', seconds: 2592000, maxRegular: 2, maxTapped: 2, kind: 'month' },
];

const DAY = 86400;

export interface PocLevelDetail {
  price: number;
  code: string;
  state: 'fresh' | 'untapped' | 'tapped';
  concentration: number;
}

interface PocLine {
  price: number;
  specIndex: number;
  state: 'fresh' | 'untapped' | 'tapped';
  createdIndex: number;
  createdPeriod: number;
  concentration: number;
  touched: boolean;
  touchedAt: number;
  bodyTouched: boolean;
  bodyTouchedAt: number;
  deleted: boolean;
}

function periodId(timestamp: number, spec: PocSpec): number {
  if (spec.kind === 'month') {
    const date = new Date(timestamp * 1000);
    return date.getUTCFullYear() * 12 + date.getUTCMonth();
  }
  if (spec.kind === 'week' || spec.kind === 'biweek') {
    const aligned = timestamp + 3 * DAY;
    return spec.kind === 'biweek' ? Math.floor(aligned / (2 * spec.seconds)) : Math.floor(aligned / spec.seconds);
  }
  return Math.floor(timestamp / spec.seconds);
}

/** POC du profil de volume d'une période + concentration du bin max (0-1). */
function periodPoc(base: Bar[], daily: Bar[], start: number, end: number): { poc: number; concentration: number } {
  const startTime = daily[start].time;
  const endTime = daily[end].time + DAY;
  let slice: Bar[] = [];
  for (const bar of base) {
    if (bar.time >= startTime && bar.time < endTime) slice.push(bar);
  }
  if (slice.length === 0) slice = daily.slice(start, end + 1);
  let hi = -Infinity;
  let lo = Infinity;
  for (const bar of slice) {
    if (bar.high > hi) hi = bar.high;
    if (bar.low < lo) lo = bar.low;
  }
  if (hi <= lo) return { poc: (hi + lo) / 2, concentration: 0 };
  const bins = 24;
  const step = (hi - lo) / bins;
  const volumeBins = new Array(bins).fill(0);
  for (const candle of slice) {
    const volume = candle.volume;
    if (volume <= 0) continue;
    const range = Math.max(candle.high - candle.low, step * 0.01);
    for (let b = 0; b < bins; b++) {
      const binLow = lo + b * step;
      const overlap = Math.max(0, Math.min(candle.high, binLow + step) - Math.max(candle.low, binLow));
      if (overlap > 0) volumeBins[b] += volume * (overlap / range);
    }
  }
  let maxBin = 0;
  for (let b = 1; b < bins; b++) {
    if (volumeBins[b] > volumeBins[maxBin]) maxBin = b;
  }
  const total = volumeBins.reduce((sum, value) => sum + value, 0);
  return { poc: lo + (maxBin + 0.5) * step, concentration: total > 0 ? volumeBins[maxBin] / total : 0 };
}

/**
 * Simulateur incrémental jour par jour. advance() consomme les nouvelles
 * bougies de base ; le premier bar d'un nouveau jour UTC déclenche le step
 * de ce jour (les touches et snapshots n'utilisent que la veille, close).
 */
export class PocSimulator {
  private readonly lines: PocLine[] = [];
  private readonly lastPeriod: number[] = new Array(SPECS.length).fill(Number.NaN);
  private readonly periodStart: number[] = new Array(SPECS.length).fill(0);
  private readonly daily: Bar[] = [];
  private currentDailyDay = -1;
  private processedBaseBars = 0;
  public readonly snapshots = new Map<number, { prices: number[]; details: PocLevelDetail[] }>();

  constructor(private readonly base: Bar[]) {}

  advance(): void {
    while (this.processedBaseBars < this.base.length) {
      const bar = this.base[this.processedBaseBars];
      const day = Math.floor(bar.time / DAY) * DAY;
      if (day !== this.currentDailyDay) {
        this.currentDailyDay = day;
        this.daily.push({ time: day, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume });
        this.stepDay(this.daily.length - 1);
      } else {
        const today = this.daily[this.daily.length - 1];
        today.high = Math.max(today.high, bar.high);
        today.low = Math.min(today.low, bar.low);
        today.close = bar.close;
        today.volume += bar.volume;
      }
      this.processedBaseBars++;
    }
  }

  private stepDay(dayIndex: number): void {
    // À l'ouverture du jour courant on connaît le OHLCV terminé d'hier.
    this.updateTouches(dayIndex - 1);
    for (let specIndex = 0; specIndex < SPECS.length; specIndex++) {
      const spec = SPECS[specIndex];
      const period = periodId(this.daily[dayIndex].time, spec);
      if (Number.isNaN(this.lastPeriod[specIndex])) {
        this.lastPeriod[specIndex] = period;
        this.periodStart[specIndex] = dayIndex;
        continue;
      }
      if (period === this.lastPeriod[specIndex]) continue;
      for (const line of this.lines) {
        if (line.specIndex !== specIndex || line.deleted) continue;
        if (spec.maxTapped === 0 && line.touched) line.deleted = true;
        if (line.bodyTouched) line.deleted = true;
      }
      const { poc, concentration } = periodPoc(this.base, this.daily, this.periodStart[specIndex], dayIndex - 1);
      for (const line of this.lines) {
        if (line.specIndex === specIndex && line.state === 'fresh' && !line.deleted) line.state = 'untapped';
      }
      this.lines.push({
        price: poc,
        specIndex,
        state: 'fresh',
        createdIndex: dayIndex,
        createdPeriod: this.lastPeriod[specIndex],
        concentration,
        touched: false,
        touchedAt: -1,
        bodyTouched: false,
        bodyTouchedAt: -1,
        deleted: false,
      });
      this.lastPeriod[specIndex] = period;
      this.periodStart[specIndex] = dayIndex;
    }

    const referenceClose = this.daily[Math.max(0, dayIndex - 1)].close;
    const prices: number[] = [];
    const details: PocLevelDetail[] = [];
    for (let specIndex = 0; specIndex < SPECS.length; specIndex++) {
      const spec = SPECS[specIndex];
      const current = this.lines.filter((line) => line.specIndex === specIndex && !line.deleted);
      const regular = current
        .filter((line) => line.state === 'untapped')
        .sort((a, b) => Math.abs(referenceClose - a.price) - Math.abs(referenceClose - b.price));
      const fresh = current.filter((line) => line.state === 'fresh');
      const tapped = current.filter((line) => line.state === 'tapped').sort((a, b) => b.touchedAt - a.touchedAt);
      const selected = [...regular.slice(0, spec.maxRegular), ...fresh, ...tapped.slice(0, spec.maxTapped)];
      for (const line of selected) {
        prices.push(line.price);
        details.push({ price: line.price, code: spec.code, state: line.state, concentration: line.concentration });
      }
    }
    this.snapshots.set(this.daily[dayIndex].time, { prices, details });
  }

  private updateTouches(dayIndex: number): void {
    if (dayIndex < 0) return;
    const row = this.daily[dayIndex];
    for (const line of this.lines) {
      if (line.deleted || dayIndex <= line.createdIndex) continue;
      const spec = SPECS[line.specIndex];
      if (periodId(this.daily[dayIndex].time, spec) <= line.createdPeriod) continue;
      const wickTouch = row.high >= line.price && line.price >= row.low;
      const bodyTop = Math.max(row.open, row.close);
      const bodyBottom = Math.min(row.open, row.close);
      const bodyCross = bodyTop >= line.price && line.price >= bodyBottom;
      if (bodyCross) {
        line.bodyTouched = true;
        line.bodyTouchedAt = dayIndex;
      } else if (wickTouch && line.state !== 'tapped') {
        if (spec.maxTapped > 0) {
          line.state = 'tapped';
          line.touchedAt = dayIndex;
        } else {
          line.touched = true;
          line.touchedAt = dayIndex;
        }
      }
    }
  }
}

/** POC visible le plus proche au-dessus (`direction`) du prix, sinon null. */
export function nearestPoc(levels: number[], price: number, direction: 'above' | 'below'): number | null {
  const candidates = direction === 'above' ? levels.filter((level) => level > price) : levels.filter((level) => level < price);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, level) => (Math.abs(level - price) < Math.abs(best - price) ? level : best));
}

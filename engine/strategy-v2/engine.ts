/**
 * Moteur live de la stratégie Peak/POC/Fib V2 — port incrémental fidèle de
 * quant-research (strategy.py::generate_trade_plans + backtest.py::run_baseline,
 * référence : V2 exécution + AOI ATR adaptatif + stop dur 2×AOI + purge).
 *
 * Sémantique : l'état n'avance que sur des bougies de base CLÔTURÉES. Les
 * timeframes supérieurs ne sont commités qu'une fois leurs barres complètes.
 * Les times des événements machine = labels de clôture TF ; les temps
 * d'exécution (activation, fills, sorties) = labels d'ouverture des bougies
 * de base (= labels TradingView).
 */

import { buildConfig, type StrategyV2Config } from './config';
import {
  RsiPeakDetector,
  resampleCloseTime,
  type Bar,
  type DivergenceEvent,
  type InvalidationEvent,
  type PeakEvent,
  type Side,
} from './peaks';
import { atrWilderSeries } from './aoi';
import { PocSimulator, nearestPoc } from './pocs';
import { planTrade, isTwin, type TradePlan } from './plans';
import { selectFibonacci } from './fib';

export interface JournalEntry {
  t: number;
  type: string;
  price?: number;
  size?: number;
  note?: string;
}

export interface ClosedTrade {
  createdAt: number;
  entryAt: number;
  exitAt: number;
  side: Side;
  averageEntry: number;
  exitPrice: number;
  pnl: number;
  fees: number;
  reason: string;
  fills: number;
  /** Journal du trade, capturé à sa clôture finale (tranche du journal
   *  moteur depuis l'activation de la position) — immunité contre la
   *  fenêtre glissante du journal global : un trade porte TOUJOURS son
   *  historique, même sur les runs de plusieurs années. */
  logs?: JournalEntry[];
}

interface Fill {
  price: number;
  size: number;
  time: number;
}

interface Position {
  plan: TradePlan;
  fills: Fill[];
  filledLevels: Set<number>;
  remainingSize: number;
  plannedSize: number;
  nextTarget: number;
  breakeven: boolean;
  adverseCloses: number;
  divergenceConfirmed: boolean;
  awaitingDirectionCandle: boolean;
  emergencyStop: number | null;
  limitsCancelled: boolean;
}

function fillPrice(level: number, side: Side, slippage: number, entering: boolean): number {
  const direction = side === 'LONG' ? 1 : -1;
  const sign = entering ? direction : -direction;
  return level * (1 + sign * slippage);
}

/** Borne « prochain évènement ≥ x » par recherche binaire. */
function bisectLeft(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface TimeframeState {
  bars: Bar[]; // barres COMPLÈTES uniquement
  partial: Bar | null;
  detector: RsiPeakDetector;
  barIndexByTime: Map<number, number>;
}

export interface StrategySnapshot {
  pendingPlans: TradePlan[];
  /** Toutes les positions actives (hedging) — la plus ancienne aussi exposée
   *  via `position` pour les consommateurs mono-position. */
  positions?: Array<{
    plan: TradePlan;
    fills: number;
    averageEntry: number | null;
    remainingSize: number;
    divergenceConfirmed: boolean;
    breakeven: boolean;
    emergencyStop: number | null;
    /** SL mèche adverse (div en loss / peak de référence cassé). */
    wickStop: number | null;
    /** Niveaux d'entrée/DCA déjà remplis (pour l'affichage). */
    filledEntryLevels: number[];
    /** Index du prochain TP à prendre (= nombre de TPs déjà pris). */
    nextTarget: number;
    nextTargetPrice: number | null;
    floatingPnl: number | null;
  }>;
  /** Somme des P&L flottants de TOUTES les positions remplies. */
  positionFloatingTotal?: number | null;
  position: {
    plan: TradePlan;
    fills: number;
    averageEntry: number | null;
    remainingSize: number;
    divergenceConfirmed: boolean;
    breakeven: boolean;
    emergencyStop: number | null;
    /** SL mèche adverse (div en loss / peak de référence cassé). */
    wickStop: number | null;
    /** Niveaux d'entrée/DCA déjà remplis (pour l'affichage). */
    filledEntryLevels: number[];
    /** Index du prochain TP à prendre (= nombre de TPs déjà pris). */
    nextTarget: number;
    nextTargetPrice: number | null;
    floatingPnl: number | null;
  } | null;
  trades: ClosedTrade[];
  journal: JournalEntry[];
  stats: { trades: number; wins: number; losses: number; pnl: number; fees: number };
  /** Historique des signaux pour l'affichage en cartes (moteur app). */
  signalHistory?: Array<{ plan: TradePlan; status: string; pnl: number; note?: string; tpsTaken?: number; pnlTotal?: number; feesTotal?: number; tpExits?: Array<{ tp: number; price: number; size: number; pnl: number }> }>;
}

export class StrategyV2Engine {
  public readonly config: StrategyV2Config;
  private capital: number;
  private readonly baseBars: Bar[] = [];
  private readonly timeframes = new Map<number, TimeframeState>();
  private readonly pocs: PocSimulator;
  private readonly divergenceEvents = new Map<string, DivergenceEvent[]>();
  private readonly divergencesByTime = new Map<string, DivergenceEvent[]>();
  private readonly invalidationsByTime = new Map<string, InvalidationEvent[]>();
  private readonly invalidationTimes = new Map<string, number[]>();
  private readonly plannedPeaks = new Set<string>();
  public readonly recentPeaks: PeakEvent[] = [];
  public readonly recentDivergences: DivergenceEvent[] = [];
  private pending: TradePlan[] = [];
  private position: Position | null = null;
  private readonly trades: ClosedTrade[] = [];
  public readonly journal: JournalEntry[] = [];
  private readonly closedPlans: TradePlan[] = [];

  constructor(baseIntervalSeconds: number, capital = 10_000) {
    this.config = buildConfig(baseIntervalSeconds);
    this.capital = capital;
    const frames = new Set<number>([...this.config.executionSeconds, ...this.config.fibonacciSeconds]);
    for (const seconds of frames) {
      // Toutes les frames partagent la convention close-time de la référence
      // Python : la frame de base décale chaque bougie de +step (une bougie
      // ouverte à T clôture à T+step et porte le label T+step).
      this.timeframes.set(seconds, {
        bars: [],
        partial: null,
        detector: new RsiPeakDetector(this.config),
        barIndexByTime: new Map(),
      });
    }
    this.pocs = new PocSimulator(this.baseBars);
  }

  setCapital(capital: number): void {
    this.capital = capital;
  }

  /** Ingère une bougie de base CLÔTURÉE (times strictement croissants). */
  ingest(bar: Bar): void {
    const last = this.baseBars[this.baseBars.length - 1];
    if (last && bar.time <= last.time) return;
    this.baseBars.push(bar);
    this.pocs.advance();
    this.commitTimeframes(bar);
    this.step(bar);
  }

  private commitTimeframes(bar: Bar): void {
    for (const [seconds, state] of this.timeframes) {
      if (seconds === this.config.baseIntervalSeconds) {
        // Frame de base en convention close-time : la bougie ouverte à T est
        // complète à l'ingestion et porte le label T + step.
        const closeBar: Bar = {
          time: bar.time + this.config.baseIntervalSeconds,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
        };
        state.bars.push(closeBar);
        state.barIndexByTime.set(closeBar.time, state.bars.length - 1);
        this.pushToDetector(state, state.bars.length - 1, seconds);
        continue;
      }
      const boundary = Math.ceil((bar.time + 1) / seconds) * seconds;
      if (state.partial && state.partial.time !== boundary) {
        state.bars.push(state.partial);
        state.barIndexByTime.set(state.partial.time, state.bars.length - 1);
        this.pushToDetector(state, state.bars.length - 1, seconds);
        state.partial = null;
      }
      if (!state.partial) {
        state.partial = {
          time: boundary,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
        };
      } else {
        state.partial.high = Math.max(state.partial.high, bar.high);
        state.partial.low = Math.min(state.partial.low, bar.low);
        state.partial.close = bar.close;
        state.partial.volume += bar.volume;
      }
    }
  }

  private pushToDetector(state: TimeframeState, index: number, seconds: number): void {
    const before = { peaks: state.detector.peaks.length, divergences: state.detector.divergences.length, invalidations: state.detector.invalidations.length };
    state.detector.push(state.bars, index);
    const events = state.detector;
    for (let i = before.peaks; i < events.peaks.length; i++) {
      this.onPeak(events.peaks[i], seconds);
    }
    for (let i = before.divergences; i < events.divergences.length; i++) {
      this.indexDivergence(events.divergences[i], seconds);
    }
    for (let i = before.invalidations; i < events.invalidations.length; i++) {
      this.indexInvalidation(events.invalidations[i], seconds);
    }
  }

  private indexDivergence(event: DivergenceEvent, seconds: number): void {
    const key = `${seconds}|${event.peakAt}`;
    const list = this.divergenceEvents.get(key) ?? [];
    list.push(event);
    this.divergenceEvents.set(key, list);
    const timeKey = `${seconds}|${event.confirmedAt}`;
    const byTime = this.divergencesByTime.get(timeKey) ?? [];
    byTime.push(event);
    this.divergencesByTime.set(timeKey, byTime);
    this.recentDivergences.push(event);
    if (this.recentDivergences.length > 100) this.recentDivergences.shift();
  }

  private indexInvalidation(event: InvalidationEvent, seconds: number): void {
    const timeKey = `${seconds}|${event.at}`;
    const byTime = this.invalidationsByTime.get(timeKey) ?? [];
    byTime.push(event);
    this.invalidationsByTime.set(timeKey, byTime);
    const sideKey = `${seconds}|${event.side}`;
    const times = this.invalidationTimes.get(sideKey) ?? [];
    times.push(event.at);
    times.sort((a, b) => a - b);
    this.invalidationTimes.set(sideKey, times);
  }

  private onPeak(peak: PeakEvent, seconds: number): void {
    this.recentPeaks.push(peak);
    if (this.recentPeaks.length > 100) this.recentPeaks.shift();
    const dedupKey = `${seconds}|${peak.confirmedAt}|${peak.peakAt}`;
    if (this.plannedPeaks.has(dedupKey)) return;
    this.plannedPeaks.add(dedupKey);
    if (!this.config.executionSeconds.includes(seconds)) return;

    const day = Math.floor(peak.confirmedAt / 86400) * 86400;
    const snapshot = this.pocs.snapshots.get(day);
    if (!snapshot) return;
    const levels = snapshot.prices;
    const poc = nearestPoc(levels, peak.peakPrice, peak.side === 'LONG' ? 'below' : 'above');
    if (poc === null) return;

    const fibFrames = new Map<number, Bar[]>();
    for (const fibSeconds of this.config.fibonacciSeconds) {
      const state = this.timeframes.get(fibSeconds);
      if (state) fibFrames.set(fibSeconds, state.bars);
    }
    const execState = this.timeframes.get(seconds);
    if (!execState) return;
    const peakIdx = execState.barIndexByTime.get(peak.peakAt) ?? this.indexOfTime(execState.bars, peak.peakAt);
    if (peakIdx === undefined || peakIdx < 0) return;
    const atr = atrWilderSeries(execState.bars, this.config.aoiAtrLength);
    const atrAtPeak = atr[peakIdx];
    const closeAtPeak = execState.bars[peakIdx].close;
    const from = Math.max(0, peakIdx - this.config.aoiAtmAdaptiveWindow + 1);
    let sum = 0;
    let count = 0;
    for (let i = from; i <= peakIdx; i++) {
      const value = atr[i];
      if (value !== null && value !== undefined) {
        sum += value;
        count++;
      }
    }
    const baseline = count > 0 && atrAtPeak !== null ? sum / count : (atrAtPeak ?? 0);
    const ratio = baseline > 0 && atrAtPeak !== null ? atrAtPeak / baseline : 1;
    const multiplier = Math.min(3, Math.max(1, ratio * this.config.aoiAtmAdaptiveGain));
    const aoiPct = atrAtPeak !== null && closeAtPeak > 0 ? (atrAtPeak / closeAtPeak) * multiplier : null;
    if (aoiPct === null) return;
    // Fibonacci multi-timeframe : golden pocket ∩ entrée + RR 1:1 AOI→TP1.
    const aoiBoundary = peak.side === 'LONG' ? poc * (1 - aoiPct) : poc * (1 + aoiPct);
    const fib = selectFibonacci(fibFrames, peak.confirmedAt, peak.side, poc, aoiBoundary, levels, this.config);
    if (fib === null) return;

    const detail = snapshot.details.find((level) => Math.abs(level.price - poc) / poc < 1e-6) ?? null;
    const plan = planTrade(peak.confirmedAt, peak.peakAt, peak.side, seconds, poc, levels, aoiPct, fib, this.config, {
      peakRsi: peak.peakRsi,
      peakPrice: peak.peakPrice,
      aoiDetail:
        atrAtPeak !== null
          ? { atr: atrAtPeak, atrPct: atrAtPeak / closeAtPeak, ratio, multiplier }
          : null,
      pocDetail: detail,
    });
    if (plan === null) return;

    // Déduplication des jumeaux inter-timeframes (le TF prioritaire gagne).
    const twinWindow = this.config.executionSeconds[0];
    const twin =
      this.pending.find((other) => isTwin(other, plan, twinWindow)) ??
      (this.position ? (isTwin(this.position.plan, plan, twinWindow) ? this.position.plan : undefined) : undefined);
    if (twin) {
      const priorityIndex = (value: number) => this.config.executionSeconds.indexOf(value);
      if (priorityIndex(plan.executionSeconds) < priorityIndex(twin.executionSeconds)) {
        this.pending = this.pending.filter((other) => other !== twin);
        this.log(plan.createdAt, 'twin_replaced', undefined, undefined, 'jumeau prioritaire remplace le plan du TF secondaire');
      } else {
        this.log(plan.createdAt, 'twin_ignored', undefined, undefined, 'twin ignored (priority TF already waiting/active)');
        return;
      }
    }
    this.pending.push(plan);
    this.pending.sort((a, b) => a.createdAt - b.createdAt);
    this.log(
      plan.createdAt,
      'plan_created',
      plan.entryPoc,
      undefined,
      `${plan.side} TF ${plan.executionSeconds / 60}min peak RSI ${plan.peakRsi.toFixed(1)} · POC ${plan.entryPoc.toFixed(1)} · AOI ${(plan.aoiPct * 100).toFixed(2)}% · DCA ${plan.entryLevels.map((level) => level.toFixed(1)).join(' / ')} · RR ${plan.rrToTp1.toFixed(2)}`
    );
  }

  private indexOfTime(bars: Bar[], time: number): number {
    let lo = 0;
    let hi = bars.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid].time === time) return mid;
      if (bars[mid].time < time) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  private log(t: number, type: string, price?: number, size?: number, note?: string): void {
    this.journal.push({ t, type, price, size, note });
    if (this.journal.length > 2000) this.journal.splice(0, this.journal.length - 2000);
  }

  /** Le plan est-il déjà mort en file ? (purge continue) */
  private purgeReason(plan: TradePlan, now: number): string | null {
    const times = this.invalidationTimes.get(`${plan.executionSeconds}|${plan.side}`) ?? [];
    const index = bisectLeft(times, plan.peakAt);
    if (index < times.length && times[index] < now) {
      return 'peak invalidated while waiting — stale setup, purged from queue';
    }
    for (const event of this.divergenceEvents.get(`${plan.executionSeconds}|${plan.peakAt}`) ?? []) {
      if (event.directionCandleConfirmed && event.confirmedAt < now) {
        return 'divergence confirmed without fill while waiting — setup purged';
      }
    }
    return null;
  }

  /** Un pas d'exécution sur une bougie de base clôturée. */
  private step(candle: Bar): void {
    const now = candle.time;
    // Purge continue de la file.
    if (this.pending.length > 0) {
      const survivors: TradePlan[] = [];
      for (const plan of this.pending) {
        const reason = this.purgeReason(plan, now);
        if (reason === null) survivors.push(plan);
        else this.log(now, 'cancelled_unfilled', candle.close, undefined, reason);
      }
      this.pending = survivors;
    }

    // Activation au premier créneau libre (FIFO par date de création, comme
    // le backtest : un plan n'entre en file qu'à partir de son createdAt).
    if (this.position === null && this.pending.length > 0 && this.pending[0].createdAt <= now) {
      {
        const plan = this.pending.shift() as TradePlan;
      const worstAverage = plan.entryLevels.reduce((sum, level) => sum + level, 0) / plan.entryLevels.length;
      const riskDistance = worstAverage * this.config.hardExitAoiMultiple * plan.aoiPct;
      let totalSize = riskDistance > 0 ? (this.capital * this.config.riskPerTradePct) / riskDistance : 0;
      totalSize = Math.min(totalSize, (this.capital * this.config.maxLeverage) / worstAverage);
      this.position = {
        plan,
        fills: [],
        filledLevels: new Set(),
        remainingSize: 0,
        plannedSize: totalSize,
        nextTarget: 0,
        breakeven: false,
        adverseCloses: 0,
        divergenceConfirmed: false,
        awaitingDirectionCandle: false,
        emergencyStop: null,
        limitsCancelled: false,
      };
      this.log(now, 'plan_activated', undefined, undefined, `${plan.side} TF ${plan.executionSeconds / 60}min, planned size ${totalSize.toFixed(4)}`);

      // Rattrapage des événements survenus pendant l'attente du créneau.
      for (const event of this.divergenceEvents.get(`${plan.executionSeconds}|${plan.peakAt}`) ?? []) {
        if (event.confirmedAt >= now) continue;
        if (event.directionCandleConfirmed) {
          this.position.divergenceConfirmed = true;
          this.position.awaitingDirectionCandle = false;
          this.log(event.confirmedAt, 'divergence_confirmed', undefined, undefined, 'catch-up: divergence confirmed while waiting');
          this.applyZoneBreakeven(this.position, now, event.confirmedAt);
        } else if (!this.position.divergenceConfirmed) {
          this.position.awaitingDirectionCandle = true;
          this.log(event.confirmedAt, 'awaiting_direction_candle', undefined, undefined, 'rattrapage : bougie de direction attendue');
        }
      }
      const staleTimes = this.invalidationTimes.get(`${plan.executionSeconds}|${plan.side}`) ?? [];
      const staleIndex = bisectLeft(staleTimes, plan.peakAt);
      const stale = staleIndex < staleTimes.length && staleTimes[staleIndex] < now;
        if (stale) {
          this.log(now, 'cancelled_unfilled', candle.close, undefined, 'peak invalidated before activation — stale setup');
          this.position = null;
          this.closedPlans.push(plan);
          return;
        }
      }
    }

    const position = this.position;
    if (!position) return;
    const plan = position.plan;
    const side = plan.side;

    // Divergence du peak du plan, traitée en direct.
    for (const event of this.divergenceEvents.get(`${plan.executionSeconds}|${plan.peakAt}`) ?? []) {
      if (event.confirmedAt === now) {
        if (event.directionCandleConfirmed) {
          position.divergenceConfirmed = true;
          position.awaitingDirectionCandle = false;
          this.log(now, 'divergence_confirmed', candle.close, undefined, 'divergence candle closed');
          this.applyZoneBreakeven(position, now, event.confirmedAt);
        } else {
          position.awaitingDirectionCandle = true;
          this.log(now, 'awaiting_direction_candle', candle.close, undefined, 'divergence detected, waiting for direction candle');
        }
      }
    }
    if (position.divergenceConfirmed && position.fills.length === 0) {
      this.log(now, 'cancelled_unfilled', candle.close, undefined, 'divergence confirmed without any fill — setup cancelled');
      this.position = null;
      this.closedPlans.push(plan);
      return;
    }
    if (position.awaitingDirectionCandle) {
      const directionCandle = side === 'LONG' ? candle.close > candle.open : candle.close < candle.open;
      if (directionCandle) {
        position.divergenceConfirmed = true;
        position.awaitingDirectionCandle = false;
        this.log(now, 'divergence_confirmed', candle.close, undefined, 'direction candle closed');
        this.applyZoneBreakeven(position, now, now);
      }
    }

    // Invalidation connue à l'ouverture de cette bougie : setup non fillé → limites retirées.
    if (position.fills.length === 0) {
      const events = this.invalidationsByTime.get(`${plan.executionSeconds}|${now}`) ?? [];
      if (events.some((event) => event.side === side)) {
        this.log(now, 'cancelled_unfilled', candle.close, undefined, 'invalidation — limits removed at invalidation candle close');
        this.position = null;
        this.closedPlans.push(plan);
        return;
      }
    }

    // Fills DCA.
    const fillSize = position.plannedSize / plan.entryLevels.length;
    for (let order = 0; order < plan.entryLevels.length; order++) {
      const level = plan.entryLevels[order];
      const rounded = Math.round(level * 1e10) / 1e10;
      if (position.filledLevels.has(rounded)) continue;
      if (position.limitsCancelled) break;
      const hit = side === 'LONG' ? candle.low <= level : candle.high >= level;
      if (hit) {
        const price = fillPrice(level, side, this.config.slippagePctPerFill, true);
        position.fills.push({ price, size: fillSize, time: now });
        position.remainingSize += fillSize;
        position.filledLevels.add(rounded);
        this.log(now, 'dca_fill', price, fillSize, `DCA${order + 1} limite @ ${level.toFixed(1)}`);
      }
    }
    if (position.fills.length === 0) return;

    const average = position.fills.reduce((sum, fill) => sum + fill.price * fill.size, 0) /
      position.fills.reduce((sum, fill) => sum + fill.size, 0);

    // BE « immediate » : première clôture favorable post-divergence.
    if (
      this.config.breakevenMode === 'immediate' &&
      position.divergenceConfirmed &&
      !position.breakeven &&
      (side === 'LONG' ? candle.close > average : candle.close < average)
    ) {
      position.breakeven = true;
      this.log(now, 'breakeven_enabled', average, undefined, 'stop moved to break-even');
    }

    // Invalidation avec position remplie : stop de secours sur la mèche (cap 2×AOI).
    const invalidationEvents = this.invalidationsByTime.get(`${plan.executionSeconds}|${now}`) ?? [];
    const invalidation = invalidationEvents.find((event) => event.side === side);
    if (!position.divergenceConfirmed && invalidation) {
      let emergency = side === 'LONG' ? this.wickLowSince(plan.peakAt, now) : this.wickHighSince(plan.peakAt, now);
      const cap = side === 'LONG'
        ? average * (1 - this.config.fallbackStopCapAoiMultiple * plan.aoiPct)
        : average * (1 + this.config.fallbackStopCapAoiMultiple * plan.aoiPct);
      emergency = side === 'LONG' ? Math.max(emergency, cap) : Math.min(emergency, cap);
      position.emergencyStop = emergency;
      this.log(now, 'emergency_stop_set', emergency, undefined, `emergency stop set (${invalidation.reason}): extreme wick since peak, capped 2×AOI`);
      if (this.config.cancelLimitsOnPartialInvalidation) {
        position.limitsCancelled = true;
        this.log(now, 'limits_cancelled', undefined, undefined, 'invalidation: remaining DCA limits removed');
      }
    }

    // Sortie forcée : deux clôtures consécutives au-delà de 2×AOI.
    const forcedLevel = side === 'LONG'
      ? average * (1 - this.config.forcedExitAoiMultiple * plan.aoiPct)
      : average * (1 + this.config.forcedExitAoiMultiple * plan.aoiPct);
    const adverseClose = side === 'LONG' ? candle.close < forcedLevel : candle.close > forcedLevel;
    position.adverseCloses = adverseClose && !position.breakeven ? position.adverseCloses + 1 : 0;
    if (position.adverseCloses > 0) {
      this.log(now, 'adverse_close', candle.close, undefined, `${position.adverseCloses} close(s) beyond 2×AOI (${forcedLevel.toFixed(1)})`);
    }

    // Stop effectif : BE / stop de secours / stop dur 2×AOI — le plus proche gouverne.
    let stop: number | null = position.emergencyStop;
    if (position.breakeven) stop = average;
    const hardLevel = side === 'LONG'
      ? average * (1 - this.config.hardExitAoiMultiple * plan.aoiPct)
      : average * (1 + this.config.hardExitAoiMultiple * plan.aoiPct);
    const candidates = [hardLevel, ...(stop !== null ? [stop] : [])];
    const effectiveStop = side === 'LONG' ? Math.max(...candidates) : Math.min(...candidates);
    const stopHit = side === 'LONG' ? candle.low <= effectiveStop : candle.high >= effectiveStop;
    const forcedExit = position.adverseCloses >= this.config.forcedExitConsecutiveCloses;
    if (stopHit || forcedExit) {
      const exitLevel = stopHit ? effectiveStop : candle.close;
      const exitPrice = fillPrice(exitLevel, side, this.config.slippagePctPerFill, false);
      const gross = side === 'LONG' ? (exitPrice - average) * position.remainingSize : (average - exitPrice) * position.remainingSize;
      const fees = (average + exitPrice) * position.remainingSize * this.config.feePctPerSide;
      const reason = stopHit && effectiveStop === hardLevel
        ? `${this.config.hardExitAoiMultiple}x_aoi_hard_stop`
        : position.breakeven && stopHit
          ? 'break_even_stop'
          : stopHit
            ? 'divergence_invalidated'
            : '2x_aoi_forced_exit';
      this.log(now, 'exit', exitPrice, position.remainingSize, `${reason}, PnL ${(gross - fees).toFixed(2)} USD`);
      this.trades.push({
        createdAt: plan.createdAt,
        entryAt: position.fills[0].time,
        exitAt: now,
        side,
        averageEntry: average,
        exitPrice,
        pnl: gross - fees,
        fees,
        reason,
        fills: position.fills.length,
      });
      this.position = null;
      this.closedPlans.push(plan);
      return;
    }

    // Take profits (évalués après les protections).
    while (position.nextTarget < plan.targets.length) {
      const target = plan.targets[position.nextTarget];
      const hit = side === 'LONG' ? candle.high >= target.price : candle.low <= target.price;
      if (!hit) break;
      const size = Math.min(position.remainingSize, position.plannedSize * target.fraction);
      if (size <= 0) {
        position.nextTarget++;
        continue;
      }
      const exitPrice = fillPrice(target.price, side, this.config.slippagePctPerFill, false);
      const gross = side === 'LONG' ? (exitPrice - average) * size : (average - exitPrice) * size;
      const fees = (average + exitPrice) * size * this.config.feePctPerSide;
      position.remainingSize -= size;
      this.log(now, 'exit', exitPrice, size, `tp${position.nextTarget + 1}, PnL ${(gross - fees).toFixed(2)} USD`);
      this.trades.push({
        createdAt: plan.createdAt,
        entryAt: position.fills[0].time,
        exitAt: now,
        side,
        averageEntry: average,
        exitPrice,
        pnl: gross - fees,
        fees,
        reason: `tp${position.nextTarget + 1}`,
        fills: position.fills.length,
      });
      position.nextTarget++;
      if (!position.breakeven) {
        position.breakeven = true;
        this.log(now, 'breakeven_enabled', average, undefined, 'TP atteint, stop au break-even');
      }
    }
    if (position.remainingSize <= 1e-12) {
      this.position = null;
      this.closedPlans.push(plan);
    }
  }

  private applyZoneBreakeven(position: Position, at: number, rsiAt: number): void {
    if (this.config.breakevenMode !== 'zone' || position.breakeven) return;
    const execState = this.timeframes.get(position.plan.executionSeconds);
    if (!execState) return;
    const index = this.indexOfTime(execState.bars, rsiAt);
    if (index < 0) return;
    const closes = execState.bars.slice(0, index + 1).map((bar) => bar.close);
    const rsiSeries = rsiSeriesOf(closes);
    const value = rsiSeries[index];
    if (value === null || value === undefined) return;
    const extreme = position.plan.side === 'SHORT' ? value >= this.config.overbought : value <= this.config.oversold;
    const average = position.fills.length > 0
      ? position.fills.reduce((sum, fill) => sum + fill.price * fill.size, 0) / position.fills.reduce((sum, fill) => sum + fill.size, 0)
      : 0;
    if (!extreme) {
      position.breakeven = true;
      this.log(at, 'breakeven_enabled', average, undefined, `div confirmed out of zone (RSI ${value.toFixed(1)}) — momentum broken, BE set`);
    } else if (position.filledLevels.size >= position.plan.entryLevels.length) {
      position.breakeven = true;
      this.log(at, 'breakeven_enabled', average, undefined, `div confirmed still in zone (RSI ${value.toFixed(1)}) but position full — BE set`);
    } else {
      this.log(at, 'zone_be_deferred', undefined, undefined, `div confirmed still in zone (RSI ${value.toFixed(1)}), DCAs remaining — BE deferred`);
    }
  }

  private wickLowSince(peakAt: number, now: number): number {
    let low = Infinity;
    const upper = now - this.config.baseIntervalSeconds; // exclut la bougie courante (info à l'ouverture)
    for (const bar of this.baseBars) {
      if (bar.time >= peakAt - this.config.baseIntervalSeconds && bar.time <= upper) {
        low = Math.min(low, bar.low);
      }
    }
    return low;
  }

  private wickHighSince(peakAt: number, now: number): number {
    let high = -Infinity;
    const upper = now - this.config.baseIntervalSeconds;
    for (const bar of this.baseBars) {
      if (bar.time >= peakAt - this.config.baseIntervalSeconds && bar.time <= upper) {
        high = Math.max(high, bar.high);
      }
    }
    return high;
  }

  getSnapshot(lastPrice: number | null): StrategySnapshot {
    const wins = this.trades.filter((trade) => trade.pnl > 0 || trade.reason === 'break_even_stop');
    const losses = this.trades.filter((trade) => trade.pnl <= 0 && trade.reason !== 'break_even_stop');
    let floating: number | null = null;
    if (this.position && lastPrice !== null && this.position.fills.length > 0) {
      const average = this.position.fills.reduce((sum, fill) => sum + fill.price * fill.size, 0) /
        this.position.fills.reduce((sum, fill) => sum + fill.size, 0);
      floating = this.position.plan.side === 'LONG'
        ? (lastPrice - average) * this.position.remainingSize
        : (average - lastPrice) * this.position.remainingSize;
    }
    return {
      pendingPlans: this.pending,
      position: this.position
        ? {
            plan: this.position.plan,
            fills: this.position.fills.length,
            averageEntry:
              this.position.fills.length > 0
                ? this.position.fills.reduce((sum, fill) => sum + fill.price * fill.size, 0) /
                  this.position.fills.reduce((sum, fill) => sum + fill.size, 0)
                : null,
            remainingSize: this.position.remainingSize,
            divergenceConfirmed: this.position.divergenceConfirmed,
            breakeven: this.position.breakeven,
            emergencyStop: this.position.emergencyStop,
            wickStop: null,
            filledEntryLevels: Array.from(this.position.filledLevels),
            nextTarget: this.position.nextTarget,
            nextTargetPrice: this.position.plan.targets[this.position.nextTarget]?.price ?? null,
            floatingPnl: floating,
          }
        : null,
      trades: this.trades,
      journal: this.journal,
      stats: {
        trades: this.trades.length,
        wins: wins.length,
        losses: losses.length,
        pnl: this.trades.reduce((sum, trade) => sum + trade.pnl, 0),
        fees: this.trades.reduce((sum, trade) => sum + trade.fees, 0),
      },
    };
  }

  /** Spéc d'overlay (données pures) pour le rendu ChartContainer. */
  buildOverlay(): OverlaySpecV2 {
    const latestDay = this.baseBars.length > 0 ? Math.floor(this.baseBars[this.baseBars.length - 1].time / 86400) * 86400 : -1;
    const snapshot = latestDay >= 0 ? this.pocs.snapshots.get(latestDay) : undefined;
    const pocLines = (snapshot?.details ?? []).map((detail) => ({
      price: detail.price,
      code: detail.code,
      state: detail.state,
      concentration: detail.concentration,
    }));
    const plans = [...this.pending, ...(this.position ? [this.position.plan] : [])].slice(-3);
    const zones: OverlayZone[] = [];
    const levels: OverlayLevel[] = [];
    const fibImpulseLines: OverlaySpecV2['fibImpulseLines'] = [];
    const now = this.baseBars[this.baseBars.length - 1]?.time ?? 0;
    for (const plan of plans) {
      const start = plan.createdAt;
      const end = now + this.config.baseIntervalSeconds * 40;
      // Frames resamplées = labels à l'heure de clôture ; le chart affiche à
      // l'heure d'ouverture → retrouver la bougie réelle portant l'extrême.
      const exactExtremeTime = (label: number, timeframeSeconds: number, pickHigh: boolean): number => {
        if (timeframeSeconds <= this.config.baseIntervalSeconds) return label;
        const spanStart = label - timeframeSeconds;
        let bestTime = spanStart;
        let bestValue = pickHigh ? -Infinity : Infinity;
        for (const bar of this.baseBars) {
          if (bar.time < spanStart || bar.time >= label) continue;
          const value = pickHigh ? bar.high : bar.low;
          if (pickHigh ? value > bestValue : value < bestValue) { bestValue = value; bestTime = bar.time; }
        }
        return bestTime;
      };
      const fibTfLabel = plan.fibonacci.timeframeSeconds >= 3600 ? `${plan.fibonacci.timeframeSeconds / 3600}h` : `${plan.fibonacci.timeframeSeconds / 60}m`;
      fibImpulseLines.push({
        x1: exactExtremeTime(plan.fibonacci.swingLowAt, plan.fibonacci.timeframeSeconds, false),
        y1: plan.fibonacci.swingLow,
        x2: exactExtremeTime(plan.fibonacci.swingHighAt, plan.fibonacci.timeframeSeconds, true),
        y2: plan.fibonacci.swingHigh,
        color: '#f59e0b',
        label: `imp ${fibTfLabel}`,
      });
      zones.push({
        start,
        end,
        top: Math.max(plan.entryPoc, plan.aoiBoundary),
        bottom: Math.min(plan.entryPoc, plan.aoiBoundary),
        color: plan.side === 'LONG' ? 'rgba(52, 211, 153, 0.10)' : 'rgba(244, 63, 94, 0.10)',
        label: `AOI ${(plan.aoiPct * 100).toFixed(2)}%`,
      });
      zones.push({
        start,
        end,
        top: Math.max(plan.fibonacci.gpLow, plan.fibonacci.gpHigh),
        bottom: Math.min(plan.fibonacci.gpLow, plan.fibonacci.gpHigh),
        color: 'rgba(255, 215, 0, 0.10)',
        label: `GP ${plan.fibonacci.timeframeSeconds / 3600}h`,
      });
      plan.entryLevels.forEach((level, index) => {
        levels.push({ price: level, label: `DCA${index + 1}`, color: '#60a5fa', style: 'dashed' });
      });
      plan.targets.forEach((target, index) => {
        levels.push({ price: target.price, label: `TP${index + 1} (${Math.round(target.fraction * 100)}%)`, color: '#34d399', style: 'dashed' });
      });
    }
    const active = this.position;
    if (active) {
      const average = active.fills.length > 0
        ? active.fills.reduce((sum, fill) => sum + fill.price * fill.size, 0) / active.fills.reduce((sum, fill) => sum + fill.size, 0)
        : null;
      if (active.emergencyStop !== null) {
        levels.push({ price: active.emergencyStop, label: 'Stop secours', color: '#f59e0b', style: 'solid' });
      }
      if (average !== null && active.breakeven) {
        levels.push({ price: average, label: 'BE', color: '#eab308', style: 'solid' });
      }
    }
    return {
      pocLines,
      fibImpulseLines,
      peakMarkers: this.recentPeaks.slice(-40).map((peak) => ({
        time: peak.peakAt,
        price: peak.peakPrice,
        side: peak.side,
        rsi: peak.peakRsi,
        confirmedAt: peak.confirmedAt,
      })),
      divergenceLines: this.recentDivergences.slice(-20).map((divergence) => {
        const peak = this.recentPeaks.find((candidate) => candidate.peakAt === divergence.peakAt && candidate.side === divergence.side);
        return {
          t1: divergence.peakAt,
          p1: peak ? peak.peakPrice : divergence.divergenceWick,
          t2: divergence.divergenceAt,
          p2: divergence.divergenceWick,
          side: divergence.side,
        };
      }),
      zones,
      levels,
      trades: this.trades.slice(-40).map((trade) => ({
        entryTime: trade.entryAt,
        entryPrice: trade.averageEntry,
        exitTime: trade.exitAt,
        exitPrice: trade.exitPrice,
        direction: trade.side,
        pnl: trade.pnl,
        reason: trade.reason,
      })),
      journalMarkers: this.journal
        .filter((entry) => entry.type === 'plan_activated' || entry.type === 'exit')
        .slice(-30)
        .map((entry) => ({
          time: entry.t,
          type: entry.type,
          price: entry.price,
          note: entry.note,
        })),
    };
  }
}

/** Série RSI Wilder locale (mode zone uniquement). */
function rsiSeriesOf(closes: number[]): (number | null)[] {
  const period = 14;
  const result: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return result;
  let averageGain = 0;
  let averageLoss = 0;
  for (let i = 1; i <= period; i++) {
    const delta = closes[i] - closes[i - 1];
    averageGain += Math.max(delta, 0);
    averageLoss += Math.max(-delta, 0);
  }
  averageGain /= period;
  averageLoss /= period;
  result[period] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    averageGain = (averageGain * (period - 1) + Math.max(delta, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-delta, 0)) / period;
    result[i] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  }
  return result;
}

export interface OverlayPocLine {
  price: number;
  code: string;
  state: string;
  concentration: number;
}

export interface OverlayZone {
  start: number;
  end: number;
  top: number;
  bottom: number;
  color: string;
  label: string;
}

export interface OverlayLevel {
  price: number;
  label: string;
  color: string;
  /** Couleur du texte du label (défaut : blanc). */
  textColor?: string;
  style: 'solid' | 'dashed' | 'dotted';
  start?: number;
  end?: number;
  /** Décalage vertical du label en pixels (ex : BE au même prix que l'entry
   *  → label décalé pour rester lisible). */
  labelOffsetPx?: number;
}

export interface OverlaySpecV2 {
  pocLines: OverlayPocLine[];
  peakMarkers: Array<{ time: number; price: number; side: Side; rsi: number; confirmedAt: number }>;
  divergenceLines: Array<{ t1: number; p1: number; t2: number; p2: number; side: Side }>;
  /** Diagonales d'impulsion fibonacci : relient le swing low au swing high
   *  utilisés par le plan (pour vérifier visuellement les extrêmes choisis). */
  fibImpulseLines: Array<{ x1: number; y1: number; x2: number; y2: number; color: string; label: string }>;
  zones: OverlayZone[];
  levels: OverlayLevel[];
  trades: Array<{ entryTime: number; entryPrice: number; exitTime: number; exitPrice: number; direction: Side; pnl: number; reason: string }>;
  journalMarkers: Array<{ time: number; type: string; price?: number; note?: string }>;
}

export { resampleCloseTime };
export type { TradePlan } from './plans';

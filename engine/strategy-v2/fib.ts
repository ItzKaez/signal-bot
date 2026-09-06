/**
 * Fibonacci causal — port fidèle de quant-research/fibonacci.py :
 * pivots confirmés (fenêtre des deux côtés), impulse valide jusqu'au trade
 * (les extrêmes doivent tenir de la zone jusqu'à l'instant du setup),
 * golden pocket [0.618, 0.886], targets 0.5/0.382/0.236/0, cascade
 * multi-timeframe jusqu'au timeframe d'exécution.
 */

import type { Bar } from './peaks';
import type { StrategyV2Config } from './config';
import { rrForFib } from './plans';

export interface FibonacciPlan {
  timeframeSeconds: number;
  side: 'LONG' | 'SHORT';
  swingLow: number;
  swingHigh: number;
  swingLowAt: number;
  swingHighAt: number;
  gpLow: number;
  gpHigh: number;
  targets: [number, number, number, number];

  containsGoldenPocket(price: number): boolean;
}

export function makeFibonacciPlan(
  timeframeSeconds: number,
  side: 'LONG' | 'SHORT',
  swingLow: number,
  swingHigh: number,
  swingLowAt: number,
  swingHighAt: number,
  gpLow: number,
  gpHigh: number,
  targets: [number, number, number, number]
): FibonacciPlan {
  return {
    timeframeSeconds,
    side,
    swingLow,
    swingHigh,
    swingLowAt,
    swingHighAt,
    gpLow,
    gpHigh,
    targets,
    containsGoldenPocket(price: number): boolean {
      return gpLow <= price && price <= gpHigh;
    },
  };
}

interface ViolationIndices {
  nextLowerLow: number[];
  nextHigherHigh: number[];
  prevLowerLow: number[];
  prevHigherHigh: number[];
}

/** Lookups O(1) : prochain/précédent index avec low strictement plus bas / high strictement plus haut. */
function violationIndices(bars: Bar[]): ViolationIndices {
  const size = bars.length;
  const lows = bars.map((bar) => bar.low);
  const highs = bars.map((bar) => bar.high);

  const nextStrict = (values: number[], smaller: boolean): number[] => {
    const result: number[] = new Array(size).fill(size);
    const stack: number[] = [];
    for (let i = 0; i < size; i++) {
      while (stack.length && (smaller ? values[i] < values[stack[stack.length - 1]] : values[i] > values[stack[stack.length - 1]])) {
        result[stack.pop() as number] = i;
      }
      stack.push(i);
    }
    return result;
  };

  const prevStrict = (values: number[], smaller: boolean): number[] => {
    const result: number[] = new Array(size).fill(-1);
    const stack: number[] = [];
    for (let i = 0; i < size; i++) {
      while (stack.length && (smaller ? values[stack[stack.length - 1]] >= values[i] : values[stack[stack.length - 1]] <= values[i])) {
        stack.pop();
      }
      if (stack.length) result[i] = stack[stack.length - 1];
      stack.push(i);
    }
    return result;
  };

  return {
    nextLowerLow: nextStrict(lows, true),
    nextHigherHigh: nextStrict(highs, false),
    prevLowerLow: prevStrict(lows, true),
    prevHigherHigh: prevStrict(highs, false),
  };
}

function allPivots(bars: Bar[], window: number): { highPivots: number[]; lowPivots: number[] } {
  const isPivot = (index: number, column: 'high' | 'low', high: boolean): boolean => {
    if (index < window || index + window >= bars.length) return false;
    const value = bars[index][column];
    for (let i = index - window; i < index; i++) {
      if (high ? bars[i][column] >= value : bars[i][column] <= value) return false;
    }
    for (let i = index + 1; i <= index + window; i++) {
      if (high ? bars[i][column] >= value : bars[i][column] <= value) return false;
    }
    return true;
  };
  const highPivots: number[] = [];
  const lowPivots: number[] = [];
  for (let i = window; i < bars.length - window; i++) {
    if (isPivot(i, 'high', true)) highPivots.push(i);
    if (isPivot(i, 'low', false)) lowPivots.push(i);
  }
  return { highPivots, lowPivots };
}

/**
 * Une impulse tracée ne compte que si ses extrêmes tiennent AU MOMENT DU
 * TRADE : sur toute la plage du swing start jusqu'à `uptoIdx`, le swing low
 * doit rester le plus bas et le swing high le plus haut.
 */
function zoneValid(
  startIdx: number,
  endIdx: number,
  side: 'LONG' | 'SHORT',
  uptoIdx: number,
  violations: ViolationIndices
): boolean {
  if (side === 'LONG') {
    return (
      violations.nextLowerLow[startIdx] > uptoIdx &&
      violations.prevHigherHigh[endIdx] <= startIdx &&
      violations.nextHigherHigh[endIdx] > uptoIdx
    );
  }
  return (
    violations.nextHigherHigh[startIdx] > uptoIdx &&
    violations.prevLowerLow[endIdx] <= startIdx &&
    violations.nextLowerLow[endIdx] > uptoIdx
  );
}

/**
 * Jusqu'à `count` impulsions confirmées DISTINCTES, de la plus récente à la
 * plus ancienne. Chaque paire (swing départ, extrême arrivée) qui tient
 * jusqu'à `asof` est une fib candidate — les swings anciens du TF du chart
 * (extrémités reculées) sont souvent ceux qu'on repère à l'œil.
 * `total` compte TOUTES les impulsions valides trouvées (même au-delà du cap)
 * pour diagnostiquer ce qui reste inexploré.
 */
function confirmedImpulses(
  bars: Bar[],
  asof: number,
  side: 'LONG' | 'SHORT',
  window: number,
  count: number
): { impulses: Array<[number, number]>; total: number } {
  const impulses: Array<[number, number]> = [];
  let total = 0;
  // availableEnd : dernier index avec time <= asof (asof = label de clôture).
  let availableEnd = bars.length - 1;
  while (availableEnd >= 0 && bars[availableEnd].time > asof) availableEnd--;
  if (availableEnd < window * 2 + 1) return { impulses, total };
  const lastConfirmable = availableEnd - window;
  const { highPivots, lowPivots } = allPivots(bars, window);
  const violations = violationIndices(bars);
  const highs = highPivots.filter((index) => index <= lastConfirmable);
  const lows = lowPivots.filter((index) => index <= lastConfirmable);
  const seen = new Set<string>();
  const tryCollect = (startIdx: number, endIdx: number): boolean => {
    total++;
    const key = `${startIdx}:${endIdx}`;
    if (seen.has(key)) return false;
    seen.add(key);
    impulses.push([startIdx, endIdx]);
    return impulses.length >= count;
  };
  if (side === 'LONG') {
    for (let h = highs.length - 1; h >= 0 && total < count; h--) {
      const highIdx = highs[h];
      for (let l = lows.length - 1; l >= 0; l--) {
        const lowIdx = lows[l];
        if (lowIdx >= highIdx) continue;
        if (zoneValid(lowIdx, highIdx, side, availableEnd, violations)) {
          if (tryCollect(lowIdx, highIdx)) break;
        }
      }
    }
  } else {
    for (let l = lows.length - 1; l >= 0 && total < count; l--) {
      const lowIdx = lows[l];
      for (let h = highs.length - 1; h >= 0; h--) {
        const highIdx = highs[h];
        if (highIdx >= lowIdx) continue;
        if (zoneValid(highIdx, lowIdx, side, availableEnd, violations)) {
          if (tryCollect(highIdx, lowIdx)) break;
        }
      }
    }
  }
  return { impulses, total };
}

function latestConfirmedImpulse(
  bars: Bar[],
  asof: number,
  side: 'LONG' | 'SHORT',
  window: number
): [number, number] | null {
  return confirmedImpulses(bars, asof, side, window, 1).impulses[0] ?? null;
}

/** Construit le plan fibonacci (GP + targets) d'une paire de pivots donnée. */
function planFromImpulse(
  bars: Bar[],
  startIdx: number,
  endIdx: number,
  timeframeSeconds: number,
  side: 'LONG' | 'SHORT',
  config: StrategyV2Config
): FibonacciPlan | null {
  const low = side === 'LONG' ? bars[startIdx].low : bars[endIdx].low;
  const high = side === 'LONG' ? bars[endIdx].high : bars[startIdx].high;
  if (high <= low) return null;
  const span = high - low;
  let levels: [number, number, number, number];
  let gpLow: number;
  let gpHigh: number;
  if (side === 'LONG') {
    levels = [0.5, 0.382, 0.236, 0.0].map((level) => high - span * level) as [number, number, number, number];
    gpLow = high - span * config.goldenPocketDeep;
    gpHigh = high - span * config.goldenPocketShallow;
  } else {
    levels = [0.5, 0.382, 0.236, 0.0].map((level) => low + span * level) as [number, number, number, number];
    gpLow = low + span * config.goldenPocketShallow;
    gpHigh = low + span * config.goldenPocketDeep;
  }
  return makeFibonacciPlan(
    timeframeSeconds,
    side,
    low,
    high,
    side === 'LONG' ? bars[startIdx].time : bars[endIdx].time,
    side === 'LONG' ? bars[endIdx].time : bars[startIdx].time,
    gpLow,
    gpHigh,
    levels
  );
}

export function fibonacciAt(
  bars: Bar[],
  asof: number,
  timeframeSeconds: number,
  side: 'LONG' | 'SHORT',
  config: StrategyV2Config
): FibonacciPlan | null {
  const impulse = latestConfirmedImpulse(bars, asof, side, config.pivotWindow);
  if (!impulse) return null;
  return planFromImpulse(bars, impulse[0], impulse[1], timeframeSeconds, side, config);
}

/** Les N dernières fibs confirmées du timeframe (récentes → anciennes), plus
 *  le nombre total d'impulsions valides disponibles dans l'historique. */
export function fibonacciCandidates(
  bars: Bar[],
  asof: number,
  timeframeSeconds: number,
  side: 'LONG' | 'SHORT',
  config: StrategyV2Config
): { plans: FibonacciPlan[]; pool: number } {
  const { impulses, total } = confirmedImpulses(bars, asof, side, config.pivotWindow, config.maxImpulsesPerTimeframe);
  const plans: FibonacciPlan[] = [];
  for (const [startIdx, endIdx] of impulses) {
    const plan = planFromImpulse(bars, startIdx, endIdx, timeframeSeconds, side, config);
    if (plan !== null) plans.push(plan);
  }
  return { plans, pool: total };
}

/** Diagnostic par timeframe : pourquoi ce TF n'a pas fourni la fib.
 *  Pour gp_miss, gpLow/gpHigh couvrent l'union des GPs des impulsions
 *  testées, `candidates` leur nombre et `pool` le nombre total d'impulsions
 *  valides disponibles (au-delà du cap). */
export interface FibDiagEntry {
  timeframeSeconds: number;
  outcome: 'no_impulse' | 'gp_miss' | 'rr_miss' | 'ok';
  gpLow?: number;
  gpHigh?: number;
  rr?: number;
  candidates?: number;
  pool?: number;
}

export function selectFibonacciDiag(
  frames: Map<number, Bar[]>,
  asof: number,
  side: 'LONG' | 'SHORT',
  entryPrice: number,
  aoiBoundary: number,
  visiblePocs: number[],
  config: StrategyV2Config
): { plan: FibonacciPlan | null; diag: FibDiagEntry[] } {
  const diag: FibDiagEntry[] = [];
  const passing: Array<{ plan: FibonacciPlan; timeframeSeconds: number; rr: number; candidates: number; pool: number }> = [];
  for (const timeframeSeconds of config.fibonacciSeconds) {
    const bars = frames.get(timeframeSeconds);
    if (!bars) continue;
    const { plans: candidates, pool } = fibonacciCandidates(bars, asof, timeframeSeconds, side, config);
    if (candidates.length === 0) {
      diag.push({ timeframeSeconds, outcome: 'no_impulse', pool });
      continue;
    }
    let unionLow = Infinity;
    let unionHigh = -Infinity;
    let firstRrMiss: number | undefined;
    let tfPassed = 0;
    for (const plan of candidates) {
      unionLow = Math.min(unionLow, plan.gpLow);
      unionHigh = Math.max(unionHigh, plan.gpHigh);
      if (!plan.containsGoldenPocket(entryPrice)) continue;
      const rr = rrForFib(entryPrice, aoiBoundary, side, plan, visiblePocs, config);
      if (rr < config.minRrToEffectiveTp1) {
        if (firstRrMiss === undefined) firstRrMiss = rr;
        continue;
      }
      passing.push({ plan, timeframeSeconds, rr, candidates: candidates.length, pool });
      tfPassed++;
    }
    if (tfPassed === 0) {
      if (firstRrMiss !== undefined) {
        diag.push({ timeframeSeconds, outcome: 'rr_miss', gpLow: unionLow, gpHigh: unionHigh, rr: firstRrMiss, candidates: candidates.length, pool });
      } else {
        diag.push({ timeframeSeconds, outcome: 'gp_miss', gpLow: unionLow, gpHigh: unionHigh, candidates: candidates.length, pool });
      }
    }
  }
  // Sélection, deux critères :
  // 1) Si les POCs fournissent DÉJÀ au moins un DCA (un POC dans l'AOI à
  //    ≥ spacing de l'entrée), le besoin DCA est couvert → priorité pure au
  //    TP1 le plus proche. Sinon, privilégier les fibs dont le 0.886 tombe
  //    dans l'AOI (une telle fib a toujours un TP1 lointain, mais le DCA
  //    vaut plus que la proximité du TP).
  // 2) Dans le sous-ensemble retenu, prendre le TP1 le PLUS PROCHE.
  const lo = Math.min(entryPrice, aoiBoundary);
  const hi = Math.max(entryPrice, aoiBoundary);
  const pocsGiveDca = visiblePocs.some((level) =>
    lo <= level && level <= hi && Math.abs(level - entryPrice) / entryPrice >= config.minPocGroupSpacingPct
  );
  const providesDca = (plan: FibonacciPlan): boolean => {
    const deepGp = side === 'LONG' ? plan.gpLow : plan.gpHigh;
    return lo <= deepGp && deepGp <= hi && Math.abs(deepGp - entryPrice) / entryPrice >= config.minPocGroupSpacingPct;
  };
  const withDca = pocsGiveDca ? [] : passing.filter((entry) => providesDca(entry.plan));
  const selectionPool = withDca.length > 0 ? withDca : passing;
  let chosen: typeof passing[number] | undefined;
  let bestTp1Distance = Infinity;
  for (const entry of selectionPool) {
    const distance = Math.abs(entry.plan.targets[0] - entryPrice);
    if (distance < bestTp1Distance) {
      bestTp1Distance = distance;
      chosen = entry;
    }
  }
  if (chosen) {
    diag.push({ timeframeSeconds: chosen.timeframeSeconds, outcome: 'ok', gpLow: chosen.plan.gpLow, gpHigh: chosen.plan.gpHigh, rr: chosen.rr, candidates: chosen.candidates, pool: chosen.pool });
  }
  return { plan: chosen?.plan ?? null, diag };
}

/**
 * Sélection multi-timeframe : on cherche, sur N'IMPORTE quel timeframe de la
 * cascade (du plus haut au plus bas — 4h d'abord pour des targets plus larges),
 * la première fibonacci dont le golden pocket contient le POC d'entrée ET dont
 * le RR jusqu'au TP1 effectif respecte le minimum (AOI → TP1). Les deux
 * conditions font partie de la définition d'un setup valide, peu importe le
 * timeframe d'où vient l'impulsion.
 */
export function selectFibonacci(
  frames: Map<number, Bar[]>,
  asof: number,
  side: 'LONG' | 'SHORT',
  entryPrice: number,
  aoiBoundary: number,
  visiblePocs: number[],
  config: StrategyV2Config
): FibonacciPlan | null {
  return selectFibonacciDiag(frames, asof, side, entryPrice, aoiBoundary, visiblePocs, config).plan;
}

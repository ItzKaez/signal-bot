/**
 * Construction des trade plans — port fidèle de quant-research/strategy.py
 * (plan_trade, _group_levels, _first_poc_in_group, _combine_targets) et
 * déduplication des jumeaux inter-timeframes (30m prioritaire sur 15m).
 */

import type { Side } from './peaks';
import type { FibonacciPlan } from './fib';
import type { PocLevelDetail } from './pocs';
import type { StrategyV2Config } from './config';

export interface TargetEntry {
  price: number;
  fraction: number;
}

export interface TradePlan {
  createdAt: number; // label de clôture de la bougie de confirmation du peak
  peakAt: number; // label de clôture TF de la bougie du peak
  side: Side;
  executionSeconds: number;
  entryLevels: number[];
  aoiPct: number;
  aoiBoundary: number;
  stopImaginary: number;
  divergenceWick: number | null;
  targets: TargetEntry[];
  effectiveTp1: number;
  rrToTp1: number;
  fibonacci: FibonacciPlan;
  entryPoc: number;
  // Métadonnées d'affichage (peaks/AOI/POC) — sans effet sur l'exécution.
  peakRsi: number;
  peakPrice: number;
  aoiDetail: { atr: number; atrPct: number; ratio: number; multiplier: number } | null;
  pocDetail: PocLevelDetail | null;
}

/** Regroupe les niveaux par PORTÉE : un groupe s'étend au maximum
 *  `spacingPct` depuis son premier niveau. (Anciennement par chaîne —
 *  chaque niveau comparé au précédent — ce qui fusionnait un mur de POCs
 *  espacés de <0.5% chacun en UN seul groupe, tuant tous les DCAs.) */
export function groupLevels(levels: number[], spacingPct: number): number[][] {
  const ordered = Array.from(new Set(levels)).sort((a, b) => a - b);
  const groups: number[][] = [];
  let anchor = 0;
  for (const level of ordered) {
    const lastGroup = groups[groups.length - 1];
    if (lastGroup && anchor > 0 && Math.abs(level - anchor) / anchor < spacingPct) {
      lastGroup.push(level);
    } else {
      groups.push([level]);
      anchor = level;
    }
  }
  return groups;
}

export function firstPocInGroup(target: number, entry: number, side: Side, groups: number[][]): number {
  void entry;
  for (const group of groups) {
    const min = Math.min(...group);
    const max = Math.max(...group);
    if (min <= target && target <= max) {
      return side === 'LONG' ? min : max;
    }
  }
  return target;
}

/** Fusionne les fractions au même prix ; ordre = première cible rencontrée par le marché. */
export function combineTargets(targets: TargetEntry[], side: Side): TargetEntry[] {
  const combined = new Map<number, number>();
  for (const target of targets) {
    const key = Math.round(target.price * 1e10) / 1e10;
    combined.set(key, (combined.get(key) ?? 0) + target.fraction);
  }
  return Array.from(combined.entries())
    .map(([price, fraction]) => ({ price, fraction }))
    .sort((a, b) => (side === 'SHORT' ? b.price - a.price : a.price - b.price));
}

/**
 * Étend l'AOI pour englober le(s) groupe(s) de POCs juste après le POC
 * d'entrée : le mouvement vise les POCs (force de retournement), une AOI
 * minuscule qui n'en englobe aucun gaspille le setup — et gonfle
 * artificiellement le RR vers TP1. On traverse les groupes consécutifs
 * au-delà de l'entrée tant que leur bord lointain tient dans le cap
 * (proportionnel à la volatilité) : un mur infini de POCs est coupé au cap,
 * un groupe trop lointain n'étend rien.
 */
export function extendAoiToPocGroups(
  entryPoc: number,
  side: Side,
  visiblePocs: number[],
  basePct: number,
  capPct: number,
  spacingPct: number
): number {
  if (entryPoc <= 0 || capPct <= basePct) return basePct;
  const deeper = visiblePocs.filter((level) => (side === 'LONG' ? level < entryPoc : level > entryPoc));
  if (deeper.length === 0) return basePct;
  const groups = groupLevels(deeper, spacingPct);
  let target = basePct;
  for (const group of groups) {
    const farEdge = side === 'LONG' ? Math.min(...group) : Math.max(...group);
    const farPct = Math.abs(farEdge - entryPoc) / entryPoc;
    if (farPct <= capPct) {
      target = Math.max(target, farPct);
    } else {
      break; // groupe suivant encore plus loin : inutile de continuer
    }
  }
  return Math.min(target, capPct);
}

export interface PlanMetadata {
  peakRsi: number;
  peakPrice: number;
  aoiDetail: { atr: number; atrPct: number; ratio: number; multiplier: number } | null;
  pocDetail: PocLevelDetail | null;
}

/** TP1 effectif : première cible — niveau fib BRUT (0.5), sans rapprochement
 *  sur les groupes de POC (les TPs restent aux niveaux normaux de la fib). */
export function effectiveTp1Price(
  entryPoc: number,
  side: Side,
  fibonacci: FibonacciPlan,
  visiblePocs: number[],
  config: StrategyV2Config
): number {
  void entryPoc; void side; void visiblePocs; void config;
  return fibonacci.targets[0];
}

/** RR jusqu'au TP1 effectif pour une fib donnée (risque = entrée → AOI). */
export function rrForFib(
  entryPoc: number,
  aoiBoundary: number,
  side: Side,
  fibonacci: FibonacciPlan,
  visiblePocs: number[],
  config: StrategyV2Config
): number {
  const tp1 = effectiveTp1Price(entryPoc, side, fibonacci, visiblePocs, config);
  const risk = Math.abs(entryPoc - aoiBoundary);
  const reward = side === 'LONG' ? tp1 - entryPoc : entryPoc - tp1;
  return risk > 0 ? reward / risk : 0;
}

export function planTrade(
  createdAt: number,
  peakAt: number,
  side: Side,
  executionSeconds: number,
  entryPoc: number,
  visiblePocs: number[],
  aoiPct: number,
  fibonacci: FibonacciPlan,
  config: StrategyV2Config,
  metadata: PlanMetadata
): TradePlan | null {
  if (aoiPct <= 0) return null;
  const aoiBoundary = side === 'LONG' ? entryPoc * (1 - aoiPct) : entryPoc * (1 + aoiPct);
  const dcaCandidates: number[] = [];
  if (side === 'LONG') {
    for (const level of visiblePocs) {
      if (aoiBoundary <= level && level <= entryPoc) dcaCandidates.push(level);
    }
  } else {
    for (const level of visiblePocs) {
      if (entryPoc <= level && level <= aoiBoundary) dcaCandidates.push(level);
    }
  }
  dcaCandidates.push(entryPoc);
  const deepGp = side === 'LONG' ? fibonacci.gpLow : fibonacci.gpHigh;
  if (Math.min(entryPoc, aoiBoundary) <= deepGp && deepGp <= Math.max(entryPoc, aoiBoundary)) {
    dcaCandidates.push(deepGp);
  }
  const dcaGroups = groupLevels(dcaCandidates, config.minPocGroupSpacingPct);
  // Le PREMIER niveau est le POC d'entrée (premier ordre rencontré dans un
  // mouvement adverse) : SHORT = entrée la plus basse → tri croissant ;
  // LONG = entrée la plus haute → tri décroissant.
  const entryLevels = dcaGroups.map((group) => (side === 'LONG' ? Math.max(...group) : Math.min(...group)));
  entryLevels.sort((a, b) => (side === 'LONG' ? b - a : a - b));
  // Plafond DCA (0 = illimité, V2) : tronque APRÈS le POC d'entrée — garde
  // les premières limites adverses, drop les plus profondes (rapport ETH :
  // 3+ fills = -882$ cumulés — les DCAs profondes attrapent les couteaux).
  if (config.maxEntryLevels > 0 && entryLevels.length > config.maxEntryLevels) {
    entryLevels.length = config.maxEntryLevels;
  }

  // TPs aux niveaux fib bruts (0.5/0.382/0.236/0) — fractions configurables
  // (V2 = 4×25%) ; une somme < 1 laisse un résidu en runner géré par stops.
  const adjusted = fibonacci.targets.map((price, i) => ({ price, fraction: config.tpFractions[i] ?? 0.25 }));
  // Moonbags : extensions AU-DELÀ du swing dans le sens du trade (même span
  // fib inversé) — 1.618/2.618/... servies par tpFractions[4...].
  const span = fibonacci.swingHigh - fibonacci.swingLow;
  for (let m = 0; m < config.moonbagExtensions.length; m++) {
    const ext = config.moonbagExtensions[m];
    const price = side === 'LONG' ? fibonacci.swingHigh + span * ext : fibonacci.swingLow - span * ext;
    const fraction = config.tpFractions[4 + m] ?? 0;
    if (fraction > 0) adjusted.push({ price, fraction });
  }
  const targets = combineTargets(adjusted, side);
  const effectiveTp1 = effectiveTp1Price(entryPoc, side, fibonacci, visiblePocs, config);
  const risk = Math.abs(entryPoc - aoiBoundary);
  const reward = side === 'LONG' ? effectiveTp1 - entryPoc : entryPoc - effectiveTp1;
  const rr = risk > 0 ? reward / risk : 0;
  if (rr < config.minRrToEffectiveTp1) return null;
  return {
    createdAt,
    peakAt,
    side,
    executionSeconds,
    entryLevels,
    aoiPct,
    aoiBoundary,
    stopImaginary: aoiBoundary,
    divergenceWick: null,
    targets,
    effectiveTp1,
    rrToTp1: rr,
    fibonacci,
    entryPoc,
    peakRsi: metadata.peakRsi,
    peakPrice: metadata.peakPrice,
    aoiDetail: metadata.aoiDetail,
    pocDetail: metadata.pocDetail,
  };
}

/**
 * Jumeaux inter-timeframes : même côté, timeframes différents, peaks à moins
 * d'une barre du timeframe prioritaire (2× base) l'un de l'autre.
 */
export function isTwin(a: TradePlan, b: TradePlan, twinWindowSeconds: number): boolean {
  return a.side === b.side && a.executionSeconds !== b.executionSeconds && Math.abs(a.peakAt - b.peakAt) <= twinWindowSeconds;
}

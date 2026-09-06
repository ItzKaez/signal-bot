/**
 * Calcul des niveaux POC (indicateur MTF POC du chart, EXACT même code que
 * l'app — parité des signaux) pour alimenter engine.setPocLevels.
 *
 * MULTI-SOURCES comme les backtests : chaque source apporte ses daily
 * propres, l'intraday 1h est BYBIT (partagé). Union des niveaux + meta
 * conc/TF « première écriture » dans l'ordre des sources — exactement la
 * fusion de runBacktest (pocByDay union par niveau, metaOut first-write).
 */
import { executeIndicator, mtfPocIndicatorCode, type IndicatorResult } from './engine/indicator-engine';
import type { Candle } from './engine/types';
import type { PocSourceDef } from './sources';

/** Applique des params au code indicateur (version minimale, comme le
 *  script run-backtest — pas d'import du module client). */
export function applyParams(code: string, params: Record<string, string>): string {
  let out = code;
  for (const [key, value] of Object.entries(params)) {
    const re = new RegExp(`(const|let|var)\\s+${key}\\s*=\\s*[^,;\\n]+`, 'i');
    out = out.replace(re, `$1 ${key} = "${value}"`);
  }
  return out;
}

export interface PocSet {
  levels: number[];
  meta: Map<number, { conc: number; tfSec: number }>;
}

/** POCs d'UNE source, calculés sur les données strictement avant `beforeSec`. */
export function computePocLevelsOne(def: PocSourceDef, dailies: Candle[], intraday: Candle[], beforeSec: number): PocSet {
  const code = applyParams(mtfPocIndicatorCode, { SRC_EXCHANGE: def.exchange, SRC_QUOTE: def.quote, SHOW_LABEL: 'false' });
  const dailyIn = dailies.filter((d) => d.time < beforeSec);
  const intraIn = intraday.filter((i) => i.time < beforeSec);
  const res: IndicatorResult = executeIndicator(code, dailyIn, dailyIn, intraIn);
  // 'poc_levels' est émis au runtime par le code MTF POC mais absent de
  // l'union IndicatorShape du harnais — accès par cast contrôlé.
  const shapes = (res.shapes ?? []) as unknown as Array<{ type: string; data?: unknown }>;
  const shape = shapes.find((s) => s.type === 'poc_levels');
  const data = (shape?.data ?? []) as Array<{ price: number; conc?: number; tfSec?: number }>;
  const levels: number[] = [];
  const meta = new Map<number, { conc: number; tfSec: number }>();
  for (const d of data) {
    if (typeof d.price !== 'number' || !Number.isFinite(d.price)) continue;
    levels.push(d.price);
    meta.set(d.price, { conc: d.conc ?? 0, tfSec: d.tfSec ?? 0 });
  }
  return { levels, meta };
}

/** UNION des sources (niveaux dédupliqués, meta première écriture dans
 *  l'ordre de la liste — sémantique de fusion du backtest). */
export function computePocUnion(
  srcs: Array<{ def: PocSourceDef; dailies: Candle[] }>,
  intraday: Candle[],
  beforeSec: number,
): PocSet {
  const merged = new Set<number>();
  const meta = new Map<number, { conc: number; tfSec: number }>();
  for (const { def, dailies } of srcs) {
    if (dailies.length === 0) continue;
    const one = computePocLevelsOne(def, dailies, intraday, beforeSec);
    for (const lvl of one.levels) {
      merged.add(lvl);
      if (!meta.has(lvl)) meta.set(lvl, one.meta.get(lvl)!);
    }
  }
  return { levels: [...merged], meta };
}

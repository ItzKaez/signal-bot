/**
 * Fetch klines Bybit v5 (linear) — pagination bornée + pacing + retry.
 * Le bot vit à côté de l'API Bybit publique : rate limit en fenêtre soutenue
 * (~120 req/min/IP) → pacing explicite entre pages et backoff sur retCode
 * 10003 (Too many visits).
 */
import type { Candle } from './engine/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Code interval Bybit : 1m→"1", 15m→"15", 1h→"60", 4h→"240", 1d→"D".
 *  'D'/'W'/'M' nus (sans chiffre) sont valides — chiffres OPTIONNELS. */
export function bybitInterval(iv: string): string {
  const m = /^(\d*)(m|h|D|W|M)$/.exec(iv);
  if (!m) return '15';
  const n = Number(m[1] || '1');
  if (m[2] === 'm') return String(n);
  if (m[2] === 'h') return String(n * 60);
  return m[2];
}

export function intervalSec(iv: string): number {
  const m = /^(\d*)(m|h|D|W|M)$/.exec(iv);
  if (!m) return 900;
  const n = Number(m[1] || '1');
  return ({ m: 60, h: 3600, D: 86400, W: 604800, M: 2592000 })[m[2]]! * n;
}

export async function fetchKlines(params: {
  symbol: string;
  interval: string;
  limit?: number;
  startSec?: number;
  endSec?: number;
}): Promise<Candle[]> {
  const q = new URLSearchParams({
    category: 'linear',
    symbol: params.symbol,
    interval: bybitInterval(params.interval),
    limit: String(params.limit ?? 1000),
  });
  if (params.startSec !== undefined) q.set('start', String(params.startSec * 1000));
  if (params.endSec !== undefined) q.set('end', String(params.endSec * 1000));
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(`https://api.bybit.com/v5/market/kline?${q}`, {
        headers: { 'User-Agent': 'trading-scope-signal-bot/1.0' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`Bybit HTTP ${res.status}`);
      const json = (await res.json()) as { retCode: number; retMsg: string; result?: { list?: string[][] } };
      if (json.retCode === 10003 && attempt < 5) {
        await sleep(2500 * (attempt + 1));
        continue;
      }
      if (json.retCode !== 0) throw new Error(`Bybit ${json.retMsg}`);
      return (json.result?.list ?? [])
        .map((k) => ({
          time: Math.floor(parseInt(k[0], 10) / 1000),
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
        }))
        .sort((a, b) => a.time - b.time);
    } catch (err) {
      lastErr = err;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw lastErr;
}

/** Plage complète paginée [fromSec, toSec] — tranches explicites, pacing
 *  600 ms par défaut (safe sous la fenêtre soutenue Bybit). */
export async function fetchRange(
  symbol: string,
  interval: string,
  fromSec: number,
  toSec: number,
  paceMs = 600,
): Promise<Candle[]> {
  const step = intervalSec(interval);
  const out: Candle[] = [];
  const seen = new Set<number>();
  const pages = Math.ceil((toSec - fromSec) / step / 1000);
  for (let pg = 0; pg < pages; pg++) {
    const end = toSec - step * 1000 * pg;
    const start = Math.max(toSec - step * 1000 * (pg + 1), fromSec);
    if (end <= fromSec) break;
    const candles = await fetchKlines({ symbol, interval, limit: 1000, startSec: start, endSec: end });
    for (const c of candles) if (!seen.has(c.time)) { seen.add(c.time); out.push(c); }
    if (pg < pages - 1) await sleep(paceMs);
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/** Bougies CLÔTURÉES uniquement (zéro repaint) : la dernière bougie retournée
 *  par Bybit est en formation tant que now < time + step. */
export function closedOnly(candles: Candle[], interval: string, nowSec: number): Candle[] {
  const step = intervalSec(interval);
  return candles.filter((c) => c.time + step <= nowSec);
}

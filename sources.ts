/**
 * Sources POC multi-exchanges — les 7 sources des backtests BTC
 * (BINANCE:USD, BINANCE:USDT.P, BYBIT:USDT.P, OKX:USDT.P, BITFINEX:USD,
 * COINBASE:USD, COINBASE:USDT). Chaque source apporte ses PROPRES bougies
 * daily ; l'intraday 1h reste BYBIT (partagé — même sémantique que la
 * pré-pass du backtest). Une source sans paire listée (ex. BNB hors
 * Bitfinex/Coinbase) est simplement absente de l'union.
 *
 * Parité des quotations avec le route /api/exchange/klines de l'app :
 * le suffixe .P est retiré (BINANCE/OKX n'ont pas de perp sur ces APIs
 * publiques — le route faisait pareil), et BINANCE:USD → USDT (Binance
 * spot n'a pas de paire USD).
 */
import type { Candle } from './engine/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PocSourceDef {
  label: string;   // ex. BINANCE:USD
  exchange: string;
  quote: string;   // brut, ex. USDT.P
}

export function parsePocSources(spec: string): PocSourceDef[] {
  return spec.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).map((label) => {
    const [exchange, quote] = label.split(':');
    return { label, exchange: exchange ?? label, quote: quote ?? 'USDT' };
  });
}

async function getJson(url: string, attempts = 2): Promise<unknown> {
  let lastErr: unknown = null;
  for (let a = 0; a < attempts; a++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'trading-scope-signal-bot/1.0' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await sleep(1200 * (a + 1));
    }
  }
  throw lastErr;
}

/** Bougies DAILY d'une source (~400 derniers jours). [] = paire absente. */
export async function fetchSourceDaily(def: PocSourceDef, base: string, limit = 400): Promise<Candle[]> {
  const bare = def.quote.replace(/\.P$/, '');
  try {
    switch (def.exchange) {
      case 'BYBIT': {
        const category = def.quote.endsWith('.P') ? 'linear' : 'spot';
        const json = await getJson(`https://api.bybit.com/v5/market/kline?category=${category}&symbol=${base}${bare}&interval=D&limit=${limit}`) as { retCode: number; result?: { list?: string[][] } };
        if (json.retCode !== 0) return [];
        return (json.result?.list ?? []).map((k: string[]) => ({
          time: Math.floor(parseInt(k[0], 10) / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
        })).sort((a, b) => a.time - b.time);
      }
      case 'BINANCE': {
        // Spot uniquement ; USD → USDT (pas de spot USD chez Binance).
        const q = bare === 'USD' ? 'USDT' : bare;
        const json = await getJson(`https://api.binance.com/api/v3/klines?symbol=${base}${q}&interval=1d&limit=${limit}`) as unknown[][];
        return json.map((k: unknown[]) => ({
          time: Math.floor(Number(k[0]) / 1000), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]),
        }));
      }
      case 'OKX': {
        // /market/candles plafonne à 300 — c'est aussi ce que recevait le
        // route de l'app (fetchOkx demandait 1000, OKX servait 300).
        const json = await getJson(`https://www.okx.com/api/v5/market/candles?instId=${base}-${bare}&bar=1D&limit=300`) as { code: string; data?: string[][] };
        if (json.code !== '0' || !json.data) return [];
        return json.data.map((k) => ({
          time: Math.floor(parseInt(k[0], 10) / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
        })).sort((a, b) => a.time - b.time);
      }
      case 'BITFINEX': {
        const json = await getJson(`https://api-pub.bitfinex.com/v2/candles/trade:1D:t${base}${bare}/hist?limit=${limit}`) as unknown[][];
        if (!Array.isArray(json)) return [];
        // [MTS, OPEN, CLOSE, HIGH, LOW, VOL] du plus récent au plus ancien.
        return json.map((k) => {
          const r = k as number[];
          return { time: Math.floor(r[0] / 1000), open: r[1], high: r[3], low: r[4], close: r[2], volume: r[5] };
        }).sort((a, b) => a.time - b.time);
      }
      case 'COINBASE': {
        const json = await getJson(`https://api.exchange.coinbase.com/products/${base}-${bare}/candles?granularity=86400`) as number[][];
        if (!Array.isArray(json)) return [];
        // [time, low, high, open, close, volume] du plus récent au plus ancien (max 300).
        return json.map((k) => ({
          time: k[0], open: k[3], high: k[2], low: k[1], close: k[4], volume: k[5],
        })).sort((a, b) => a.time - b.time);
      }
      default:
        console.warn(`[sources] exchange inconnue : ${def.exchange} (${def.label})`);
        return [];
    }
  } catch (err) {
    // Paire absente (404/invalid symbol) ou échec réseau → source absente
    // de l'union pour ce cycle ; pas fatal.
    console.warn(`[sources] ${def.label} ${base} indisponible : ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

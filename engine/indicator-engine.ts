// Custom Indicator Engine - Full featured, like the strategy framework
import type { Candle } from './types';

// === VISUAL TYPES ===

export interface LinePlot {
  type: 'line';
  name: string;
  data: Array<{ time: number; value: number }>;
  color?: string;
  width?: number;
  overlay?: boolean;
  style?: 'solid' | 'dashed' | 'dotted';
  fill?: boolean; // fill area between this and next line (for clouds)
  fillColor?: string;
}

export interface HistogramPlot {
  type: 'histogram';
  name: string;
  data: Array<{ time: number; value: number; color?: string }>;
  overlay?: boolean;
}

export interface BoxShape {
  type: 'box';
  name?: string;
  data: Array<{
    t1: number; // start time
    t2: number; // end time
    p1: number; // top price
    p2: number; // bottom price
    color?: string;
    transparent?: boolean;
  }>;
}

export interface TrendLineShape {
  type: 'trend_line';
  name?: string;
  data: Array<{
    t1: number; // start time
    p1: number; // start price
    t2: number; // end time
    p2: number; // end price
    color?: string;
    width?: number;
    style?: 'solid' | 'dashed' | 'dotted';
  }>;
}

export interface LabelShape {
  type: 'label';
  name?: string;
  data: Array<{
    time: number;
    price: number;
    text: string;
    color?: string;
    size?: number;
    position?: 'above' | 'below' | 'left' | 'right';
    shape?: 'circle' | 'square' | 'diamond' | 'arrow_up' | 'arrow_down' | 'flag' | 'none';
  }>;
}

export interface HLineShape {
  type: 'hline';
  name?: string;
  data: Array<{
    price: number;
    color?: string;
    width?: number;
    style?: 'solid' | 'dashed' | 'dotted';
    text?: string;
  }>;
}

export interface FillBetween {
  type: 'fill';
  name?: string;
  line1: string; // name of first line plot
  line2: string; // name of second line plot
  color: string;
  transparent?: boolean;
}

export type IndicatorPlot = LinePlot | HistogramPlot;
export type IndicatorShape = BoxShape | TrendLineShape | LabelShape | HLineShape;
export type IndicatorFill = FillBetween;

export interface IndicatorResult {
  plots: IndicatorPlot[];
  shapes?: IndicatorShape[];
  fills?: IndicatorFill[];
  error?: string;
}

// === BUILT-IN HELPER FUNCTIONS ===
const indicatorHelpers = `
// === TREND INDICATORS ===
function ema(values, period) {
  const result = new Array(values.length).fill(null);
  if (values.length === 0) return result;
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (values[i] === null || values[i] === undefined || isNaN(values[i])) continue;
    if (prev === null) { prev = values[i]; } 
    else { prev = values[i] * k + prev * (1 - k); }
    result[i] = prev;
  }
  return result;
}

function sma(values, period) {
  const result = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0, count = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (values[j] !== null && values[j] !== undefined && !isNaN(values[j])) { sum += values[j]; count++; }
    }
    if (count === period) result[i] = sum / period;
  }
  return result;
}

function wma(values, period) {
  const result = new Array(values.length).fill(null);
  const weightSum = period * (period + 1) / 2;
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += values[i - period + 1 + j] * (j + 1);
    }
    result[i] = sum / weightSum;
  }
  return result;
}

function hma(values, period) {
  const halfPeriod = Math.max(1, Math.floor(period / 2));
  const sqrtPeriod = Math.max(1, Math.floor(Math.sqrt(period)));
  const wma1 = wma(values, halfPeriod);
  const wma2 = wma(values, period);
  const diff = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    if (wma1[i] !== null && wma2[i] !== null) diff[i] = 2 * wma1[i] - wma2[i];
  }
  return wma(diff, sqrtPeriod);
}

function alma(values, period, offset, sigma) {
  offset = offset || 0.85;
  sigma = sigma || 6;
  const result = new Array(values.length).fill(null);
  const m = offset * (period - 1);
  const s = period / sigma;
  let weightSum = 0;
  const weights = [];
  for (let i = 0; i < period; i++) {
    const w = Math.exp(-((i - m) * (i - m)) / (2 * s * s));
    weights.push(w);
    weightSum += w;
  }
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += values[i - period + 1 + j] * weights[j];
    }
    result[i] = sum / weightSum;
  }
  return result;
}

function dema(values, period) {
  const e1 = ema(values, period);
  const e2 = ema(e1.map(v => v === null ? NaN : v), period);
  const result = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    if (e1[i] !== null && e2[i] !== null) result[i] = 2 * e1[i] - e2[i];
  }
  return result;
}

function tema(values, period) {
  const e1 = ema(values, period);
  const e2 = ema(e1.map(v => v === null ? NaN : v), period);
  const e3 = ema(e2.map(v => v === null ? NaN : v), period);
  const result = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    if (e1[i] !== null && e2[i] !== null && e3[i] !== null) {
      result[i] = 3 * e1[i] - 3 * e2[i] + e3[i];
    }
  }
  return result;
}

// === MOMENTUM INDICATORS ===
function rsi(values, period) {
  const result = new Array(values.length).fill(null);
  if (values.length < period + 1) return result;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) avgGain += change; else avgLoss -= change;
  }
  avgGain /= period; avgLoss /= period;
  if (avgLoss === 0) result[period] = 100;
  else result[period] = 100 - (100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? -change : 0)) / period;
    if (avgLoss === 0) result[i] = 100;
    else result[i] = 100 - (100 / (1 + avgGain / avgLoss));
  }
  return result;
}

function macd(values, fast, slow, signal) {
  fast = fast || 12; slow = slow || 26; signal = signal || 9;
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    if (emaFast[i] !== null && emaSlow[i] !== null) macdLine[i] = emaFast[i] - emaSlow[i];
  }
  const validMacd = macdLine.filter(v => v !== null);
  const signalLine = ema(validMacd, signal);
  const fullSignal = new Array(values.length).fill(null);
  let sigIdx = 0;
  for (let i = 0; i < values.length; i++) {
    if (macdLine[i] !== null) {
      if (sigIdx < signalLine.length && signalLine[sigIdx] !== null) fullSignal[i] = signalLine[sigIdx];
      sigIdx++;
    }
  }
  const histogram = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    if (macdLine[i] !== null && fullSignal[i] !== null) histogram[i] = macdLine[i] - fullSignal[i];
  }
  return { macd: macdLine, signal: fullSignal, histogram };
}

function stochastic(highs, lows, closes, kPeriod, dPeriod) {
  kPeriod = kPeriod || 14; dPeriod = dPeriod || 3;
  const k = new Array(closes.length).fill(null);
  const d = new Array(closes.length).fill(null);
  for (let i = kPeriod - 1; i < closes.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) { if (highs[j] > hh) hh = highs[j]; if (lows[j] < ll) ll = lows[j]; }
    k[i] = hh !== ll ? ((closes[i] - ll) / (hh - ll)) * 100 : 50;
  }
  for (let i = kPeriod + dPeriod - 2; i < closes.length; i++) {
    let sum = 0, count = 0;
    for (let j = i - dPeriod + 1; j <= i; j++) { if (k[j] !== null) { sum += k[j]; count++; } }
    if (count === dPeriod) d[i] = sum / dPeriod;
  }
  return { k, d };
}

function cci(highs, lows, closes, period) {
  period = period || 20;
  const result = new Array(closes.length).fill(null);
  const tp = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
  const tpSma = sma(tp, period);
  for (let i = period - 1; i < closes.length; i++) {
    if (tpSma[i] === null) continue;
    let meanDev = 0;
    for (let j = i - period + 1; j <= i; j++) meanDev += Math.abs(tp[j] - tpSma[i]);
    meanDev /= period;
    result[i] = meanDev !== 0 ? (tp[i] - tpSma[i]) / (0.015 * meanDev) : 0;
  }
  return result;
}

function adx(highs, lows, closes, period) {
  period = period || 14;
  const tr = new Array(closes.length).fill(0);
  const plusDM = new Array(closes.length).fill(0);
  const minusDM = new Array(closes.length).fill(0);
  tr[0] = highs[0] - lows[0];
  for (let i = 1; i < closes.length; i++) {
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
    const upMove = highs[i] - highs[i-1];
    const downMove = lows[i-1] - lows[i];
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }
  const atrVals = ema(tr, period);
  const smoothPlusDM = ema(plusDM, period);
  const smoothMinusDM = ema(minusDM, period);
  const plusDI = new Array(closes.length).fill(null);
  const minusDI = new Array(closes.length).fill(null);
  const dx = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (atrVals[i] !== null && atrVals[i] !== 0) {
      plusDI[i] = (smoothPlusDM[i] / atrVals[i]) * 100;
      minusDI[i] = (smoothMinusDM[i] / atrVals[i]) * 100;
      const sum = plusDI[i] + minusDI[i];
      dx[i] = sum !== 0 ? Math.abs(plusDI[i] - minusDI[i]) / sum * 100 : 0;
    }
  }
  const adxLine = ema(dx.map(v => v === null ? NaN : v), period);
  return { adx: adxLine, plusDI, minusDI };
}

function williams(highs, lows, closes, period) {
  period = period || 14;
  const result = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) { if (highs[j] > hh) hh = highs[j]; if (lows[j] < ll) ll = lows[j]; }
    result[i] = hh !== ll ? ((hh - closes[i]) / (hh - ll)) * -100 : -50;
  }
  return result;
}

// === VOLATILITY INDICATORS ===
function atr(highs, lows, closes, period) {
  const result = new Array(highs.length).fill(null);
  if (highs.length < 2) return result;
  const tr = new Array(highs.length).fill(0);
  tr[0] = highs[0] - lows[0];
  for (let i = 1; i < highs.length; i++) {
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
  }
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  result[period - 1] = sum / period;
  for (let i = period; i < highs.length; i++) {
    result[i] = (result[i-1] * (period - 1) + tr[i]) / period;
  }
  return result;
}

function bollinger(values, period, stdDev) {
  stdDev = stdDev || 2;
  const middle = sma(values, period);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    if (middle[i] === null) continue;
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) sumSq += Math.pow(values[j] - middle[i], 2);
    const sd = Math.sqrt(sumSq / period);
    upper[i] = middle[i] + sd * stdDev;
    lower[i] = middle[i] - sd * stdDev;
  }
  return { upper, middle, lower };
}

function keltner(highs, lows, closes, emaPeriod, atrPeriod, mult) {
  emaPeriod = emaPeriod || 20; atrPeriod = atrPeriod || 10; mult = mult || 1.5;
  const middle = ema(closes, emaPeriod);
  const atrVals = atr(highs, lows, closes, atrPeriod);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (middle[i] !== null && atrVals[i] !== null) {
      upper[i] = middle[i] + mult * atrVals[i];
      lower[i] = middle[i] - mult * atrVals[i];
    }
  }
  return { upper, middle, lower };
}

function donchian(highs, lows, period) {
  period = period || 20;
  const upper = new Array(highs.length).fill(null);
  const lower = new Array(highs.length).fill(null);
  const middle = new Array(highs.length).fill(null);
  for (let i = period - 1; i < highs.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) { if (highs[j] > hh) hh = highs[j]; if (lows[j] < ll) ll = lows[j]; }
    upper[i] = hh; lower[i] = ll; middle[i] = (hh + ll) / 2;
  }
  return { upper, middle, lower };
}

// ATR Trailing Stop (like Supertider without the direction logic)
function superTrend(highs, lows, closes, period, multiplier) {
  period = period || 10; multiplier = multiplier || 3;
  const atrVals = atr(highs, lows, closes, period);
  const trend = new Array(closes.length).fill(1); // 1 = uptrend, -1 = downtrend
  const upperBand = new Array(closes.length).fill(null);
  const lowerBand = new Array(closes.length).fill(null);
  const st = new Array(closes.length).fill(null);
  
  for (let i = period - 1; i < closes.length; i++) {
    if (atrVals[i] === null) continue;
    const hl2 = (highs[i] + lows[i]) / 2;
    const basicUpper = hl2 + multiplier * atrVals[i];
    const basicLower = hl2 - multiplier * atrVals[i];
    
    upperBand[i] = (i > period - 1 && upperBand[i-1] !== null && basicUpper < upperBand[i-1]) || (i > period - 1 && closes[i-1] > upperBand[i-1]) 
      ? basicUpper : (upperBand[i-1] || basicUpper);
    lowerBand[i] = (i > period - 1 && lowerBand[i-1] !== null && basicLower > lowerBand[i-1]) || (i > period - 1 && closes[i-1] < lowerBand[i-1])
      ? basicLower : (lowerBand[i-1] || basicLower);
    
    if (i === period - 1) {
      trend[i] = closes[i] <= upperBand[i] ? -1 : 1;
    } else {
      const prevTrend = trend[i-1];
      if (prevTrend === 1) trend[i] = closes[i] < lowerBand[i] ? -1 : 1;
      else trend[i] = closes[i] > upperBand[i] ? 1 : -1;
    }
    st[i] = trend[i] === 1 ? lowerBand[i] : upperBand[i];
  }
  return { superTrend: st, trend, upperBand, lowerBand };
}

// Ichimoku Cloud
function ichimoku(highs, lows, closes, tenkanPeriod, kijunPeriod, senkouBPeriod, displacement) {
  tenkanPeriod = tenkanPeriod || 9; kijunPeriod = kijunPeriod || 26; senkouBPeriod = senkouBPeriod || 52; displacement = displacement || 26;
  const tenkan = donchian(highs, lows, tenkanPeriod).middle;
  const kijun = donchian(highs, lows, kijunPeriod).middle;
  const senkouA = new Array(closes.length + displacement).fill(null);
  const senkouBFull = donchian(highs, lows, senkouBPeriod).middle;
  
  for (let i = 0; i < closes.length; i++) {
    if (tenkan[i] !== null && kijun[i] !== null) {
      senkouA[i + displacement] = (tenkan[i] + kijun[i]) / 2;
    }
  }
  
  const senkouB = new Array(closes.length + displacement).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (senkouBFull[i] !== null) senkouB[i + displacement] = senkouBFull[i];
  }
  
  const chikou = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length - displacement; i++) chikou[i + displacement] = closes[i];
  
  return { tenkan, kijun, senkouA, senkouB, chikou };
}

// === VOLUME INDICATORS ===
function vwap(closes, volumes, highs, lows) {
  const result = new Array(closes.length).fill(null);
  let cumTP = 0, cumVol = 0;
  for (let i = 0; i < closes.length; i++) {
    cumTP += ((highs[i] + lows[i] + closes[i]) / 3) * volumes[i];
    cumVol += volumes[i];
    if (cumVol > 0) result[i] = cumTP / cumVol;
  }
  return result;
}

function obv(closes, volumes) {
  const result = new Array(closes.length).fill(null);
  result[0] = 0;
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i-1]) result[i] = result[i-1] + volumes[i];
    else if (closes[i] < closes[i-1]) result[i] = result[i-1] - volumes[i];
    else result[i] = result[i-1];
  }
  return result;
}

function mfi(highs, lows, closes, volumes, period) {
  period = period || 14;
  const result = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    let posFlow = 0, negFlow = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const tp = (highs[j] + lows[j] + closes[j]) / 3;
      const prevTP = (highs[j-1] + lows[j-1] + closes[j-1]) / 3;
      const mf = tp * volumes[j];
      if (tp > prevTP) posFlow += mf; else negFlow += mf;
    }
    result[i] = negFlow !== 0 ? 100 - (100 / (1 + posFlow / negFlow)) : 100;
  }
  return result;
}

function cmf(highs, lows, closes, volumes, period) {
  period = period || 20;
  const result = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let sumMFV = 0, sumVol = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const range = highs[j] - lows[j];
      const mfv = range !== 0 ? ((closes[j] - lows[j]) - (highs[j] - closes[j])) / range * volumes[j] : 0;
      sumMFV += mfv; sumVol += volumes[j];
    }
    result[i] = sumVol !== 0 ? sumMFV / sumVol : 0;
  }
  return result;
}

// === PATTERN / STRUCTURE HELPERS ===
function swingHighs(highs, leftBars, rightBars) {
  leftBars = leftBars || 2; rightBars = rightBars || 2;
  const result = new Array(highs.length).fill(null);
  for (let i = leftBars; i < highs.length - rightBars; i++) {
    let isHigh = true;
    for (let j = 1; j <= leftBars; j++) if (highs[i-j] >= highs[i]) { isHigh = false; break; }
    if (isHigh) for (let j = 1; j <= rightBars; j++) if (highs[i+j] >= highs[i]) { isHigh = false; break; }
    if (isHigh) result[i] = highs[i];
  }
  return result;
}

function swingLows(lows, leftBars, rightBars) {
  leftBars = leftBars || 2; rightBars = rightBars || 2;
  const result = new Array(lows.length).fill(null);
  for (let i = leftBars; i < lows.length - rightBars; i++) {
    let isLow = true;
    for (let j = 1; j <= leftBars; j++) if (lows[i-j] <= lows[i]) { isLow = false; break; }
    if (isLow) for (let j = 1; j <= rightBars; j++) if (lows[i+j] <= lows[i]) { isLow = false; break; }
    if (isLow) result[i] = lows[i];
  }
  return result;
}

function pivotPoints(high, low, close) {
  const pp = (high + low + close) / 3;
  return {
    pp,
    r1: 2 * pp - low, s1: 2 * pp - high,
    r2: pp + (high - low), s2: pp - (high - low),
    r3: high + 2 * (pp - low), s3: low - 2 * (high - pp),
  };
}

function fairValueGaps(opens, highs, lows, closes) {
  const fvgs = [];
  for (let i = 2; i < closes.length; i++) {
    // Bullish FVG: candle[i] low > candle[i-2] high
    if (lows[i] > highs[i-2]) {
      fvgs.push({ index: i, type: 'bullish', top: lows[i], bottom: highs[i-2], time: null });
    }
    // Bearish FVG: candle[i] high < candle[i-2] low
    if (highs[i] < lows[i-2]) {
      fvgs.push({ index: i, type: 'bearish', top: lows[i-2], bottom: highs[i], time: null });
    }
  }
  return fvgs;
}

function orderBlocks(opens, highs, lows, closes, lookback) {
  lookback = lookback || 10;
  const blocks = [];
  for (let i = 1; i < closes.length; i++) {
    const isBullish = closes[i] > opens[i];
    const isBearish = closes[i] < opens[i];
    const bodySize = Math.abs(closes[i] - opens[i]);
    const avgBody = closes.slice(Math.max(0, i - lookback), i).reduce((s, c, j, arr) => {
      const o = opens[Math.max(0, i - lookback) + j];
      return s + Math.abs(c - o);
    }, 0) / Math.min(i, lookback);
    
    if (bodySize > avgBody * 1.5) {
      if (isBullish) blocks.push({ index: i, type: 'bullish', top: Math.max(opens[i], closes[i]), bottom: Math.min(opens[i], closes[i]) });
      if (isBearish) blocks.push({ index: i, type: 'bearish', top: Math.max(opens[i], closes[i]), bottom: Math.min(opens[i], closes[i]) });
    }
  }
  return blocks;
}

// === UTILITY FUNCTIONS ===
function crossover(series1, series2, idx) {
  if (idx < 1) return false;
  const s1 = series1[idx], s1p = series1[idx-1], s2 = series2[idx], s2p = series2[idx-1];
  if (s1 === null || s1p === null || s2 === null || s2p === null) return false;
  return s1 > s2 && s1p <= s2p;
}

function crossunder(series1, series2, idx) {
  if (idx < 1) return false;
  const s1 = series1[idx], s1p = series1[idx-1], s2 = series2[idx], s2p = series2[idx-1];
  if (s1 === null || s1p === null || s2 === null || s2p === null) return false;
  return s1 < s2 && s1p >= s2p;
}

function highest(values, period, idx) {
  if (idx < period - 1) return null;
  let max = -Infinity;
  for (let i = idx - period + 1; i <= idx; i++) if (values[i] !== null && values[i] > max) max = values[i];
  return max === -Infinity ? null : max;
}

function lowest(values, period, idx) {
  if (idx < period - 1) return null;
  let min = Infinity;
  for (let i = idx - period + 1; i <= idx; i++) if (values[i] !== null && values[i] < min) min = values[i];
  return min === Infinity ? null : min;
}

function change(values, idx) {
  if (idx < 1 || values[idx] === null || values[idx-1] === null) return null;
  return values[idx] - values[idx-1];
}

function percentChange(values, idx) {
  if (idx < 1 || values[idx] === null || values[idx-1] === null || values[idx-1] === 0) return null;
  return ((values[idx] - values[idx-1]) / values[idx-1]) * 100;
}

function nz(value, fallback) {
  return (value === null || value === undefined || isNaN(value)) ? (fallback || 0) : value;
}

function barssince(conditionArray) {
  const result = new Array(conditionArray.length).fill(null);
  let lastTrue = -1;
  for (let i = 0; i < conditionArray.length; i++) {
    if (conditionArray[i]) lastTrue = i;
    result[i] = lastTrue >= 0 ? i - lastTrue : null;
  }
  return result;
}

function valuewhen(conditionArray, sourceArray, occurrence) {
  occurrence = occurrence || 0;
  const result = new Array(conditionArray.length).fill(null);
  for (let i = 0; i < conditionArray.length; i++) {
    let count = 0;
    for (let j = i; j >= 0; j--) {
      if (conditionArray[j]) {
        if (count === occurrence) { result[i] = sourceArray[j]; break; }
        count++;
      }
    }
  }
  return result;
}

// === ADDITIONAL TRADINGVIEW-STYLE HELPERS ===

// Parabolic SAR
function psar(highs, lows, startAF, maxAF) {
  startAF = startAF || 0.02; maxAF = maxAF || 0.2;
  const result = new Array(highs.length).fill(null);
  if (highs.length < 2) return result;
  let trend = 1; // 1 = up, -1 = down
  let af = startAF;
  let ep = highs[0];
  let sar = lows[0];
  result[0] = sar;
  for (let i = 1; i < highs.length; i++) {
    sar = sar + af * (ep - sar);
    if (trend === 1) {
      sar = Math.min(sar, lows[i-1], i >= 2 ? lows[i-2] : lows[i-1]);
      if (lows[i] < sar) { trend = -1; sar = ep; ep = lows[i]; af = startAF; }
      else { if (highs[i] > ep) { ep = highs[i]; af = Math.min(af + startAF, maxAF); } }
    } else {
      sar = Math.max(sar, highs[i-1], i >= 2 ? highs[i-2] : highs[i-1]);
      if (highs[i] > sar) { trend = 1; sar = ep; ep = highs[i]; af = startAF; }
      else { if (lows[i] < ep) { ep = lows[i]; af = Math.min(af + startAF, maxAF); } }
    }
    result[i] = sar;
  }
  return result;
}

// Heikin Ashi candles
function heikinAshi(opens, highs, lows, closes) {
  const haOpen = new Array(closes.length).fill(null);
  const haClose = new Array(closes.length).fill(null);
  const haHigh = new Array(closes.length).fill(null);
  const haLow = new Array(closes.length).fill(null);
  haClose[0] = (opens[0] + highs[0] + lows[0] + closes[0]) / 4;
  haOpen[0] = (opens[0] + closes[0]) / 2;
  haHigh[0] = Math.max(highs[0], haOpen[0], haClose[0]);
  haLow[0] = Math.min(lows[0], haOpen[0], haClose[0]);
  for (let i = 1; i < closes.length; i++) {
    haClose[i] = (opens[i] + highs[i] + lows[i] + closes[i]) / 4;
    haOpen[i] = (haOpen[i-1] + haClose[i-1]) / 2;
    haHigh[i] = Math.max(highs[i], haOpen[i], haClose[i]);
    haLow[i] = Math.min(lows[i], haOpen[i], haClose[i]);
  }
  return { open: haOpen, high: haHigh, low: haLow, close: haClose };
}

// ZigZag (returns pivot points)
function zigzag(highs, lows, closes, deviation) {
  deviation = deviation || 5;
  const devThresh = deviation / 100;
  const pivots = [];
  let lastPivotIdx = 0;
  let lastPivotPrice = closes[0];
  let lastPivotType = 'high';
  let currentHigh = highs[0], currentLow = lows[0];
  let currentHighIdx = 0, currentLowIdx = 0;
  for (let i = 1; i < closes.length; i++) {
    if (highs[i] > currentHigh) { currentHigh = highs[i]; currentHighIdx = i; }
    if (lows[i] < currentLow) { currentLow = lows[i]; currentLowIdx = i; }
    if (lastPivotType === 'low') {
      if (currentHigh / lastPivotPrice - 1 >= devThresh) {
        pivots.push({ index: currentLowIdx, price: currentLow, type: 'low' });
        lastPivotPrice = currentHigh;
        lastPivotIdx = currentHighIdx;
        lastPivotType = 'high';
        currentLow = lows[i]; currentLowIdx = i;
      }
    } else {
      if (1 - currentLow / lastPivotPrice >= devThresh) {
        pivots.push({ index: currentHighIdx, price: currentHigh, type: 'high' });
        lastPivotPrice = currentLow;
        lastPivotIdx = currentLowIdx;
        lastPivotType = 'low';
        currentHigh = highs[i]; currentHighIdx = i;
      }
    }
  }
  return pivots;
}

// Linear Regression
function linReg(values, period) {
  const result = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let j = 0; j < period; j++) {
      const val = values[i - period + 1 + j];
      if (val === null || val === undefined) { sumY = NaN; break; }
      sumX += j; sumY += val; sumXY += j * val; sumX2 += j * j;
    }
    if (!isNaN(sumY)) result[i] = sumY / period + (((period - 1) * sumXY - sumX * sumY) / (period * sumX2 - sumX * sumX)) * ((period - 1) / 2);
  }
  return result;
}

// Rate of Change
function roc(values, period) {
  period = period || 12;
  const result = new Array(values.length).fill(null);
  for (let i = period; i < values.length; i++) {
    if (values[i] !== null && values[i - period] !== null && values[i - period] !== 0)
      result[i] = ((values[i] - values[i - period]) / values[i - period]) * 100;
  }
  return result;
}

// Momentum
function momentum(values, period) {
  period = period || 10;
  const result = new Array(values.length).fill(null);
  for (let i = period; i < values.length; i++) {
    if (values[i] !== null && values[i - period] !== null)
      result[i] = values[i] - values[i - period];
  }
  return result;
}

// True Strength Index
function tsi(values, longPeriod, shortPeriod) {
  longPeriod = longPeriod || 25; shortPeriod = shortPeriod || 13;
  const changes = new Array(values.length).fill(null);
  for (let i = 1; i < values.length; i++) changes[i] = values[i] - values[i-1];
  const doubleSmoothed = (arr, p1, p2) => ema(ema(arr.map(v => v === null ? NaN : v), p1).map(v => v === null ? NaN : v), p2);
  const dsChanges = doubleSmoothed(changes, longPeriod, shortPeriod);
  const absChanges = changes.map(v => v === null ? null : Math.abs(v));
  const dsAbsChanges = doubleSmoothed(absChanges, longPeriod, shortPeriod);
  const result = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    if (dsChanges[i] !== null && dsAbsChanges[i] !== null && dsAbsChanges[i] !== 0)
      result[i] = (dsChanges[i] / dsAbsChanges[i]) * 100;
  }
  return result;
}

// Ultimate Oscillator
function ultimateOscillator(highs, lows, closes, p1, p2, p3) {
  p1 = p1 || 7; p2 = p2 || 14; p3 = p3 || 28;
  const bp = new Array(closes.length).fill(null);
  const tr = new Array(closes.length).fill(null);
  bp[0] = closes[0] - lows[0]; tr[0] = highs[0] - lows[0];
  for (let i = 1; i < closes.length; i++) {
    bp[i] = closes[i] - Math.min(lows[i], closes[i-1]);
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
  }
  const sumBP = (arr, period, endIdx) => { let s = 0; for (let i = endIdx - period + 1; i <= endIdx; i++) s += (arr[i] || 0); return s; };
  const result = new Array(closes.length).fill(null);
  for (let i = p3 - 1; i < closes.length; i++) {
    const bp1 = sumBP(bp, p1, i), bp2 = sumBP(bp, p2, i), bp3 = sumBP(bp, p3, i);
    const tr1 = sumBP(tr, p1, i), tr2 = sumBP(tr, p2, i), tr3 = sumBP(tr, p3, i);
    if (tr1 + tr2 + tr3 !== 0) result[i] = 100 * (4*bp1/tr1 + 2*bp2/tr2 + bp3/tr3) / (4+2+1);
  }
  return result;
}

// Standard Deviation
function stddev(values, period) {
  const result = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0, count = 0;
    for (let j = i - period + 1; j <= i; j++) { if (values[j] !== null) { sum += values[j]; count++; } }
    if (count < period) continue;
    const mean = sum / count;
    let sqSum = 0;
    for (let j = i - period + 1; j <= i; j++) if (values[j] !== null) sqSum += (values[j] - mean) ** 2;
    result[i] = Math.sqrt(sqSum / count);
  }
  return result;
}

// Pearson Correlation
function correlation(x, y, period) {
  const result = new Array(x.length).fill(null);
  for (let i = period - 1; i < x.length; i++) {
    let sx = 0, sy = 0, sxy = 0, sx2 = 0, sy2 = 0, n = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (x[j] !== null && y[j] !== null) {
        sx += x[j]; sy += y[j]; sxy += x[j]*y[j]; sx2 += x[j]*x[j]; sy2 += y[j]*y[j]; n++;
      }
    }
    if (n >= period) {
      const denom = Math.sqrt((n*sx2-sx*sx)*(n*sy2-sy*sy));
      result[i] = denom !== 0 ? (n*sxy-sx*sy) / denom : 0;
    }
  }
  return result;
}

// TTM Squeeze detection (Bollinger inside Keltner = squeeze)
function squeeze(highs, lows, closes, bbPeriod, bbStd, keltnerPeriod, keltnerMult) {
  bbPeriod = bbPeriod || 20; bbStd = bbStd || 2; keltnerPeriod = keltnerPeriod || 20; keltnerMult = keltnerMult || 1.5;
  const bb = bollinger(closes, bbPeriod, bbStd);
  const kelt = keltner(highs, lows, closes, keltnerPeriod, 10, keltnerMult);
  const sqzOn = new Array(closes.length).fill(false);
  const sqzOff = new Array(closes.length).fill(false);
  const momentum = new Array(closes.length).fill(null);
  const lr = linReg(closes, bbPeriod);
  for (let i = 0; i < closes.length; i++) {
    if (bb.lower[i] !== null && kelt.lower[i] !== null) {
      sqzOn[i] = bb.lower[i] >= kelt.lower[i] && bb.upper[i] <= kelt.upper[i];
      sqzOff[i] = bb.lower[i] < kelt.lower[i] && bb.upper[i] > kelt.upper[i];
    }
    if (lr[i] !== null) momentum[i] = closes[i] - lr[i];
  }
  return { sqzOn, sqzOff, momentum, bbUpper: bb.upper, bbLower: bb.lower, keltnerUpper: kelt.upper, keltnerLower: kelt.lower };
}

// EMA Ribbon (multiple EMAs)
function ribbon(closes, startPeriod, endPeriod, step) {
  startPeriod = startPeriod || 10; endPeriod = endPeriod || 50; step = step || 5;
  const emas = [];
  for (let p = startPeriod; p <= endPeriod; p += step) {
    emas.push({ period: p, values: ema(closes, p) });
  }
  return emas;
}

// Choppiness Index
function choppiness(highs, lows, closes, period) {
  period = period || 14;
  const atrVals = atr(highs, lows, closes, 1);
  const result = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let sumATR = 0;
    for (let j = i - period + 1; j <= i; j++) sumATR += (atrVals[j] || 0);
    let hh = -Infinity, ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) { if (highs[j] > hh) hh = highs[j]; if (lows[j] < ll) ll = lows[j]; }
    if (sumATR > 0 && hh !== ll) result[i] = 100 * Math.log(sumATR / (hh - ll)) / Math.log(period);
  }
  return result;
}
`;

/**
 * Execute custom indicator code on candle data
 */
export const fvdbIndicatorCode = `// FVDB (Funding, Volume, Daily Bias) by Danz
// overlay: true

function calculate(c) {
  const AOI_METHOD     = "Body Avg x2 (original)";
  const N_BARS         = 6;
  const ATR_LENGTH     = 14;
  const ATR_MULT       = 1.5;
  const PERCENTILE_LEN = 20;
  const SHOW_SESSIONS  = true;
  const SHOW_FUTURE    = true;
  const SHOW_ASIA      = true;
  const SHOW_LONDON    = true;
  const SHOW_NY        = true;
  const ASIA_COLOR     = 'rgba(240, 192, 64, 0.4)';
  const LONDON_COLOR   = 'rgba(77, 166, 255, 0.4)';
  const NY_COLOR       = 'rgba(255, 96, 96, 0.4)';

  // AOI CALCULATION
  function calcBodyAvg() {
    let s = 0;
    for (let i = 1; i <= N_BARS && i < c.length; i++) s += Math.abs(c.close[i] - c.open[i]) / c.open[i] * 100;
    return (s / N_BARS) * 2.0;
  }
  function calcAtrNorm() {
    const a = atr(c.high, c.low, c.close, ATR_LENGTH);
    return (a[a.length - 1] || 0) / c.close[c.length - 1] * 100 * ATR_MULT;
  }
  function calcAtrAdaptive() {
    const a = atr(c.high, c.low, c.close, ATR_LENGTH);
    const lastAtr = a[a.length - 1] || 0;
    let sma = 0, cnt = 0;
    for (let i = 0; i < 50 && i < a.length; i++) if (!isNaN(a[a.length-1-i])) { sma += a[a.length-1-i]; cnt++; }
    sma = cnt > 0 ? sma/cnt : lastAtr;
    const ratio = sma > 0 ? lastAtr/sma : 1;
    const mult = Math.max(1, Math.min(3, ratio*1.5));
    return lastAtr / c.close[c.length-1] * 100 * mult;
  }
  function calcPercentile() {
    const r = [];
    for (let i = 1; i <= PERCENTILE_LEN && i < c.length; i++) r.push(c.high[i]-c.low[i]);
    r.sort((a,b)=>a-b);
    const idx = Math.min(Math.round(PERCENTILE_LEN*0.75), r.length-1);
    return (r[idx]||0) / c.close[c.length-1] * 100;
  }
  function calcVolWeighted() {
    let sw=0, sb=0;
    for (let i = 1; i <= N_BARS && i < c.length; i++) { const w=c.volume[i]||0; sw+=w; sb+=Math.abs(c.close[i]-c.open[i])/c.open[i]*100*w; }
    return sw > 0 ? (sb/sw)*2.0 : 0;
  }
  function calcSigma() {
    const ret = [];
    for (let i = 1; i <= PERCENTILE_LEN && i < c.length; i++) { const r = c.close[i+1]!==0 ? Math.abs(c.close[i]-c.close[i+1])/c.close[i+1]*100 : 0; ret.push(r); }
    const mu = ret.reduce((a,b)=>a+b,0)/ret.length;
    const v = ret.reduce((s,r)=>s+Math.pow(r-mu,2),0)/ret.length;
    return mu + Math.sqrt(v);
  }
  let aoiResult = 0;
  if (AOI_METHOD === "ATR normalise") aoiResult = calcAtrNorm();
  else if (AOI_METHOD === "ATR adaptatif") aoiResult = calcAtrAdaptive();
  else if (AOI_METHOD === "Percentile P75") aoiResult = calcPercentile();
  else if (AOI_METHOD === "Volume-weighted body") aoiResult = calcVolWeighted();
  else if (AOI_METHOD === "Ecart-type (1sigma)") aoiResult = calcSigma();
  else aoiResult = calcBodyAvg();

  // Volume 24h - sum of (close * volume) for each bar in the last 24h
  // This gives the real quote volume (USDT) like TradingView
  const tfSec = c.length > 1 ? c.time[1] - c.time[0] : 3600;
  const barsIn24h = Math.max(1, Math.round(86400 / tfSec));
  let vol24hQuote = 0;
  for (let i = 0; i < barsIn24h && i < c.length; i++) {
    const idx = c.length - 1 - i;
    vol24hQuote += (c.close[idx] || 0) * (c.volume[idx] || 0);
  }

  function formatVol(v) {
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(2) + 'K';
    return v.toFixed(2);
  }

  // Daily Bias
  const lastTime = c.time[c.length - 1] * 1000;
  const lastDate = new Date(lastTime);
  const pineDow = lastDate.getUTCDay() + 1;
  const dayNames = ['', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const biasMap = { 2:'profit', 3:'long', 4:'profit', 5:'short', 6:'long', 7:'profit', 1:'short' };
  const currentBias = biasMap[pineDow] || 'profit';
  const currentDayName = dayNames[pineDow] || '';

  // Session Lines
  const sessionLines = [];
  const labels = [];
  for (let i = 0; i < c.length; i++) {
    const t = c.time[i] * 1000;
    const d = new Date(t);
    const h = d.getUTCHours();
    const m = d.getUTCMinutes();
    if (SHOW_SESSIONS && h === 0 && m === 0 && SHOW_ASIA) {
      sessionLines.push({ t1: c.time[i], p1: c.low[i], t2: c.time[i], p2: c.high[i], color: ASIA_COLOR, width: 1, style: 'dashed' });
      labels.push({ time: c.time[i], price: c.high[i], text: 'Asia', color: ASIA_COLOR });
    }
    if (SHOW_SESSIONS && h === 7 && m === 0 && SHOW_LONDON) {
      sessionLines.push({ t1: c.time[i], p1: c.low[i], t2: c.time[i], p2: c.high[i], color: LONDON_COLOR, width: 1, style: 'dashed' });
      labels.push({ time: c.time[i], price: c.high[i], text: 'London', color: LONDON_COLOR });
    }
    if (SHOW_SESSIONS && h === 13 && m === 0 && SHOW_NY) {
      sessionLines.push({ t1: c.time[i], p1: c.low[i], t2: c.time[i], p2: c.high[i], color: NY_COLOR, width: 1, style: 'dashed' });
      labels.push({ time: c.time[i], price: c.high[i], text: 'NY', color: NY_COLOR });
    }
  }

  // Future session
  if (SHOW_SESSIONS && SHOW_FUTURE && c.length > 0) {
    const lastD = new Date(c.time[c.length - 1] * 1000);
    const curMin = lastD.getUTCHours() * 60 + lastD.getUTCMinutes();
    const isNextLondon = curMin < 420;
    const isNextNY = !isNextLondon && curMin < 780;
    const delta = isNextLondon ? 420 - curMin : isNextNY ? 780 - curMin : (1440 - curMin);
    const ft = c.time[c.length - 1] + (delta * 60);
    const fc = isNextLondon ? LONDON_COLOR : isNextNY ? NY_COLOR : ASIA_COLOR;
    const fl = isNextLondon ? 'London (next)' : isNextNY ? 'NY (next)' : 'Asia (next)';
    sessionLines.push({ t1: ft, p1: c.low[c.length-1], t2: ft, p2: c.high[c.length-1], color: fc, width: 1, style: 'dashed' });
    labels.push({ time: ft, price: c.high[c.length-1], text: fl, color: fc });
  }

  // Info labels
  const lastBar = c.time[c.length - 1];
  const lastPrice = c.close[c.length - 1];
  const off = lastPrice * 0.01;
  labels.push({ time: lastBar, price: lastPrice + off * 4, text: 'AOI: ' + aoiResult.toFixed(2) + '%', color: '#FFD700' });
  labels.push({ time: lastBar, price: lastPrice + off * 3, text: 'Vol 24h: ' + formatVol(vol24hQuote), color: '#ffffff' });
  labels.push({ time: lastBar, price: lastPrice + off * 2, text: currentDayName + ': ' + currentBias, color: currentBias === 'long' ? '#3fb950' : currentBias === 'short' ? '#f85149' : '#ffa500' });

  return {
    plots: [],
    shapes: [
      { type: 'trend_line', name: 'Session Lines', data: sessionLines },
      { type: 'label', name: 'Session Labels', data: labels },
    ],
  };
}`;

export function executeIndicator(
  code: string,
  candles: Candle[],
  dailyCandles?: Candle[],
  intradayCandles?: Candle[],
  aggTradePocs?: Record<string, number>
): IndicatorResult {
  if (!candles || candles.length === 0) {
    return { plots: [], error: 'No candle data available' };
  }

  try {
    const times = candles.map(c => c.time);
    const opens = candles.map(c => c.open);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);

    // Si dailyCandles est fourni, on prépare les arrays daily
    // L'indicateur peut alors utiliser `daily` au lieu de `c` pour calculer sur des bougies 1D
    const hasDaily = !!(dailyCandles && dailyCandles.length > 0);
    const dailyTimes = hasDaily ? dailyCandles!.map(c => c.time) : [];
    const dailyOpens = hasDaily ? dailyCandles!.map(c => c.open) : [];
    const dailyHighs = hasDaily ? dailyCandles!.map(c => c.high) : [];
    const dailyLows = hasDaily ? dailyCandles!.map(c => c.low) : [];
    const dailyCloses = hasDaily ? dailyCandles!.map(c => c.close) : [];
    const dailyVolumes = hasDaily ? dailyCandles!.map(c => c.volume) : [];
    const dailyLength = dailyCloses.length;

    // Si intradayCandles est fourni (ex: 15m), on le passe à l'indicateur
    // pour reconstruire le POC 1D à partir de données intraday
    const hasIntraday = !!(intradayCandles && intradayCandles.length > 0);
    const intradayTimes = hasIntraday ? intradayCandles!.map(c => c.time) : [];
    const intradayOpens = hasIntraday ? intradayCandles!.map(c => c.open) : [];
    const intradayHighs = hasIntraday ? intradayCandles!.map(c => c.high) : [];
    const intradayLows = hasIntraday ? intradayCandles!.map(c => c.low) : [];
    const intradayCloses = hasIntraday ? intradayCandles!.map(c => c.close) : [];
    const intradayVolumes = hasIntraday ? intradayCandles!.map(c => c.volume) : [];
    const intradayLength = intradayCloses.length;

    const fullCode = `
      ${indicatorHelpers}
      ${code}
      return calculate({
        time: times, open: opens, high: highs, low: lows, close: closes, volume: volumes,
        length: closes.length,
        daily: {
          time: dailyTimes, open: dailyOpens, high: dailyHighs, low: dailyLows,
          close: dailyCloses, volume: dailyVolumes, length: dailyLength
        },
        intraday: {
          time: intradayTimes, open: intradayOpens, high: intradayHighs, low: intradayLows,
          close: intradayCloses, volume: intradayVolumes, length: intradayLength
        },
        aggTradePocs: aggTradePocs || {}
      });
    `;

    const fn = new Function(
      'times', 'opens', 'highs', 'lows', 'closes', 'volumes',
      'dailyTimes', 'dailyOpens', 'dailyHighs', 'dailyLows', 'dailyCloses', 'dailyVolumes', 'dailyLength',
      'intradayTimes', 'intradayOpens', 'intradayHighs', 'intradayLows', 'intradayCloses', 'intradayVolumes', 'intradayLength',
      'aggTradePocs',
      fullCode
    );
    const result = fn(
      times, opens, highs, lows, closes, volumes,
      dailyTimes, dailyOpens, dailyHighs, dailyLows, dailyCloses, dailyVolumes, dailyLength,
      intradayTimes, intradayOpens, intradayHighs, intradayLows, intradayCloses, intradayVolumes, intradayLength,
      aggTradePocs || {}
    );

    if (!result) {
      return { plots: [], error: 'Indicator must return an object with plots, shapes, and/or fills' };
    }

    // Normalize plots
    const plots: IndicatorPlot[] = (result.plots || [])
      .filter((p: any) => p && p.data && Array.isArray(p.data))
      .map((p: any) => {
        const plotType = p.type || 'line';
        if (plotType === 'histogram') {
          return {
            type: 'histogram' as const,
            name: p.name || 'Histogram',
            data: p.data.filter((d: any) => d && d.time != null && d.value != null && !isNaN(d.value))
              .map((d: any) => ({ time: d.time, value: d.value, color: d.color })),
            overlay: p.overlay || false,
          } as HistogramPlot;
        }
        return {
          type: 'line' as const,
          name: p.name || 'Unnamed',
          data: p.data.filter((d: any) => d && d.time != null && d.value != null && !isNaN(d.value))
            .sort((a: any, b: any) => a.time - b.time),
          color: p.color || '#58a6ff',
          width: p.width || 2,
          overlay: p.overlay !== false,
          style: p.style || 'solid',
          fill: p.fill || false,
          fillColor: p.fillColor,
        } as LinePlot;
      });

    // Normalize shapes
    const shapes: IndicatorShape[] = (result.shapes || [])
      .filter((s: any) => s && s.data && Array.isArray(s.data))
      .map((s: any) => {
        if (s.type === 'box') return { type: 'box', name: s.name, data: s.data } as BoxShape;
        if (s.type === 'trend_line') return { type: 'trend_line', name: s.name, data: s.data } as TrendLineShape;
        if (s.type === 'label') return { type: 'label', name: s.name, data: s.data } as LabelShape;
        if (s.type === 'hline') return { type: 'hline', name: s.name, data: s.data } as HLineShape;
        if (s.type === 'poc_levels') return { type: 'poc_levels', name: s.name, data: s.data } as any;
        return null;
      })
      .filter(Boolean) as IndicatorShape[];

    // Normalize fills
    const fills: IndicatorFill[] = (result.fills || [])
      .filter((f: any) => f && f.line1 && f.line2)
      .map((f: any) => ({
        type: 'fill',
        name: f.name,
        line1: f.line1,
        line2: f.line2,
        color: f.color || 'rgba(88, 166, 255, 0.1)',
        transparent: f.transparent !== false,
      }));

    return { plots, shapes, fills };
  } catch (error: any) {
    return { plots: [], error: error.message || 'Failed to execute indicator' };
  }
}

// === PRESET INDICATORS ===

export const defaultIndicatorCode = `// EMA 20 - Simple overlay line
function calculate(c) {
  const e = ema(c.close, 20);
  const data = [];
  for (let i = 0; i < c.length; i++)
    if (e[i] !== null) data.push({ time: c.time[i], value: e[i] });
  return { plots: [{ name: 'EMA 20', data, color: '#2196F3', width: 2 }] };
}`;

export const emaCrossIndicatorCode = `// EMA Crossover with fill cloud
function calculate(c) {
  const fast = ema(c.close, 9);
  const slow = ema(c.close, 21);
  const fastData = [], slowData = [];
  for (let i = 0; i < c.length; i++) {
    if (fast[i] !== null) fastData.push({ time: c.time[i], value: fast[i] });
    if (slow[i] !== null) slowData.push({ time: c.time[i], value: slow[i] });
  }
  return {
    plots: [
      { name: 'EMA 9', data: fastData, color: '#2196F3', width: 2 },
      { name: 'EMA 21', data: slowData, color: '#FF9800', width: 2 },
    ],
    fills: [
      { line1: 'EMA 9', line2: 'EMA 21', color: 'rgba(33, 150, 243, 0.08)' }
    ]
  };
}`;

export const bollingerIndicatorCode = `// Bollinger Bands with fill
function calculate(c) {
  const bb = bollinger(c.close, 20, 2);
  const upper = [], middle = [], lower = [];
  for (let i = 0; i < c.length; i++) {
    if (bb.upper[i] !== null) upper.push({ time: c.time[i], value: bb.upper[i] });
    if (bb.middle[i] !== null) middle.push({ time: c.time[i], value: bb.middle[i] });
    if (bb.lower[i] !== null) lower.push({ time: c.time[i], value: bb.lower[i] });
  }
  return {
    plots: [
      { name: 'BB Upper', data: upper, color: '#9C27B0', width: 1 },
      { name: 'BB Middle', data: middle, color: '#9C27B0', width: 1, style: 'dashed' },
      { name: 'BB Lower', data: lower, color: '#9C27B0', width: 1 },
    ],
    fills: [
      { line1: 'BB Upper', line2: 'BB Lower', color: 'rgba(156, 39, 176, 0.06)' }
    ]
  };
}`;

// @param period number 14 Période RSI [max:100]
// @param src select [close,open,high,low,hl2,hlc3,ohlc4] close Source
// @param obLevel number 70 Niveau surachat [max:100]
// @param osLevel number 30 Niveau survente [max:100]
// @param colorRSI color #E91E63 Couleur RSI
export const rsiIndicatorCode = `// RSI Style TradingView — sur sa propre échelle avec OB/OS
function calculate(c) {
  const period   = 14;
  const srcType  = 'close';
  const obLevel  = 70;
  const osLevel  = 30;
  const colorRSI = '#E91E63';

  let src;
  if (srcType === 'close') src = c.close;
  else if (srcType === 'open') src = c.open;
  else if (srcType === 'high') src = c.high;
  else if (srcType === 'low') src = c.low;
  else if (srcType === 'hl2') src = c.high.map((h, i) => (h + c.low[i]) / 2);
  else if (srcType === 'hlc3') src = c.high.map((h, i) => (h + c.low[i] + c.close[i]) / 3);
  else if (srcType === 'ohlc4') src = c.high.map((h, i) => (h + c.low[i] + c.open[i] + c.close[i]) / 4);
  else src = c.close;

  const r = rsi(src, period);

  const rsiData = [], obData = [], osData = [], midData = [];
  for (let i = 0; i < c.length; i++) {
    const t = c.time[i];
    if (r[i] !== null) rsiData.push({ time: t, value: r[i] });
    obData.push({ time: t, value: obLevel });
    osData.push({ time: t, value: osLevel });
    midData.push({ time: t, value: 50 });
  }

  return {
    plots: [
      { name: 'RSI', data: rsiData, color: colorRSI, width: 1, overlay: false },
      { name: 'OB', data: obData, color: 'rgba(248,81,73,0.4)', width: 1, style: 'dashed', overlay: false },
      { name: 'OS', data: osData, color: 'rgba(63,185,80,0.4)', width: 1, style: 'dashed', overlay: false },
      { name: 'MID', data: midData, color: 'rgba(139,148,158,0.25)', width: 1, style: 'dotted', overlay: false },
    ],
    fills: [
      { line1: 'RSI', line2: 'OB', color: 'rgba(248,81,73,0.08)' },
      { line1: 'RSI', line2: 'OS', color: 'rgba(63,185,80,0.08)' },
    ]
  };
}`;

export const macdIndicatorCode = `// MACD with histogram
function calculate(c) {
  const m = macd(c.close, 12, 26, 9);
  const macdData = [], signalData = [], histData = [];
  for (let i = 0; i < c.length; i++) {
    if (m.macd[i] !== null) macdData.push({ time: c.time[i], value: m.macd[i] });
    if (m.signal[i] !== null) signalData.push({ time: c.time[i], value: m.signal[i] });
    if (m.histogram[i] !== null) histData.push({
      time: c.time[i], value: m.histogram[i],
      color: m.histogram[i] >= 0 ? 'rgba(63, 185, 80, 0.6)' : 'rgba(248, 81, 73, 0.6)'
    });
  }
  return {
    plots: [
      { name: 'MACD', data: macdData, color: '#2196F3', width: 2, overlay: false },
      { name: 'Signal', data: signalData, color: '#FF9800', width: 1, overlay: false },
      { name: 'Histogram', data: histData, type: 'histogram', overlay: false },
    ],
    shapes: [
      { type: 'hline', data: [{ price: 0, color: '#30363d', style: 'dotted' }] }
    ]
  };
}`;

export const supertrendIndicatorCode = `// Supertrend
function calculate(c) {
  const st = superTrend(c.high, c.low, c.close, 10, 3);
  const data = [];
  for (let i = 0; i < c.length; i++) {
    if (st.superTrend[i] !== null) data.push({
      time: c.time[i], value: st.superTrend[i],
    });
  }
  return {
    plots: [{ name: 'Supertrend', data, color: '#FF9800', width: 2 }],
  };
}`;

export const ichimokuIndicatorCode = `// Ichimoku Cloud
function calculate(c) {
  const ich = ichimoku(c.high, c.low, c.close, 9, 26, 52, 26);
  const tenkan = [], kijun = [], senkouA = [], senkouB = [], chikou = [];
  for (let i = 0; i < c.length; i++) {
    if (ich.tenkan[i] !== null) tenkan.push({ time: c.time[i], value: ich.tenkan[i] });
    if (ich.kijun[i] !== null) kijun.push({ time: c.time[i], value: ich.kijun[i] });
    if (ich.chikou[i] !== null) chikou.push({ time: c.time[i], value: ich.chikou[i] });
  }
  // Senkou spans are displaced forward
  for (let i = 0; i < ich.senkouA.length; i++) {
    if (ich.senkouA[i] !== null) senkouA.push({ time: c.time[0] + i * (c.time[1] - c.time[0]), value: ich.senkouA[i] });
    if (ich.senkouB[i] !== null) senkouB.push({ time: c.time[0] + i * (c.time[1] - c.time[0]), value: ich.senkouB[i] });
  }
  return {
    plots: [
      { name: 'Tenkan', data: tenkan, color: '#2196F3', width: 1 },
      { name: 'Kijun', data: kijun, color: '#f85149', width: 1 },
      { name: 'Senkou A', data: senkouA, color: '#3fb950', width: 1 },
      { name: 'Senkou B', data: senkouB, color: '#f85149', width: 1 },
      { name: 'Chikou', data: chikou, color: '#9C27B0', width: 1 },
    ],
    fills: [
      { line1: 'Senkou A', line2: 'Senkou B', color: 'rgba(63, 185, 80, 0.1)' }
    ]
  };
}`;

export const fvgIndicatorCode = `// Fair Value Gaps (Boxes)
function calculate(c) {
  const fvgs = fairValueGaps(c.open, c.high, c.low, c.close);
  const boxes = fvgs.map(f => ({
    t1: c.time[f.index - 1],
    t2: c.time[Math.min(f.index + 10, c.length - 1)],
    p1: f.top,
    p2: f.bottom,
    color: f.type === 'bullish' ? 'rgba(63, 185, 80, 0.15)' : 'rgba(248, 81, 73, 0.15)',
  }));
  return {
    plots: [],
    shapes: [
      { type: 'box', name: 'FVG', data: boxes }
    ]
  };
}`;

export const swingLevelsIndicatorCode = `// Swing High/Low with Labels
function calculate(c) {
  const sh = swingHighs(c.high, 3, 3);
  const sl = swingLows(c.low, 3, 3);
  const labels = [];
  for (let i = 0; i < c.length; i++) {
    if (sh[i] !== null) labels.push({
      time: c.time[i], price: sh[i],
      text: 'HH', color: '#f85149',
      position: 'above', shape: 'arrow_down'
    });
    if (sl[i] !== null) labels.push({
      time: c.time[i], price: sl[i],
      text: 'LL', color: '#3fb950',
      position: 'below', shape: 'arrow_up'
    });
  }
  return {
    plots: [],
    shapes: [{ type: 'label', name: 'Swings', data: labels }]
  };
}`;

export const vwapIndicatorCode = `// VWAP
function calculate(c) {
  const v = vwap(c.close, c.volume, c.high, c.low);
  const data = [];
  for (let i = 0; i < c.length; i++)
    if (v[i] !== null) data.push({ time: c.time[i], value: v[i] });
  return { plots: [{ name: 'VWAP', data, color: '#FF9800', width: 2, style: 'dashed' }] };
}`;

export const stochasticIndicatorCode = `// Stochastic RSI
function calculate(c) {
  const st = stochastic(c.high, c.low, c.close, 14, 3);
  const kData = [], dData = [];
  for (let i = 0; i < c.length; i++) {
    if (st.k[i] !== null) kData.push({ time: c.time[i], value: st.k[i] });
    if (st.d[i] !== null) dData.push({ time: c.time[i], value: st.d[i] });
  }
  return {
    plots: [
      { name: '%K', data: kData, color: '#2196F3', width: 2, overlay: false },
      { name: '%D', data: dData, color: '#FF9800', width: 1, overlay: false },
    ],
    shapes: [
      { type: 'hline', data: [
        { price: 80, color: '#f85149', style: 'dashed' },
        { price: 20, color: '#3fb950', style: 'dashed' },
      ]}
    ]
  };
}`;

export const donchianIndicatorCode = `// Donchian Channels
function calculate(c) {
  const dc = donchian(c.high, c.low, 20);
  const upper = [], middle = [], lower = [];
  for (let i = 0; i < c.length; i++) {
    if (dc.upper[i] !== null) upper.push({ time: c.time[i], value: dc.upper[i] });
    if (dc.middle[i] !== null) middle.push({ time: c.time[i], value: dc.middle[i] });
    if (dc.lower[i] !== null) lower.push({ time: c.time[i], value: dc.lower[i] });
  }
  return {
    plots: [
      { name: 'DC Upper', data: upper, color: '#58a6ff', width: 1 },
      { name: 'DC Middle', data: middle, color: '#58a6ff', width: 1, style: 'dashed' },
      { name: 'DC Lower', data: lower, color: '#58a6ff', width: 1 },
    ],
    fills: [
      { line1: 'DC Upper', line2: 'DC Lower', color: 'rgba(88, 166, 255, 0.05)' }
    ]
  };
}`;

export const psarIndicatorCode = `// Parabolic SAR
function calculate(c) {
  const sar = psar(c.high, c.low, 0.02, 0.2);
  const data = [];
  for (let i = 0; i < c.length; i++)
    if (sar[i] !== null) data.push({ time: c.time[i], value: sar[i] });
  return { plots: [{ name: 'PSAR', data, color: '#FF9800', width: 2 }] };
}`;

export const emaRibbonIndicatorCode = `// EMA Ribbon (10-50)
function calculate(c) {
  const rib = ribbon(c.close, 10, 50, 5);
  const colors = ['#f85149','#FF6B35','#FF9800','#FFC107','#3fb950','#2196F3','#58a6ff','#9C27B0','#E91E63','#8b949e'];
  const plots = rib.map((r, i) => {
    const data = [];
    for (let j = 0; j < c.length; j++) if (r.values[j] !== null) data.push({ time: c.time[j], value: r.values[j] });
    return { name: 'EMA ' + r.period, data, color: colors[i % colors.length], width: 1 };
  });
  return { plots };
}`;

export const squeezeIndicatorCode = `// TTM Squeeze
function calculate(c) {
  const sq = squeeze(c.high, c.low, c.close, 20, 2, 20, 1.5);
  const momData = [], sqzOnData = [], sqzOffData = [];
  for (let i = 0; i < c.length; i++) {
    if (sq.momentum[i] !== null) {
      const color = sq.sqzOn[i] ? '#FFD700' : sq.momentum[i] >= 0 ? 'rgba(63,185,80,0.8)' : 'rgba(248,81,73,0.8)';
      momData.push({ time: c.time[i], value: sq.momentum[i], color });
    }
  }
  return {
    plots: [
      { name: 'Momentum', data: momData, type: 'histogram', overlay: false },
    ],
    shapes: [
      { type: 'hline', data: [{ price: 0, color: '#30363d', style: 'dotted' }] }
    ]
  };
}`;

export const zigzagIndicatorCode = `// ZigZag 5%
function calculate(c) {
  const pivots = zigzag(c.high, c.low, c.close, 5);
  const lines = [];
  for (let i = 1; i < pivots.length; i++) {
    lines.push({
      t1: c.time[pivots[i-1].index], p1: pivots[i-1].price,
      t2: c.time[pivots[i].index], p2: pivots[i].price,
      color: pivots[i].type === 'high' ? '#f85149' : '#3fb950',
      width: 2,
    });
  }
  return {
    plots: [],
    shapes: [{ type: 'trend_line', name: 'ZigZag', data: lines }]
  };
}`;

export const choppinessIndicatorCode = `// Choppiness Index
function calculate(c) {
  const ch = choppiness(c.high, c.low, c.close, 14);
  const data = [];
  for (let i = 0; i < c.length; i++)
    if (ch[i] !== null) data.push({ time: c.time[i], value: ch[i] });
  return {
    plots: [{ name: 'CHOP', data, color: '#9C27B0', width: 2, overlay: false }],
    shapes: [{ type: 'hline', data: [
      { price: 61.8, color: '#f85149', style: 'dashed', text: 'Choppy' },
      { price: 38.2, color: '#3fb950', style: 'dashed', text: 'Trending' },
    ]}]
  };
}`;

export const obvIndicatorCode = `// On Balance Volume
function calculate(c) {
  const o = obv(c.close, c.volume);
  const data = [];
  for (let i = 0; i < c.length; i++)
    if (o[i] !== null) data.push({ time: c.time[i], value: o[i] });
  return { plots: [{ name: 'OBV', data, color: '#58a6ff', width: 2, overlay: false }] };
}`;

export const cciIndicatorCode = `// CCI (Commodity Channel Index)
function calculate(c) {
  const v = cci(c.high, c.low, c.close, 20);
  const data = [];
  for (let i = 0; i < c.length; i++)
    if (v[i] !== null) data.push({ time: c.time[i], value: v[i] });
  return {
    plots: [{ name: 'CCI', data, color: '#2196F3', width: 2, overlay: false }],
    shapes: [{ type: 'hline', data: [
      { price: 100, color: '#f85149', style: 'dashed' },
      { price: -100, color: '#3fb950', style: 'dashed' },
      { price: 0, color: '#30363d', style: 'dotted' },
    ]}]
  };
}`;

export const keltnerIndicatorCode = `// Keltner Channels
function calculate(c) {
  const k = keltner(c.high, c.low, c.close, 20, 10, 1.5);
  const upper = [], middle = [], lower = [];
  for (let i = 0; i < c.length; i++) {
    if (k.upper[i] !== null) upper.push({ time: c.time[i], value: k.upper[i] });
    if (k.middle[i] !== null) middle.push({ time: c.time[i], value: k.middle[i] });
    if (k.lower[i] !== null) lower.push({ time: c.time[i], value: k.lower[i] });
  }
  return {
    plots: [
      { name: 'KC Upper', data: upper, color: '#FF9800', width: 1 },
      { name: 'KC Middle', data: middle, color: '#FF9800', width: 1, style: 'dashed' },
      { name: 'KC Lower', data: lower, color: '#FF9800', width: 1 },
    ],
    fills: [{ line1: 'KC Upper', line2: 'KC Lower', color: 'rgba(255,152,0,0.05)' }]
  };
}`;

export const williamsIndicatorCode = `// Williams %R
function calculate(c) {
  const w = williams(c.high, c.low, c.close, 14);
  const data = [];
  for (let i = 0; i < c.length; i++)
    if (w[i] !== null) data.push({ time: c.time[i], value: w[i] });
  return {
    plots: [{ name: 'Williams %R', data, color: '#E91E63', width: 2, overlay: false }],
    shapes: [{ type: 'hline', data: [
      { price: -20, color: '#f85149', style: 'dashed' },
      { price: -80, color: '#3fb950', style: 'dashed' },
    ]}]
  };
}`;

export const mfiIndicatorCode = `// MFI (Money Flow Index)
function calculate(c) {
  const m = mfi(c.high, c.low, c.close, c.volume, 14);
  const data = [];
  for (let i = 0; i < c.length; i++)
    if (m[i] !== null) data.push({ time: c.time[i], value: m[i] });
  return {
    plots: [{ name: 'MFI', data, color: '#9C27B0', width: 2, overlay: false }],
    shapes: [{ type: 'hline', data: [
      { price: 80, color: '#f85149', style: 'dashed' },
      { price: 20, color: '#3fb950', style: 'dashed' },
    ]}]
  };
}`;

export const adxIndicatorCode = `// ADX with +DI/-DI
function calculate(c) {
  const a = adx(c.high, c.low, c.close, 14);
  const adxData = [], plusData = [], minusData = [];
  for (let i = 0; i < c.length; i++) {
    if (a.adx[i] !== null) adxData.push({ time: c.time[i], value: a.adx[i] });
    if (a.plusDI[i] !== null) plusData.push({ time: c.time[i], value: a.plusDI[i] });
    if (a.minusDI[i] !== null) minusData.push({ time: c.time[i], value: a.minusDI[i] });
  }
  return {
    plots: [
      { name: 'ADX', data: adxData, color: '#58a6ff', width: 2, overlay: false },
      { name: '+DI', data: plusData, color: '#3fb950', width: 1, overlay: false },
      { name: '-DI', data: minusData, color: '#f85149', width: 1, overlay: false },
    ],
    shapes: [
      { type: 'hline', data: [{ price: 25, color: '#FF9800', style: 'dashed', text: 'Trend threshold' }] }
    ]
  };
}`;

export const pvpIndicatorCode = `// =============================================================
// PERIODIC VOLUME PROFILE (PVP)
// Build volume profiles per period (Bar/Minute/Hour/Day/Week/Month)
// with POC, Value Area, and extendable lines.
// =============================================================

// === INPUTS (edit these constants) ===
const PERIOD_MULT  = 1;        // Period multiplier
const PERIOD       = 'Day';    // Bar | Minute | Hour | Day | Week | Month
const VOL_TYPE     = 'Total';  // Total | UpDown | Delta
const VA_PCT       = 70;       // Value Area % (typically 70)
const ROWS_LAYOUT  = 'Number'; // Number | Ticks
const ROW_SIZE     = 24;       // Number of rows OR ticks per row
const EXTEND_POC   = true;     // Extend POC line to the right
const EXTEND_VAH   = false;    // Extend VAH line to the right
const EXTEND_VAL   = false;    // Extend VAL line to the right
const MAX_PROFILES = 8;        // Limit number of recent profiles drawn (perf)
const PROFILE_W    = 0.25;     // Histogram width as fraction of period (0-1)
const MAX_BOXES    = 1500;     // Hard cap to keep the chart smooth

// === COLORS ===
const COLOR_UP       = 'rgba(38, 166, 154, 0.78)';
const COLOR_UP_FADE  = 'rgba(38, 166, 154, 0.32)';
const COLOR_DOWN     = 'rgba(239, 83, 80, 0.78)';
const COLOR_DOWN_FADE= 'rgba(239, 83, 80, 0.32)';
const COLOR_VA       = 'rgba(33, 150, 243, 0.78)';
const COLOR_VA_FILL  = 'rgba(33, 150, 243, 0.30)';
const COLOR_POC      = '#FFC107';
const COLOR_VAH      = '#90CAF9';
const COLOR_VAL      = '#90CAF9';

function calculate(c) {
  if (c.length < 1) return { plots: [], shapes: [] };

  // --- Auto-detect tick size from price deltas (clamped for visibility) ---
  let minDiff = Infinity;
  const sample = Math.min(c.length, 3000);
  for (let i = 1; i < sample; i++) {
    const d = Math.abs(c.close[i] - c.close[i - 1]);
    if (d > 1e-10 && d < minDiff) minDiff = d;
  }
  // Use a chunkier tickSize so that boxes are actually visible on the chart.
  // We round UP to the nearest standard step based on the detected minimum delta.
  let tickSize;
  if (minDiff <= 0.001) tickSize = 0.01;
  else if (minDiff <= 0.01) tickSize = 0.1;
  else if (minDiff <= 0.1) tickSize = 1;
  else if (minDiff <= 1) tickSize = 10;
  else if (minDiff <= 10) tickSize = 50;
  else if (minDiff <= 50) tickSize = 100;
  else if (minDiff <= 200) tickSize = 500;
  else if (minDiff <= 1000) tickSize = 1000;
  else tickSize = Math.max(100, Math.round(minDiff / 10) * 10);
  if (!isFinite(tickSize) || tickSize <= 0) tickSize = 1;

  // --- Period key (UTC based) ---
  function periodKey(time) {
    const d = new Date(time * 1000);
    const Y = d.getUTCFullYear();
    const M = d.getUTCMonth();
    const D = d.getUTCDate();
    const h = d.getUTCHours();
    const m = d.getUTCMinutes();
    if (PERIOD === 'Bar') return 'b' + time;
    if (PERIOD === 'Minute') return Y + '|' + M + '|' + D + '|' + h + '|' + (Math.floor(m / PERIOD_MULT) * PERIOD_MULT);
    if (PERIOD === 'Hour')   return Y + '|' + M + '|' + D + '|' + (Math.floor(h / PERIOD_MULT) * PERIOD_MULT);
    if (PERIOD === 'Day')    return Y + '|' + M + '|' + (Math.floor((D - 1) / PERIOD_MULT) * PERIOD_MULT + 1);
    if (PERIOD === 'Week') {
      const yearStart = Math.floor(Date.UTC(Y, 0, 1) / 1000);
      return Y + '|W' + Math.floor((time - yearStart) / (604800 * PERIOD_MULT));
    }
    if (PERIOD === 'Month') return Y + '|M' + (Math.floor(M / PERIOD_MULT) * PERIOD_MULT);
    return 'b' + time;
  }

  // --- Group candles by period ---
  const groups = [];
  let curKey = null, curStart = -1, curEnd = -1;
  for (let i = 0; i < c.length; i++) {
    const k = periodKey(c.time[i]);
    if (k !== curKey) {
      if (curStart >= 0) groups.push({ start: curStart, end: curEnd });
      curKey = k; curStart = i;
    }
    curEnd = i;
  }
  if (curStart >= 0) groups.push({ start: curStart, end: curEnd });

  const profiles = groups.slice(-MAX_PROFILES);
  const boxes = [];
  const hlines = [];

  for (let g = 0; g < profiles.length; g++) {
    const grp = profiles[g];
    const t0 = c.time[grp.start];
    const t1 = c.time[grp.end];
    const dur = Math.max(t1 - t0, 1);

    // Price range
    let hi = -Infinity, lo = Infinity;
    for (let i = grp.start; i <= grp.end; i++) {
      if (c.high[i] > hi) hi = c.high[i];
      if (c.low[i]  < lo) lo = c.low[i];
    }
    if (hi <= lo || !isFinite(hi)) continue;

    const top = Math.ceil(hi / tickSize) * tickSize;
    const bot = Math.floor(lo / tickSize) * tickSize;
    const totalTicks = Math.round((top - bot) / tickSize);
    if (totalTicks <= 0) continue;

    // Ticks per row
    let tpr;
    if (ROWS_LAYOUT === 'Ticks') {
      tpr = Math.max(1, Math.round(ROW_SIZE));
    } else {
      const ideal = totalTicks / ROW_SIZE;
      const a = Math.max(1, Math.floor(ideal));
      const b = Math.max(1, Math.ceil(ideal));
      const ra = Math.abs(Math.ceil(totalTicks / a) - ROW_SIZE);
      const rb = Math.abs(Math.ceil(totalTicks / b) - ROW_SIZE);
      tpr = ra <= rb ? a : b;
    }
    const numRows = Math.ceil(totalTicks / tpr);
    if (numRows <= 0) continue;

    // Volume arrays
    const vU = new Array(numRows).fill(0);
    const vD = new Array(numRows).fill(0);

    for (let i = grp.start; i <= grp.end; i++) {
      const v = c.volume[i] || 0;
      if (v <= 0) continue;
      const o = c.open[i], cl = c.close[i], h = c.high[i], l = c.low[i];
      let bV, sV;
      if (cl > o) { bV = v; sV = 0; }
      else if (cl < o) { bV = 0; sV = v; }
      else { bV = v * 0.5; sV = v * 0.5; }
      const range = Math.max(h - l, tickSize * 0.0001);
      for (let r = 0; r < numRows; r++) {
        const rL = bot + r * tpr * tickSize;
        const rH = rL + tpr * tickSize;
        const ov = Math.min(h, rH) - Math.max(l, rL);
        if (ov > 0) {
          const f = ov / range;
          vU[r] += bV * f;
          vD[r] += sV * f;
        }
      }
    }

    const vT = vU.map((u, r) => u + vD[r]);
    let maxV = 0;
    for (let i = 0; i < vT.length; i++) if (vT[i] > maxV) maxV = vT[i];
    if (maxV <= 0) continue;

    // POC
    let pocR = 0;
    for (let r = 1; r < numRows; r++) if (vT[r] > vT[pocR]) pocR = r;
    const pocP = bot + (pocR + 0.5) * tpr * tickSize;

    // Value Area
    let totV = 0;
    for (let i = 0; i < vT.length; i++) totV += vT[i];
    const tgt = (VA_PCT / 100) * totV;
    let vaT = pocR, vaB = pocR, vaV = vT[pocR];
    let safety = 0;
    while (vaV < tgt && (vaT < numRows - 1 || vaB > 0) && safety < numRows) {
      const upV = vaT < numRows - 1 ? vT[vaT + 1] : -1;
      const dnV = vaB > 0 ? vT[vaB - 1] : -1;
      if (upV >= dnV && vaT < numRows - 1) { vaT++; vaV += upV; }
      else if (vaB > 0) { vaB--; vaV += dnV; }
      else break;
      safety++;
    }
    const vahP = bot + (vaT + 1) * tpr * tickSize;
    const valP = bot + vaB * tpr * tickSize;

    // Draw histogram rows (cap width to PROFILE_W of period + MAX_BOXES total)
    for (let r = 0; r < numRows; r++) {
      if (vT[r] <= 0) continue;
      if (boxes.length >= MAX_BOXES) break;
      const rL = bot + r * tpr * tickSize;
      const rH = rL + tpr * tickSize;
      const inVA = r >= vaB && r <= vaT;
      // Cap the histogram width to PROFILE_W of the period
      const w = Math.min(vT[r] / maxV, PROFILE_W) * dur;
      const end = t0 + Math.max(w, dur * 0.002);

      if (VOL_TYPE === 'UpDown') {
        const u = vU[r], d = vD[r], s = u + d;
        if (s > 0) {
          const uw = (u / s) * w;
          if (u > 0 && boxes.length < MAX_BOXES) boxes.push({ t1: t0, t2: t0 + Math.max(uw, 0.001), p1: rL, p2: rH, color: inVA ? COLOR_UP : COLOR_UP_FADE });
          if (d > 0 && boxes.length < MAX_BOXES) boxes.push({ t1: t0 + uw, t2: end, p1: rL, p2: rH, color: inVA ? COLOR_DOWN : COLOR_DOWN_FADE });
        }
      } else if (VOL_TYPE === 'Delta') {
        const delta = vU[r] - vD[r];
        const color = delta >= 0 ? (inVA ? COLOR_UP : COLOR_UP_FADE) : (inVA ? COLOR_DOWN : COLOR_DOWN_FADE);
        boxes.push({ t1: t0, t2: end, p1: rL, p2: rH, color });
      } else {
        boxes.push({ t1: t0, t2: end, p1: rL, p2: rH, color: inVA ? COLOR_VA : COLOR_VA_FILL });
      }
    }

    // POC/VAH/VAL lines for the most recent profile
    if (g === profiles.length - 1) {
      if (EXTEND_POC) hlines.push({ price: pocP, color: COLOR_POC, style: 'solid', text: 'POC ' + pocP.toFixed(2) });
      if (EXTEND_VAH) hlines.push({ price: vahP, color: COLOR_VAH, style: 'dashed', text: 'VAH ' + vahP.toFixed(2) });
      if (EXTEND_VAL) hlines.push({ price: valP, color: COLOR_VAL, style: 'dashed', text: 'VAL ' + valP.toFixed(2) });
    }
  }

  return {
    plots: [],
    shapes: [
      { type: 'box', data: boxes },
      { type: 'hline', data: hlines }
    ]
  };
}
`;

// =============================================================
// MTF POC MENTORSHIP BY DANZ v28
// Point of Control multi-timeframe avec états FRESH / UNTAPPED / TAPPED
// Réplique le comportement du POC original (Multi-Timeframe PVP POC)
// =============================================================
export const mtfPocIndicatorCode = `// MTF POC Mentorship by Danz v28 — Point of Control multi-timeframe
// Lifecycle: FRESH (gray) -> UNTAPPED (dark purple) -> TAPPED (light purple)
// 1D/2D/3D touched = REMOVED | 5D/1W/2W/1M touched = TAPPED (stays until replaced)
//
// IMPORTANT: Les POCs sont TOUJOURS calculés avec des bougies DAILY (1D)
// pour que les niveaux restent stables peu importe le timeframe sélectionné.
// Si daily est fourni (via le 3ème paramètre d'executeIndicator), il est utilisé.
// Sinon, on fallback sur les bougies actuelles.

// @param I_RES number 24 Résolution (bins du volume profile) [max:1000]
// @param SRC_EXCHANGE select [AUTO,BINANCE,BYBIT,OKX,BITFINEX,COINBASE] AUTO Exchange source des POCs
// @param SRC_QUOTE select [USDT,USD,USDT.P,USDC,BTC,ETH] USDT Paire de cotation source
// @param I_LW number 1 Épaisseur des lignes [max:5]
// @param COL_FRESH color #8b949e Couleur FRESH (nouveaux)
// @param COL_NAKED color #6A0DAD Couleur UNTAPPED
// @param COL_TAPPED color #C39BD3 Couleur TAPPED
// @param SHOW_LABEL boolean true Afficher le label des POCs

function calculate(input) {
  // Sélectionne les bougies daily si disponibles, sinon fallback
  const c = (input.daily && input.daily.close && input.daily.close.length > 0) ? input.daily : input;
  // === PARAMÈTRES (modifiables via le bouton ⚙️) ===
  // Les noms ci-dessous correspondent EXACTEMENT aux @param ci-dessus.
  // applyParamsToCode() remplace ces valeurs quand l'utilisateur change les params.
  const maxLevels   = 3;
  const maxTappedM  = 2;
  const I_RES       = 24;  // 24 parcelles par bougie (comme TradingView PVP)
  const I_LW        = 1;
  const SHOW_LABEL  = true;
  const COL_FRESH   = "#8b949e";
  const COL_NAKED   = "#6A0DAD";
  const COL_TAPPED  = "#C39BD3";
  const I_FILTER_DUPLICATE = false;
  const I_FILTER_MIN_DIST  = false;
  const LINE_STYLE  = 'dotted';
  // RÈGLE: 1D/2D/3D touché ne supprime pas immédiatement le POC.
  // Il est marqué "touched" et disparaît au changement de période suivant.
  // (La spec dit "disappears at end of the period", pas immédiatement.)

  // Timeframes (en secondes) avec nombre max de niveaux visibles
  // Regular levels: tri par distance au prix actuel (les plus proches d'abord)
  // Tapped levels: tri par récence (les plus récents d'abord)
  // RÈGLES EXACTES DE TRADINGVIEW (MTF POC Mentorship v28):
  // - Regular (UNTAPPED): tri par distance au prix actuel, top N affichés
  // - Tapped: tri par récence (le plus récent d'abord), top N affichés
  // - 1D/2D/3D touché = SUPPRIMÉ (disparaît, pas de version T)
  // - 5D/1W/2W touché = devient TAPPED (violet clair, suffixe T)
  // - 1M touché = devient TAPPED (suffixe 1MT)
  // - IMPORTANT: un POC touché pendant sa période ne disparaît pas immédiatement,
  //   seulement à la fin de la période (update 1x par jour).
  const tfs = [
    { code: '1D', sec: 86400,    maxReg: 3, maxTapped: 0, type: 'fixed' },
    { code: '2D', sec: 172800,   maxReg: 3, maxTapped: 0, type: 'fixed' },
    { code: '3D', sec: 259200,   maxReg: 3, maxTapped: 0, type: 'fixed' },
    { code: '5D', sec: 432000,   maxReg: 3, maxTapped: 1, type: 'fixed' },
    { code: '1W', sec: 604800,   maxReg: 3, maxTapped: 1, type: 'week' },
    { code: '2W', sec: 1209600,  maxReg: 3, maxTapped: 1, type: 'biweek' },
    { code: '1M', sec: 2592000,  maxReg: 2, maxTapped: 2, type: 'month' },
  ];

  // Calcule l'ID de période selon le type (aligné sur les calendriers TradingView)
  // - fixed: N jours fixes depuis epoch (1D/2D/3D/5D) - correct car epoch = minuit UTC
  // - week: semaines ISO (lundi→dimanche), pas jeudi→mercredi comme le ferait floor(time/604800)
  // - biweek: 2 semaines ISO (même alignement lundi)
  // - month: mois calendaires (janvier, février, ...) - pas 30 jours fixes
  function getPeriodId(time, tfType, sec) {
    if (tfType === 'month') {
      const d = new Date(time * 1000);
      return d.getUTCFullYear() * 12 + d.getUTCMonth();
    }
    if (tfType === 'week' || tfType === 'biweek') {
      // Aligner sur lundi: epoch (jeudi 1 jan 1970) = jour 3 depuis le lundi precedent
      // Decaler de 3 jours (259200 sec) pour que les semaines commencent lundi
      const alignedTime = time + 3 * 86400;  // +3 jours pour aligner sur lundi
      if (tfType === 'biweek') return Math.floor(alignedTime / (2 * sec));
      return Math.floor(alignedTime / sec);
    }
    // fixed (1D/2D/3D/5D): epoch commence a minuit UTC, donc l'alignement est correct
    return Math.floor(time / sec);
  }

  // === CALCUL DU POC (Point of Control) ===
  // Volume profile sur une fenêtre de barres, retourne le prix du bin avec le plus de volume
  function calcPoc(startIdx, endIdx) {
    if (endIdx < startIdx) return null;
    // Single candle: TradingView's Volume Profile uses a "time-at-price" approximation
    // for single-candle profiles. We use the candle's midpoint (typical price)
    // weighted by volume as a reasonable proxy. This is more accurate than
    // uniform distribution which would give the low.
    if (endIdx === startIdx) {
      const cl = c.close[startIdx];
      const hi1 = c.high[startIdx];
      const lo1 = c.low[startIdx];
      const vol = c.volume[startIdx] || 1;
      // Typical Price (HLC/3) is a better estimator of where the price "spent time"
      // than close alone, especially for wicks-heavy candles.
      // conc=1 : sous cette approximation tout le volume de la bougie siège
      // au prix typique — cohérent avec la forme {poc, conc} attendue par
      // TOUS les consommateurs (un retour numérique faisait pocRes.poc →
      // undefined → ligne sans prix → toFixed explosait au label).
      return { poc: (hi1 + lo1 + cl) / 3, conc: 1 };
    }
    let hi = -Infinity, lo = Infinity;
    for (let i = startIdx; i <= endIdx; i++) {
      if (c.high[i] > hi) hi = c.high[i];
      if (c.low[i] < lo) lo = c.low[i];
    }
    if (hi === lo) return { poc: (hi + lo) / 2, conc: 1 };
    const step = (hi - lo) / I_RES;
    const bins = new Array(I_RES).fill(0);
    for (let i = startIdx; i <= endIdx; i++) {
      // Distribution uniforme: chaque bougie divisée en I_RES parcelles égales
      const bH = c.high[i], bL = c.low[i], bV = c.volume[i] || 1;
      const bR = Math.max(bH - bL, step * 0.01);
      for (let b = 0; b < I_RES; b++) {
        const lvlLo = lo + b * step;
        const overlap = Math.max(0, Math.min(bH, lvlLo + step) - Math.max(bL, lvlLo));
        if (overlap > 0) bins[b] += bV * (overlap / bR);
      }
    }
    let maxVol = -1, pocIdx = 0, totVol = 0;
    for (let b = 0; b < I_RES; b++) {
      totVol += bins[b];
      if (bins[b] > maxVol) { maxVol = bins[b]; pocIdx = b; }
    }
    return { poc: lo + (pocIdx + 0.5) * step, conc: totVol > 0 ? maxVol / totVol : 0 };
  }

  // === CALCUL DU POC AVEC INTRADAY ===
  // Si intraday est fourni, on reconstruit le POC à partir des bougies intraday (1h)
  // pour matcher le comportement de TradingView (volume profile précis).
  // Sinon fallback sur les bougies daily.
  // La période couvre [c.time[startIdx], c.time[endIdx]] (en secondes UTC).
  function calcPocIntraday(startIdx, endIdx) {
    // 1. Vérifier si on a un POC pré-calculé via aggTrades (précision TradingView)
    const startTs = c.time[startIdx];
    const endTs = c.time[endIdx] + 86400;  // Fin du dernier jour
    const pocKey = startTs + ':' + endTs;
    const pocKey2 = startTs + ':' + (endTs - 86400);
    if (input.aggTradePocs && (input.aggTradePocs[pocKey] !== undefined || input.aggTradePocs[pocKey2] !== undefined)) {
      const agg = input.aggTradePocs[pocKey] !== undefined ? input.aggTradePocs[pocKey] : input.aggTradePocs[pocKey2];
      return { poc: agg, conc: 0 };
    }

    const intraday = input.intraday;
    const hasIntraday = intraday && intraday.time && intraday.time.length > 0 &&
                        intraday.time[0] <= c.time[startIdx] &&
                        intraday.time[intraday.time.length - 1] >= c.time[endIdx];
    if (!hasIntraday) {
      // Fallback: utiliser les bougies daily
      // Log supprimé pour les performances
      return calcPoc(startIdx, endIdx);
    }
    // Trouver les bougies intraday dans la plage de la période
    // tEnd doit couvrir la FIN du dernier jour (pas seulement son ouverture)
    // car c.time[endIdx] = heure d'ouverture de la bougie daily
    const tStart = c.time[startIdx];
    const tEnd = c.time[endIdx] + 86400;  // +1 jour pour inclure toutes les bougies 1h du dernier jour
    let iStart = -1, iEnd = -1;
    for (let i = 0; i < intraday.time.length; i++) {
      if (iStart < 0 && intraday.time[i] >= tStart) iStart = i;
      if (intraday.time[i] < tEnd) iEnd = i;
    }
    if (iStart < 0 || iEnd < iStart) return calcPoc(startIdx, endIdx);
    // Calculer le POC sur la fenêtre intraday
    let hi = -Infinity, lo = Infinity;
    for (let i = iStart; i <= iEnd; i++) {
      if (intraday.high[i] > hi) hi = intraday.high[i];
      if (intraday.low[i] < lo) lo = intraday.low[i];
    }
    if (hi <= lo) return calcPoc(startIdx, endIdx);
    const step = (hi - lo) / I_RES;
    const bins = new Array(I_RES).fill(0);
    for (let i = iStart; i <= iEnd; i++) {
      // Distribution uniforme: chaque bougie divisée en I_RES parcelles égales
      const bH = intraday.high[i], bL = intraday.low[i], bV = intraday.volume[i] || 1;
      const bR = Math.max(bH - bL, step * 0.01);
      for (let b = 0; b < I_RES; b++) {
        const lvlLo = lo + b * step;
        const overlap = Math.max(0, Math.min(bH, lvlLo + step) - Math.max(bL, lvlLo));
        if (overlap > 0) bins[b] += bV * (overlap / bR);
      }
    }
    let maxVol = -1, pocIdx = 0, totVol = 0;
    for (let b = 0; b < I_RES; b++) {
      totVol += bins[b];
      if (bins[b] > maxVol) { maxVol = bins[b]; pocIdx = b; }
    }
    return { poc: lo + (pocIdx + 0.5) * step, conc: totVol > 0 ? maxVol / totVol : 0 };
  }

  // === SIMULATION BARRE PAR BARRE ===
  // state: 0=FRESH (nouveau), 1=UNTAPPED (non touché), 2=TAPPED (mèche a touché)
  // touchedByBar: index de la barre où la mèche a touché (pour le tri par récence)
  const lines = [];
  const tfState = tfs.map(() => ({ lastPeriod: -1, periodStartIdx: -1 }));

  // Détection du jour en cours (bougie daily NON finalisée).
  // En LIVE : la dernière barre est le jour en cours (high/low évolue).
  // En REPLAY : la reconstruction ajoute une "trigger candle" synthétique pour
  // le jour suivant (OHLC identiques = dernier prix, volume 0) afin de finaliser
  // le POC du jour précédent. Le jour en cours (partiel) est alors l'AVANT-dernière
  // barre. On doit ignorer le toucher sur le jour en cours dans les deux cas,
  // sinon les POCs s'actualisent pendant la journée au lieu d'attendre minuit.
  const lastIdx = c.length - 1;
  const isSyntheticTrigger = (lastIdx > 0 && (c.volume[lastIdx] || 0) === 0
    && c.open[lastIdx] === c.high[lastIdx] && c.high[lastIdx] === c.low[lastIdx]
    && c.low[lastIdx] === c.close[lastIdx]);
  const currentBarIdx = isSyntheticTrigger ? lastIdx - 1 : lastIdx;

  for (let i = 0; i < c.length; i++) {
    const h = c.high[i], l = c.low[i], o = c.open[i], cl = c.close[i];
    // Vrai si cette barre est le jour en cours (non finalisé) ou le trigger.
    const isCurrentDay = (i >= currentBarIdx);

    // 1. Mettre à jour les états des POCs existants
    // RÈGLE IMPORTANTE : un POC ne s'actualise PAS en temps réel.
    // Il ne peut être touché que par une bougie dans une période ULTÉRIEURE
    // à sa période de création (sinon le POC est figé jusqu'à la fin de la période).
    // On ignore le jour en cours : les POCs ne s'actualisent qu'à minuit,
    // quand la bougie daily se ferme et devient complète.
    if (!isCurrentDay) {
    for (const ln of lines) {
      if (ln.deleted || i <= ln.createdIdx) continue;

      const tf = tfs[ln.tfIdx];
      const currentPeriod = getPeriodId(c.time[i], tf.type, tf.sec);
      // Si on est dans la MÊME période que la création du POC → figé, pas de MAJ
      if (currentPeriod <= ln.createdPeriod) continue;

      // Distinction mèche vs corps:
      // - wickOnlyTouch: seule la mèche touche le niveau (le corps ne le traverse pas)
      //   → TAPPED pour 5D/1W/2W/1M, supprimé pour 1D/2D/3D
      // - bodyCrosses: le corps traverse le niveau → le POC est INVALIDE (supprimé)
      const wickTouch = h >= ln.price && l <= ln.price;
      const bodyHigh = Math.max(o, cl);
      const bodyLow = Math.min(o, cl);
      const bodyCrosses = bodyHigh >= ln.price && bodyLow <= ln.price;

      // bodyCrosses: le corps traverse le POC → on ne change PAS l'état pendant la période
      // On marque juste bodyTouched pour invalidation à la fin de la période
      // Pendant la période en cours, le POC reste dans son état actuel (UNTAPPED ou FRESH)
      if (bodyCrosses) {
        ln.bodyTouched = true;
        ln.bodyTouchedAt = i;
      } else if (wickTouch && ln.state < 2) {
        // Seule la mèche touche → TAPPED ou supprimé selon le TF
        if (tf.maxTapped > 0) {
          // 5D/1W/2W/1M: devient TAPPED (reste sur le graphique avec suffixe T)
          ln.state = 2;
          ln.touchedByBar = i;
        } else {
          // 1D/2D/3D: marqué touché — sera supprimé au prochain changement de période
          ln.touched = true;
          ln.touchedAt = i;
        }
      }
    }
    } // fin if (!isCurrentDay)

    // 2. Détection des changements de période pour chaque TF
    // (À minuit, quand une nouvelle bougie daily apparaît, on actualise les POCs)
    for (let t = 0; t < tfs.length; t++) {
      const period = getPeriodId(c.time[i], tfs[t].type, tfs[t].sec);
      if (period !== tfState[t].lastPeriod) {
        // Nouvelle période: calculer le POC de la période précédente
        if (tfState[t].lastPeriod >= 0 && tfState[t].periodStartIdx >= 0) {
          // 1D/2D/3D: supprimer les POCs touchés avant de calculer le nouveau
          // Aussi invalider les POCs dont le corps a traversé (bodyTouched) pour tous les TFs
          if (tfs[t].maxTapped === 0) {
            for (const ln of lines) {
              if (ln.tfIdx === t && ln.touched && ln.touchedAt < i && !ln.deleted) ln.deleted = true;
            }
          }
          // Pour TOUS les TFs: invalider les POCs dont le corps a traversé pendant la période close
          for (const ln of lines) {
            if (ln.tfIdx === t && ln.bodyTouched && ln.bodyTouchedAt < i && !ln.deleted) ln.deleted = true;
          }
          // Tous les TFs utilisent intraday (1h) pour un volume profile précis
          const pocRes = calcPocIntraday(tfState[t].periodStartIdx, i - 1);
          const poc = pocRes !== null ? pocRes.poc : null;
          const pocConc = pocRes !== null ? pocRes.conc : 0;
          if (poc !== null) {
            // Les anciens FRESH de ce TF deviennent UNTAPPED
            for (const ln of lines) {
              if (ln.tfIdx === t && ln.state === 0 && !ln.deleted) ln.state = 1;
            }
            // Filtre doublon (même niveau que la période précédente)
            let isDup = false;
            if (I_FILTER_DUPLICATE) {
              for (const ln of lines) {
                if (ln.tfIdx === t && !ln.deleted) {
                  if (Math.abs(ln.price - poc) / Math.max(Math.abs(poc), 1e-8) * 100 < 0.01) {
                    isDup = true; break;
                  }
                }
              }
            }
            if (!isDup) {
  // Stocke la période de création pour figer le POC pendant sa période
  // periodStartTs = timestamp de la PREMIÈRE bougie de la période couverte par ce POC
              lines.push({ price: poc, tfIdx: t, state: 0, createdIdx: i, createdPeriod: tfState[t].lastPeriod, periodStartIdx: tfState[t].periodStartIdx, touchedByBar: -1, touched: false, deleted: false, fromIntraday: false, conc: pocConc });
            }
          }
        }
        tfState[t].lastPeriod = period;
        tfState[t].periodStartIdx = i;
      }
    }
  }

  // === FILTRAGE ET GÉNÉRATION DES LIGNES ===
  const active = lines.filter(ln => !ln.deleted);
  const hlines = [];

  // Prix de référence pour le tri des POCs UNTAPPED par distance.
  // IMPORTANT: on utilise le close de la dernière bougie daily FINALISÉE,
  // pas le jour en cours (dont le close change à chaque bougie intraday).
  // Sinon, l'ordre des top-N POCs change à chaque tick → les lignes sautent.
  // Les POCs (prix + états) ne s'actualisent qu'une fois par jour à minuit,
  // le tri doit donc aussi être stable sur toute la journée.
  const refIdx = isSyntheticTrigger ? Math.max(0, lastIdx - 2) : Math.max(0, lastIdx - 1);
  const lastClose = c.close[refIdx];

  for (let t = 0; t < tfs.length; t++) {
    const tf = tfs[t];
    const tfLines = active.filter(ln => ln.tfIdx === t);

    // UNTAPPED levels uniquement (state=1): tri par distance au prix actuel
    // Le FRESH (state=0, "NEW") est affiché EN PLUS, il ne compte pas dans maxReg
    const regular = tfLines.filter(ln => ln.state === 1)
      .sort((a, b) => Math.abs(lastClose - a.price) - Math.abs(lastClose - b.price));

    // FRESH levels (state=0 = "NEW"): le plus récent de chaque TF, affiché en plus
    const fresh = tfLines.filter(ln => ln.state === 0)
      .sort((a, b) => b.createdIdx - a.createdIdx);

    // Tapped levels: tri par RÉCENT (closest to current date, pas price)
    // Spec TV: "the last tapped levels are shown (closest to current date, not price)"
    const tapped = tfLines.filter(ln => ln.state === 2)
      .sort((a, b) => b.touchedByBar - a.touchedByBar);

    // Helper: convertit un timestamp en date lisible
    const fmtDate = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

    // Afficher les regular levels jusqu'à maxReg
    let regCount = 0;
    for (const ln of regular) {
      if (regCount >= tf.maxReg) break;
      const col = ln.state === 0 ? COL_FRESH : COL_NAKED;
      const startDate = ln.periodStartIdx >= 0 ? fmtDate(c.time[ln.periodStartIdx]) : fmtDate(c.time[ln.createdIdx]);
      const createdDate = fmtDate(c.time[ln.createdIdx]);
      hlines.push({ price: ln.price, color: col, style: LINE_STYLE, width: I_LW, text: SHOW_LABEL ? 'POC:' + tf.code + ' ' + ln.price.toFixed(1) + ' [' + createdDate + ']' : '', start: startDate });
      regCount++;
    }

    // Afficher les tapped levels jusqu'à maxTapped
    let tapCount = 0;
    for (const ln of tapped) {
      if (tapCount >= tf.maxTapped) break;
      const startDate = ln.periodStartIdx >= 0 ? fmtDate(c.time[ln.periodStartIdx]) : fmtDate(c.time[ln.createdIdx]);
      const createdDate = fmtDate(c.time[ln.createdIdx]);
      hlines.push({ price: ln.price, color: COL_TAPPED, style: LINE_STYLE, width: I_LW, text: SHOW_LABEL ? 'POC:' + tf.code + 'T ' + ln.price.toFixed(1) + ' [' + createdDate + ']' : '', start: startDate });
      tapCount++;
    }

    // Afficher le FRESH level (NEW)
    if (fresh.length > 0) {
      const ln = fresh[0];
      const startDate = ln.periodStartIdx >= 0 ? fmtDate(c.time[ln.periodStartIdx]) : fmtDate(c.time[ln.createdIdx]);
      const createdDate = fmtDate(c.time[ln.createdIdx]);
      hlines.push({ price: ln.price, color: COL_FRESH, style: LINE_STYLE, width: I_LW, text: SHOW_LABEL ? 'POC:' + tf.code + ' ' + ln.price.toFixed(1) + ' [' + createdDate + ']' : '', start: startDate });
    }
  }

  // console.table supprimé pour les performances

  // FULL ACTIVE POCs (all non-deleted lines, no display top-N caps): the V2
  // strategy picks its entry POC from ALL active lines. Separate type
  // ('poc_levels') — the chart only draws hlines, the engine reads this.
  const allActive = active.map(ln => ({ price: ln.price, state: ln.state, conc: ln.conc ?? 0, tfSec: tfs[ln.tfIdx].sec, tfCode: tfs[ln.tfIdx].code }));
  return { plots: [], shapes: [{ type: 'hline', data: hlines }, { type: 'poc_levels', data: allActive }] };
}
`;

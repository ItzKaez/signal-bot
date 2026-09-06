/**
 * Port INCRÉMENTAL des sémantiques EXACTES de rsipeaks.ts (l'indicateur du
 * chart) — machine à états portée bougie par bougie, O(1) par bougie.
 *
 * Pourquoi un port dédié (et pas peaks.ts) : peaks.ts est la parité PYTHON
 * (pas de consolidation midline, ré-armement post-div) ; le moteur
 * app-engine.ts doit reproduire L'INDICATEUR DU CHART.
 *
 * Parité garantie par fuzzing (scripts/fuzz-rsipeaks-live.ts) : nourrir la
 * machine séquentiellement = EXACTEMENT les markers+divLines de
 * detectRsiPeaks batch (sémantiques v31 : âge 25, consolidation midline 5,
 * PAS de ré-armement post-div, resets sur trous de données).
 *
 * Sémantique de flux : feedFinalBar(bar) par barre DÉFINITIVE de la frame.
 * Pour une frame resamplée (30m depuis du 15m), le caller ne nourrit que
 * des buckets COMPLETS (ResampledCompletedFeeder) — jamais un bucket
 * partiel évolutif : le batch re-tournait de zéro à chaque update et
 * "réécrivait" les événements d'un bucket partiel ; une machine portée ne
 * peut pas rétracter ses émissions. Ne nourrir que le complet = zéro
 * repaint, même règle live et backtest (moteur partagé).
 *
 * Look-ahead de l'endpoint ±1 : le batch full-array peut peek la bougie
 * FUTURE di+1 du scan ±1 (inoffensif sur un chart, mais réel). La machine
 * émet la div avec le meilleur endpoint CONNU, puis un événement 'div-revise'
 * à la bougie suivante si la bougie future améliore l'endpoint — le moteur
 * remplace alors l'entrée de sa map, reproduisant le rebuild batch.
 */

export interface LiveBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export const OB_LEVEL = 70;
export const OS_LEVEL = 30;
export const MID_LEVEL = 50;
export const MAX_PEAK_AGE = 25;
export const MIDLINE_CONSOLIDATION_BARS = 5;

/** Snapshot immuable d'une bougie de frame (RSI non-null) — équivalent d'une
 *  entrée de rsiArray + sa bougie : la machine ne référence JAMAIS le passé
 *  au-delà de ces snapshots. */
interface Snap {
  idx: number; // index dans la suite des RSI non-nuls (compteur machine)
  time: number;
  val: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface LiveDivLine {
  t1: number; p1: number;
  t2: number; p2: number;
  t2_rsi: number; p2_rsi: number;
  isOB: boolean;
}

export type LiveEvent =
  /** Marker peak + sa confirmation (première bougie APRÈS le peak dont le
   *  RSI repart hors zone — toujours la bougie d'émission en v31, le scan
   *  est gardé par robustesse). */
  | { kind: 'peak'; peakAt: number; peakRsi: number; peakPrice: number; isOB: boolean; confirmedAt: number }
  /** Marker croix : midline/âge (isBreakout=false) ou breakout (true). */
  | { kind: 'cross'; at: number; isOB: boolean; isBreakout: boolean }
  /** Ligne de divergence (cf. divLines de detectRsiPeaks). */
  | { kind: 'div'; line: LiveDivLine }
  /** Révision de l'endpoint d'une div émise à la bougie précédente : le scan
   *  ±1 du batch voyait la bougie future — ici elle est connue un bar plus
   *  tard. Le moteur REMPLACE l'entrée correspondante de sa map. */
  | { kind: 'div-revise'; line: LiveDivLine };

interface ZoneState {
  state: 'idle' | 'tracking' | 'active';
  peak: Snap | null;
  climbLast: Snap | null;
  divEnd: Snap | null;
  priceExceeded: boolean;
  midlineConsolidation: number;
  /** Div émise à la bougie précédente dont l'endpoint peut être révisé par
   *  la bougie future (divEnd = bougie d'émission uniquement). */
  pendingRevise: { line: LiveDivLine; divEndIdx: number; endpointVal: number } | null;
}

/** Anneau des derniers snaps — sert au scan ±1 du endpoint et à la
 *  confirmation des peaks. Un peak vit au plus MAX_PEAK_AGE bougies. */
const RING_SIZE = 64;

export class RsiPeaksLiveFrame {
  /** RSI Wilder incrémental — reproduction EXACTE des opérations de rsiWilder
   *  (seed SMA sur `period` deltas, puis récursion RMA) : mêmes flottants. */
  private sumGain = 0;
  private sumLoss = 0;
  private avgGain = 0;
  private avgLoss = 0;
  private deltas = 0;
  private lastClose = NaN;

  private nonNull = 0; // taille du rsiArray équivalent
  private hasPrev = false;
  private prevVal = 0;
  private prevTime = 0;
  private machineBars = 0; // bougies traitées par la machine (i du batch)

  /** Médiane COURANTE des écarts (running exact par comptage) — le batch la
   *  calcule sur l'array final ; avec des données uniformes elle est stable
   *  dès les premières bougies. */
  private deltaCounts = new Map<number, number>();
  private deltaTotal = 0;

  private ring: Snap[] = [];
  private ringBase = 0; // idx du ring[0]

  private zones: { ob: ZoneState; os: ZoneState };
  private seenMarkerKeys = new Set<string>();

  constructor(private readonly rsiPeriod = 14) {
    const fresh = (): ZoneState => ({
      state: 'idle', peak: null, climbLast: null, divEnd: null,
      priceExceeded: false, midlineConsolidation: 0, pendingRevise: null,
    });
    this.zones = { ob: fresh(), os: fresh() };
  }

  private snapAt(idx: number): Snap | undefined {
    if (idx < this.ringBase || idx >= this.ringBase + this.ring.length) return undefined;
    return this.ring[idx - this.ringBase];
  }

  private runningMedianDelta(): number {
    let half = this.deltaTotal >> 1;
    const keys = [...this.deltaCounts.keys()].sort((a, b) => a - b);
    for (const k of keys) {
      half -= this.deltaCounts.get(k)!;
      if (half < 0) return k;
    }
    return keys.length > 0 ? keys[keys.length - 1] : 0;
  }

  private gapThreshold(): number {
    return Math.max(this.runningMedianDelta() * 3, 600);
  }

  /** RSI Wilder d'une nouvelle clôture — mêmes opérations que rsiWilder. */
  private rsiPush(close: number): number | null {
    if (Number.isNaN(this.lastClose)) { this.lastClose = close; return null; }
    const delta = close - this.lastClose;
    this.lastClose = close;
    const gain = Math.max(delta, 0);
    const loss = Math.max(-delta, 0);
    this.deltas++;
    if (this.deltas < this.rsiPeriod) {
      this.sumGain += gain;
      this.sumLoss += loss;
      return null;
    }
    if (this.deltas === this.rsiPeriod) {
      this.avgGain = (this.sumGain + gain) / this.rsiPeriod;
      this.avgLoss = (this.sumLoss + loss) / this.rsiPeriod;
    } else {
      this.avgGain = (this.avgGain * (this.rsiPeriod - 1) + gain) / this.rsiPeriod;
      this.avgLoss = (this.avgLoss * (this.rsiPeriod - 1) + loss) / this.rsiPeriod;
    }
    return this.avgLoss === 0 ? 100 : 100 - 100 / (1 + this.avgGain / this.avgLoss);
  }

  /** Nourrit une barre DÉFINITIVE de la frame → événements de cette barre. */
  feedFinalBar(bar: LiveBar): LiveEvent[] {
    const val = this.rsiPush(bar.close);
    if (val === null) return [];

    const snap: Snap = { idx: this.nonNull, time: bar.time, val, open: bar.open, high: bar.high, low: bar.low, close: bar.close };
    this.nonNull++;

    this.ring.push(snap);
    if (this.ring.length > RING_SIZE) { this.ring.shift(); this.ringBase = snap.idx - this.ring.length + 1; }

    // La machine batch démarre à i=1 : la première valeur non-nulle ne sert
    // que de prevVal.
    if (!this.hasPrev) { this.hasPrev = true; this.prevVal = val; this.prevTime = bar.time; return []; }

    const events: LiveEvent[] = [];

    // Médiane courante des écarts (après intégration de ce delta).
    const dt = bar.time - this.prevTime;
    this.deltaCounts.set(dt, (this.deltaCounts.get(dt) ?? 0) + 1);
    this.deltaTotal++;

    // Trou de données (i > 1 : la première bougie machine n'est pas checkée).
    if (this.machineBars >= 1 && dt > this.gapThreshold()) {
      for (const z of [this.zones.ob, this.zones.os]) {
        z.state = 'idle'; z.climbLast = null;
        z.divEnd = null; z.priceExceeded = false; z.midlineConsolidation = 0;
        z.pendingRevise = null;
      }
      this.machineBars++;
      this.prevVal = val; this.prevTime = bar.time;
      return events;
    }

    this.processZone(this.zones.ob, true, snap, this.prevVal, events);
    this.processZone(this.zones.os, false, snap, this.prevVal, events);
    this.machineBars++;
    this.prevVal = val;
    this.prevTime = bar.time;
    return events;
  }

  private pushCross(events: LiveEvent[], at: number, isOB: boolean, isBreakout: boolean): void {
    const key = `${at}-${isOB}-true-${isBreakout ? 'true' : 'undefined'}`;
    if (this.seenMarkerKeys.has(key)) return;
    this.seenMarkerKeys.add(key);
    events.push({ kind: 'cross', at, isOB, isBreakout });
  }

  /** Port exact du corps de bougie de _processZone (rsipeaks.ts v31). */
  private processZone(z: ZoneState, isOB: boolean, snap: Snap, prevVal: number, events: LiveEvent[]): void {
    const val = snap.val;
    const time = snap.time;
    const zoneLevel = isOB ? OB_LEVEL : OS_LEVEL;
    const gapThreshold = this.gapThreshold();
    const isRising = val > prevVal;
    const isFalling = val < prevVal;
    const inZone = isOB ? val >= zoneLevel : val <= zoneLevel;
    const towardZone = isOB ? isRising : isFalling;
    const awayFromZone = isOB ? isFalling : isRising;

    // Révision d'endpoint de la div précédente (la bougie future est connue).
    if (z.pendingRevise && z.pendingRevise.divEndIdx + 1 === snap.idx) {
      const pr = z.pendingRevise;
      const nv = snap.val;
      if (isOB ? nv > pr.endpointVal : nv < pr.endpointVal) {
        const revised: LiveDivLine = { ...pr.line, t2_rsi: time, p2_rsi: nv };
        events.push({ kind: 'div-revise', line: revised });
      }
      z.pendingRevise = null;
    }

    if (z.state === 'active') {
      const peak = z.peak!;
      let resolved = false;

      // 1. Breakout invalidation
      if (isOB ? val >= peak.val : val <= peak.val) {
        this.pushCross(events, time, isOB, true);
        z.state = 'idle';
        this.resetTracking(z);
        resolved = true;
      }

      if (!resolved) {
        // 2. Price exceeded
        if (isOB ? snap.high > peak.high : snap.low < peak.low) z.priceExceeded = true;

        // 3. divEnd = bougie au prix extrême depuis le peak
        if (!z.divEnd || (isOB ? snap.high > z.divEnd.high : snap.low < z.divEnd.low)) {
          z.divEnd = snap;
        }
        // (3b zonePeak : tracking mort en v31 — plus jamais lu.)

        // 4. Divergence confirmation
        if (awayFromZone && z.priceExceeded && z.divEnd) {
          const divEnd = z.divEnd;
          // SÉCURITÉ trous : portée max en index OU en temps. Le `continue`
          // du batch saute AUSSI la section idle/tracking de cette bougie.
          if (divEnd.idx - peak.idx > MAX_PEAK_AGE || divEnd.time - peak.time > MAX_PEAK_AGE * gapThreshold) {
            z.state = 'idle';
            this.resetTracking(z);
            z.climbLast = null;
            return;
          }
          const rsiDiv = isOB ? divEnd.val < peak.val : divEnd.val > peak.val;
          const priceDiv = isOB ? divEnd.high > peak.high : divEnd.low < peak.low;
          if (rsiDiv && priceDiv) {
            // RSI endpoint = peak local autour de divEnd (±1, sans le futur)
            let endpoint = divEnd;
            for (let off = -1; off <= 1; off++) {
              const nv = this.snapAt(divEnd.idx + off);
              if (!nv || nv.idx > snap.idx) continue; // futur inconnu
              if (isOB ? nv.val > endpoint.val : nv.val < endpoint.val) endpoint = nv;
            }
            const line: LiveDivLine = {
              t1: peak.time, p1: peak.val,
              t2: divEnd.time, p2: divEnd.val,
              t2_rsi: endpoint.time, p2_rsi: endpoint.val,
              isOB,
            };
            events.push({ kind: 'div', line });
            // Si divEnd = bougie courante, la bougie FUTURE (di+1) peut
            // améliorer l'endpoint → révision à la prochaine bougie.
            if (divEnd.idx === snap.idx) {
              z.pendingRevise = { line, divEndIdx: divEnd.idx, endpointVal: endpoint.val };
            }

            // PAS de ré-armement après une div (v31) : retour idle.
            z.state = 'idle';
            this.resetTracking(z);
            resolved = true;
          }
        }
      }

      if (!resolved) {
        // 5. Midline par consolidation (5 clôtures consécutives au-delà).
        const beyondMid = isOB ? val < MID_LEVEL : val > MID_LEVEL;
        if (beyondMid) {
          z.midlineConsolidation++;
          if (z.midlineConsolidation >= MIDLINE_CONSOLIDATION_BARS) {
            this.pushCross(events, time, isOB, false);
            z.state = 'idle';
            this.resetTracking(z);
            resolved = true;
          }
        } else {
          z.midlineConsolidation = 0;
        }
        // 6. Âge — index OU temps.
        if (!resolved && (snap.idx - z.peak!.idx >= MAX_PEAK_AGE || time - z.peak!.time > MAX_PEAK_AGE * gapThreshold)) {
          this.pushCross(events, time, isOB, false);
          z.state = 'idle';
          this.resetTracking(z);
          resolved = true;
        }
      }
    }

    // IDLE / TRACKING
    if (z.state === 'idle') {
      if (inZone && towardZone) {
        z.state = 'tracking';
        z.climbLast = snap;
      }
    } else if (z.state === 'tracking') {
      if (towardZone && inZone) {
        z.climbLast = snap;
      } else if (awayFromZone && z.climbLast) {
        z.peak = z.climbLast;
        this.emitPeak(events, z.climbLast, isOB);
        z.state = 'active';
        this.resetTracking(z);
        z.climbLast = null;
      } else if (!inZone) {
        z.state = 'idle';
        z.climbLast = null;
      }
    }
  }

  private resetTracking(z: ZoneState): void {
    z.divEnd = null;
    z.priceExceeded = false;
    z.midlineConsolidation = 0;
  }

  /** Marker peak + confirmation : première bougie APRÈS le peak dont le RSI
   *  repart hors zone (scan du ring). */
  private emitPeak(events: LiveEvent[], peakSnap: Snap, isOB: boolean): void {
    const key = `${peakSnap.time}-${isOB}-false-false`;
    if (this.seenMarkerKeys.has(key)) return;
    this.seenMarkerKeys.add(key);

    let confirmedAt = -1;
    for (let idx = peakSnap.idx + 1; idx < this.nonNull; idx++) {
      const s = this.snapAt(idx);
      const prev = idx > 0 ? this.snapAt(idx - 1) : undefined;
      if (!s || !prev) break;
      const away = isOB ? s.val < prev.val : s.val > prev.val;
      if (away) { confirmedAt = s.time; break; }
    }
    if (confirmedAt < 0) return; // jamais confirmé — écarté comme le batch

    events.push({
      kind: 'peak',
      peakAt: peakSnap.time,
      peakRsi: peakSnap.val,
      peakPrice: isOB ? peakSnap.high : peakSnap.low,
      isOB,
      confirmedAt,
    });
  }

  /** Bougie de frame par label de temps (données de divergence t2). */
  snapByTime(time: number): Snap | undefined {
    for (let i = this.ring.length - 1; i >= 0; i--) {
      if (this.ring[i].time === time) return this.ring[i];
    }
    return undefined;
  }

  /** Dernier RSI de la frame (bougie COMPLÈTE la plus récente — zéro
   *  repaint) : le ladder lit ici l'état OB/OS du TF haut pour autoriser
   *  ou non les entrées des TF bas. */
  latestSnap(): Snap | undefined {
    return this.ring.length > 0 ? this.ring[this.ring.length - 1] : undefined;
  }
}

/** Nourrit une frame resamplée UNIQUEMENT avec des buckets COMPLETS.
 *  Semantics resample = resampleCloseTime (label de clôture) ; un bucket de
 *  step S sur une base B contient exactement K = S/B bougies de base : il est
 *  nourri DÈS sa K-ième bougie — même update que le batch, dont le rebuild
 *  de cette bougie contient le bucket complété. Le bucket partiel final
 *  n'est jamais nourri (zéro repaint, cf. en-tête du module). */
export class ResampledCompletedFeeder {
  private bucket: LiveBar | null = null;
  private boundary = -1;
  private barsInBucket = 0;
  private readonly barsPerBucket: number;

  constructor(
    private readonly stepSeconds: number,
    private readonly frame: RsiPeaksLiveFrame,
    baseIntervalSeconds: number,
  ) {
    const k = stepSeconds / baseIntervalSeconds;
    this.barsPerBucket = Number.isInteger(k) && k >= 1 ? k : 0; // 0 = fallback boundary
  }

  feedBaseBar(c: { time: number; open: number; high: number; low: number; close: number }): LiveEvent[] {
    const boundary = Math.ceil((c.time + 1) / this.stepSeconds) * this.stepSeconds;
    if (!this.bucket || boundary !== this.boundary) {
      this.bucket = { time: boundary, open: c.open, high: c.high, low: c.low, close: c.close };
      this.boundary = boundary;
      this.barsInBucket = 1;
      return [];
    }
    // Étend le bucket en cours.
    this.bucket.high = Math.max(this.bucket.high, c.high);
    this.bucket.low = Math.min(this.bucket.low, c.low);
    this.bucket.close = c.close;
    this.barsInBucket++;
    if (this.barsPerBucket >= 1 && this.barsInBucket >= this.barsPerBucket) {
      // Bucket COMPLET → nourrir maintenant (même bougie que le batch).
      const events = this.frame.feedFinalBar(this.bucket);
      this.bucket = null;
      this.boundary = -1;
      this.barsInBucket = 0;
      return events;
    }
    return [];
  }

  /** Frame sous-jacente (lookups de bougies de frame par label de temps). */
  frameRef(): RsiPeaksLiveFrame {
    return this.frame;
  }
}

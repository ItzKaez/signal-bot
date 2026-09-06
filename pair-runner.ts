/**
 * Un PairRunner = UNE paire : son moteur AppStrategyEngine (exactement le
 * moteur live/backtest de l'app), ses bougies, ses POCs et son tailer de
 * journal qui transforme les événements en messages Telegram.
 *
 * Cycle de vie :
 *  1. WARMUP — fetch 1m historique (WARMUP_DAYS), warmupAsync : machines
 *     RSI/peaks chaudes, plans du passé jetés.
 *  2. CATCHUP — replay des CATCHUP_DAYS derniers jours en mode backtest
 *     (POCs injectés à CHAQUE frontière de jour UTC, comme le cache du
 *     backtest) : les positions OUVERTES et setups en file sont reconstruits
 *     à l'identique → un redémarrage du bot ne perd JAMAIS un trade en
 *     cours. Les événements du replay ne sont pas envoyés (grâce).
 *  3. LIVE — poll 1m (seulement des bougies CLÔTURÉES, zéro repaint),
 *     POCs réactualisés à minuit UTC, journal tailé → Telegram.
 */
import { AppStrategyEngine } from './engine/strategy-v2/app-engine';
import type { JournalEntry, ClosedTrade } from './engine/strategy-v2/engine';
import type { Candle } from './engine/types';
import { fetchKlines, fetchRange, closedOnly } from './bybit';
import { computePocUnion } from './poc';
import { fetchSourceDaily, type PocSourceDef } from './sources';
import { setupMessage, closeMessage, eventMessage } from './format';
import type { Telegram } from './telegram';

export interface PairRunnerOptions {
  symbol: string;        // ex. BTCUSDT (Bybit linear)
  capital: number;
  override: Record<string, unknown>;
  warmupDays: number;
  catchupDays: number;
  pollSec: number;
  /** TEST_DAYS > 0 : mode TEST — le replay du catchup ÉMET tous les
   *  événements (setups, fills, BE, SL, clôtures) comme s'ils étaient
   *  live, puis le process se termine. Pour tester sans attendre. */
  testDays: number;
  /** Sources POC (ex. les 7 des backtests) — union des niveaux. */
  pocSources: PocSourceDef[];
  telegram: Telegram;
}

export class PairRunner {
  private engine!: AppStrategyEngine;
  private base1m: Candle[] = [];
  private dailies: Candle[] = [];
  private intraday: Candle[] = [];
  private lastJournalIdx = 0;
  private lastSentT = 0;
  private readonly seenPlans = new Set<string>();
  private readonly seenTrades = new Set<string>();
  private currentPocDay = -1;
  private pocCount = 0;
  private lastRefsAt = 0;
  private lastSrcAt = 0;
  /** Dailies PAR SOURCE (les 7 des backtests) pour l'union POC. */
  private srcDailies: Array<{ def: PocSourceDef; dailies: Candle[] }> = [];
  private lastEventAt: number | null = null;
  private graceT: number;
  booted = false;
  lastError: string | null = null;

  constructor(private readonly opts: PairRunnerOptions) {
    // Mode test : la grâce couvre tout sauf les TEST_DAYS derniers jours —
    // le replay émet donc les événements du passé récent.
    this.graceT = Math.floor(Date.now() / 1000) - (opts.testDays > 0 ? opts.testDays * 86400 : 120);
  }

  get symbol(): string { return this.opts.symbol; }

  // ═══════════════ BOOT ═══════════════
  async boot(onProgress?: (msg: string) => void): Promise<void> {
    const { symbol, warmupDays, catchupDays } = this.opts;
    const nowSec = Math.floor(Date.now() / 1000);
    const say = (m: string) => { onProgress?.(m); console.log(`[${symbol}] ${m}`); };

    say(`fetch 1m ${warmupDays}j + daily/intraday + ${this.opts.pocSources.length} sources POC…`);
    const [c1m, dailies, intraday] = await Promise.all([
      fetchRange(symbol, '1m', nowSec - warmupDays * 86400, nowSec),
      fetchRange(symbol, 'D', nowSec - 500 * 86400, nowSec),
      fetchRange(symbol, '60', nowSec - 60 * 86400, nowSec),
    ]);
    this.base1m = closedOnly(c1m, '1m', nowSec);
    this.dailies = dailies;
    this.intraday = intraday;
    // Dailies des sources POC (séquentiel, pacing léger) — une source sans
    // cette paire (ex. BNB hors Bitfinex) reste vide : absente de l'union.
    const base = symbol.replace(/USDT$|USD$|USDC$/, '');
    for (const def of this.opts.pocSources) {
      const d = await fetchSourceDaily(def, base);
      this.srcDailies.push({ def, dailies: d });
      await new Promise((r) => setTimeout(r, 250));
    }
    const srcOk = this.srcDailies.filter((x) => x.dailies.length > 0).length;
    say(`${this.base1m.length.toLocaleString()} bougies 1m · ${dailies.length} daily · ${intraday.length} 1h · sources POC ${srcOk}/${this.opts.pocSources.length}`);

    this.engine = new AppStrategyEngine(60, this.opts.capital, this.opts.override as never);
    // Warmup sur le PASSÉ PROCHE (moins le catchup) : machines chaudes,
    // plans jetés.
    const catchupStart = nowSec - catchupDays * 86400;
    const warmupSlice = this.base1m.filter((c) => c.time < catchupStart);
    await this.engine.warmupAsync(warmupSlice, dailies, intraday, (done, total) => {
      if (done % 20000 === 0) say(`warmup ${done.toLocaleString()}/${total.toLocaleString()}`);
    });

    // Catchup : POCs par frontière de jour UTC (causal : données < frontière),
    // exactement la sémantique du cache pocs-day du backtest.
    const boundaries: number[] = [];
    for (let d = Math.floor(catchupStart / 86400) * 86400 + 86400; d <= nowSec; d += 86400) boundaries.push(d);
    for (const b of boundaries) {
      const poc = computePocUnion(this.srcDailies, this.intraday, b);
      this.engine.setPocLevels(poc.levels, poc.meta);
      this.engine.update(this.base1m, this.dailies, this.intraday, true, b - 1);
      // Mode test : chaque jour rejoué émet ses événements — pipeline
      // complet (messages, diffs plans/trades) sur des setups RÉELS.
      if (this.opts.testDays > 0) this.emitNew();
    }
    // POCs du jour courant + consommation jusqu'à la dernière clôturée.
    this.injectTodayPocs(nowSec);
    this.engine.update(this.base1m, this.dailies, this.intraday, false);
    if (this.opts.testDays > 0) this.emitNew();

    // Marquer comme vus les états reconstruits (pas de spam au démarrage).
    this.syncSeenState();
    this.booted = true;
    const snap = this.engine.getSnapshot(this.base1m[this.base1m.length - 1]?.close ?? null);
    const nPos = (snap.positions ?? []).length;
    say(`prêt · ${snap.pendingPlans.length} setup(s) en file · ${nPos} position(s) reconstruite(s)`);
    this.opts.telegram.send(`✅ ${symbol} en ligne · ${snap.pendingPlans.length} setup(s) en file · ${nPos} position(s)`);
  }

  // ═══════════════ LIVE ═══════════════
  async tick(): Promise<void> {
    if (!this.booted) return;
    const nowSec = Math.floor(Date.now() / 1000);
    try {
      // 1. Bougies 1m clôturées depuis le dernier poll.
      const recent = closedOnly(await fetchKlines({ symbol: this.symbol, interval: '1m', limit: 290 }), '1m', nowSec);
      const known = this.base1m.length > 0 ? this.base1m[this.base1m.length - 1].time : 0;
      let fresh = 0;
      for (const c of recent) {
        if (c.time > known) { this.base1m.push(c); fresh++; }
      }
      if (this.base1m.length > 220_000) this.base1m.splice(0, this.base1m.length - 160_000);

      // 2. Références : daily+1h Bybit toutes les 15 min ; dailies des
      //     sources POC toutes les 30 min (elles ne changent qu'à minuit,
      //     et le calcul du jour filtre < frontière de toute façon).
      if (nowSec - this.lastRefsAt > 900) {
        this.lastRefsAt = nowSec;
        const [d, i] = await Promise.all([
          fetchRange(this.symbol, 'D', nowSec - 500 * 86400, nowSec, 300),
          fetchRange(this.symbol, '60', nowSec - 60 * 86400, nowSec, 300),
        ]);
        this.dailies = d;
        this.intraday = i;
      }
      if (nowSec - this.lastSrcAt > 1800) {
        this.lastSrcAt = nowSec;
        const base2 = this.symbol.replace(/USDT$|USD$|USDC$/, '');
        for (let k = 0; k < this.srcDailies.length; k++) {
          this.srcDailies[k].dailies = await fetchSourceDaily(this.srcDailies[k].def, base2);
          await new Promise((r) => setTimeout(r, 250));
        }
      }

      // 3. Frontière de jour UTC → POCs du nouveau jour.
      const today = Math.floor(nowSec / 86400);
      if (today !== this.currentPocDay) {
        this.injectTodayPocs(nowSec);
        this.opts.telegram.send(`📅 ${this.symbol} · nouveau jour UTC · ${this.pocCount} POCs actifs`);
      }

      // 4. Moteur + émission des nouveaux événements. Attention : update()
      // REMPLACE baseBars par le tableau passé — donner le tableau COMPLET
      // (le scan de mèche adverse balaie baseBars depuis le peak de
      // référence, ne pas tronquer).
      if (fresh > 0) {
        this.engine.update(this.base1m, this.dailies, this.intraday, false);
        this.emitNew();
      }
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error(`[${this.symbol}] tick failed:`, this.lastError);
    }
  }

  /** État humain pour /status. */
  status(): { booted: boolean; openPositions: number; pending: number; lastEventAt: number | null; positionSummary: string[]; pocCount: number; lastError: string | null } {
    if (!this.booted) return { booted: false, openPositions: 0, pending: 0, lastEventAt: null, positionSummary: [], pocCount: 0, lastError: this.lastError };
    const last = this.base1m[this.base1m.length - 1]?.close ?? null;
    const snap = this.engine.getSnapshot(last);
    const summary: string[] = [];
    for (const p of (snap.positions ?? []) as Array<Record<string, unknown>>) {
      const plan = p.plan as { side: string; executionSeconds: number; entryLevels: number[] } | undefined;
      const fills = typeof p.fills === 'number' ? p.fills : 0;
      summary.push(`${plan?.side ?? '?'} ${Math.round((plan?.executionSeconds ?? 0) / 60)}m · fills ${fills}/${plan?.entryLevels.length ?? '?'} · TP suivant ${typeof p.nextTargetPrice === 'number' ? p.nextTargetPrice.toFixed(0) : '—'} · floating ${typeof p.floatingPnl === 'number' ? `${p.floatingPnl >= 0 ? '+' : ''}${p.floatingPnl.toFixed(0)}$` : '—'}`);
    }
    return {
      booted: true,
      openPositions: (snap.positions ?? []).length,
      pending: snap.pendingPlans.length,
      lastEventAt: this.lastEventAt,
      positionSummary: summary,
      pocCount: this.pocCount,
      lastError: this.lastError,
    };
  }

  // ═══════════════ interne ═══════════════
  private injectTodayPocs(nowSec: number): void {
    const todayStart = Math.floor(nowSec / 86400) * 86400;
    const poc = computePocUnion(this.srcDailies, this.intraday, todayStart);
    this.engine.setPocLevels(poc.levels, poc.meta);
    this.pocCount = poc.levels.length;
    this.currentPocDay = Math.floor(nowSec / 86400);
  }

  /** Marque plans/trades/journal courants comme vus (post-replay). */
  private syncSeenState(): void {
    const last = this.base1m[this.base1m.length - 1]?.close ?? null;
    const snap = this.engine.getSnapshot(last);
    for (const p of snap.pendingPlans) this.seenPlans.add(`${p.createdAt}|${p.executionSeconds}`);
    for (const t of snap.trades as ClosedTrade[]) this.seenTrades.add(`${t.exitAt}|${t.reason}|${t.pnl.toFixed(2)}`);
    this.lastJournalIdx = snap.journal.length;
    const j = snap.journal as JournalEntry[];
    if (j.length > 0) this.lastSentT = j[j.length - 1].t;
  }

  /** Taille le journal + détecte nouveaux setups/clôtures → messages. */
  private emitNew(): void {
    const last = this.base1m[this.base1m.length - 1]?.close ?? null;
    const snap = this.engine.getSnapshot(last);
    const journal = snap.journal as JournalEntry[];

    // Nouveaux SETUPS (message riche : entrées, AOI, TPs).
    for (const p of snap.pendingPlans) {
      const key = `${p.createdAt}|${p.executionSeconds}`;
      if (this.seenPlans.has(key)) continue;
      this.seenPlans.add(key);
      if (p.createdAt >= this.graceT) {
        this.opts.telegram.send(setupMessage(this.symbol, p));
      }
    }

    // Clôtures (couvre TP / BE / SL mèche / hard stop).
    for (const t of snap.trades as ClosedTrade[]) {
      const key = `${t.exitAt}|${t.reason}|${t.pnl.toFixed(2)}`;
      if (this.seenTrades.has(key)) continue;
      this.seenTrades.add(key);
      if (t.exitAt >= this.graceT) {
        this.opts.telegram.send(closeMessage(this.symbol, t));
      }
    }

    // Journal (fills, BE, SL, ladder, activations…).
    if (journal.length < this.lastJournalIdx) this.lastJournalIdx = journal.length; // trim
    for (let i = this.lastJournalIdx; i < journal.length; i++) {
      const e = journal[i];
      if (e.t < this.graceT || e.t <= this.lastSentT) continue;
      this.lastSentT = e.t;
      this.lastEventAt = e.t;
      const msg = eventMessage(this.symbol, e);
      if (msg) this.opts.telegram.send(msg);
    }
    this.lastJournalIdx = journal.length;
  }
}

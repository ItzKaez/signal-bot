/**
 * Configuration de la stratégie Peak/POC/Fib V2 — portage fidèle du moteur
 * quant-research (référence validée : V2 exécution + AOI ATR adaptatif +
 * stop dur 2×AOI + purge continue).
 *
 * Exécution MONO-timeframe : les signaux sont détectés uniquement sur la
 * timeframe affichée sur le graphique (chart 15m → peaks 15m, chart 1m →
 * peaks 1m). La cascade fibonacci reste ancrée sur le 4h pour les targets.
 */

export interface StrategyV2Config {
  /** Timeframe de base en secondes (= timeframe affichée sur le graphique). */
  baseIntervalSeconds: number;
  /** Timeframes d'exécution (détection des peaks) — uniquement la base. */
  executionSeconds: number[];
  /** Cascade fibonacci, du plus haut au plus bas timeframe. */
  fibonacciSeconds: number[];
  /** Nombre d'impulsions confirmées testées par TF (de la plus récente à la
   *  plus ancienne) — les fibs "à l'œil" utilisent souvent des swings anciens. */
  maxImpulsesPerTimeframe: number;
  rsiPeriod: number;
  overbought: number;
  oversold: number;
  midline: number;
  maxPeakAgeBars: number;
  pivotWindow: number;
  aoiAtrLength: number;
  aoiAtmAdaptiveWindow: number;
  aoiAtmAdaptiveGain: number;
  /** Extension POC de l'AOI : multiple max de l'AOI ATR (cap volatilité). */
  aoiPocExtendCapX: number;
  /** Extension POC de l'AOI : plafond absolu (ex. 0.015 = 1.5%). */
  aoiPocExtendMaxPct: number;
  goldenPocketShallow: number;
  goldenPocketDeep: number;
  minPocGroupSpacingPct: number;
  minRrToEffectiveTp1: number;
  riskPerTradePct: number;
  maxLeverage: number;
  feePctPerSide: number;
  slippagePctPerFill: number;
  forcedExitAoiMultiple: number;
  forcedExitConsecutiveCloses: number;
  hardExitAoiMultiple: number;
  /** Moment du break-even : à la confirmation de divergence (on_divergence),
   *  ou après TP1 (after_tp1).
   *  profit_close = ÉCHELLE : dès qu'une bougie CLÔTURE en profit → BE
   *  immédiat — au niveau couvrant les frais si le close l'atteint, sinon à
   *  la MOYENNE pure ; upgrade vers le niveau couvrant dès qu'un close
   *  ultérieur le permet. Un retournement scratche au lieu d'aller au SL. */
  breakevenMode: 'on_divergence' | 'after_tp1' | 'zone' | 'immediate' | 'profit_close';
  fallbackStopCapAoiMultiple: number;
  cancelLimitsOnPartialInvalidation: boolean;
  /** Hedging : plusieurs positions simultanées (sens opposés inclus), chacune
   *  gérée isolément — fills, stops, TPs et break-even d'un setup
   *  n'interfèrent jamais avec ceux d'un autre. false = comportement
   *  mono-position historique (une seule à la fois). */
  hedgingEnabled: boolean;
  /** Nombre maximal de positions actives en même temps (limites en attente
   *  incluses). Au-delà, les setups restent en file jusqu'à libération. */
  maxConcurrentPositions: number;
  /** Part du capital×levier engagementable en notional cumulé — les nouvelles
   *  positions sont taillées dans la marge restante (ex. 0.8 = 80%). */
  marginUtilizationCap: number;
  /** Part MAX du plafond de marge qu'UNE SEULE position peut consommer
   *  (1 = un setup peut tout prendre — le hedging meurt faute de marge ;
   *  0.5 = chaque setup laisse la moitié de la marge aux setups opposés).
   *  Un AOI petit → sizing risque-basé énorme → verrouillage : ce cap le
   *  prévient. */
  maxMarginSharePerPosition: number;
  /** Fenêtre glissante (bougies de base) pour les frames fibonacci/AOI :
   *  le moteur incrémental resample cette fenêtre alignée aux pas fib au
   *  moment de chaque plan (Wilder ATR exact au-delà de ~300 bougies).
   *  200000 bougies de 15m ≈ 5,7 ans : parité EXACTE avec l'ancien moteur
   *  (qui rebuildait sur tout le préfixe) sur toute période réaliste, tout
   *  en bornant les cas pathologiques. Réduire (ex. 20000 ≈ 7 mois) accélère
   *  les backtests très longs au prix d'une sélection fib légèrement
   *  différente sur les impulsions anciennes (~1,7% des signaux sur 3 ans). */
  fibWindowBars: number;
  // ═══ Levers de GESTION — stratégie "POCs Reversal Optimisé" ═══
  // Les DÉFAUTS reproduisent EXACTEMENT le comportement V2 (harnais de
  // parité : 0 diff). La strat Optimisée = mêmes moteurs, autres valeurs.
  /** Décalage du stop BE au-delà de la moyenne (ex. 0.0005 = +0,05% dans le
   *  sens du trade) : les sorties BE remboursent les frais au lieu de les
   *  perdre. 0 = BE à la moyenne exacte (V2). Ignored si breakevenCoverFees. */
  breakevenOffsetPct: number;
  /** BE à remboursement EXACT des frais : le niveau est calculé par position
   *  pour que la sortie nette du solde restant tombe à 0 — frais d'entrée
   *  (maker) + frais de sortie (taker, stop) + slippage de sortie (celui
   *  d'entrée est déjà dans la moyenne d'entrée). false = V2 (offset fixe). */
  breakevenCoverFees: boolean;
  /** Armement du SL mèche à la confirmation de div en loss : 'immediate'
   *  (V2), 'after_tp1' (seulement après un TP touché), 'off' (jamais —
   *  reposent sur le hard stop 2×AOI et la sortie forcée). */
  wickStopMode: 'immediate' | 'after_tp1' | 'off';
  /** Fractions de sortie aux TPs fib (0.5/0.382/0.236/0), dans l'ordre.
   *  Somme < 1 = résidu en runner géré par stops (moonbag implicite). */
  tpFractions: number[];
  /** Extensions moonbag AU-DELÀ du swing (mêmes spans fib, sens du trade) :
   *  ex. [1.618, 2.618, 3.618, 4.618] ajoute 4 TPs supplémentaires à
   *  swing ± span×extension, servis par tpFractions[4...]. [] = aucun (V2). */
  moonbagExtensions: number[];
  /** Expiration des limites non fillées en bougies de base (0 = jamais —
   *  l'invalidation seule décide, V2). */
  limitExpiryBars: number;
  /** Modèle de frais : 'flat' (feePctPerSide partout, V2) ou 'maker_taker'
   *  (entrées/TPs = maker, stops/sorties forcées = taker). */
  feeModel: 'flat' | 'maker_taker';
  makerFeePct: number;
  takerFeePct: number;
  // ═══ Filtres d'ENTRÉE (dérivés des buckets du Quant Report — 0/off =
  // comportement V2 exact, harnais de parité inchangé) ═══
  /** AOI minimum (fraction de l'entryPoc, ex. 0.01 = 1%) — les setups à AOI
   *  minuscule sont du chop : riskDist trop courte pour un RR sain et des
   *  limites remplies par du bruit. Rapport ETH 15m : AOI <1% = -1477$. */
  minAoiSizePct: number;
  /** Filtre de VOLATILITÉ (régime) : minimum d'EWMA du True Range %
   *  (pondération exponentielle — plus une bougie est récente, plus elle
   *  pèse) sur les volatilityLookbackBars dernières bougies. Ex. 0.0015 =
   *  rejeter les setups nés dans un régime mort (p10 historique 15m BTC ≈
   *  0.17%). Motivation : un spike de news au milieu d'un jour mort crée un
   *  peak dont l'AOI (ATR du régime mort) sera écrasée par l'expansion →
   *  sortie 1,5×AOI. 0 = off. */
  minVolatilityPct: number;
  /** Fenêtre effective de l'EWMA de volatilité (alpha = 2/(N+1)).
   *  96 = 24h en 15m. */
  volatilityLookbackBars: number;
  /** CONFLUENCE LIQUIDITÉ : concentration minimale du POC d'ENTRÉE —
   *  part du volume de la fenêtre (concLookbackDays) concentrée dans son
   *  bin, profil 24 bins (même math que le POC du quant-research, où
   *  conc ≥ 0.10 : PF 0.69 → 0.84 · ≥ 0.117 : PF 1.0 en IS). Un POC qui
   *  concentre ≥10% du volume = zone de liquidité dense (liquidations,
   *  ordres) : forte probabilité de reversion. 0 = off. */
  minPocConcentration: number;
  /** TF d'origine minimal du POC d'entree en SECONDES (86400 = 1D+,
   *  604800 = 1W+). Idee : plus le POC vient d'un TF eleve, plus le niveau
   *  est structurel. 0 = off. POC sans meta : passe. */
  minPocTfSec: number;
  /** STRATÉGIE LADDER 4 TF (30m > 15m > 5m > 1m, base 1m) : les DÉBUTS de
   *  setup sont limités aux N TF les plus hauts (ladderEntryTfCount) ; le
   *  plan d'ORIGINE reste INTÉGRAL (limites, AOI, stops, TPs) — montée et
   *  descente ne basculent que le setup SURVEILLÉ (peak de référence,
   *  divergences, invalidation) ; invalidation → descente en cascade vers le
   *  TF inférieur suivant au lieu du SL mèche ; fully filled ou TOUS
   *  invalidés → gestion normale / SL mèche. Nécessite executionSeconds
   *  multi-TF (ex. [60, 300, 900, 1800]) sur une base 1m. false = V2. */
  mtfLadderEnabled: boolean;
  /** Nombre de TF les plus hauts autorisés à DÉBUTER un setup en ladder
   *  (2 = 30m/15m). Les TF plus bas ne sont jamais des entrées : ils vivent
   *  en file comme cibles de descente (downgrade) — pour un futur accès en
   *  1m/5m il faudra 30m déjà OB/OS (règle 5, ladderLowTfZoneGated) ET une
   *  zone à forte confluence de liquidité (gros volume POC). */
  ladderEntryTfCount: number;
  /** Stratégie de POSE du SL mèche : 'standard' (à la clôture de l'événement,
   *  mèche jusqu'à cette bougie) ; 'breathe' (div en loss : PAS de mèche, le
   *  trade respire — BE à la première clôture en profit, mèche uniquement à
   *  la cassure réelle de la div, sans condition de TP) ; 'next_candle' (la
   *  mèche se pose à la bougie SUIVANTE — on ne se fait pas sortir par la
   *  mèche de la bougie cassante) ; 'sweep' (la bougie suivante doit SWEEPER
   *  l'extrême de la cassure puis réagir — le SL va sur la mèche du sweep ;
   *  sinon on attend, hard stop en filet) ; 'breathe_next_candle' (A+B :
   *  breathe sur la div en loss + mèche de la cassure posée à la bougie
   *  SUIVANTE — les deux leviers sont indépendants). */
  wickArmStrategy: 'standard' | 'breathe' | 'next_candle' | 'sweep' | 'breathe_next_candle';
  /** Agrégation de la liquidité de ZONE (filtre minPocConcentration) :
   *  'sum' = somme des concentrations du groupe (volume total de l'étagère),
   *  'avg' = moyenne (densité typique), 'max' = le meilleur POC de la zone. */
  pocZoneAgg: 'sum' | 'avg' | 'max';
  /** Cascade de DESCENTE activée ? false = aucune tentative de downgrade
   *  (règle 3 éteinte) : à l'invalidation, gestion normale (SL mèche selon
   *  wickStopMode, hard stop 2×AOI). La montée (règle 2) et la priorité
   *  au TF le plus haut (règle 1) restent actives. */
  ladderDowngradeEnabled: boolean;
  /** COUVERTURE NEWS-CANDLE : l'AOI est étendue pour couvrir la plus
   *  grosse bougie des aoiNewsCoverBars dernières (k× sa range en %).
   *  C'est la version RELATIVE du plancher : un spike de news au milieu
   *  d'un régime mort crée un peak dont l'AOI (ATR du régime d'avant) est
   *  plus petite que le mouvement en cours → sortie 1,5×AOI immédiate.
   *  0 = off. La mesure EWMA absolue ne discriminate PAS (tous les setups
   *  naissent en régime volatil) — c'est le ratio AOI/bougie-récente qui
   *  prédit l'écrasement. */
  aoiNewsCoverMult: number;
  /** Fenêtre de la bougie max (défaut 12 = 3h en 15m). */
  aoiNewsCoverBars: number;
  /** PLANCHER d'AOI (fraction de l'entryPoc, ex. 0.003 = 0,3%) : après le
   *  calcul ATR + l'englobement des groupes de POC adjacents, une AOI plus
   *  petite que ce plancher est ÉTENDUE jusqu'à lui (pas de rejet — le setup
   *  vit avec une zone plus large). 0 = off. Motivation : AOI minuscule =
   *  sizing énorme qui verrouille la marge et TPs en centimes. */
  minAoiFloorPct: number;
  /** Extrémité RSI maximum du peak (LONG: peakRsi · SHORT: 100−peakRsi ;
   *  100 = off). Plus petit = extrémité plus profonde exigée. Rapport ETH :
   *  0-25 = +2372$ · 25-30 = -1425$. */
  maxRsiExtremity: number;
  /** Plafond de niveaux d'entrée DCA (0 = illimité). Tronque APRÈS le POC
   *  d'entrée : garde les 1ères limites adverses, drop les plus profondes.
   *  Rapport ETH : 3+ fills = -882$ cumulés. */
  maxEntryLevels: number;
}

/** Construit la config pour une timeframe de base donnée (secondes). */
export function buildConfig(baseIntervalSeconds: number): StrategyV2Config {
  // Cascade fibonacci : TOUS les timeframes standards du TF du chart jusqu'au
  // 4h (du plus grand au plus petit). L'impulsion peut venir de n'importe
  // lequel — le setup est valide si l'entrée est dans le golden pocket et le
  // RR 1:1 (AOI→TP1) respecté, peu importe le timeframe.
  const ladder = [60, 180, 300, 900, 1800, 3600, 7200, 14400].filter((seconds) => seconds >= baseIntervalSeconds);
  const fibonacciSeconds = Array.from(new Set(ladder)).sort((a, b) => b - a);
  return {
    baseIntervalSeconds,
    executionSeconds: [baseIntervalSeconds],
    maxImpulsesPerTimeframe: 8,
    fibonacciSeconds,
    rsiPeriod: 14,
    overbought: 70,
    oversold: 30,
    midline: 50,
    maxPeakAgeBars: 25,
    pivotWindow: 2,
    aoiAtrLength: 14,
    aoiAtmAdaptiveWindow: 50,
    aoiAtmAdaptiveGain: 1.5,
    aoiPocExtendCapX: 4.0,
    aoiPocExtendMaxPct: 0.015,
    goldenPocketShallow: 0.618,
    goldenPocketDeep: 0.886,
    minPocGroupSpacingPct: 0.003,
    minRrToEffectiveTp1: 1.0,
    riskPerTradePct: 0.01,
    maxLeverage: 3.0,
    feePctPerSide: 0.0004, // prop breakout : 0.08% aller-retour
    slippagePctPerFill: 0.0001,
    forcedExitAoiMultiple: 2.0,
    forcedExitConsecutiveCloses: 2,
    hardExitAoiMultiple: 2.0,
    breakevenMode: 'on_divergence',
    fallbackStopCapAoiMultiple: 2.0,
    cancelLimitsOnPartialInvalidation: true,
    hedgingEnabled: true,
    maxConcurrentPositions: 4,
    marginUtilizationCap: 0.8,
    maxMarginSharePerPosition: 0.5,
    fibWindowBars: 200000,
    breakevenOffsetPct: 0,
    breakevenCoverFees: false,
    wickStopMode: 'immediate',
    tpFractions: [0.25, 0.25, 0.25, 0.25],
    moonbagExtensions: [],
    limitExpiryBars: 0,
    feeModel: 'flat',
    makerFeePct: 0.0002,
    takerFeePct: 0.00055,
    minAoiSizePct: 0,
    minAoiFloorPct: 0,
    minVolatilityPct: 0,
    volatilityLookbackBars: 96,
    aoiNewsCoverMult: 0,
    aoiNewsCoverBars: 12,
    minPocConcentration: 0,
    minPocTfSec: 0,
    mtfLadderEnabled: false,
    ladderEntryTfCount: 2,
    ladderDowngradeEnabled: true,
    pocZoneAgg: 'sum',
    wickArmStrategy: 'standard',
    maxRsiExtremity: 100,
    maxEntryLevels: 0,
  };
}

/** Préréglage "POCs Reversal Optimisé" — issus du sweep IS/OOS
 *  (scripts/sweep-optimized.ts + sweep-pass2.ts, rapports dans
 *  quant-research/reports/sweep_optimized*.json). Indicateurs V2 intouchés ;
 *  seuls ces 4 leviers de gestion ont battu la baseline sur les DEUX
 *  périodes (IS 2022-2024 ET OOS 2025-2026) :
 *    BE offset +0.05% (sorties BE remboursent les frais),
 *    hard stop 1.5×AOI (pertes pleines réduites d'un quart),
 *    expiration des limites à 24 bougies,
 *    frais maker/taker réalistes (entrées/TPs maker, stops taker).
 *  Résultats : IS -48$ (baseline -1358$) · OOS +2466$ PF 1.29 (baseline
 *  -399$) · DD ÷2 sur les deux périodes.
 *  Écartés comme overfits IS (se retournent en OOS) : wickStop off
 *  (+4807$ IS → -3749$ OOS), minRR 0.5, TP 40/30/20/10. */
export function buildOptimizedConfig(baseIntervalSeconds: number): StrategyV2Config {
  return {
    ...buildConfig(baseIntervalSeconds),
    // BE à remboursement EXACT : niveau calculé par position (frais
    // maker entrée + taker sortie + slippage sortie ≈ +0,085% avec les
    // frais actuels) — le fixe +0,05% laissait une petite perte nette.
    breakevenOffsetPct: 0,
    breakevenCoverFees: true,
    // BE échelle : toute clôture en profit arme le BE immédiatement (niveau
    // frais-couverts si atteignable, moyenne pure sinon, upgrade ensuite) —
    // une reversion scratche au lieu d'aller au stop dur.
    breakevenMode: 'profit_close',
    // Sweep 2023-2026 : SYNERGIE hard stop 2.0 + wick SL after_tp1 —
    // hard 2.0 seul : IS -1093 / OOS +1514 · + wick after_tp1 : IS +4809 /
    // OOS +931 (les deux périodes positives). Sans l'un ou l'autre ça
    // s'effondre (hard 1.5 + wick after_tp1 : IS -107 / OOS -517).
    // off == after_tp1 (plateau), hedging 4 : IS +4679 / OOS +559 (mono
    // meilleur). Sous-fenêtres : 2024H1 +1419 · 2024H2 +2462 · 2025H1 -25 ·
    // 2025H2 +2250 · 2026YTD -989.
    hardExitAoiMultiple: 2.0,
    wickStopMode: 'after_tp1',
    maxConcurrentPositions: 1,
    limitExpiryBars: 25,
    feeModel: 'maker_taker',
    // Plancher AOI 0,30% : AOI minuscule = sizing énorme (marge verrouillée)
    // et TPs en centimes — on élargit la zone au lieu de rejeter.
    minAoiFloorPct: 0.003,
    // Confluence liquidité : le POC d'entrée doit concentrer >=8% du volume
    // de SON profil de période (zone de liquidité dense). Validation IS+OOS
    // monotone : IS -2606->-1200$, OOS -2668->+1644$ PF 1.51 (74 trades).
    minPocConcentration: 0.07,
  // Sweep zone IS+OOS (16 runs) : avg@7% = les DEUX periodes positives
  // (IS +2983\$/161t PF1.28 · OOS +25\$/194t) — l'etagere doit etre dense
  // EN MOYENNE. Alternatives : sum@15% (+1660/+300, plus conservateur) ;
  // sum@10% meilleur en IS (+3303) mais OOS -964\$ (overfit IS).
  pocZoneAgg: 'avg',
  // Sweep mèche IS+OOS (5 variantes) : 'breathe' = PAS de mèche à la div
  // confirmée en loss (le trade respire, BE à la première clôture en
  // profit) ; la mèche ne se pose qu'à la CASSURE réelle de la div, sans
  // condition de TP. OOS : +1002\$/222t PF 1.11 WR 85% (standard: +25\$,
  // next_candle: +866\$, sweep: -24\$, breathe_next_candle: +415\$ — le
  // combo retarde la coupure de cassure et ne cumule pas). IS : +217\$
  // (standard +2983\$) — l'ancien régime préférait couper vite ; le régime
  // actuel (2025-26) paie le breathe.
  wickArmStrategy: 'breathe',
    // Couverture news-candle et filtre EWMA : TESTÉS ET ÉCARTÉS du preset
    // (IS 2023-24 : -2606 → -3045 $, PF 0.56 → 0.48 · OOS 2025-26 :
    // -2668 → -2815 $, PF 0.82 → 0.76 — le gain de drawdown ne compense
    // pas la perte de profit factor). Leviers dispo dans l'onglet.
    aoiNewsCoverMult: 0,
    minVolatilityPct: 0,
    // Levier réel de la prop firm (x10) : le plafond de marge du sizing
    // (capital x levier x utilisation) coupait les setups a petit AOI a
    // ~12k$ de notional -> risque reel 0,03% au lieu des 1% voulus, TPs en
    // centimes. x10 -> plafond 80k$, la taille risque-base passe bien plus
    // souvent.
    maxLeverage: 10,
  };
}

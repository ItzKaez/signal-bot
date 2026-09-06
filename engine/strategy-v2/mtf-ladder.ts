/**
 * LADDER MULTI-TF — orchestrateur de la stratégie « 4 TF en cascade »
 * (ex. 30m > 15m > 5m > 1m sur base 1m).
 *
 * RÈGLES (spécification utilisateur, rév. 2 — le plan d'origine est ROI) :
 *  1. ENTRÉE : les DÉBUTS de setup sont limités aux N TF les plus hauts
 *     (ladderEntryTfCount, défaut 2 = 30m/15m) — on joue toujours le plus
 *     élevé disponible. Les TF bas (1m/5m) ne sont JAMAIS des entrées : la
 *     porte OB/OS (règle 5) les rend quasi impossibles et il faudra en plus
 *     une zone à forte confluence de liquidité — ils ne servent que de
 *     cibles de descente.
 *  2. MONTÉE (trade ouvert, PAS encore fully filled) : à chaque bougie, si
 *     un setup d'un TF SUPÉRIEUR au setup SURVEILLÉ devient disponible →
 *     on bascule le REGARD sur lui. Le PLAN D'ORIGINE reste INTÉGRAL :
 *     limites DCA restantes, AOI, hard stop 2×AOI, TPs fib — RIEN ne
 *     change dans l'exécution. Seuls le peak de référence, les divergences
 *     et l'invalidation se lisent sur le TF supérieur.
 *  3. DESCENTE (invalidation du setup surveillé) : PAS de SL mèche — on
 *     cherche un setup sur le TF juste INFÉRIEUR, puis le suivant. Dès
 *     qu'un setup est dispo, le REGARD bascule dessus (exécution toujours
 *     celle du plan d'origine). La tentative est SANS condition de TP (la
 *     politique wickStopMode after_tp1 ne règle que l'armement du SL
 *     mèche, pas la cascade). Si AUCUN candidat n'est dispo à l'instant de
 *     l'invalidation : la position reste vivante (hard stop 2×AOI en
 *     filet) et la descente se RE-TENTE à chaque bougie — les peaks
 *     inférieurs nés du mouvement adverse sont confirmés quelques minutes
 *     plus tard. Depuis un TF inférieur, on re-vérifie la montée à chaque
 *     bougie (2).
 *  4. SORTIES : fully filled → gestion normale (SL mèche + BE échelle,
 *     plus de changement de regard) ; TOUS les TF invalidés (plus aucun
 *     setup dispo nulle part) → SL mèche — calculé sur la géométrie du
 *     PLAN D'ORIGINE (mèche adverse depuis le peak surveillé, cap 2×AOI).
 *
 * L'orchestrateur ne calcule RIEN lui-même : il classe, stocke et choisit.
 * Les plans restent produits par le moteur V2 (maybeCreatePlan), la gestion
 * de position reste celle du moteur — le ladder ne bascule que le setup
 * SURVEILLÉ (Position.ladderRef), jamais le plan d'exécution.
 */
import type { TradePlan } from './plans';

export interface LadderCandidate {
  plan: TradePlan;
  /** TF du plan en secondes. */
  tfSec: number;
  side: 'LONG' | 'SHORT';
  /** Toujours jouable (pas purgé par purgeReason). */
  valid: boolean;
}

/** TFs du ladder triés du plus haut au plus bas. */
export function ladderTfs(executionSeconds: number[]): number[] {
  return [...executionSeconds].sort((a, b) => b - a);
}

/**
 * Choisit le plan à ACTIVER parmi les candidats valides : celui du TF le
 * plus élevé (règle 1). Ex-aequo TF : le plus récent (createdAt max).
 */
export function pickHighestTf(candidates: LadderCandidate[]): LadderCandidate | null {
  const valid = candidates.filter((c) => c.valid);
  if (valid.length === 0) return null;
  return valid.reduce((best, c) =>
    c.tfSec > best.tfSec || (c.tfSec === best.tfSec && c.plan.createdAt > best.plan.createdAt) ? c : best,
  );
}

/**
 * Cherche un candidat de MONTÉE : setup valide sur un TF STRICTEMENT
 * supérieur au TF courant, même côté que la position (règle 2).
 */
export function findUpgrade(candidates: LadderCandidate[], side: 'LONG' | 'SHORT', currentTfSec: number): LadderCandidate | null {
  const ups = candidates.filter((c) => c.valid && c.side === side && c.tfSec > currentTfSec);
  return pickHighestTf(ups);
}

/**
 * Cherche un candidat de DESCENTE en cascade : le TF juste inférieur
 * d'abord, puis le suivant, jusqu'au plus bas (règle 3). Même côté.
 */
export function findDowngrade(candidates: LadderCandidate[], side: 'LONG' | 'SHORT', currentTfSec: number, tfsDesc: number[]): LadderCandidate | null {
  // tfsDesc : TFs triés du plus haut au plus bas. On prend les TFs
  // STRICTEMENT inférieurs au courant, et on les parcours du plus haut
  // (le « juste en dessous ») vers le plus bas.
  for (const tf of tfsDesc) {
    if (tf >= currentTfSec) continue;
    const c = candidates.find((x) => x.valid && x.side === side && x.tfSec === tf);
    if (c) return c;
  }
  return null;
}

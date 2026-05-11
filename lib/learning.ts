// Auto-learning system. Records the factors behind every pick, updates
// per-factor win rates as bets resolve, and exposes a weights-injection
// helper so Claude's future picks weight the most-rewarding signals heavier.
//
// All functions are best-effort: a learning-pipeline failure must never
// break pick generation or result settlement. Errors are caught + logged.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Bet, KeyStat, Pick } from './types';

type PickWithFactors = Partial<Pick> & {
  id: string;
  sport: string;
  pick: string;
  odds_decimal: number;
  bet_type: string;
};

interface FactorMap {
  [key: string]: boolean | string | null;
}

function keyStatsArray(ks: Pick['key_stats']): KeyStat[] {
  if (Array.isArray(ks)) return ks as KeyStat[];
  return [];
}

function statMatch(stats: KeyStat[], label: string, predicate: (v: number) => boolean): boolean {
  for (const s of stats) {
    if (!s?.label || !s?.value) continue;
    if (!s.label.toLowerCase().includes(label.toLowerCase())) continue;
    const m = String(s.value).match(/-?\d+(\.\d+)?/);
    if (!m) continue;
    const n = parseFloat(m[0]);
    if (Number.isFinite(n) && predicate(n)) return true;
  }
  return false;
}

function statHasLabel(stats: KeyStat[], ...needles: string[]): boolean {
  for (const s of stats) {
    if (!s?.label) continue;
    const lbl = s.label.toLowerCase();
    if (needles.some((n) => lbl.includes(n.toLowerCase()))) return true;
  }
  return false;
}

function oddsRange(odds: number): string {
  if (odds < 1.5) return 'heavy_fav';
  if (odds < 2.0) return 'moderate_fav';
  if (odds < 2.5) return 'slight_fav';
  return 'underdog';
}

function confidenceRange(c: number | null | undefined): string {
  const n = Number(c ?? 0);
  if (n >= 85) return '85+';
  if (n >= 70) return '70-84';
  return '55-69';
}

export function extractFactors(pick: PickWithFactors): FactorMap {
  const stats = keyStatsArray(pick.key_stats ?? null);
  const odds = Number(pick.odds_decimal);
  const edge = Number(pick.edge ?? 0);
  const league = (pick.league ?? '').toLowerCase();
  const firstWordOfPick = pick.pick.split(/\s+/)[0]?.toLowerCase() ?? '';
  const homeName = (pick.home_team ?? '').toLowerCase();

  return {
    home_team: homeName.length > 0 && homeName.includes(firstWordOfPick),
    home_favorite: odds < 2.0,

    pitcher_era_under_3: statMatch(stats, 'ERA', (v) => v < 3.0),
    pitcher_era_under_4: statMatch(stats, 'ERA', (v) => v < 4.0),
    pitcher_k9_over_9: statMatch(stats, 'K/9', (v) => v > 9.0),

    // Renamed from sharp_confirms (Pinnacle-based, dead). Now reflects whether
    // both market sources (DraftKings ML + ESPN BPI) agreed on the edge.
    market_consensus_ok: (pick.market_sources_count ?? 0) >= 2,
    edge_over_5: edge > 0.05,
    edge_over_7: edge > 0.07,

    odds_range: oddsRange(odds),

    has_trap_warning: !!pick.trap_warning,
    is_playoff: league.includes('playoff') || league.includes('postseason'),

    tier: pick.tier ?? null,
    confidence_range: confidenceRange(pick.confidence ?? null),

    bet_type: pick.bet_type,
    sport: pick.sport,

    outdoor_game: statHasLabel(stats, 'Weather', 'Viento', 'Wind'),

    has_regression_flag: !!pick.regression_flags,
    has_line_movement: !!pick.line_movement_note,
  };
}

export async function recordPickFactors(
  supabase: SupabaseClient,
  pick: PickWithFactors,
): Promise<void> {
  try {
    const factors = extractFactors(pick);
    const { error } = await supabase.from('pick_factors').insert({
      pick_id: pick.id,
      sport: pick.sport,
      factors,
    });
    if (error) console.error('[learning] recordPickFactors insert failed', error);
  } catch (e) {
    console.error('[learning] recordPickFactors threw', e);
  }
}

export async function updateFactorPerformance(
  supabase: SupabaseClient,
  bet: Bet,
): Promise<void> {
  try {
    if (!bet.pick_id) return;
    if (bet.result !== 'win' && bet.result !== 'loss') return;

    const { data: pf } = await supabase
      .from('pick_factors')
      .select('*')
      .eq('pick_id', bet.pick_id)
      .maybeSingle();
    if (!pf) return;

    const isWin = bet.result === 'win';
    const amount = Number(bet.amount);
    const payout = Number(bet.payout ?? 0);
    const profit = isWin ? payout - amount : -amount;

    await supabase
      .from('pick_factors')
      .update({ bet_id: bet.id, result: bet.result, profit })
      .eq('id', pf.id);

    const factors = (pf.factors ?? {}) as FactorMap;
    const sport = pf.sport ?? bet.sport;

    for (const [factorName, factorValue] of Object.entries(factors)) {
      if (factorValue === false || factorValue === null || factorValue === undefined) continue;
      const valueStr = String(factorValue);

      const { data: existing } = await supabase
        .from('factor_performance')
        .select('*')
        .eq('factor_name', factorName)
        .eq('factor_value', valueStr)
        .eq('sport', sport)
        .maybeSingle();

      if (existing) {
        const newWins = Number(existing.wins) + (isWin ? 1 : 0);
        const newLosses = Number(existing.losses) + (isWin ? 0 : 1);
        const newTotal = Number(existing.total_picks) + 1;
        const newProfit = Number(existing.total_profit) + profit;
        await supabase
          .from('factor_performance')
          .update({
            wins: newWins,
            losses: newLosses,
            total_picks: newTotal,
            total_profit: newProfit,
            win_rate: newTotal > 0 ? newWins / newTotal : 0,
            last_updated: new Date().toISOString(),
          })
          .eq('id', existing.id);
      } else {
        await supabase.from('factor_performance').insert({
          factor_name: factorName,
          factor_value: valueStr,
          sport,
          total_picks: 1,
          wins: isWin ? 1 : 0,
          losses: isWin ? 0 : 1,
          total_profit: profit,
          win_rate: isWin ? 1 : 0,
        });
      }
    }
  } catch (e) {
    console.error('[learning] updateFactorPerformance threw', e);
  }
}

export async function getWeightsForPrompt(supabase: SupabaseClient): Promise<string> {
  try {
    const { data: weights } = await supabase
      .from('system_weights')
      .select('*')
      .gt('sample_size', 19)
      .order('weight', { ascending: false });
    if (!weights || weights.length === 0) return '';

    let prompt = '\nPESOS APRENDIDOS DEL SISTEMA (basados en historial real):\n';
    for (const w of weights) {
      const impact =
        Number(w.weight) >= 1.5
          ? 'MÁS importancia'
          : Number(w.weight) <= 0.5
            ? 'MENOS importancia'
            : 'importancia normal';
      prompt += `- ${w.factor_name} (${w.sport}): peso ${w.weight} — darle ${impact}\n`;
    }
    prompt +=
      '\nUsa estos pesos para ajustar tu análisis. Los factores con peso alto deben influir más en tu decisión.\n';
    return prompt;
  } catch (e) {
    console.error('[learning] getWeightsForPrompt threw', e);
    return '';
  }
}

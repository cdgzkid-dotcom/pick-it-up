// Line-movement / reverse-line-movement (RLM) detection.
// Captures opening odds the first time we see a game today, then on each
// subsequent run compares current consensus odds to those openings.
//
// RLM heuristic (no public-money data available on free tier — using book
// behavior as proxy):
//   • Implied prob shift > +5% on the *underdog* side = sharps on the dog.
//     Public bets favorites, so a dog price shortening is usually sharp $$.
//   • The *favorite* side of that game is then the RLM-trap candidate.
//   • Implied prob shift > +8% on either side regardless of opener = steam.

import type { SupabaseClient } from '@supabase/supabase-js';

export interface OpeningRow {
  espn_event_id: string;
  sport: string;
  game_label?: string | null;
  home_team?: string | null;
  away_team?: string | null;
  home_ml_open: number | null;
  away_ml_open: number | null;
  spread_line_open?: number | null;
  spread_home_odds_open?: number | null;
  total_line_open?: number | null;
  over_odds_open?: number | null;
  under_odds_open?: number | null;
  opened_at: string;
}

export interface MovementSignal {
  /** "home" or "away" — side whose implied prob increased (price shortened). */
  steam_side?: 'home' | 'away';
  /** Implied-prob delta (current - opening). Positive = shortened. */
  home_delta?: number;
  away_delta?: number;
  /** True when shortening happened on the side that was the underdog at open. */
  rlm: boolean;
  /** Which side is the suspected trap (the favorite when RLM on dog). */
  rlm_trap_side?: 'home' | 'away';
  /** Human-readable summary for the prompt + analysis. */
  note: string;
  home_ml_open?: number;
  away_ml_open?: number;
  home_ml_now: number;
  away_ml_now: number;
}

export async function captureOrLoadOpening(
  supabase: SupabaseClient,
  row: {
    espn_event_id: string;
    sport: string;
    game_label?: string | null;
    home_team?: string | null;
    away_team?: string | null;
    home_ml_now?: number | null;
    away_ml_now?: number | null;
    spread_line?: number | null;
    spread_home_odds?: number | null;
    total_line?: number | null;
    over_odds?: number | null;
    under_odds?: number | null;
  },
): Promise<OpeningRow | null> {
  if (!row.espn_event_id) return null;
  const { data: existing } = await supabase
    .from('line_openings')
    .select('*')
    .eq('espn_event_id', row.espn_event_id)
    .maybeSingle();

  if (existing) return existing as OpeningRow;
  if (!row.home_ml_now || !row.away_ml_now) return null;

  const payload = {
    espn_event_id: row.espn_event_id,
    sport: row.sport,
    game_label: row.game_label ?? null,
    home_team: row.home_team ?? null,
    away_team: row.away_team ?? null,
    home_ml_open: row.home_ml_now,
    away_ml_open: row.away_ml_now,
    spread_line_open: row.spread_line ?? null,
    spread_home_odds_open: row.spread_home_odds ?? null,
    total_line_open: row.total_line ?? null,
    over_odds_open: row.over_odds ?? null,
    under_odds_open: row.under_odds ?? null,
  };
  const { data: inserted, error } = await supabase
    .from('line_openings')
    .insert(payload)
    .select()
    .single();
  if (error) {
    console.warn(`[lineMovement] insert failed for ${row.espn_event_id}`, error.message);
    return null;
  }
  return inserted as OpeningRow;
}

export function computeMovement(
  opening: OpeningRow,
  homeMlNow: number,
  awayMlNow: number,
): MovementSignal | null {
  if (!opening.home_ml_open || !opening.away_ml_open) return null;

  const homeOpenProb = 1 / opening.home_ml_open;
  const awayOpenProb = 1 / opening.away_ml_open;
  const homeNowProb = 1 / homeMlNow;
  const awayNowProb = 1 / awayMlNow;
  const homeDelta = homeNowProb - homeOpenProb;
  const awayDelta = awayNowProb - awayOpenProb;

  const STEAM_THRESHOLD = 0.05; // 5pp implied-prob shift

  let steamSide: 'home' | 'away' | undefined;
  if (Math.abs(homeDelta) >= STEAM_THRESHOLD || Math.abs(awayDelta) >= STEAM_THRESHOLD) {
    steamSide = Math.abs(homeDelta) > Math.abs(awayDelta) ? 'home' : 'away';
  }

  // RLM: a side whose opening was the underdog (<0.50 implied) shortened.
  let rlm = false;
  let trapSide: 'home' | 'away' | undefined;
  if (homeDelta >= STEAM_THRESHOLD && homeOpenProb < 0.5) {
    rlm = true;
    trapSide = 'away';
  } else if (awayDelta >= STEAM_THRESHOLD && awayOpenProb < 0.5) {
    rlm = true;
    trapSide = 'home';
  }

  const noteBits: string[] = [];
  if (rlm && trapSide) {
    const sharpSide = trapSide === 'home' ? 'visitante' : 'local';
    noteBits.push(
      `RLM detectado: dinero sharp en ${sharpSide} (línea se acortó de ${
        trapSide === 'home' ? opening.away_ml_open?.toFixed(2) : opening.home_ml_open?.toFixed(2)
      } a ${trapSide === 'home' ? awayMlNow.toFixed(2) : homeMlNow.toFixed(2)})`,
    );
  } else if (steamSide) {
    const dir = steamSide === 'home' ? homeDelta : awayDelta;
    const open = steamSide === 'home' ? opening.home_ml_open : opening.away_ml_open;
    const now = steamSide === 'home' ? homeMlNow : awayMlNow;
    noteBits.push(
      `Movimiento ${dir > 0 ? 'a favor' : 'en contra'} del ${steamSide === 'home' ? 'local' : 'visitante'}: ${open?.toFixed(2)} → ${now.toFixed(2)}`,
    );
  }

  if (!steamSide && !rlm) return null;

  return {
    steam_side: steamSide,
    home_delta: homeDelta,
    away_delta: awayDelta,
    rlm,
    rlm_trap_side: trapSide,
    note: noteBits.join(' · '),
    home_ml_open: opening.home_ml_open ?? undefined,
    away_ml_open: opening.away_ml_open ?? undefined,
    home_ml_now: homeMlNow,
    away_ml_now: awayMlNow,
  };
}

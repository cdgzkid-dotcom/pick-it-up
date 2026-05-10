import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import type { Pick } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Returns picks that the AI generated today but the user hasn't yet bet on
 * (status='pending'). Used by ManualBetForm to surface the un-bet picks
 * before falling back to fully-manual entry.
 */
export async function GET() {
  const supabase = supabaseAdmin();
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from('picks')
    .select(
      'id, sport, game, home_team, away_team, home_team_abbr, away_team_abbr, espn_event_id, pick, bet_type, odds_decimal, tier, recommended_amount, confidence, real_probability, edge',
    )
    .gte('updated_at', since)
    .eq('status', 'pending')
    .order('edge', { ascending: false });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ picks: (data as Partial<Pick>[]) ?? [] });
}

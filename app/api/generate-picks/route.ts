import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase';
import { fetchGames, fetchInjuriesForSports } from '@/lib/espn';
import { analyzeGames } from '@/lib/pickGen';
import type { Game } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_GAMES_PER_REQUEST = 10;

const RequestSchema = z.object({
  sports: z.array(z.string()).min(1),
  event_ids: z.array(z.string()).optional(),
});

function competitiveness(g: Game): number {
  const h = g.odds.moneyline?.home;
  if (!h || !Number.isFinite(h)) return Number.POSITIVE_INFINITY;
  return Math.abs(0.5 - 1 / h);
}

function selectTopGames(games: Game[], requestedSports: string[], max: number): Game[] {
  const bySport: Record<string, Game[]> = {};
  for (const g of games) (bySport[g.sport] ??= []).push(g);
  for (const s of Object.keys(bySport)) {
    bySport[s].sort((a, b) => competitiveness(a) - competitiveness(b));
  }
  const order = requestedSports.filter((s) => (bySport[s]?.length ?? 0) > 0);
  const result: Game[] = [];
  while (result.length < max && order.some((s) => bySport[s].length > 0)) {
    for (const s of order) {
      if (result.length >= max) break;
      const next = bySport[s].shift();
      if (next) result.push(next);
    }
  }
  return result;
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Bad request', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const t0 = Date.now();
  console.log(`[generate-picks] start sports=${parsed.data.sports.join(',')}`);

  let games: Game[];
  let injuriesByTeam: Record<string, Record<string, { player: string; position?: string; status: string; detail?: string }[]>> = {};
  try {
    const [g, inj] = await Promise.all([
      fetchGames(parsed.data.sports),
      fetchInjuriesForSports(parsed.data.sports),
    ]);
    games = g;
    injuriesByTeam = inj;
  } catch (err) {
    console.error('[generate-picks] ESPN fetch failed', err);
    return NextResponse.json(
      { error: 'No se pudo conectar con ESPN', detail: (err as Error).message },
      { status: 502 },
    );
  }

  for (const g of games) {
    const sportInjuries = injuriesByTeam[g.sport] ?? {};
    const homeInj = sportInjuries[g.home_team] ?? [];
    const awayInj = sportInjuries[g.away_team] ?? [];
    const merged = [...awayInj, ...homeInj];
    if (merged.length > 0) g.injuries = merged;
  }

  if (games.length === 0) {
    return NextResponse.json({
      analyzed: 0,
      total_available: 0,
      with_edge: 0,
      inserted: 0,
      updated: 0,
      message: 'No hay juegos con momios disponibles en los deportes seleccionados',
    });
  }

  const totalAvailable = games.length;
  let toAnalyze: Game[];
  if (parsed.data.event_ids && parsed.data.event_ids.length > 0) {
    const set = new Set(parsed.data.event_ids);
    toAnalyze = games.filter((g) => g.espn_event_id && set.has(g.espn_event_id));
  } else {
    toAnalyze = selectTopGames(games, parsed.data.sports, MAX_GAMES_PER_REQUEST);
  }

  console.log(`[generate-picks] analyzing ${toAnalyze.length} of ${totalAvailable}`);

  const supabase = supabaseAdmin();
  const { data: settingsRow, error: settingsErr } = await supabase
    .from('settings')
    .select('bankroll_current, unit_percentage')
    .eq('id', 1)
    .single();
  if (settingsErr) {
    return NextResponse.json({ error: 'Settings missing', detail: settingsErr.message }, { status: 500 });
  }

  let result;
  try {
    result = await analyzeGames(toAnalyze, supabase, {
      bankroll: Number(settingsRow.bankroll_current),
      unitPercentage: Number(settingsRow.unit_percentage),
    });
  } catch (e) {
    return NextResponse.json({ error: 'Analyze failed', detail: (e as Error).message }, { status: 500 });
  }

  console.log(`[generate-picks] done in ${Date.now() - t0}ms`);

  return NextResponse.json({
    analyzed: toAnalyze.length,
    total_available: totalAvailable,
    with_edge: result.withEdge,
    parlays: result.parlayCount,
    inserted: result.inserted,
    updated: result.updated,
    timestamp: new Date().toISOString(),
  });
}

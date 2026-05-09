import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreateBetSchema = z.object({
  pick_id: z.string().uuid().optional().nullable(),
  sport: z.string(),
  game: z.string(),
  home_team: z.string().optional().nullable(),
  away_team: z.string().optional().nullable(),
  home_team_abbr: z.string().optional().nullable(),
  away_team_abbr: z.string().optional().nullable(),
  pick: z.string(),
  bet_type: z.string(),
  odds_decimal: z.coerce.number().positive(),
  amount: z.coerce.number().positive(),
  tier: z.enum(['lock', 'strong', 'value', 'parlay']).optional().nullable(),
  date: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = CreateBetSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Bad request', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const supabase = supabaseAdmin();
  const { pick_id, ...fields } = parsed.data;

  const { data: bet, error } = await supabase
    .from('bets')
    .insert([{ ...fields, pick_id: pick_id ?? null, result: 'pending' }])
    .select()
    .single();
  if (error) {
    return NextResponse.json({ error: 'Insert failed', detail: error.message }, { status: 500 });
  }

  if (pick_id) {
    await supabase.from('picks').update({ status: 'bet' }).eq('id', pick_id);
  }

  return NextResponse.json(bet);
}

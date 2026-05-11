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
  espn_event_id: z.string().optional().nullable(),
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
    console.error('[POST /api/bets] validation failed', JSON.stringify(parsed.error.flatten()), 'body:', JSON.stringify(body));
    return NextResponse.json(
      { error: 'Bad request', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  console.log(`[POST /api/bets] ${parsed.data.pick_id ? 'pick' : 'MANUAL'} ${parsed.data.pick} ${parsed.data.bet_type} @${parsed.data.odds_decimal} $${parsed.data.amount} (${parsed.data.sport})`);

  const supabase = supabaseAdmin();
  const { pick_id, ...fields } = parsed.data;

  if (pick_id) {
    const { data: existing } = await supabase
      .from('bets')
      .select('id')
      .eq('pick_id', pick_id)
      .maybeSingle();
    if (existing) {
      return NextResponse.json(
        { error: 'Ya apostaste en este pick', existing_bet_id: existing.id },
        { status: 409 },
      );
    }
  }

  // If the pick has an espn_event_id / game_start_time, copy to the bet
  let espn_event_id = fields.espn_event_id ?? null;
  let game_start_time: string | null = null;
  if (pick_id) {
    const { data: pickRow } = await supabase
      .from('picks')
      .select('espn_event_id, game_start_time')
      .eq('id', pick_id)
      .maybeSingle();
    if (!espn_event_id) espn_event_id = pickRow?.espn_event_id ?? null;
    game_start_time = pickRow?.game_start_time ?? null;
  }

  // Get current bankroll
  const { data: settings, error: settingsErr } = await supabase
    .from('settings')
    .select('bankroll_current')
    .eq('id', 1)
    .single();
  if (settingsErr) {
    return NextResponse.json({ error: 'Settings missing' }, { status: 500 });
  }
  const currentBankroll = Number(settings.bankroll_current);
  const newBankroll = currentBankroll - fields.amount;

  // Insert the bet — capture odds_at_bet for CLV tracking
  const { data: bet, error } = await supabase
    .from('bets')
    .insert([{
      ...fields,
      espn_event_id,
      game_start_time,
      pick_id: pick_id ?? null,
      result: 'pending',
      odds_at_bet: fields.odds_decimal,
    }])
    .select()
    .single();
  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { error: 'Ya apostaste en este pick' },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: 'Insert failed', detail: error.message }, { status: 500 });
  }

  // ATOMICITY GUARD: verify bet was actually persisted before touching bankroll
  if (!bet || !bet.id) {
    return NextResponse.json(
      { error: 'Insert returned no data — bet not created. Bankroll untouched.' },
      { status: 500 },
    );
  }

  // Double-check bet exists in DB before deducting
  const { data: verified } = await supabase.from('bets').select('id').eq('id', bet.id).maybeSingle();
  if (!verified) {
    return NextResponse.json(
      { error: 'Bet not found after insert — possible timeout. Bankroll untouched.' },
      { status: 500 },
    );
  }

  // Deduct bankroll + log (only after confirmed bet exists)
  const { error: bankrollErr } = await supabase
    .from('settings')
    .update({ bankroll_current: newBankroll })
    .eq('id', 1);
  if (bankrollErr) {
    // Rollback: delete the bet since bankroll couldn't be deducted
    await supabase.from('bets').delete().eq('id', bet.id);
    return NextResponse.json(
      { error: 'Bankroll update failed — bet rolled back.', detail: bankrollErr.message },
      { status: 500 },
    );
  }

  await supabase.from('bankroll_log').insert([
    {
      type: 'stake',
      amount: -fields.amount,
      balance_after: newBankroll,
      note: `Apuesta: ${fields.pick} (${fields.game})`,
    },
  ]);

  if (pick_id) {
    await supabase.from('picks').update({ status: 'bet' }).eq('id', pick_id);
  }

  return NextResponse.json({ ...bet, bankroll_current: newBankroll });
}

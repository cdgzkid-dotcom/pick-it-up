import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const supabase = supabaseAdmin();

  const { data: pending, error: fetchErr } = await supabase
    .from('bets')
    .select('id, pick_id')
    .eq('result', 'pending');
  if (fetchErr) {
    return NextResponse.json({ error: 'Fetch failed', detail: fetchErr.message }, { status: 500 });
  }
  if (!pending || pending.length === 0) {
    return NextResponse.json({ ok: true, deleted: 0 });
  }

  const ids = pending.map((b) => b.id);
  const pickIds = pending.map((b) => b.pick_id).filter((x): x is string => Boolean(x));

  const { error: delErr } = await supabase.from('bets').delete().in('id', ids);
  if (delErr) {
    return NextResponse.json({ error: 'Delete failed', detail: delErr.message }, { status: 500 });
  }

  if (pickIds.length > 0) {
    await supabase.from('picks').update({ status: 'pending' }).in('id', pickIds);
  }

  return NextResponse.json({ ok: true, deleted: ids.length });
}

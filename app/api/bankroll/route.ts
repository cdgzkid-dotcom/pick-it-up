import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PatchSchema = z.object({
  bankroll_current: z.coerce.number().nonnegative(),
  unit_percentage: z.coerce.number().positive().optional(),
  note: z.string().optional(),
});

export async function PATCH(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Bad request', detail: parsed.error.flatten() }, { status: 400 });
  }

  const supabase = supabaseAdmin();
  const { data: prev, error: prevErr } = await supabase
    .from('settings')
    .select('bankroll_current, unit_percentage')
    .eq('id', 1)
    .single();
  if (prevErr) {
    return NextResponse.json({ error: 'Settings missing', detail: prevErr.message }, { status: 500 });
  }

  const updates: Record<string, number> = { bankroll_current: parsed.data.bankroll_current };
  if (parsed.data.unit_percentage !== undefined) {
    updates.unit_percentage = parsed.data.unit_percentage;
  }
  const { error: updErr } = await supabase.from('settings').update(updates).eq('id', 1);
  if (updErr) {
    return NextResponse.json({ error: 'Update failed', detail: updErr.message }, { status: 500 });
  }

  const delta = parsed.data.bankroll_current - Number(prev.bankroll_current);
  if (delta !== 0) {
    await supabase.from('bankroll_log').insert([{
      type: delta > 0 ? 'deposit' : 'withdraw',
      amount: delta,
      balance_after: parsed.data.bankroll_current,
      note: parsed.data.note ?? 'Edición manual de bankroll',
    }]);
  }

  return NextResponse.json({ ok: true, bankroll_current: parsed.data.bankroll_current });
}

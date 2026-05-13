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

  const delta = parsed.data.bankroll_current - Number(prev.bankroll_current);

  // unit_percentage is a separate, non-bankroll setting — update it
  // directly (no log entry needed) before/after the atomic adjust.
  if (parsed.data.unit_percentage !== undefined) {
    const { error: upErr } = await supabase
      .from('settings')
      .update({ unit_percentage: parsed.data.unit_percentage })
      .eq('id', 1);
    if (upErr) {
      return NextResponse.json({ error: 'Update failed', detail: upErr.message }, { status: 500 });
    }
  }

  // bankroll change goes through the atomic RPC: UPDATE settings +
  // INSERT bankroll_log in a single PL/pgSQL block.
  if (delta !== 0) {
    const { data: rpcData, error: rpcErr } = await supabase.rpc('adjust_bankroll_atomic', {
      p_delta: delta,
      p_type: delta > 0 ? 'deposit' : 'withdraw',
      p_note: parsed.data.note ?? 'Edición manual de bankroll',
    });
    if (rpcErr) {
      const msg = rpcErr.message ?? '';
      if (msg.startsWith('negative_bankroll_blocked')) {
        return NextResponse.json({ error: 'Bankroll resultaría negativo', detail: msg }, { status: 409 });
      }
      return NextResponse.json({ error: 'adjust_bankroll_atomic failed', detail: msg }, { status: 500 });
    }
    const result = rpcData as { ok: boolean; bankroll_current: number };
    return NextResponse.json({ ok: true, bankroll_current: result.bankroll_current });
  }

  return NextResponse.json({ ok: true, bankroll_current: parsed.data.bankroll_current });
}

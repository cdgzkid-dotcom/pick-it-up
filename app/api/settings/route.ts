import { NextResponse } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PatchSchema = z.object({
  auto_sports: z.array(z.string()).optional(),
  auto_enabled: z.boolean().optional(),
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
  const updates: Record<string, unknown> = {};
  if (parsed.data.auto_sports !== undefined) updates.auto_sports = parsed.data.auto_sports;
  if (parsed.data.auto_enabled !== undefined) updates.auto_enabled = parsed.data.auto_enabled;
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }

  const supabase = supabaseAdmin();
  const { error } = await supabase.from('settings').update(updates).eq('id', 1);
  if (error) {
    return NextResponse.json({ error: 'Update failed', detail: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, ...updates });
}

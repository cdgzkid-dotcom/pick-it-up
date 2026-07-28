import { NextResponse } from 'next/server';
import { supabaseAdmin } from './supabase';

/**
 * Kill switch gate (route layer). settings.system_enabled = false means the
 * system writes NOTHING: pick generation, bet resolution and bankroll moves
 * all stop. Distinct from auto_enabled, which only pauses automatic pick
 * generation while bets keep resolving.
 *
 * Returns a 503 with a distinguishable body when disabled, so "switched off
 * on purpose" can never be confused with "silently broken" from a curl.
 * Null means enabled — proceed. A missing/unreadable settings row degrades
 * to enabled so a broken singleton can't brick the app.
 *
 * The route gates are convenience (clean 503s); the guard that cannot be
 * bypassed lives in the atomic RPCs (assert_system_enabled, migration
 * 20260728120000_kill_switch.sql).
 */
export async function systemDisabledResponse(
  caller: string,
): Promise<NextResponse | null> {
  try {
    const { data } = await supabaseAdmin()
      .from('settings')
      .select('system_enabled, system_disabled_reason')
      .eq('id', 1)
      .single();
    if (data && data.system_enabled === false) {
      console.log(
        `[kill-switch] ${caller} blocked — system_disabled` +
          (data.system_disabled_reason ? `: ${data.system_disabled_reason}` : ''),
      );
      return NextResponse.json(
        { error: 'system_disabled', reason: data.system_disabled_reason ?? null },
        { status: 503 },
      );
    }
  } catch (e) {
    console.error(`[kill-switch] ${caller} check failed — treating as enabled`, e);
  }
  return null;
}

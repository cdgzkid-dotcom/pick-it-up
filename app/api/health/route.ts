import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface HealthCheckResult {
  name: string;
  status: 'ok' | 'warning' | 'error' | 'expected_unsupported';
  detail?: string;
  duration_ms?: number;
}

async function checkEnvVars(): Promise<HealthCheckResult> {
  const required = [
    'ANTHROPIC_API_KEY',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    'SUPABASE_SERVICE_ROLE_KEY',
    'CRON_SECRET',
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  ];
  const missing: string[] = [];
  const empty: string[] = [];
  for (const v of required) {
    const val = process.env[v];
    if (val === undefined) missing.push(v);
    else if (val === '' || val === '""') empty.push(v);
  }
  if (missing.length > 0 || empty.length > 0) {
    return {
      name: 'env_vars',
      status: 'error',
      detail: `missing=${missing.join(',')} empty=${empty.join(',')}`,
    };
  }
  return { name: 'env_vars', status: 'ok' };
}

async function checkSupabase(): Promise<HealthCheckResult> {
  const t0 = Date.now();
  try {
    const sb = supabaseAdmin();
    const { error } = await sb.from('settings').select('id').eq('id', 1).single();
    if (error) {
      return {
        name: 'supabase_connection',
        status: 'error',
        detail: error.message,
        duration_ms: Date.now() - t0,
      };
    }
    return { name: 'supabase_connection', status: 'ok', duration_ms: Date.now() - t0 };
  } catch (e) {
    return {
      name: 'supabase_connection',
      status: 'error',
      detail: (e as Error).message,
      duration_ms: Date.now() - t0,
    };
  }
}

async function checkDbColumns(): Promise<HealthCheckResult> {
  // Verifica que TODAS las columnas críticas existen. Si falta cualquiera,
  // el SELECT tira error con el nombre de la columna faltante — así sabemos
  // inmediatamente si una migration se perdió.
  const t0 = Date.now();
  try {
    const sb = supabaseAdmin();
    const { error } = await sb
      .from('picks')
      .select(
        [
          'id',
          // CAPA 2 lock-in
          'locked_at',
          'original_real_probability',
          'original_odds',
          'reanalysis_count',
          'lock_reason',
          // Gate del floor + audit
          'edge_vs_market',
          'market_consensus_implied',
          'market_sources_count',
          'market_sources',
          'floor_applied',
          'confidence_raw',
        ].join(', '),
      )
      .limit(1);
    if (error) {
      return {
        name: 'db_columns',
        status: 'error',
        detail: error.message,
        duration_ms: Date.now() - t0,
      };
    }
    return { name: 'db_columns', status: 'ok', duration_ms: Date.now() - t0 };
  } catch (e) {
    return {
      name: 'db_columns',
      status: 'error',
      detail: (e as Error).message,
      duration_ms: Date.now() - t0,
    };
  }
}

async function checkEspnScoreboard(): Promise<HealthCheckResult> {
  const t0 = Date.now();
  try {
    const res = await fetch(
      'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard',
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) {
      return {
        name: 'espn_scoreboard',
        status: 'error',
        detail: `HTTP ${res.status}`,
        duration_ms: Date.now() - t0,
      };
    }
    const data = (await res.json()) as { events?: unknown[] };
    return {
      name: 'espn_scoreboard',
      status: 'ok',
      detail: `${data.events?.length ?? 0} events`,
      duration_ms: Date.now() - t0,
    };
  } catch (e) {
    return {
      name: 'espn_scoreboard',
      status: 'error',
      detail: (e as Error).message,
      duration_ms: Date.now() - t0,
    };
  }
}

async function checkEspnPredictor(
  sport: 'mlb' | 'nba' | 'nfl' | 'nhl',
): Promise<HealthCheckResult> {
  const t0 = Date.now();
  const sportMap: Record<typeof sport, string> = {
    mlb: 'baseball/mlb',
    nba: 'basketball/nba',
    nfl: 'football/nfl',
    nhl: 'hockey/nhl',
  };
  try {
    const sbRes = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/${sportMap[sport]}/scoreboard`,
      { signal: AbortSignal.timeout(5000) },
    );
    const sbData = (await sbRes.json()) as { events?: Array<{ id: string }> };
    const eventId = sbData.events?.[0]?.id;
    if (!eventId) {
      return {
        name: `espn_predictor_${sport}`,
        status: 'warning',
        detail: 'no event to test',
        duration_ms: Date.now() - t0,
      };
    }

    const [coreSport, coreLeague] = sportMap[sport].split('/');
    const predRes = await fetch(
      `https://sports.core.api.espn.com/v2/sports/${coreSport}/leagues/${coreLeague}/events/${eventId}/competitions/${eventId}/predictor`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!predRes.ok) {
      return {
        name: `espn_predictor_${sport}`,
        status: 'error',
        detail: `HTTP ${predRes.status}`,
        duration_ms: Date.now() - t0,
      };
    }
    const predData = (await predRes.json()) as { error?: unknown; homeTeam?: unknown };

    if (predData.error) {
      if (sport === 'nhl') {
        return {
          name: `espn_predictor_${sport}`,
          status: 'expected_unsupported',
          detail: 'NHL not supported by ESPN BPI',
          duration_ms: Date.now() - t0,
        };
      }
      return {
        name: `espn_predictor_${sport}`,
        status: 'error',
        detail: 'predictor returned error',
        duration_ms: Date.now() - t0,
      };
    }
    return { name: `espn_predictor_${sport}`, status: 'ok', duration_ms: Date.now() - t0 };
  } catch (e) {
    return {
      name: `espn_predictor_${sport}`,
      status: 'error',
      detail: (e as Error).message,
      duration_ms: Date.now() - t0,
    };
  }
}

async function checkAnthropic(): Promise<HealthCheckResult> {
  // Test mínimo: POST a Haiku con max_tokens=5. ~$0.0001 por check.
  const t0 = Date.now();
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'ok' }],
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text();
      return {
        name: 'anthropic_api',
        status: 'error',
        detail: `HTTP ${res.status}: ${body.slice(0, 100)}`,
        duration_ms: Date.now() - t0,
      };
    }
    return { name: 'anthropic_api', status: 'ok', duration_ms: Date.now() - t0 };
  } catch (e) {
    return {
      name: 'anthropic_api',
      status: 'error',
      detail: (e as Error).message,
      duration_ms: Date.now() - t0,
    };
  }
}

async function checkTelegram(): Promise<HealthCheckResult> {
  // getMe es trivial y NO manda mensaje. Solo verifica que el bot existe y la key sirve.
  const t0 = Date.now();
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN || '';
    if (!token) {
      return { name: 'telegram_bot', status: 'error', detail: 'TELEGRAM_BOT_TOKEN empty' };
    }
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return {
        name: 'telegram_bot',
        status: 'error',
        detail: `HTTP ${res.status}`,
        duration_ms: Date.now() - t0,
      };
    }
    return { name: 'telegram_bot', status: 'ok', duration_ms: Date.now() - t0 };
  } catch (e) {
    return {
      name: 'telegram_bot',
      status: 'error',
      detail: (e as Error).message,
      duration_ms: Date.now() - t0,
    };
  }
}

async function checkRecentCronActivity(): Promise<HealthCheckResult> {
  // Verifica que el cron de analyze corrió en los últimos 15 min (corre cada
  // 10 min por GitHub Actions, así que 15 min es un buffer razonable).
  // Severidad ERROR si no hay run — si el cron está muerto, queremos HTTP 503
  // del health para que el heartbeat lo reporte como crítico.
  const t0 = Date.now();
  try {
    const sb = supabaseAdmin();
    const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { data, error } = await sb
      .from('cron_runs')
      .select('started_at, duration_ms, generated_picks, errors')
      .eq('workflow', 'analyze')
      .gt('started_at', cutoff)
      .order('started_at', { ascending: false })
      .limit(1);
    if (error) {
      return {
        name: 'recent_cron_activity',
        status: 'error',
        detail: error.message,
        duration_ms: Date.now() - t0,
      };
    }
    if (!data || data.length === 0) {
      return {
        name: 'recent_cron_activity',
        status: 'error',
        detail: 'no cron run in last 15 min',
        duration_ms: Date.now() - t0,
      };
    }
    const last = data[0];
    if (last.errors) {
      return {
        name: 'recent_cron_activity',
        status: 'warning',
        detail: `last run had errors: ${JSON.stringify(last.errors).slice(0, 150)}`,
        duration_ms: Date.now() - t0,
      };
    }
    return {
      name: 'recent_cron_activity',
      status: 'ok',
      detail: `last run ${last.started_at} (${last.duration_ms}ms, ${last.generated_picks} picks)`,
      duration_ms: Date.now() - t0,
    };
  } catch (e) {
    return {
      name: 'recent_cron_activity',
      status: 'error',
      detail: (e as Error).message,
      duration_ms: Date.now() - t0,
    };
  }
}

async function checkStuckPendingBets(): Promise<HealthCheckResult> {
  // Bets pending donde game_start_time es >24h en el pasado → check-results no las cazó.
  const t0 = Date.now();
  try {
    const sb = supabaseAdmin();
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await sb
      .from('bets')
      .select('id, pick, game_start_time')
      .eq('result', 'pending')
      .lt('game_start_time', cutoff);
    if (error) {
      return {
        name: 'stuck_bets',
        status: 'warning',
        detail: error.message,
        duration_ms: Date.now() - t0,
      };
    }
    const count = data?.length ?? 0;
    if (count > 0) {
      return {
        name: 'stuck_bets',
        status: 'error',
        detail: `${count} bets stuck pending >24h: ${data.map((b) => b.pick).join(', ').slice(0, 200)}`,
        duration_ms: Date.now() - t0,
      };
    }
    return { name: 'stuck_bets', status: 'ok', duration_ms: Date.now() - t0 };
  } catch (e) {
    return {
      name: 'stuck_bets',
      status: 'warning',
      detail: (e as Error).message,
      duration_ms: Date.now() - t0,
    };
  }
}

async function checkRecentPickStructure(): Promise<HealthCheckResult> {
  // Verifica que picks recientes tienen los campos esperados poblados.
  // Detecta si CAPA 1/2/3 dejaron de poblar campos críticos.
  const t0 = Date.now();
  try {
    const sb = supabaseAdmin();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await sb
      .from('picks')
      .select('id, edge_vs_market, market_sources_count, floor_applied, locked_at, confidence_raw')
      .gte('created_at', since)
      .eq('is_parlay', false)
      .neq('status', 'analyzed_no_odds_data')
      .limit(10);
    if (error) {
      return {
        name: 'recent_pick_structure',
        status: 'warning',
        detail: error.message,
        duration_ms: Date.now() - t0,
      };
    }
    if (!data || data.length === 0) {
      return {
        name: 'recent_pick_structure',
        status: 'warning',
        detail: 'no picks in last 24h to check',
        duration_ms: Date.now() - t0,
      };
    }

    const missingLocked = data.filter((p) => !p.locked_at).length;
    const missingConfRaw = data.filter((p) => p.confidence_raw === null).length;
    const missingFloor = data.filter((p) => p.floor_applied === null).length;
    if (missingLocked > data.length / 2) {
      return {
        name: 'recent_pick_structure',
        status: 'error',
        detail: `${missingLocked}/${data.length} picks missing locked_at (CAPA 2 broken)`,
        duration_ms: Date.now() - t0,
      };
    }
    if (missingConfRaw > data.length / 2) {
      return {
        name: 'recent_pick_structure',
        status: 'error',
        detail: `${missingConfRaw}/${data.length} picks missing confidence_raw (gate audit broken)`,
        duration_ms: Date.now() - t0,
      };
    }
    return {
      name: 'recent_pick_structure',
      status: 'ok',
      detail: `${data.length} picks checked, ${missingLocked} missing lock, ${missingConfRaw} missing conf_raw, ${missingFloor} missing floor`,
      duration_ms: Date.now() - t0,
    };
  } catch (e) {
    return {
      name: 'recent_pick_structure',
      status: 'warning',
      detail: (e as Error).message,
      duration_ms: Date.now() - t0,
    };
  }
}

export async function GET() {
  const t0 = Date.now();
  const checks = await Promise.all([
    checkEnvVars(),
    checkSupabase(),
    checkDbColumns(),
    checkEspnScoreboard(),
    checkEspnPredictor('mlb'),
    checkEspnPredictor('nba'),
    checkEspnPredictor('nfl'),
    checkEspnPredictor('nhl'),
    checkAnthropic(),
    checkTelegram(),
    checkRecentCronActivity(),
    checkStuckPendingBets(),
    checkRecentPickStructure(),
  ]);
  const errors = checks.filter((c) => c.status === 'error');
  const warnings = checks.filter((c) => c.status === 'warning');
  return NextResponse.json(
    {
      ok: errors.length === 0,
      summary: {
        total: checks.length,
        ok: checks.filter((c) => c.status === 'ok' || c.status === 'expected_unsupported').length,
        warnings: warnings.length,
        errors: errors.length,
      },
      duration_ms: Date.now() - t0,
      timestamp: new Date().toISOString(),
      checks,
    },
    { status: errors.length > 0 ? 503 : 200 },
  );
}

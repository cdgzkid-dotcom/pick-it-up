// Supabase-backed cache for external API responses. Keeps us under the
// free-tier rate limits (Odds API 500/mo, etc.) and speeds up the pickGen
// pipeline by reusing slow stats fetches across games in the same batch.
//
// TTL guidelines used by callers:
//   standings: 120 min (rarely change mid-day)
//   team season stats: 240 min
//   pitcher season stats: 120 min
//   probable pitchers (today): 30 min (can swap last minute)
//   odds: 5 min (move fast)
//   weather: 30 min
//   lineups: do NOT cache (final lineup may post 5min before first pitch)

import { supabaseAdmin } from './supabase';

interface CacheRow<T = unknown> {
  data: T;
  expires_at: string;
}

// Maps are not JSON-serializable as own properties: JSON.stringify(new Map([[1,'a']]))
// returns '{}', which Supabase then stores verbatim. On cache hit, the plain object
// would be cast back to Map<...> and `.get()` would throw TypeError. Wrap Maps in a
// small envelope so we can round-trip them through JSONB.
const MAP_MARK = '__map__';

function pack(value: unknown): unknown {
  if (value instanceof Map) {
    return { [MAP_MARK]: Array.from(value.entries()) };
  }
  return value;
}

function unpack<T>(value: unknown): T {
  if (
    value !== null &&
    typeof value === 'object' &&
    MAP_MARK in (value as Record<string, unknown>)
  ) {
    const entries = (value as Record<string, unknown>)[MAP_MARK] as Array<[unknown, unknown]>;
    return new Map(entries) as unknown as T;
  }
  return value as T;
}

export async function cached<T>(
  key: string,
  ttlMinutes: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const supabase = supabaseAdmin();
  try {
    const { data: row } = await supabase
      .from('data_cache')
      .select('data, expires_at')
      .eq('cache_key', key)
      .maybeSingle();
    if (row && new Date((row as CacheRow).expires_at) > new Date()) {
      return unpack<T>((row as CacheRow).data);
    }
  } catch (e) {
    console.warn(`[cache] read failed for ${key}`, e);
  }

  const fresh = await fetcher();

  try {
    await supabase.from('data_cache').upsert({
      cache_key: key,
      data: pack(fresh),
      expires_at: new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
    });
  } catch (e) {
    console.warn(`[cache] write failed for ${key}`, e);
  }

  return fresh;
}

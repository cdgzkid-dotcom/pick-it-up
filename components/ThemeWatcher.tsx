'use client';
import { useEffect } from 'react';

const COORDS = { lat: 20.6597, lng: -103.3496 };
const CACHE_KEY = 'pick-it-up:sun';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const RECHECK_INTERVAL_MS = 30 * 60 * 1000;
const CDMX_OFFSET_MS = -6 * 60 * 60 * 1000;

const FALLBACK_LIGHT_START = 6 + 45 / 60;
const FALLBACK_DARK_START = 19 + 15 / 60;

interface CachedSun {
  sunrise: string;
  sunset: string;
  fetched_at: number;
}

function cdmxNow() {
  const d = new Date(Date.now() + CDMX_OFFSET_MS);
  return {
    dateStr: d.toISOString().slice(0, 10),
    hourFrac: d.getUTCHours() + d.getUTCMinutes() / 60,
    iso: d.toISOString(),
  };
}

function applyFromTimes(sunriseRaw: string, sunsetRaw: string): void {
  const now = Date.now();
  const sunriseMs = new Date(sunriseRaw).getTime();
  const sunsetMs = new Date(sunsetRaw).getTime();
  const isLight = now >= sunriseMs && now < sunsetMs;
  const cdmx = cdmxNow();
  console.log('[ThemeWatcher] apply', {
    sunriseRaw,
    sunsetRaw,
    sunriseCdmx: new Date(sunriseMs + CDMX_OFFSET_MS).toISOString(),
    sunsetCdmx: new Date(sunsetMs + CDMX_OFFSET_MS).toISOString(),
    nowUtc: new Date(now).toISOString(),
    nowCdmx: cdmx.iso,
    theme: isLight ? 'light' : 'dark',
  });
  document.documentElement.classList.toggle('light', isLight);
}

function applyFallback(): void {
  const { hourFrac, iso } = cdmxNow();
  const isLight = hourFrac >= FALLBACK_LIGHT_START && hourFrac < FALLBACK_DARK_START;
  console.log('[ThemeWatcher] fallback', {
    nowCdmx: iso,
    hourFrac,
    lightStart: FALLBACK_LIGHT_START,
    darkStart: FALLBACK_DARK_START,
    theme: isLight ? 'light' : 'dark',
  });
  document.documentElement.classList.toggle('light', isLight);
}

function readCache(): CachedSun | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as CachedSun;
    if (!c.sunrise || !c.sunset || !c.fetched_at) return null;
    if (Date.now() - c.fetched_at > CACHE_TTL_MS) return null;
    return c;
  } catch {
    return null;
  }
}

export default function ThemeWatcher() {
  useEffect(() => {
    let cancelled = false;

    async function refresh(): Promise<void> {
      try {
        const cached = readCache();
        if (cached) {
          console.log('[ThemeWatcher] cache hit', cached);
          if (!cancelled) applyFromTimes(cached.sunrise, cached.sunset);
          return;
        }
        const { dateStr } = cdmxNow();
        const url = `https://api.sunrise-sunset.org/json?lat=${COORDS.lat}&lng=${COORDS.lng}&formatted=0&date=${dateStr}`;
        console.log('[ThemeWatcher] fetching', url);
        const r = await fetch(url);
        if (!r.ok) throw new Error(`sun api ${r.status}`);
        const d = (await r.json()) as {
          status: string;
          results?: { sunrise: string; sunset: string };
        };
        if (d.status !== 'OK' || !d.results) throw new Error('sun api bad payload');
        console.log('[ThemeWatcher] api results', d.results);
        try {
          localStorage.setItem(
            CACHE_KEY,
            JSON.stringify({
              sunrise: d.results.sunrise,
              sunset: d.results.sunset,
              fetched_at: Date.now(),
            }),
          );
        } catch {
          /* localStorage full or disabled */
        }
        if (!cancelled) applyFromTimes(d.results.sunrise, d.results.sunset);
      } catch (e) {
        console.warn('[ThemeWatcher] refresh failed', e);
        if (!cancelled) applyFallback();
      }
    }

    refresh();
    const interval = setInterval(refresh, RECHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return null;
}

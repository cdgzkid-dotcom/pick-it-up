'use client';
import { useEffect } from 'react';

// Guadalajara — same TZ as CDMX (UTC-6 year round)
const COORDS = { lat: 20.6597, lng: -103.3496 };
const CACHE_KEY = 'pick-it-up:sun';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const RECHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 min

interface CachedSun {
  sunrise: string; // ISO UTC
  sunset: string; // ISO UTC
  fetched_at: number;
}

function applyTheme(sunriseMs: number, sunsetMs: number): void {
  const now = Date.now();
  const isLight = now >= sunriseMs && now < sunsetMs;
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

/**
 * Watches sunrise/sunset for Guadalajara and switches the `light` class on
 * <html> accordingly. On mount: refreshes from sunrise-sunset.org if the
 * 24h cache is stale, otherwise uses cached values. Re-evaluates every
 * 30 min so the theme flips at the sun crossings without a page refresh.
 *
 * The inline bootstrap script in app/layout.tsx already applied an initial
 * class (from cache or 7-20 fallback) before paint, so this component
 * only needs to handle cache refresh + interval recheck.
 */
export default function ThemeWatcher() {
  useEffect(() => {
    let cancelled = false;

    async function refresh(): Promise<void> {
      try {
        const cached = readCache();
        let sunriseMs: number;
        let sunsetMs: number;
        if (cached) {
          sunriseMs = new Date(cached.sunrise).getTime();
          sunsetMs = new Date(cached.sunset).getTime();
        } else {
          const r = await fetch(
            `https://api.sunrise-sunset.org/json?lat=${COORDS.lat}&lng=${COORDS.lng}&formatted=0&date=today`,
          );
          if (!r.ok) throw new Error(`sun api ${r.status}`);
          const d = (await r.json()) as { status: string; results?: { sunrise: string; sunset: string } };
          if (d.status !== 'OK' || !d.results) throw new Error('sun api bad payload');
          sunriseMs = new Date(d.results.sunrise).getTime();
          sunsetMs = new Date(d.results.sunset).getTime();
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
            /* localStorage full or disabled — ignore */
          }
        }
        if (!cancelled) applyTheme(sunriseMs, sunsetMs);
      } catch {
        // Inline bootstrap already applied a sane default. Do nothing.
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

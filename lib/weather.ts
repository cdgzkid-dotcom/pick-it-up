// OpenWeather API integration (https://api.openweathermap.org).
// Free tier: 1,000 calls/day, 5-day forecast in 3-hour increments.
// Optional — if WEATHER_API_KEY isn't set or hasn't activated, returns null
// and Claude analyzes without weather context. Mostly useful for outdoor MLB
// and NFL games.
//
// IMPORTANT: newly-issued OpenWeather keys take up to 2 hours to activate.
// If you see 401 errors in logs right after setting the key, wait.

export interface GameWeather {
  temp_f: number;
  wind_mph: number;
  wind_dir: string;
  humidity: number;
  precip_chance: number;
  condition: string;
  is_dome?: boolean;
}

// MLB venue → coordinates. Indoor/retractable-roof venues are flagged so we
// skip the API call (weather doesn't matter inside a dome).
const MLB_VENUES: Record<string, { lat: number; lon: number; dome?: boolean }> = {
  'American Family Field': { lat: 43.0283, lon: -87.9711, dome: true }, // retractable
  'Angel Stadium': { lat: 33.8003, lon: -117.8827 },
  'Busch Stadium': { lat: 38.6226, lon: -90.1928 },
  'Chase Field': { lat: 33.4453, lon: -112.0667, dome: true }, // retractable
  'Citi Field': { lat: 40.7571, lon: -73.8458 },
  'Citizens Bank Park': { lat: 39.9061, lon: -75.1665 },
  'Comerica Park': { lat: 42.339, lon: -83.0485 },
  'Coors Field': { lat: 39.7559, lon: -104.9942 },
  'Daikin Park': { lat: 29.7572, lon: -95.3553, dome: true }, // Astros (was Minute Maid Park)
  'Minute Maid Park': { lat: 29.7572, lon: -95.3553, dome: true },
  'Dodger Stadium': { lat: 34.0739, lon: -118.24 },
  'Fenway Park': { lat: 42.3467, lon: -71.0972 },
  'George M. Steinbrenner Field': { lat: 27.9789, lon: -82.5067 },
  'Globe Life Field': { lat: 32.7473, lon: -97.0817, dome: true }, // retractable
  'Great American Ball Park': { lat: 39.0974, lon: -84.5071 },
  'Guaranteed Rate Field': { lat: 41.83, lon: -87.6339 },
  'Rate Field': { lat: 41.83, lon: -87.6339 },
  'Kauffman Stadium': { lat: 39.0517, lon: -94.4803 },
  'LoanDepot Park': { lat: 25.7781, lon: -80.2197, dome: true }, // retractable
  'Nationals Park': { lat: 38.873, lon: -77.0074 },
  'Oakland Coliseum': { lat: 37.7516, lon: -122.2008 },
  'Oracle Park': { lat: 37.7786, lon: -122.3893 },
  'Oriole Park at Camden Yards': { lat: 39.2839, lon: -76.6217 },
  'Petco Park': { lat: 32.7073, lon: -117.157 },
  'PNC Park': { lat: 40.4469, lon: -80.0058 },
  'Progressive Field': { lat: 41.4962, lon: -81.6852 },
  'Rogers Centre': { lat: 43.6414, lon: -79.3894, dome: true }, // retractable
  'Sutter Health Park': { lat: 38.5803, lon: -121.5133 },
  'T-Mobile Park': { lat: 47.5914, lon: -122.3325, dome: true }, // retractable
  'Target Field': { lat: 44.9817, lon: -93.2776 },
  'Tropicana Field': { lat: 27.7682, lon: -82.6534, dome: true }, // fixed roof
  'Truist Park': { lat: 33.8908, lon: -84.4678 },
  'Wrigley Field': { lat: 41.9484, lon: -87.6553 },
  'Yankee Stadium': { lat: 40.8296, lon: -73.9262 },
};

// NFL outdoor stadiums (subset — domes excluded)
const NFL_VENUES: Record<string, { lat: number; lon: number; dome?: boolean }> = {
  'Lambeau Field': { lat: 44.5013, lon: -88.0622 },
  'Soldier Field': { lat: 41.8625, lon: -87.6166 },
  'Highmark Stadium': { lat: 42.7738, lon: -78.787 },
  'MetLife Stadium': { lat: 40.8135, lon: -74.0744 },
  'Lincoln Financial Field': { lat: 39.9008, lon: -75.1675 },
  'Bank of America Stadium': { lat: 35.2258, lon: -80.8528 },
  'Empower Field at Mile High': { lat: 39.7439, lon: -105.02 },
  'GEHA Field at Arrowhead Stadium': { lat: 39.0489, lon: -94.4839 },
  'Allegiant Stadium': { lat: 36.0909, lon: -115.1833, dome: true },
  'Caesars Superdome': { lat: 29.9509, lon: -90.0815, dome: true },
  'AT&T Stadium': { lat: 32.7473, lon: -97.0945, dome: true },
  'Mercedes-Benz Stadium': { lat: 33.7553, lon: -84.4006, dome: true },
  'NRG Stadium': { lat: 29.6847, lon: -95.4107, dome: true },
  'State Farm Stadium': { lat: 33.5276, lon: -112.2626, dome: true },
  'U.S. Bank Stadium': { lat: 44.9736, lon: -93.2575, dome: true },
  'Lucas Oil Stadium': { lat: 39.7601, lon: -86.1639, dome: true },
  'Ford Field': { lat: 42.34, lon: -83.0456, dome: true },
};

const VENUES = { ...MLB_VENUES, ...NFL_VENUES };

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
function degToCompass(deg: number): string {
  if (!Number.isFinite(deg)) return '';
  const ix = Math.round(((deg % 360) + 360) % 360 / 22.5) % 16;
  return COMPASS[ix];
}

export function isDome(venue?: string | null): boolean {
  if (!venue) return false;
  const v = VENUES[venue];
  return v?.dome === true;
}

interface OpenWeatherForecastResp {
  cod?: string | number;
  message?: string;
  list?: Array<{
    dt: number; // unix seconds
    main?: { temp?: number; humidity?: number; feels_like?: number };
    weather?: Array<{ main?: string; description?: string }>;
    wind?: { speed?: number; deg?: number };
    pop?: number; // 0..1
    rain?: { '3h'?: number };
  }>;
}

export async function fetchGameWeather(
  venue: string | null | undefined,
  isoTime: string | null | undefined,
): Promise<GameWeather | null> {
  if (!venue || !isoTime) return null;
  const v = VENUES[venue];
  if (!v) return null;
  if (v.dome) {
    return { temp_f: 72, wind_mph: 0, wind_dir: '', humidity: 50, precip_chance: 0, condition: 'Indoor', is_dome: true };
  }

  const apiKey = process.env.WEATHER_API_KEY;
  if (!apiKey) return null;

  try {
    // OpenWeather 5-day / 3-hour forecast. Returns "list" of forecast points.
    const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${v.lat}&lon=${v.lon}&appid=${apiKey}&units=imperial`;
    const r = await fetch(url, { next: { revalidate: 1800 } });
    if (!r.ok) {
      if (r.status === 401) {
        console.warn('[weather] OpenWeather 401 — key not activated yet (can take up to 2hrs)');
      } else {
        console.warn(`[weather] OpenWeather HTTP ${r.status}`);
      }
      return null;
    }
    const data: OpenWeatherForecastResp = await r.json();
    if (!data.list || data.list.length === 0) return null;

    // Pick the forecast point closest to game start time
    const target = new Date(isoTime).getTime();
    let best = data.list[0];
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const slot of data.list) {
      const delta = Math.abs(slot.dt * 1000 - target);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = slot;
      }
    }

    return {
      temp_f: best.main?.temp ?? 70,
      wind_mph: best.wind?.speed ?? 0,
      wind_dir: degToCompass(best.wind?.deg ?? 0),
      humidity: best.main?.humidity ?? 50,
      precip_chance: Math.round(((best.pop ?? 0) as number) * 100),
      condition: best.weather?.[0]?.description ?? best.weather?.[0]?.main ?? '',
    };
  } catch (e) {
    console.warn('[weather] fetch threw', e);
    return null;
  }
}

export function venueOf(notableStats: Record<string, unknown> | undefined): string | null {
  return (notableStats?.venue as string) ?? null;
}

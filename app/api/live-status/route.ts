import { NextResponse } from 'next/server';
import { fetchLiveStatus, type EventStatus } from '@/lib/espn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

interface EventRequest {
  sport: string;
  event_id: string;
  game_start_time?: string | null;
}

interface Body {
  events?: EventRequest[];
}

export type EventLiveResult =
  | { status: EventStatus }
  | { not_found: true }
  | { source_error: string };

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const events = Array.isArray(body.events) ? body.events : [];
  if (events.length === 0) {
    return NextResponse.json({ statuses: {} });
  }

  const results = await Promise.all(
    events.map(async (e): Promise<[string, EventLiveResult] | null> => {
      if (!e?.event_id) return null;
      if (!e.sport) {
        return [e.event_id, { source_error: 'missing_sport' }];
      }
      try {
        const status = await fetchLiveStatus(e.sport, e.event_id, e.game_start_time);
        if (!status) {
          return [e.event_id, { not_found: true }];
        }
        return [e.event_id, { status }];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return [e.event_id, { source_error: msg || 'source_error' }];
      }
    }),
  );

  const statuses: Record<string, EventLiveResult> = {};
  for (const item of results) {
    if (item) {
      const [id, res] = item;
      statuses[id] = res;
    }
  }

  return NextResponse.json({ statuses });
}

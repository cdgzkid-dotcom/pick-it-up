import { NextResponse } from 'next/server';
import { fetchLiveStatus } from '@/lib/espn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

interface Body {
  events?: Array<{ sport: string; event_id: string; game_start_time?: string | null }>;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Body | null;
  const events = body?.events ?? [];
  if (events.length === 0) {
    return NextResponse.json({ statuses: {} });
  }

  const results = await Promise.all(
    events.map(async (e) => {
      if (!e?.sport || !e?.event_id) return [e?.event_id ?? '', null] as const;
      try {
        const status = await fetchLiveStatus(e.sport, e.event_id, e.game_start_time);
        return [e.event_id, status] as const;
      } catch {
        return [e.event_id, null] as const;
      }
    }),
  );

  const statuses: Record<string, unknown> = {};
  for (const [id, status] of results) {
    if (id && status) statuses[id] = status;
  }

  return NextResponse.json({ statuses });
}

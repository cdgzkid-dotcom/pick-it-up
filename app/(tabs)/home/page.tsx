import { supabaseAdmin } from '@/lib/supabase';
import BankrollEditor from '@/components/BankrollEditor';
import BetResolver from '@/components/BetResolver';
import ResultsRefresher from '@/components/ResultsRefresher';
import AutoSportsSettings from '@/components/AutoSportsSettings';
import UpcomingGames from '@/components/UpcomingGames';
import AnalyzeNowButton from '@/components/AnalyzeNowButton';
import { computeStats } from '@/lib/stats';
import { ESPN_SPORTS, FAVORITE_SPORTS, fetchGames, gameCountsBySport } from '@/lib/espn';
import type { Bet, Settings } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function HomePage() {
  const supabase = supabaseAdmin();

  const [settingsRes, betsRes, counts] = await Promise.all([
    supabase.from('settings').select('*').eq('id', 1).single(),
    supabase.from('bets').select('*').order('created_at', { ascending: false }),
    gameCountsBySport(),
  ]);

  const settings = settingsRes.data as Settings | null;
  const bets = (betsRes.data as Bet[]) ?? [];
  const pending = bets.filter((b) => b.result === 'pending');
  const stats = computeStats(bets);

  const autoSports = settings?.auto_sports ?? FAVORITE_SPORTS;
  const autoEnabled = settings?.auto_enabled ?? true;

  const sportOptions = [
    ...FAVORITE_SPORTS,
    ...ESPN_SPORTS.filter((s) => !FAVORITE_SPORTS.includes(s)),
  ].map((s) => ({
    value: s,
    label: s.toUpperCase(),
    hasGames: (counts[s] ?? 0) > 0,
  }));

  let upcoming: Array<{
    espn_event_id: string;
    sport: string;
    game_label: string;
    start_time: string;
    has_picks: boolean;
  }> = [];

  try {
    const games = await fetchGames(autoSports);
    const future = games.filter((g) => {
      if (!g.start_time) return false;
      return new Date(g.start_time).getTime() > Date.now() - 5 * 60_000;
    });
    const eventIds = future.map((g) => g.espn_event_id).filter((x): x is string => Boolean(x));
    let withPicks = new Set<string>();
    if (eventIds.length > 0) {
      const { data: existing } = await supabase
        .from('picks')
        .select('espn_event_id')
        .in('status', ['pending', 'bet'])
        .in('espn_event_id', eventIds);
      withPicks = new Set((existing ?? []).map((p) => p.espn_event_id as string));
    }
    upcoming = future
      .filter((g) => g.espn_event_id && g.start_time)
      .map((g) => ({
        espn_event_id: g.espn_event_id!,
        sport: g.sport,
        game_label: g.game_label,
        start_time: g.start_time!,
        has_picks: withPicks.has(g.espn_event_id!),
      }))
      .sort((a, b) => a.start_time.localeCompare(b.start_time));
  } catch (e) {
    console.error('[home] failed to fetch upcoming games', e);
  }

  return (
    <div className="space-y-6">
      <ResultsRefresher />
      <header>
        <h1 className="text-xl font-bold tracking-tight">PICK IT UP</h1>
      </header>

      <BankrollEditor
        initial={Number(settings?.bankroll_current ?? 0)}
        unitPercentage={Number(settings?.unit_percentage ?? 5)}
      />

      <div className="grid grid-cols-4 gap-2">
        <Stat label="W-L" value={`${stats.wins}-${stats.losses}`} />
        <Stat
          label="ROI"
          value={`${stats.roi >= 0 ? '+' : ''}${stats.roi.toFixed(1)}%`}
          color={stats.roi >= 0 ? 'green' : 'red'}
        />
        <Stat
          label="P/L"
          value={`${stats.pl >= 0 ? '+' : ''}$${Math.round(stats.pl)}`}
          color={stats.pl >= 0 ? 'green' : 'red'}
        />
        <Stat
          label="Racha"
          value={
            stats.current_streak.type
              ? `${stats.current_streak.n}${stats.current_streak.type}`
              : '—'
          }
          color={stats.current_streak.type === 'W' ? 'green' : stats.current_streak.type === 'L' ? 'red' : undefined}
        />
      </div>

      <AutoSportsSettings
        options={sportOptions}
        initial={autoSports}
        enabled={autoEnabled}
      />

      <UpcomingGames games={upcoming} />

      <AnalyzeNowButton sports={autoSports} />

      {pending.length > 0 && (
        <section className="space-y-2">
          <div className="text-[10px] text-muted uppercase tracking-wider">
            Apuestas activas ({pending.length})
          </div>
          <div className="space-y-2">
            {pending.map((b) => (
              <BetResolver key={b.id} bet={b} />
            ))}
          </div>
        </section>
      )}

      <details className="text-xs">
        <summary className="text-muted cursor-pointer">▶ Leyenda de tiers</summary>
        <div className="mt-2 space-y-1 text-muted pl-3 border-l border-line">
          <div><span className="text-blue font-bold">🔒 LOCK 85-100%</span> · 2 units</div>
          <div><span className="text-green font-bold">✅ STRONG 70-84%</span> · 1.5 units</div>
          <div><span className="text-yellow font-bold">⚠️ VALUE 55-69%</span> · 1 unit</div>
          <div><span className="text-orange font-bold">🎯 PARLAY</span> · 0.5 unit</div>
          <div className="pt-1">Momio &lt;1.40 → baja un tier</div>
          <div className="pt-1 text-[10px]">Datos: ESPN · momios: DraftKings/FanDuel/etc.</div>
        </div>
      </details>
    </div>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: 'green' | 'red';
}) {
  const c = color === 'green' ? 'text-green' : color === 'red' ? 'text-red' : 'text-fg';
  return (
    <div className="bg-card border border-line rounded p-2 text-center">
      <div className="text-[9px] text-muted uppercase tracking-wider">{label}</div>
      <div className={`text-sm font-bold mt-0.5 ${c}`}>{value}</div>
    </div>
  );
}

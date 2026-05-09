import { supabaseAdmin } from '@/lib/supabase';
import BankrollEditor from '@/components/BankrollEditor';
import SportSelector from '@/components/SportSelector';
import BetResolver from '@/components/BetResolver';
import { computeStats } from '@/lib/stats';
import { ESPN_SPORTS, FAVORITE_SPORTS, gameCountsBySport } from '@/lib/espn';
import { sportLeagueLogoUrl } from '@/components/Logo';
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

  const sportOptions = [
    ...FAVORITE_SPORTS,
    ...ESPN_SPORTS.filter((s) => !FAVORITE_SPORTS.includes(s)),
  ].map((s) => {
    const n = counts[s] ?? 0;
    return {
      value: s,
      label: n > 0 ? `${s.toUpperCase()} ${n}` : `${s.toUpperCase()} · sin juegos`,
      star: FAVORITE_SPORTS.includes(s),
      today: n > 0,
      disabled: n === 0,
      iconSrc: sportLeagueLogoUrl(s) ?? undefined,
    };
  });

  const initialSelected = FAVORITE_SPORTS.filter((s) => (counts[s] ?? 0) > 0);

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-bold tracking-tight">PICK IT UP</h1>
        <span className="text-[10px] text-muted">Draftea · MX</span>
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

      <SportSelector options={sportOptions} initial={initialSelected} />

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
          <div><span className="text-red font-bold">❌ NO BET</span> &lt;55% confianza</div>
          <div className="pt-1">Momio &lt;1.40 → baja un tier (no paga lo suficiente)</div>
          <div className="pt-1 text-[10px]">Datos de juegos: ESPN API · momios: DraftKings/FanDuel/etc.</div>
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

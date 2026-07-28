import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const envContent = fs.readFileSync('.env.local', 'utf-8');
const env = {};
envContent.split('\n').forEach(line => {
  const [k, ...v] = line.split('=');
  if (k && v.length) env[k.trim()] = v.join('=').trim();
});

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  const { data: picks, error } = await supabase.from('picks').select('*');
  if (error) throw error;

  console.log(`Total picks fetched: ${picks.length}`);

  // Look for picks where real_probability is > 0 and < 0.55
  const lowProbPicks = picks.filter(p => p.real_probability > 0 && p.real_probability < 0.55);
  console.log(`Picks with 0 < real_probability < 0.55: ${lowProbPicks.length}`);

  lowProbPicks.forEach(p => {
    const odds = p.original_odds ?? p.odds_decimal;
    const implied = p.implied_probability ?? (odds > 0 ? 1 / odds : null);
    const edge = p.edge ?? (implied != null ? p.real_probability - implied : null);
    console.log({
      id: p.id,
      sport: p.sport,
      game: p.game,
      status: p.status,
      odds,
      real_probability: p.real_probability,
      implied,
      edge,
      tier: p.tier
    });
  });
}

main().catch(console.error);

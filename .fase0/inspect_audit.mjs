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
  const { data: picks, error } = await supabase
    .from('picks')
    .select('*')
    .eq('status', 'filtered_quality_audit');

  if (error) throw error;

  console.log(`filtered_quality_audit total rows: ${picks.length}`);

  const reasons = {};
  picks.forEach(p => {
    const odds = p.original_odds ?? p.odds_decimal;
    const isDog = odds >= 2.00;
    const fails = p.audit_failures;
    
    let failureKeys = [];
    if (Array.isArray(fails)) {
      failureKeys = fails;
    } else if (typeof fails === 'object' && fails !== null) {
      failureKeys = Object.keys(fails);
    } else if (typeof fails === 'string') {
      failureKeys = [fails];
    } else {
      failureKeys = ['unspecified'];
    }

    failureKeys.forEach(k => {
      if (!reasons[k]) reasons[k] = { total: 0, dog: 0, fav: 0 };
      reasons[k].total++;
      if (isDog) reasons[k].dog++;
      else reasons[k].fav++;
    });
  });

  console.table(reasons);
  console.log("Sample audit_failures jsonb values:", picks.slice(0, 5).map(p => ({
    id: p.id, game: p.game, odds: p.original_odds ?? p.odds_decimal, audit_failures: p.audit_failures
  })));
}

main().catch(console.error);

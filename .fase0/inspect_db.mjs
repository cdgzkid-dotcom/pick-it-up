import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const envContent = fs.readFileSync('.env.local', 'utf-8');
const env = {};
envContent.split('\n').forEach(line => {
  const [k, ...v] = line.split('=');
  if (k && v.length) env[k.trim()] = v.join('=').trim();
});

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(url, key);

async function main() {
  console.log("Checking picks sample...");
  const { data: picks, error: pErr } = await supabase.from('picks').select('*').limit(3);
  if (pErr) console.error("Picks error:", pErr);
  else console.log("Picks sample keys:", Object.keys(picks[0] || {}));

  const { count: pickCount, error: cErr } = await supabase.from('picks').select('*', { count: 'exact', head: true });
  console.log("Total picks count:", pickCount);

  const { data: bets, error: bErr } = await supabase.from('bets').select('*').limit(3);
  if (bErr) console.error("Bets error:", bErr);
  else console.log("Bets sample keys:", Object.keys(bets[0] || {}));

  const { count: betCount } = await supabase.from('bets').select('*', { count: 'exact', head: true });
  console.log("Total bets count:", betCount);
}

main().catch(console.error);

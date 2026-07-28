import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const envContent = fs.readFileSync('.env.local', 'utf-8');
const env = {};
envContent.split('\n').forEach(line => {
  const [k, ...v] = line.split('=');
  if (k && v.length) env[k.trim()] = v.join('=').trim();
});

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

async function fetchAll(table) {
  let all = [];
  let page = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .range(page * pageSize, (page + 1) * pageSize - 1);
    if (error) throw error;
    all = all.concat(data);
    if (data.length < pageSize) break;
    page++;
  }
  return all;
}

async function main() {
  const picks = await fetchAll('picks');
  const bets = await fetchAll('bets');
  console.log(`Fetched ${picks.length} picks and ${bets.length} bets.`);

  // Save summary of picks statuses
  const statusCounts = {};
  picks.forEach(p => {
    statusCounts[p.status] = (statusCounts[p.status] || 0) + 1;
  });
  console.log("Picks statuses:", statusCounts);

  // Save summary of sports
  const sportCounts = {};
  picks.forEach(p => {
    sportCounts[p.sport] = (sportCounts[p.sport] || 0) + 1;
  });
  console.log("Picks sports:", sportCounts);

  // Save summary of bets results
  const betResults = {};
  bets.forEach(b => {
    betResults[b.result] = (betResults[b.result] || 0) + 1;
  });
  console.log("Bets results:", betResults);
}

main().catch(console.error);

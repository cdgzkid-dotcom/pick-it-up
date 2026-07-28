import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const envContent = fs.readFileSync('.env.local', 'utf-8');
const env = {};
envContent.split('\n').forEach(line => {
  const [k, ...v] = line.split('=');
  if (k && v.length) env[k.trim()] = v.join('=').trim();
});

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function sampleStdDev(arr) {
  const m = mean(arr);
  const v = arr.reduce((a, b) => a + Math.pow(b - m, 2), 0) / (arr.length - 1);
  return Math.sqrt(v);
}

async function main() {
  const { data: bets, error } = await supabase
    .from('bets')
    .select('*')
    .not('clv', 'is', null)
    .eq('excluded_from_stats', false);

  if (error) throw error;

  console.log(`Total bets with CLV (excluded_from_stats = false): ${bets.length}`);

  const favs = bets.filter(b => (b.odds_at_bet ?? b.odds_decimal) < 2.00);
  const dogs = bets.filter(b => (b.odds_at_bet ?? b.odds_decimal) >= 2.00);

  const favClv = favs.map(b => Number(b.clv));
  const dogClv = dogs.map(b => Number(b.clv));

  const mFav = mean(favClv);
  const sFav = sampleStdDev(favClv);

  const mDog = mean(dogClv);
  const sDog = sampleStdDev(dogClv);

  const nFav = favClv.length;
  const nDog = dogClv.length;

  const se = Math.sqrt((sFav * sFav / nFav) + (sDog * sDog / nDog));
  const tStat = (mFav - mDog) / se;

  // Degrees of freedom for Welch t-test (Welch–Satterthwaite equation)
  const vFav = (sFav * sFav) / nFav;
  const vDog = (sDog * sDog) / nDog;
  const df = Math.pow(vFav + vDog, 2) / (Math.pow(vFav, 2) / (nFav - 1) + Math.pow(vDog, 2) / (nDog - 1));

  console.log("FAVORITOS:");
  console.log(`  n = ${nFav}`);
  console.log(`  mean = ${mFav.toFixed(6)} (${(mFav * 100).toFixed(3)} pp)`);
  console.log(`  std  = ${sFav.toFixed(6)} (${(sFav * 100).toFixed(3)} pp)`);

  console.log("\nUNDERDOGS:");
  console.log(`  n = ${nDog}`);
  console.log(`  mean = ${mDog.toFixed(6)} (${(mDog * 100).toFixed(3)} pp)`);
  console.log(`  std  = ${sDog.toFixed(6)} (${(sDog * 100).toFixed(3)} pp)`);

  console.log("\nWELCH T-TEST:");
  console.log(`  diff = ${(mFav - mDog).toFixed(6)} (${((mFav - mDog) * 100).toFixed(3)} pp)`);
  console.log(`  se   = ${se.toFixed(6)}`);
  console.log(`  t    = ${tStat.toFixed(4)}`);
  console.log(`  df   = ${df.toFixed(2)}`);

  console.log("\nTODAS LAS FILAS DE BETS CON CLV:");
  bets.map(b => ({
    id: b.id,
    game: b.game,
    pick: b.pick,
    odds_at_bet: b.odds_at_bet,
    odds_decimal: b.odds_decimal,
    odds_at_close: b.odds_at_close,
    clv: b.clv
  })).forEach(b => console.log(b));
}

main().catch(console.error);

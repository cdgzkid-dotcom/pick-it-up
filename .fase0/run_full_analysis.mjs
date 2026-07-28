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

function quantile(arr, q) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdDev(arr) {
  if (arr.length <= 1) return 0;
  const m = mean(arr);
  const variance = arr.reduce((a, b) => a + Math.pow(b - m, 2), 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

async function main() {
  const picks = await fetchAll('picks');
  const bets = await fetchAll('bets');

  console.log("=== POINT 1: VOLUMEN DE FAVORITOS VS UNDERDOGS ===");
  // We check odds reference.
  // For picks, odds can be original_odds or odds_decimal.
  // analyzed_no_edge rows have odds_decimal = 1 and original_odds = null.
  // Let's inspect odds across statuses.
  const p1_validPicks = picks.filter(p => (p.original_odds ?? p.odds_decimal) > 1);
  console.log(`Total picks: ${picks.length}, Picks with valid odds (>1): ${p1_validPicks.length}`);

  const p1_bySportPeriod = {};
  picks.forEach(p => {
    const period = p.created_at ? p.created_at.substring(0, 7) : 'unknown';
    const sport = p.sport || 'unknown';
    const key = `${sport} | ${period}`;
    if (!p1_bySportPeriod[key]) {
      p1_bySportPeriod[key] = { total: 0, fav: 0, dog: 0, placeholder: 0 };
    }
    p1_bySportPeriod[key].total++;

    const odds = p.original_odds ?? p.odds_decimal;
    if (odds <= 1 || p.status === 'analyzed_no_edge') {
      p1_bySportPeriod[key].placeholder++;
    } else if (odds < 2.00) {
      p1_bySportPeriod[key].fav++;
    } else {
      p1_bySportPeriod[key].dog++;
    }
  });
  console.table(p1_bySportPeriod);

  console.log("\n=== POINT 2 & 3: CONTRADICCIÓN PISO 55% Y UNDERDOGS ELIMINADOS ===");
  const mlbPicks = picks.filter(p => p.sport === 'MLB');
  const mlbValidOddsPicks = mlbPicks.filter(p => (p.original_odds ?? p.odds_decimal) > 1);
  const mlbDogs = mlbValidOddsPicks.filter(p => (p.original_odds ?? p.odds_decimal) >= 2.00);
  console.log(`MLB total picks in DB: ${mlbPicks.length}`);
  console.log(`MLB picks with valid odds (>1): ${mlbValidOddsPicks.length}`);
  console.log(`MLB underdog picks (odds >= 2.00): ${mlbDogs.length} (${(mlbDogs.length / mlbValidOddsPicks.length * 100).toFixed(1)}% of valid odds picks)`);

  const totalBets = bets.filter(b => !b.excluded_from_stats);
  const dogBets = totalBets.filter(b => (b.odds_at_bet ?? b.odds_decimal) >= 2.00);
  console.log(`Total non-excluded bets: ${totalBets.length}, Underdog bets (odds >= 2.00): ${dogBets.length} (${(dogBets.length / totalBets.length * 100).toFixed(1)}%)`);

  // Inspect picks with real_probability < 0.55 and odds >= 2.00
  const picksProbUnder55 = picks.filter(p => p.real_probability > 0 && p.real_probability < 0.55);
  console.log(`Picks with 0 < real_probability < 0.55: ${picksProbUnder55.length}`);
  console.log("Details of picks with 0 < real_probability < 0.55:", picksProbUnder55.map(p => ({
    id: p.id, sport: p.sport, game: p.game, status: p.status, odds: p.original_odds ?? p.odds_decimal, real_prob: p.real_probability, edge: p.edge
  })));

  console.log("\n=== POINT 4 & 5: CLV DE UNDERDOGS VS FAVORITOS & POR RANGO DE MOMIO ===");
  const betsWithCLV = bets.filter(b => b.clv != null && !b.excluded_from_stats);
  console.log(`Bets with non-null CLV (excluding excluded_from_stats): ${betsWithCLV.length}`);

  const favCLV = betsWithCLV.filter(b => (b.odds_at_bet ?? b.odds_decimal) < 2.00);
  const dogCLV = betsWithCLV.filter(b => (b.odds_at_bet ?? b.odds_decimal) >= 2.00);

  const favCLVVals = favCLV.map(b => Number(b.clv));
  const dogCLVVals = dogCLV.map(b => Number(b.clv));

  const meanFav = mean(favCLVVals);
  const stdFav = stdDev(favCLVVals);
  const meanDog = mean(dogCLVVals);
  const stdDog = stdDev(dogCLVVals);

  // Welch t-test
  const n1 = favCLVVals.length;
  const n2 = dogCLVVals.length;
  const se = Math.sqrt((stdFav * stdFav / n1) + (stdDog * stdDog / n2));
  const tStat = (meanFav - meanDog) / se;

  console.log(`Favoritos CLV: n=${n1}, mean=${meanFav.toFixed(4)}, std=${stdFav.toFixed(4)}`);
  console.log(`Underdogs CLV: n=${n2}, mean=${meanDog.toFixed(4)}, std=${stdDog.toFixed(4)}`);
  console.log(`Welch t-stat: ${tStat.toFixed(4)}`);

  // CLV by odds range
  const ranges = [
    { name: '< 1.50', min: 0, max: 1.50 },
    { name: '1.50 - 1.99', min: 1.50, max: 2.00 },
    { name: '2.00 - 2.49', min: 2.00, max: 2.50 },
    { name: '>= 2.50', min: 2.50, max: 999 }
  ];

  const rangeResults = ranges.map(r => {
    const sub = betsWithCLV.filter(b => {
      const o = b.odds_at_bet ?? b.odds_decimal;
      return o >= r.min && o < r.max;
    });
    const vals = sub.map(b => Number(b.clv));
    return {
      range: r.name,
      n: sub.length,
      mean_clv: mean(vals).toFixed(4),
      std_clv: stdDev(vals).toFixed(4),
      min_clv: vals.length ? Math.min(...vals).toFixed(4) : null,
      max_clv: vals.length ? Math.max(...vals).toFixed(4) : null
    };
  });
  console.table(rangeResults);

  console.log("\n=== POINT 6: FILTROS QUE ELIMINAN MAS UNDERDOGS ===");
  const picksByStatus = {};
  picks.forEach(p => {
    const s = p.status;
    const odds = p.original_odds ?? p.odds_decimal;
    const isDog = odds >= 2.00;
    if (!picksByStatus[s]) picksByStatus[s] = { total: 0, dog: 0, fav: 0, placeholder: 0 };
    picksByStatus[s].total++;
    if (odds <= 1 || s === 'analyzed_no_edge') picksByStatus[s].placeholder++;
    else if (isDog) picksByStatus[s].dog++;
    else picksByStatus[s].fav++;
  });
  console.table(picksByStatus);

  // Inspect audit_failures
  const picksWithAuditFail = picks.filter(p => p.audit_failures != null);
  console.log(`Picks with audit_failures jsonb: ${picksWithAuditFail.length}`);

  console.log("\n=== POINT 7 & 8: RECONSTRUIBILIDAD Y DAÑO DE PLACEHOLDERS ===");
  const noEdgePicks = picks.filter(p => p.status === 'analyzed_no_edge');
  console.log(`Total analyzed_no_edge rows: ${noEdgePicks.length} (${(noEdgePicks.length / picks.length * 100).toFixed(1)}% of all picks)`);
  
  const noEdgeLastMonth = noEdgePicks.filter(p => {
    const d = new Date(p.created_at);
    const monthAgo = new Date('2026-06-28T00:00:00Z');
    return d >= monthAgo;
  });
  console.log(`analyzed_no_edge rows in last month (since 2026-06-28): ${noEdgeLastMonth.length}`);

  // Check fields in analyzed_no_edge
  const sampleNoEdge = noEdgePicks[0];
  console.log("Sample analyzed_no_edge fields:", {
    real_probability: sampleNoEdge.real_probability,
    implied_probability: sampleNoEdge.implied_probability,
    edge: sampleNoEdge.edge,
    edge_vs_market: sampleNoEdge.edge_vs_market,
    original_odds: sampleNoEdge.original_odds,
    original_real_probability: sampleNoEdge.original_real_probability,
    confidence: sampleNoEdge.confidence
  });

  console.log("\n=== POINT 9: DISTRIBUCIONES SOBRE TODOS LOS CANDIDATOS ===");
  const allRealProbs = picks.map(p => Number(p.real_probability)).filter(n => !isNaN(n));
  const validRealProbs = picks.filter(p => p.status !== 'analyzed_no_edge' && p.real_probability > 0).map(p => Number(p.real_probability));
  const allEdgeVsMarket = picks.map(p => p.edge_vs_market != null ? Number(p.edge_vs_market) : null).filter(n => n !== null);

  console.log("Real Probability (ALL picks including placeholders n=" + allRealProbs.length + "):");
  console.log({
    min: Math.min(...allRealProbs),
    p10: quantile(allRealProbs, 0.10),
    p25: quantile(allRealProbs, 0.25),
    median: quantile(allRealProbs, 0.50),
    p75: quantile(allRealProbs, 0.75),
    p90: quantile(allRealProbs, 0.90),
    max: Math.max(...allRealProbs),
    mean: mean(allRealProbs)
  });

  console.log("Real Probability (VALID picks excluding placeholders n=" + validRealProbs.length + "):");
  console.log({
    min: Math.min(...validRealProbs),
    p10: quantile(validRealProbs, 0.10),
    p25: quantile(validRealProbs, 0.25),
    median: quantile(validRealProbs, 0.50),
    p75: quantile(validRealProbs, 0.75),
    p90: quantile(validRealProbs, 0.90),
    max: Math.max(...validRealProbs),
    mean: mean(validRealProbs)
  });

  console.log("Edge vs Market (Picks with non-null edge_vs_market n=" + allEdgeVsMarket.length + "):");
  if (allEdgeVsMarket.length > 0) {
    console.log({
      min: Math.min(...allEdgeVsMarket),
      p10: quantile(allEdgeVsMarket, 0.10),
      p25: quantile(allEdgeVsMarket, 0.25),
      median: quantile(allEdgeVsMarket, 0.50),
      p75: quantile(allEdgeVsMarket, 0.75),
      p90: quantile(allEdgeVsMarket, 0.90),
      max: Math.max(...allEdgeVsMarket),
      mean: mean(allEdgeVsMarket)
    });
  }

  console.log("\n=== POINT 10: PROMPT CAPS VIOLATION QUANTIFICATION ===");
  // Caps:
  // MLB: away 58%, home 66%
  // NBA: home 70%, away 55%
  // NHL: home 65%, away 55%
  // NFL: home 73%, away 62%
  const caps = {
    MLB: { home: 0.66, away: 0.58 },
    NBA: { home: 0.70, away: 0.55 },
    NHL: { home: 0.65, away: 0.55 },
    NFL: { home: 0.73, away: 0.62 }
  };

  const validPicksForCaps = picks.filter(p => p.status !== 'analyzed_no_edge' && p.real_probability > 0);
  
  const violations = [];
  let totalEvaluated = 0;
  const sideCounts = { MLB: { home: 0, away: 0 }, NBA: { home: 0, away: 0 }, NHL: { home: 0, away: 0 }, NFL: { home: 0, away: 0 } };

  validPicksForCaps.forEach(p => {
    const sport = p.sport;
    if (!caps[sport]) return;

    let side = null;
    const pickText = (p.pick || '').trim().toLowerCase();
    const homeText = (p.home_team || '').trim().toLowerCase();
    const awayText = (p.away_team || '').trim().toLowerCase();
    const homeAbbr = (p.home_team_abbr || '').trim().toLowerCase();
    const awayAbbr = (p.away_team_abbr || '').trim().toLowerCase();

    if (pickText === homeText || (homeAbbr && pickText === homeAbbr) || pickText.includes(homeText)) {
      side = 'home';
    } else if (pickText === awayText || (awayAbbr && pickText === awayAbbr) || pickText.includes(awayText)) {
      side = 'away';
    } else {
      // Check game representation "Away @ Home"
      if (p.game && p.game.includes('@')) {
        const parts = p.game.split('@').map(s => s.trim().toLowerCase());
        if (pickText.includes(parts[0])) side = 'away';
        else if (pickText.includes(parts[1])) side = 'home';
      }
    }

    if (!side) return; // couldn't determine side reliably

    totalEvaluated++;
    sideCounts[sport][side]++;

    const cap = caps[sport][side];
    const prob = Number(p.real_probability);
    if (prob > cap) {
      const excess = prob - cap;
      violations.push({
        id: p.id,
        sport,
        side,
        game: p.game,
        pick: p.pick,
        real_prob: prob,
        cap,
        excess,
        status: p.status
      });
    }
  });

  console.log(`Evaluated ${totalEvaluated} picks for cap violations.`);
  console.log(`Total violations: ${violations.length} (${(violations.length / totalEvaluated * 100).toFixed(1)}%)`);

  // Group violations by sport and side
  const violationStats = {};
  ['MLB', 'NBA', 'NHL', 'NFL'].forEach(sp => {
    ['home', 'away'].forEach(sd => {
      const key = `${sp}_${sd}`;
      const sub = violations.filter(v => v.sport === sp && v.side === sd);
      const totalSidePicks = sideCounts[sp][sd];
      const excesses = sub.map(v => v.excess);
      violationStats[key] = {
        sport: sp,
        side: sd,
        total_picks: totalSidePicks,
        violations: sub.length,
        pct: totalSidePicks > 0 ? (sub.length / totalSidePicks * 100).toFixed(1) + '%' : '0%',
        mean_excess: excesses.length ? (mean(excesses) * 100).toFixed(2) + ' pp' : 'N/A',
        max_excess: excesses.length ? (Math.max(...excesses) * 100).toFixed(2) + ' pp' : 'N/A',
        p50_excess: excesses.length ? (quantile(excesses, 0.5) * 100).toFixed(2) + ' pp' : 'N/A',
        p90_excess: excesses.length ? (quantile(excesses, 0.9) * 100).toFixed(2) + ' pp' : 'N/A'
      };
    });
  });
  console.table(violationStats);
}

main().catch(console.error);

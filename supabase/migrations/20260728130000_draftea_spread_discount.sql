alter table picks add column if not exists edge_vs_dk numeric;
alter table picks add column if not exists edge_after_spread numeric;
alter table bets  add column if not exists book_spread_pp numeric;
comment on column picks.edge_vs_dk is 'Edge bruto vs DraftKings al análisis. No se reescribe.';
comment on column picks.edge_after_spread is 'edge_vs_dk - BOOK_SPREAD_DISCOUNT (2.35pp, n=11, 2026-07-28).';
comment on column bets.book_spread_pp is 'Spread observado del ticket: (1/odds_at_bet - 1/original_odds)*100. Muestra para recalibrar.';
-- Reversible: drop column en cada caso.

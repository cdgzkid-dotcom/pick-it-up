-- Sizing transparency: persist what the tier ceiling was and why
-- recommended_amount may be below it. Lets Telegram show
-- "Apostar: $22 (1.7u de 2u — Kelly MLB recortó por varianza)" so
-- the user never has to guess where the stake came from.
--
-- Each pick is self-contained — if TIER_UNITS changes in the future,
-- historical picks keep their original ceiling.

alter table picks add column if not exists theoretical_amount numeric;
alter table picks add column if not exists sizing_reason text;
alter table picks add column if not exists units_actual numeric;
alter table picks add column if not exists units_theoretical numeric;

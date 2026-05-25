-- Activate WNBA in production auto_sports + remove zombie sports
-- Zombies: Liga MX, Premier League, Champions, UFC (no SPORTS dict entry)
-- Context: commit f6a56f5 enabled WNBA in code but never updated settings row
-- Executed: 2026-05-25

UPDATE settings
SET auto_sports = ARRAY['NBA', 'MLB', 'NHL', 'NFL', 'WNBA']
WHERE id = 1;

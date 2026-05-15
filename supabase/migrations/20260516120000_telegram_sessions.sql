-- Temporary storage for Telegram bet-confirmation sessions.
-- A row is created when the bot receives a photo and Claude Vision
-- extracts a valid ticket. The session UUID goes in the inline button
-- callback_data. The row is deleted on confirm OR cancel.
create table if not exists telegram_sessions (
  id         uuid        primary key default gen_random_uuid(),
  chat_id    bigint      not null,
  payload    jsonb       not null,
  created_at timestamptz not null default now()
);

-- Allow querying/deleting expired sessions (older than 24 h).
create index if not exists telegram_sessions_created_at_idx
  on telegram_sessions (created_at);

-- ============================================================
-- Roybal AI — meter TTS (spoken replies) into the ai_usage ledger
-- ============================================================
-- The Ask-the-Office assistant speaks its answers (Deepgram Aura,
-- ~$0.03 per 1k characters). Until now that spend was invisible to
-- the ledger, so heavy voice under-reported against SPEND_CAP_USD.
-- Two additive columns; cost_usd REMAINS the single field the cap
-- sums — the edge function now writes stt + llm + tts into it.
--
-- SAFE + ADDITIVE. Run AFTER 201_ai_usage.sql.
-- ============================================================

alter table public.ai_usage add column if not exists tts_chars    integer not null default 0;
alter table public.ai_usage add column if not exists tts_cost_usd numeric not null default 0;

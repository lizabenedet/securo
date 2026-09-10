-- One-time reconciliation for the two migrations that both claimed "085".
--
-- This fork wrote 085_cards before upstream released v0.15.1, which brought an
-- 085 of its own (transactions.exclude_from_pnl). The rebase renumbered ours to
-- 086, and that leaves any database migrated by the OLD numbering in a state
-- Alembic reads wrong: `alembic_version` says "085", meaning our cards
-- migration, while the new code takes "085" to mean upstream's column. So an
-- `alembic upgrade head` on such a database would skip the column it needs and
-- try to create the `cards` table it already has, failing on startup with
-- "relation cards already exists".
--
-- This script closes the gap by hand: it applies what upstream's 085 does, then
-- moves the marker to 086. Nothing is recreated, so card names typed by the
-- user survive.
--
-- Idempotent by construction: safe to run twice, safe on a database that was
-- built from scratch under the new numbering, and safe on one already at 086.
--
--   docker exec -i securo-db-1 psql -U postgres -d securo -v ON_ERROR_STOP=1 \
--     < scripts/reconcile-085-collision.sql
--
-- Take a dump first. See CLAUDE.md, "Deploy".

BEGIN;

DO $$
DECLARE
    marker text;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'transactions' AND column_name = 'exclude_from_pnl'
    ) THEN
        ALTER TABLE transactions
            ADD COLUMN exclude_from_pnl BOOLEAN NOT NULL DEFAULT false;
        RAISE NOTICE 'added transactions.exclude_from_pnl (upstream 085)';
    ELSE
        RAISE NOTICE 'transactions.exclude_from_pnl already present, left alone';
    END IF;

    SELECT version_num INTO marker FROM alembic_version;

    -- "085" plus an existing `cards` table can only mean the marker was written
    -- by this fork's old 085_cards. A database that ran upstream's 085 and
    -- stopped there has no `cards` table, and must still run 086 normally.
    IF marker = '085' AND to_regclass('public.cards') IS NOT NULL THEN
        UPDATE alembic_version SET version_num = '086';
        RAISE NOTICE 'marker 085 (this fork''s cards migration) moved to 086';
    ELSE
        RAISE NOTICE 'marker is %, nothing to move', marker;
    END IF;
END $$;

COMMIT;

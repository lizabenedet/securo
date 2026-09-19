-- One-time fix for a database that ran this fork's cards migration under an
-- upstream number.
--
-- The cards migration was written as "085", renumbered to "086" when upstream
-- v0.15.1 took 085 (transactions.exclude_from_pnl), and collided again when
-- v0.16.0 took 086-089 (payment matching). It is now `fork001`, chained after
-- upstream's head, and skips itself when `cards` already exists.
--
-- What is left is the marker. A database migrated under an old number says
-- "085" or "086" in `alembic_version` meaning *cards*, and the current code
-- reads those as upstream's revisions: `alembic upgrade head` would skip
-- upstream's work it never ran. This script puts the marker back on 085 as
-- upstream means it (adding upstream 085's column first, for a database from
-- before the v0.15.1 rebase), so the upgrade runs upstream 086-089 and then
-- passes over fork001 without recreating anything. Card names typed by the
-- user survive.
--
-- The test for "marker written by us": `cards` exists but upstream 086's
-- `reconciliation_rules` does not. Idempotent by construction: safe to run
-- twice, and a no-op on a database built from scratch or already upgraded.
--
--   docker exec -i securo-db-1 psql -U postgres -d securo -v ON_ERROR_STOP=1 \
--     < scripts/reconcile-cards-migration.sql
--
-- Take a dump first. See CLAUDE.md, "Deploy".

BEGIN;

DO $$
DECLARE
    marker text;
BEGIN
    SELECT version_num INTO marker FROM alembic_version;

    IF marker IN ('085', '086')
       AND to_regclass('public.cards') IS NOT NULL
       AND to_regclass('public.reconciliation_rules') IS NULL
    THEN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'transactions' AND column_name = 'exclude_from_pnl'
        ) THEN
            ALTER TABLE transactions
                ADD COLUMN exclude_from_pnl BOOLEAN NOT NULL DEFAULT false;
            RAISE NOTICE 'added transactions.exclude_from_pnl (upstream 085)';
        END IF;
        UPDATE alembic_version SET version_num = '085';
        RAISE NOTICE 'marker % (this fork''s cards migration) moved to 085; upgrade head runs upstream 086-089 next', marker;
    ELSE
        RAISE NOTICE 'marker is %, nothing to move', marker;
    END IF;
END $$;

COMMIT;

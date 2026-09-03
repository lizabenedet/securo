"""split a credit-card account into the cards that share it

Revision ID: 085
Revises: 084
Create Date: 2026-09-02
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "085"
down_revision: Union[str, None] = "084"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# The provider's own card number, dug out of the payload we already store.
# Pluggy reports four digits; anything else is left alone so the charge
# falls back to the account's default card instead of failing the insert.
_LAST4 = "t.raw_data->'creditCardMetadata'->>'cardNumber'"


def upgrade() -> None:
    op.create_table(
        "cards",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "workspace_id",
            UUID(as_uuid=True),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "account_id",
            UUID(as_uuid=True),
            sa.ForeignKey("accounts.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("last4", sa.String(length=4), nullable=True),
        sa.Column("name", sa.String(length=60), nullable=True),
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("account_id", "last4", name="uq_cards_account_last4"),
    )
    op.create_index("ix_cards_workspace_id", "cards", ["workspace_id"])
    op.create_index("ix_cards_account_id", "cards", ["account_id"])

    op.add_column(
        "transactions",
        sa.Column(
            "card_id",
            UUID(as_uuid=True),
            sa.ForeignKey("cards.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index("ix_transactions_card_id", "transactions", ["card_id"])

    # Every credit-card account gets its catch-all row up front, so the read
    # path can assume one exists rather than inventing it mid-query.
    op.execute(
        """
        INSERT INTO cards (id, workspace_id, account_id, last4, name, is_default, created_at)
        SELECT gen_random_uuid(), a.workspace_id, a.id, NULL, NULL, true, now()
        FROM accounts a
        WHERE a.type = 'credit_card'
        """
    )

    # One row per card the provider has ever named on this account. Distinct
    # first, uuid after: gen_random_uuid() is volatile, so selecting it
    # inside the DISTINCT would make every duplicate look unique.
    op.execute(
        f"""
        INSERT INTO cards (id, workspace_id, account_id, last4, name, is_default, created_at)
        SELECT gen_random_uuid(), s.workspace_id, s.account_id, s.last4, NULL, false, now()
        FROM (
            SELECT DISTINCT t.workspace_id, t.account_id, {_LAST4} AS last4
            FROM transactions t
            JOIN accounts a ON a.id = t.account_id
            WHERE a.type = 'credit_card'
              AND t.raw_data IS NOT NULL
              AND {_LAST4} ~ '^[0-9]{{1,4}}$'
        ) s
        """
    )

    op.execute(
        f"""
        UPDATE transactions t
        SET card_id = c.id
        FROM cards c
        WHERE c.account_id = t.account_id
          AND c.last4 = {_LAST4}
          AND t.card_id IS NULL
        """
    )


def downgrade() -> None:
    op.drop_index("ix_transactions_card_id", table_name="transactions")
    op.drop_column("transactions", "card_id")
    op.drop_index("ix_cards_account_id", table_name="cards")
    op.drop_index("ix_cards_workspace_id", table_name="cards")
    op.drop_table("cards")

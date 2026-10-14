"""mark a category as a fixed expense

Revision ID: fork002
Revises: fork001
Create Date: 2026-10-13

"Fixed" means the expense comes every month, whatever its amount: an
electricity bill that swings between 300 and 700 is still fixed. The
fixed-vs-variable report groups spending by this flag; an unmarked category
counts as variable.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "fork002"
down_revision: Union[str, None] = "fork001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "categories",
        sa.Column("is_fixed", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade() -> None:
    op.drop_column("categories", "is_fixed")

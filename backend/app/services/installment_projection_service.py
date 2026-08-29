"""Project the parcels of a card purchase that have not been charged yet.

A bank sync delivers an installment plan one parcel at a time: buy in six
instalments and the ledger holds only what has actually been billed. Every
forward-looking surface therefore misses the rest, even though the remaining
parcels are the most certain future outflow there is — the amount and the dates
are already agreed, unlike a recurrence, which is only a guess that last month
repeats.

(A plan entered by hand through ``create_installment_series`` is different: it
writes every parcel up front, so those already exist as rows and are skipped
here by the same guard that stops the pending next parcel being counted twice.)

Pure read, no writes, and no new table: the plan is reconstructed from the
installment columns the sync already fills in.
"""
import calendar
import uuid
from collections import defaultdict
from datetime import date, timedelta
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.account import Account
from app.models.category import Category
from app.models.transaction import Transaction

# Stop projecting when the last charge is older than this. A plan whose parcels
# stopped arriving has either been settled early or the connection went stale,
# and inventing debt from a feed that went quiet is worse than showing nothing.
STALE_AFTER_DAYS = 75


def _add_months(anchor: date, months: int) -> date:
    """Same day in a later month, clamped to that month's length.

    A parcel charged on the 31st falls on the 30th in November and the 28th in
    February, which is what the card issuer does too.
    """
    total = anchor.month - 1 + months
    year = anchor.year + total // 12
    month = total % 12 + 1
    return date(year, month, min(anchor.day, calendar.monthrange(year, month)[1]))


async def get_installment_projections(
    session: AsyncSession,
    workspace_id: uuid.UUID,
    range_start: date,
    range_end: date,
    account_ids: Optional[list[uuid.UUID]] = None,
    *,
    include_transfer_like: bool = False,
) -> list[dict]:
    """Parcels still to be charged, shaped like a recurring projection.

    Mirrors ``_get_recurring_projections``: same dict shape, same category
    filters, same account scoping, so a caller cannot tell the two sources
    apart and none of them needed changing.

    Dated on the charge date, the way a recurrence is dated on its occurrence.
    Under accrual accounting the cash actually leaves on the bill's due date;
    recurrences have that same gap today, and closing it for one source but not
    the other would be worse than leaving both consistent.
    """
    if account_ids is not None and len(account_ids) == 0:
        return []

    today = date.today()

    stmt = (
        select(Transaction)
        .join(Account, Transaction.account_id == Account.id)
        .outerjoin(Category, Transaction.category_id == Category.id)
        .where(
            Transaction.workspace_id == workspace_id,
            Account.is_closed == False,  # noqa: E712
            Transaction.total_installments.is_not(None),
            Transaction.installment_number.is_not(None),
            Transaction.is_ignored == False,  # noqa: E712
        )
    )
    if account_ids:
        stmt = stmt.where(Transaction.account_id.in_(account_ids))

    rows = list((await session.execute(stmt)).scalars().all())
    if not rows:
        return []

    # (account, description, size, purchase date) identifies a plan: the same
    # shop charged twice in six parcels is two plans, told apart by the date the
    # purchase was made.
    plans: dict[tuple, list[Transaction]] = defaultdict(list)
    for row in rows:
        plans[
            (
                row.account_id,
                row.description,
                row.total_installments,
                row.installment_purchase_date,
            )
        ].append(row)

    categories = {
        category.id: category
        for category in (
            await session.execute(select(Category).where(Category.workspace_id == workspace_id))
        ).scalars()
    }

    projections: list[dict] = []
    for parcels in plans.values():
        parcels.sort(key=lambda tx: tx.installment_number or 0)
        total = parcels[-1].total_installments or 0
        charged = {tx.installment_number for tx in parcels}
        last = parcels[-1]
        if (last.installment_number or 0) >= total:
            continue
        if last.date < today - timedelta(days=STALE_AFTER_DAYS):
            continue

        category = categories.get(last.category_id) if last.category_id else None
        if category is not None:
            if category.is_ignored:
                continue
            if category.treat_as_transfer and not include_transfer_like:
                continue

        for step in range(1, total - (last.installment_number or 0) + 1):
            number = (last.installment_number or 0) + step
            # Already in the ledger — the next parcel usually arrives as a
            # pending row before it is billed, and a hand-entered series writes
            # every parcel up front.
            if number in charged:
                continue
            occurrence = _add_months(last.date, step)
            if occurrence < range_start or occurrence > range_end:
                continue
            projections.append({
                "category_id": last.category_id,
                "amount": float(last.amount),
                "type": last.type,
                "currency": last.currency,
                "date": occurrence,
            })

    return projections

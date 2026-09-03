"""Cards: the several plastics that share one credit-card account.

The account is the bill; the card is who spent. Providers already say which
card made each charge, so most of this file is about keeping that attribution
attached to something a person can name, and about answering "who spent what"
with the same definition of spend the rest of the app uses.
"""
import uuid
from datetime import date
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.account import Account
from app.models.card import Card
from app.models.category import Category
from app.models.transaction import Transaction
from app.models.user import User
from app.schemas.card import (
    CardCategoryItem,
    CardMonthlyPoint,
    CardSummaryItem,
    CardSummaryResponse,
    CardUpdate,
)
from app.services._query_filters import (
    counts_as_user_pnl,
    has_already_happened,
    reporting_date_col,
)
from app.services.admin_service import get_credit_card_accounting_mode
from app.services.report_service import _report_start_date


def extract_last4(raw_data: object) -> Optional[str]:
    """The card number a provider attached to a charge, or None.

    Pluggy nests it under `creditCardMetadata`; anything that is not one to
    four digits is discarded rather than stretched to fit, because a wrong
    card is worse than no card — an unattributed charge lands on the
    account's default card, which is visibly a fallback.
    """
    if not isinstance(raw_data, dict):
        return None
    meta = raw_data.get("creditCardMetadata")
    if not isinstance(meta, dict):
        return None
    value = meta.get("cardNumber")
    if value is None:
        return None
    text = str(value).strip()
    if not text or len(text) > 4 or not text.isdigit():
        return None
    return text


async def get_default_card(session: AsyncSession, account: Account) -> Card:
    """The account's catch-all card, created on first use.

    Charges nobody can attribute — interest, the annual fee, an imported
    statement, a manual entry — belong to the account rather than to any one
    plastic, and this is where the page shows them.
    """
    existing = (
        await session.execute(
            select(Card).where(
                Card.account_id == account.id,
                Card.is_default.is_(True),
            )
        )
    ).scalar_one_or_none()
    if existing:
        return existing

    card = Card(
        workspace_id=account.workspace_id,
        account_id=account.id,
        is_default=True,
    )
    session.add(card)
    await session.flush()
    return card


async def attribute_cards_for_account(session: AsyncSession, account: Account) -> int:
    """Point this account's unattributed charges at the card that made them.

    Runs after a sync rather than inside the paths that create transactions:
    a charge can arrive as an insert, as a pending row later updated in
    place, or as a bill charge, and one pass over what is still unattributed
    covers all three (and whatever the upstream adds next). Rows the
    provider never named stay null and read as the default card, so the pass
    reconsiders only a handful of rows on each run.

    Returns how many charges it attributed.
    """
    if account.type != "credit_card":
        return 0

    rows = (
        await session.execute(
            select(Transaction).where(
                Transaction.account_id == account.id,
                Transaction.card_id.is_(None),
                Transaction.raw_data.isnot(None),
            )
        )
    ).scalars().all()

    pending: dict[str, list[Transaction]] = {}
    for tx in rows:
        last4 = extract_last4(tx.raw_data)
        if last4:
            pending.setdefault(last4, []).append(tx)
    if not pending:
        return 0

    known = {
        card.last4: card
        for card in (
            await session.execute(
                select(Card).where(
                    Card.account_id == account.id,
                    Card.last4.isnot(None),
                )
            )
        ).scalars().all()
    }

    attributed = 0
    for last4, transactions in pending.items():
        card = known.get(last4)
        if card is None:
            card = Card(
                workspace_id=account.workspace_id,
                account_id=account.id,
                last4=last4,
            )
            session.add(card)
            await session.flush()
            known[last4] = card
        for tx in transactions:
            tx.card_id = card.id
            attributed += 1
    return attributed


async def get_cards(session: AsyncSession, workspace_id: uuid.UUID) -> list[Card]:
    """Every card of every open credit-card account in the workspace.

    Ensures each account has its default row on the way out, so a workspace
    whose accounts pre-date this feature (or arrived by a path that never
    touched it) still lists something.
    """
    accounts = (
        await session.execute(
            select(Account).where(
                Account.workspace_id == workspace_id,
                Account.type == "credit_card",
                Account.is_closed == False,  # noqa: E712 — SQL, not Python truthiness
            )
        )
    ).scalars().all()
    if not accounts:
        return []
    for account in accounts:
        await get_default_card(session, account)
    await session.commit()

    cards = (
        await session.execute(
            select(Card)
            .options(selectinload(Card.account))
            .where(Card.account_id.in_([a.id for a in accounts]))
        )
    ).scalars().all()
    return sorted(cards, key=_card_sort_key)


def _card_sort_key(card: Card) -> tuple:
    account_name = (card.account.display_name or card.account.name) if card.account else ""
    # Within an account: named cards first, then numbered ones, then the
    # catch-all — which is the order of how much a person recognises them.
    return (account_name, card.is_default, card.name is None, card.name or card.last4 or "")


async def update_card(
    session: AsyncSession, card_id: uuid.UUID, workspace_id: uuid.UUID, data: CardUpdate
) -> Optional[Card]:
    card = (
        await session.execute(
            select(Card)
            .options(selectinload(Card.account))
            .where(Card.id == card_id, Card.workspace_id == workspace_id)
        )
    ).scalar_one_or_none()
    if card is None:
        return None

    if data.name is not None:
        # An empty name clears it rather than storing blank, so the display
        # falls back to the digits instead of showing nothing at all.
        card.name = data.name.strip() or None
    await session.commit()
    await session.refresh(card, ["account"])
    return card


def card_filter(card: Card):
    """SQL filter matching the charges that belong to `card`.

    The default card owns everything its account never attributed, which is
    why this is not simply an equality on `card_id`.
    """
    if card.is_default:
        return (Transaction.account_id == card.account_id) & Transaction.card_id.is_(None)
    return Transaction.card_id == card.id


async def get_card_summary(
    session: AsyncSession,
    workspace_id: uuid.UUID,
    user_id: uuid.UUID,
    months: int = 12,
    period: Optional[str] = None,
    days: Optional[int] = None,
    card_id: Optional[uuid.UUID] = None,
) -> CardSummaryResponse:
    """Spend per card, per month, and per category.

    Deliberately built from the same fragments as the income/expenses
    report — `reporting_date_col`, `has_already_happened`, `counts_as_user_pnl`
    — so a month here shows the same number a month there does. A card
    payment sits in a `treat_as_transfer` category and is already excluded by
    that definition, which is what keeps the account the bill is paid from
    out of the ranking.
    """
    user = await session.get(User, user_id)
    primary_currency = user.primary_currency if user else "USD"

    today = date.today()
    start = _report_start_date(today, months, period, days)

    cards = await get_cards(session, workspace_id)
    by_id = {card.id: card for card in cards}
    default_by_account = {c.account_id: c.id for c in cards if c.is_default}
    selected = by_id.get(card_id) if card_id else None

    accounting_mode = await get_credit_card_accounting_mode(session)
    report_date = reporting_date_col(accounting_mode)
    amount_expr = func.coalesce(Transaction.amount_primary, Transaction.amount)
    period_expr = func.to_char(report_date, "YYYY-MM")

    # One pass, grouped finely enough to serve all three shapes. The row
    # count is bounded by cards × months × categories, which stays small
    # enough that aggregating in Python beats three round-trips.
    rows = (
        await session.execute(
            select(
                Transaction.card_id,
                Transaction.account_id,
                period_expr,
                Transaction.category_id,
                func.sum(amount_expr),
                func.count(),
            )
            .join(Account, Transaction.account_id == Account.id)
            .where(
                Transaction.workspace_id == workspace_id,
                Account.type == "credit_card",
                Account.is_closed == False,  # noqa: E712
                Transaction.type == "debit",
                Transaction.source != "opening_balance",
                report_date >= start,
                report_date <= today,
                has_already_happened(today),
                counts_as_user_pnl(),
            )
            .group_by(
                Transaction.card_id,
                Transaction.account_id,
                period_expr,
                Transaction.category_id,
            )
        )
    ).all()

    totals: dict[uuid.UUID, float] = {}
    counts: dict[uuid.UUID, int] = {}
    monthly: dict[str, dict[uuid.UUID, float]] = {}
    categories: dict[Optional[uuid.UUID], float] = {}

    for row_card_id, account_id, bucket, category_id, total, count in rows:
        resolved = row_card_id or default_by_account.get(account_id)
        if resolved is None or resolved not in by_id:
            continue
        value = float(total or 0)
        totals[resolved] = totals.get(resolved, 0.0) + value
        counts[resolved] = counts.get(resolved, 0) + int(count or 0)
        monthly.setdefault(bucket, {})
        monthly[bucket][resolved] = monthly[bucket].get(resolved, 0.0) + value
        if selected is None or resolved == selected.id:
            categories[category_id] = categories.get(category_id, 0.0) + value

    # Last use ignores the window on purpose: a card that stopped being used
    # in February should say so, not go blank.
    last_used_rows = (
        await session.execute(
            select(
                Transaction.card_id,
                Transaction.account_id,
                func.max(Transaction.date),
            )
            .join(Account, Transaction.account_id == Account.id)
            .where(
                Transaction.workspace_id == workspace_id,
                Account.type == "credit_card",
                Account.is_closed == False,  # noqa: E712
                Transaction.source != "opening_balance",
                Transaction.date <= today,
            )
            .group_by(Transaction.card_id, Transaction.account_id)
        )
    ).all()
    last_used: dict[uuid.UUID, date] = {}
    for row_card_id, account_id, seen in last_used_rows:
        resolved = row_card_id or default_by_account.get(account_id)
        if resolved is None or seen is None:
            continue
        current = last_used.get(resolved)
        if current is None or seen > current:
            last_used[resolved] = seen

    grand_total = sum(totals.values())

    items = [
        CardSummaryItem(
            id=card.id,
            account_id=card.account_id,
            account_name=(card.account.display_name or card.account.name)
            if card.account
            else None,
            card_brand=card.account.card_brand if card.account else None,
            last4=card.last4,
            name=card.name,
            is_default=card.is_default,
            total=round(totals.get(card.id, 0.0), 2),
            share=(totals.get(card.id, 0.0) / grand_total) if grand_total else 0.0,
            transaction_count=counts.get(card.id, 0),
            last_used=last_used.get(card.id),
        )
        for card in cards
    ]
    items.sort(key=lambda item: (-item.total, item.account_name or "", item.last4 or ""))

    category_rows = await _load_categories(session, list(categories.keys()))
    category_total = sum(categories.values())
    category_items = [
        CardCategoryItem(
            category_id=cat_id,
            name=category_rows.get(cat_id).name if category_rows.get(cat_id) else None,
            icon=category_rows.get(cat_id).icon if category_rows.get(cat_id) else None,
            color=category_rows.get(cat_id).color if category_rows.get(cat_id) else None,
            total=round(value, 2),
            share=(value / category_total) if category_total else 0.0,
        )
        for cat_id, value in categories.items()
    ]
    category_items.sort(key=lambda item: -item.total)

    return CardSummaryResponse(
        currency=primary_currency,
        start=start,
        end=today,
        total=round(grand_total, 2),
        cards=items,
        monthly=[
            CardMonthlyPoint(
                period=bucket,
                totals={cid: round(value, 2) for cid, value in per_card.items()},
            )
            for bucket, per_card in sorted(monthly.items())
        ],
        categories=category_items,
    )


async def _load_categories(
    session: AsyncSession, ids: list[Optional[uuid.UUID]]
) -> dict[Optional[uuid.UUID], Category]:
    real_ids = [cat_id for cat_id in ids if cat_id is not None]
    if not real_ids:
        return {}
    rows = (
        await session.execute(select(Category).where(Category.id.in_(real_ids)))
    ).scalars().all()
    return {row.id: row for row in rows}


async def resolve_card_filter(
    session: AsyncSession, workspace_id: uuid.UUID, card_id: uuid.UUID
):
    """Filter for the transaction list, or None when the card is unknown."""
    card = (
        await session.execute(
            select(Card).where(Card.id == card_id, Card.workspace_id == workspace_id)
        )
    ).scalar_one_or_none()
    if card is None:
        return None
    return card_filter(card)


__all__ = [
    "attribute_cards_for_account",
    "card_filter",
    "extract_last4",
    "get_card_summary",
    "get_cards",
    "get_default_card",
    "resolve_card_filter",
    "update_card",
]

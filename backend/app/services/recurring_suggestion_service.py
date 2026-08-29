"""Find recurring commitments the user has not registered yet.

``recurring_match_service`` links a *registered* bill to the charge that pays
it. This is the step before that: reading the ledger and proposing the bills
worth registering in the first place, which its docstring leaves open as "a
later suggestion-based pass".

Nothing is stored. Suggestions are recomputed on every request and dismissals
live in ``User.preferences``, so the fork adds no Alembic migration and keeps
rebasing onto upstream releases cleanly.

What the detector looks at
--------------------------
The signal is **regularity of the interval between charges**, not how often a
description repeats. A bakery visited 25 times at exactly R$1.85 is not a
subscription; an electricity bill of a different amount every month is. Ranking
by occurrence count surfaces the bakery first, which is why gaps drive the
score and the amount only decides what to prefill.

Gaps rather than day-of-month, because a charge that lands on the 31st, then the
1st, then the 30th is perfectly monthly while its day-of-month variance is huge.
Gaps also name the frequency for free: ~7 days is weekly, ~30 monthly.
"""
import re
import statistics
import uuid
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal
from typing import Iterable, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.account import Account
from app.models.category import Category
from app.models.recurring_transaction import RecurringTransaction
from app.models.transaction import Transaction
from app.models.user import User

# How far back to read. A year covers the yearly band and keeps a lapsed
# commitment from lingering in the list forever.
HISTORY_MONTHS = 12
MIN_OCCURRENCES = 3
# Below this the group is noise worth nobody's attention: interest credits of a
# few cents repeat perfectly and would otherwise score 100%.
MIN_AMOUNT = Decimal("5.00")

# (frequency, typical gap in days, tolerance). Tolerances overlap nothing, so a
# median gap matches at most one band.
FREQUENCY_BANDS = (
    ("weekly", 7.0, 2.0),
    ("monthly", 30.4, 6.0),
    ("quarterly", 91.3, 12.0),
    ("yearly", 365.0, 40.0),
)

# A gap counts as "on schedule" when it is within this much of the median.
GAP_TOLERANCE = 0.30
# Share of gaps that must be on schedule. Deliberately permissive: a salary
# paid between the 5th and the 25th scores 0.67 and is worth suggesting, even
# though the same bar lets a weekly supermarket run through.
MIN_CONSISTENCY = 0.6

# Two descriptions are the same commitment above this token overlap.
MERGE_SIMILARITY = 0.6
# A token in this share of distinct descriptions carries no identity — it is a
# city, a country code, or a statement verb. Dropping them matters: without it
# "DM SPOTIFY SAO PAULO BRA" and "DL UBERRIDES SAO PAULO BRA" overlap on three
# place tokens out of five, and the 147-charge Uber group swallows Spotify.
COMMON_TOKEN_SHARE = 0.08

PREFERENCE_KEY = "dismissed_recurring_suggestions"
CATEGORY_PREFERENCE_KEY = "muted_recurring_categories"


@dataclass
class RecurringSuggestion:
    """One proposed bill, shaped so the create form can be prefilled from it."""

    fingerprint: str
    description: str
    amount: Decimal
    amount_varies: bool
    currency: str
    type: str
    frequency: str
    confidence: float
    occurrences: int
    first_date: date
    last_date: date
    next_date: date
    day_of_month: Optional[int]
    account_id: uuid.UUID
    account_ids: list[uuid.UUID] = field(default_factory=list)
    category_id: Optional[uuid.UUID] = None


def normalize_description(value: Optional[str]) -> str:
    """Collapse whitespace and drop long digit runs (card and order ids)."""
    collapsed = re.sub(r"\s+", " ", (value or "").lower()).strip()
    return re.sub(r"\b\d{4,}\b", "", collapsed).strip()


def common_tokens(descriptions: Iterable[str]) -> set[str]:
    """Tokens too widespread to identify a merchant.

    Derived from the workspace's own descriptions rather than a hardcoded list,
    so it adapts to whatever the user's banks happen to print.
    """
    descriptions = list(descriptions)
    frequency: Counter[str] = Counter()
    for description in descriptions:
        frequency.update(set(description.split()))
    cutoff = max(2, int(len(descriptions) * COMMON_TOKEN_SHARE))
    return {token for token, count in frequency.items() if count >= cutoff}


def description_similarity(left: str, right: str, common: set[str]) -> float:
    """Token overlap ignoring the tokens everything shares."""
    left_tokens = set(left.split()) - common
    right_tokens = set(right.split()) - common
    if not left_tokens or not right_tokens:
        return 0.0
    return len(left_tokens & right_tokens) / max(len(left_tokens), len(right_tokens))


def _classify(dates: list[date]) -> Optional[tuple[str, float, float]]:
    """(frequency, median gap, consistency) when the dates form a schedule."""
    if len(dates) < MIN_OCCURRENCES:
        return None
    gaps = [(later - earlier).days for earlier, later in zip(dates, dates[1:])]
    gaps = [gap for gap in gaps if gap > 0]
    if len(gaps) < MIN_OCCURRENCES - 1:
        return None

    median = statistics.median(gaps)
    band = next(
        (name for name, typical, tolerance in FREQUENCY_BANDS if abs(median - typical) <= tolerance),
        None,
    )
    if band is None:
        return None

    on_schedule = sum(1 for gap in gaps if abs(gap - median) <= max(1.0, median * GAP_TOLERANCE))
    consistency = on_schedule / len(gaps)
    if consistency < MIN_CONSISTENCY:
        return None
    return band, median, consistency


def _fingerprint(tx_type: str, description: str) -> str:
    """Stable id for dismissals. Survives new charges landing in the group."""
    return f"{tx_type}:{description}"[:200]


def _dismissed(user: Optional[User], key: str) -> set[str]:
    preferences = (user.preferences if user else None) or {}
    stored = preferences.get(key)
    return {str(item) for item in stored} if isinstance(stored, list) else set()


async def get_suggestions(
    session: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID
) -> list[RecurringSuggestion]:
    since = date.today() - timedelta(days=31 * HISTORY_MONTHS)

    user = await session.get(User, user_id)
    dismissed = _dismissed(user, PREFERENCE_KEY)
    muted_categories = _dismissed(user, CATEGORY_PREFERENCE_KEY)

    categories = {
        category.id: category
        for category in (
            await session.execute(select(Category).where(Category.workspace_id == workspace_id))
        ).scalars()
    }
    accounts = {
        account.id: account
        for account in (
            await session.execute(select(Account).where(Account.workspace_id == workspace_id))
        ).scalars()
    }

    # Paired transfers and card payments move money between the user's own
    # accounts; registering one as a bill double-counts it in the very forecast
    # this feature exists to fill. Installments end on a known date, so they are
    # not a standing commitment either.
    result = await session.execute(
        select(Transaction)
        .where(
            Transaction.workspace_id == workspace_id,
            Transaction.date >= since,
            Transaction.source != "opening_balance",
            Transaction.is_ignored == False,  # noqa: E712
            Transaction.transfer_pair_id.is_(None),
            Transaction.total_installments.is_(None),
        )
        .order_by(Transaction.date)
    )
    transactions = [
        tx
        for tx in result.scalars()
        if not _is_excluded(tx, categories, muted_categories)
    ]
    if not transactions:
        return []

    exact: dict[tuple[str, str], list[Transaction]] = {}
    for tx in transactions:
        exact.setdefault((tx.type, normalize_description(tx.description)), []).append(tx)

    common = common_tokens(description for _, description in exact)

    # Merge similar groups, largest first, so the biggest group keeps its label.
    # The account is deliberately not part of the key: the same commitment often
    # moves between accounts, and splitting it hides a schedule that is really
    # there — one rent paid from three accounts scored 67% split and 90% merged.
    merged: list[tuple[str, str, list[Transaction]]] = []
    for key in sorted(exact, key=lambda k: -len(exact[k])):
        tx_type, description = key
        target = next(
            (
                group
                for group in merged
                if group[0] == tx_type and description_similarity(group[1], description, common) >= MERGE_SIMILARITY
            ),
            None,
        )
        if target is None:
            merged.append((tx_type, description, list(exact[key])))
        else:
            target[2].extend(exact[key])

    existing = (
        await session.execute(
            select(RecurringTransaction).where(RecurringTransaction.workspace_id == workspace_id)
        )
    ).scalars().all()

    suggestions: list[RecurringSuggestion] = []
    for tx_type, description, items in merged:
        fingerprint = _fingerprint(tx_type, description)
        if fingerprint in dismissed:
            continue
        if any(
            bill.type == tx_type
            and description_similarity(normalize_description(bill.description), description, common)
            >= MERGE_SIMILARITY
            for bill in existing
        ):
            continue

        items.sort(key=lambda tx: tx.date)
        classified = _classify([tx.date for tx in items])
        if classified is None:
            continue
        frequency, median_gap, confidence = classified

        amounts = [tx.amount for tx in items]
        amount = Decimal(str(statistics.median(float(value) for value in amounts))).quantize(
            Decimal("0.01")
        )
        if abs(amount) < MIN_AMOUNT:
            continue

        last = items[-1]
        next_date = last.date + timedelta(days=round(median_gap))
        used_accounts = list(dict.fromkeys(tx.account_id for tx in items))

        suggestions.append(
            RecurringSuggestion(
                fingerprint=fingerprint,
                description=(last.description or "").strip(),
                amount=amount,
                amount_varies=len(set(amounts)) > 1,
                currency=accounts[last.account_id].currency
                if last.account_id in accounts
                else last.currency,
                type=tx_type,
                frequency=frequency,
                confidence=round(confidence, 2),
                occurrences=len(items),
                first_date=items[0].date,
                last_date=last.date,
                next_date=next_date,
                # Only meaningful for a monthly schedule, and only when the day
                # is actually stable; a bill that wanders has no day to offer.
                day_of_month=_stable_day_of_month(items) if frequency == "monthly" else None,
                # The account that paid most recently: the create form needs
                # exactly one, even when the history spans several.
                account_id=last.account_id,
                account_ids=used_accounts,
                category_id=_dominant_category(items),
            )
        )

    # Biggest commitments first: what moves the budget is what deserves the
    # user's attention, and confidence is on the row for them to judge.
    suggestions.sort(key=lambda s: abs(s.amount), reverse=True)
    return suggestions


def _is_excluded(
    tx: Transaction, categories: dict[uuid.UUID, Category], muted: set[str]
) -> bool:
    category = categories.get(tx.category_id) if tx.category_id else None
    if category is None:
        return False
    if category.treat_as_transfer or category.is_ignored:
        return True
    return str(category.id) in muted


def _stable_day_of_month(items: list[Transaction]) -> Optional[int]:
    days = [tx.date.day for tx in items]
    most_common, count = Counter(days).most_common(1)[0]
    return most_common if count >= len(days) / 2 else None


def _dominant_category(items: list[Transaction]) -> Optional[uuid.UUID]:
    present = [tx.category_id for tx in items if tx.category_id]
    if not present:
        return None
    return Counter(present).most_common(1)[0][0]


async def dismiss(
    session: AsyncSession, user_id: uuid.UUID, *, fingerprint: Optional[str] = None,
    category_id: Optional[uuid.UUID] = None,
) -> None:
    """Hide one suggestion, or every suggestion in a category.

    The category flavour is what retires bank fees and interest without naming
    a category in code: those arrive under whatever the user called them, and
    "Tarifas/Juros" is not a seeded category with a stable key.
    """
    user = await session.get(User, user_id)
    if user is None:
        return
    preferences = dict(user.preferences or {})

    if fingerprint:
        stored = list(preferences.get(PREFERENCE_KEY) or [])
        if fingerprint not in stored:
            stored.append(fingerprint)
        preferences[PREFERENCE_KEY] = stored
    if category_id:
        stored = list(preferences.get(CATEGORY_PREFERENCE_KEY) or [])
        if str(category_id) not in stored:
            stored.append(str(category_id))
        preferences[CATEGORY_PREFERENCE_KEY] = stored

    # Reassign rather than mutate: SQLAlchemy does not track in-place edits to a
    # JSON column, so an appended list would never reach the database.
    user.preferences = preferences
    await session.commit()

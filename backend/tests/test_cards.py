"""Cards — the several plastics that share one credit-card account.

Covers the three things that can go wrong: a charge attributed to the wrong
card (or to none), a summary that counts something the rest of the app does
not call spend, and a name that cannot be given or is given to a card that
should not have one.
"""
import uuid
from datetime import date, timedelta
from decimal import Decimal

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.account import Account
from app.models.card import Card
from app.models.category import Category
from app.models.transaction import Transaction
from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.card import CardUpdate
from app.services import card_service


async def _register_sqlite_to_char(session: AsyncSession) -> None:
    """SQLite stand-in for Postgres `to_char(date, 'YYYY-MM')`.

    The month buckets use the same expression the reports do, which only
    exists on Postgres; without this the summary cannot be exercised at all
    under the SQLite test backend.
    """

    def _to_char(value, fmt):
        return None if value is None else str(value)[:7]

    raw = await session.connection()
    await raw.run_sync(
        lambda conn: conn.connection.dbapi_connection.create_function("to_char", 2, _to_char)
    )


async def _make_card_account(
    session: AsyncSession, user: User, workspace: Workspace, name: str = "PLATINUM"
) -> Account:
    account = Account(
        id=uuid.uuid4(),
        user_id=user.id,
        workspace_id=workspace.id,
        name=name,
        type="credit_card",
        balance=Decimal("0.00"),
        currency="BRL",
    )
    session.add(account)
    await session.commit()
    await session.refresh(account)
    return account


async def _charge(
    session: AsyncSession,
    user: User,
    workspace: Workspace,
    account: Account,
    amount: str,
    when: date,
    *,
    last4: str | None = None,
    description: str = "Mercado",
    txn_type: str = "debit",
    category_id: uuid.UUID | None = None,
    transfer_pair_id: uuid.UUID | None = None,
    is_ignored: bool = False,
) -> Transaction:
    raw = {"creditCardMetadata": {"cardNumber": last4}} if last4 else None
    tx = Transaction(
        id=uuid.uuid4(),
        user_id=user.id,
        workspace_id=workspace.id,
        account_id=account.id,
        description=description,
        amount=Decimal(amount),
        amount_primary=Decimal(amount),
        currency="BRL",
        date=when,
        effective_date=when,
        type=txn_type,
        source="sync",
        status="posted",
        raw_data=raw,
        category_id=category_id,
        transfer_pair_id=transfer_pair_id,
        is_ignored=is_ignored,
    )
    session.add(tx)
    await session.commit()
    await session.refresh(tx)
    return tx


@pytest.mark.asyncio
async def test_attribution_splits_the_account_by_card(
    session: AsyncSession, test_user: User, test_workspace: Workspace
):
    account = await _make_card_account(session, test_user, test_workspace)
    today = date.today()
    first = await _charge(session, test_user, test_workspace, account, "100.00", today, last4="2925")
    second = await _charge(session, test_user, test_workspace, account, "50.00", today, last4="4502")
    same_card = await _charge(session, test_user, test_workspace, account, "20.00", today, last4="2925")
    fee = await _charge(session, test_user, test_workspace, account, "3.85", today, description="IOF")

    attributed = await card_service.attribute_cards_for_account(session, account)
    await session.commit()

    assert attributed == 3
    cards = (
        await session.execute(select(Card).where(Card.account_id == account.id))
    ).scalars().all()
    assert sorted(c.last4 for c in cards if c.last4) == ["2925", "4502"]

    await session.refresh(first)
    await session.refresh(second)
    await session.refresh(same_card)
    await session.refresh(fee)
    assert first.card_id == same_card.card_id
    assert second.card_id != first.card_id
    # A charge the provider never named stays unattributed on purpose: it is
    # the account's, and the default card is where the page shows it.
    assert fee.card_id is None


@pytest.mark.asyncio
async def test_attribution_runs_again_without_changing_anything(
    session: AsyncSession, test_user: User, test_workspace: Workspace
):
    """The pass runs after every sync, so it has to be safe to repeat."""
    account = await _make_card_account(session, test_user, test_workspace)
    today = date.today()
    tx = await _charge(session, test_user, test_workspace, account, "10.00", today, last4="2925")
    fee = await _charge(session, test_user, test_workspace, account, "3.85", today, description="IOF")

    assert await card_service.attribute_cards_for_account(session, account) == 1
    await session.commit()
    await session.refresh(tx)
    first_pass = tx.card_id

    assert await card_service.attribute_cards_for_account(session, account) == 0
    await session.commit()
    await session.refresh(tx)
    await session.refresh(fee)
    assert tx.card_id == first_pass
    # And a second row was not minted for the same four digits.
    cards = (
        await session.execute(select(Card).where(Card.account_id == account.id))
    ).scalars().all()
    assert [c.last4 for c in cards if c.last4] == ["2925"]
    assert fee.card_id is None


@pytest.mark.asyncio
async def test_summary_counts_spend_the_way_the_reports_do(
    session: AsyncSession, test_user: User, test_workspace: Workspace
):
    await _register_sqlite_to_char(session)
    account = await _make_card_account(session, test_user, test_workspace)
    today = date.today()

    transfer_category = Category(
        id=uuid.uuid4(),
        user_id=test_user.id,
        workspace_id=test_workspace.id,
        name="Card payment",
        treat_as_transfer=True,
    )
    session.add(transfer_category)
    await session.commit()

    await _charge(session, test_user, test_workspace, account, "100.00", today, last4="2925")
    await _charge(session, test_user, test_workspace, account, "40.00", today, last4="4502")
    # Everything below is excluded by the shared P/L definition, and so must
    # not reach the ranking: a bill payment, a paired transfer, an ignored
    # row and a charge dated in the future.
    await _charge(
        session, test_user, test_workspace, account, "900.00", today,
        last4="8181", txn_type="credit", description="PAGAMENTO ON LINE",
        category_id=transfer_category.id,
    )
    await _charge(
        session, test_user, test_workspace, account, "77.00", today,
        last4="2925", transfer_pair_id=uuid.uuid4(),
    )
    await _charge(
        session, test_user, test_workspace, account, "55.00", today,
        last4="2925", is_ignored=True,
    )
    await _charge(
        session, test_user, test_workspace, account, "33.00", today + timedelta(days=40),
        last4="2925",
    )

    await card_service.attribute_cards_for_account(session, account)
    await session.commit()

    summary = await card_service.get_card_summary(
        session, test_workspace.id, test_user.id, months=12
    )

    totals = {
        (card.last4 or "default"): card.total for card in summary.cards
    }
    assert totals["2925"] == 100.0
    assert totals["4502"] == 40.0
    # The payment card exists (the bank named it) but spent nothing.
    assert totals["8181"] == 0.0
    assert summary.total == 140.0

    ranked = [card.last4 for card in summary.cards]
    assert ranked[0] == "2925"
    assert summary.cards[0].share == pytest.approx(100 / 140)

    month = today.strftime("%Y-%m")
    point = next(p for p in summary.monthly if p.period == month)
    assert sum(point.totals.values()) == 140.0


@pytest.mark.asyncio
async def test_summary_puts_unattributed_charges_on_the_default_card(
    session: AsyncSession, test_user: User, test_workspace: Workspace
):
    await _register_sqlite_to_char(session)
    account = await _make_card_account(session, test_user, test_workspace, name="Viacredi 1230")
    today = date.today()
    await _charge(session, test_user, test_workspace, account, "21.49", today, description="Posto")
    await _charge(session, test_user, test_workspace, account, "9.00", today, description="Mercearia")

    summary = await card_service.get_card_summary(
        session, test_workspace.id, test_user.id, months=12
    )

    assert len(summary.cards) == 1
    only = summary.cards[0]
    assert only.is_default
    assert only.last4 is None
    assert only.name is None  # the UI falls back to the account name
    assert only.total == 30.49
    assert only.transaction_count == 2


@pytest.mark.asyncio
async def test_categories_follow_the_selected_card(
    session: AsyncSession, test_user: User, test_workspace: Workspace
):
    await _register_sqlite_to_char(session)
    account = await _make_card_account(session, test_user, test_workspace)
    today = date.today()

    groceries = Category(
        id=uuid.uuid4(), user_id=test_user.id, workspace_id=test_workspace.id, name="Groceries"
    )
    fuel = Category(
        id=uuid.uuid4(), user_id=test_user.id, workspace_id=test_workspace.id, name="Fuel"
    )
    session.add_all([groceries, fuel])
    await session.commit()

    await _charge(
        session, test_user, test_workspace, account, "100.00", today,
        last4="2925", category_id=groceries.id,
    )
    await _charge(
        session, test_user, test_workspace, account, "60.00", today,
        last4="4502", category_id=fuel.id,
    )
    await card_service.attribute_cards_for_account(session, account)
    await session.commit()

    everything = await card_service.get_card_summary(
        session, test_workspace.id, test_user.id, months=12
    )
    assert {item.name for item in everything.categories} == {"Groceries", "Fuel"}

    target = next(card for card in everything.cards if card.last4 == "4502")
    one_card = await card_service.get_card_summary(
        session, test_workspace.id, test_user.id, months=12, card_id=target.id
    )
    assert [item.name for item in one_card.categories] == ["Fuel"]
    assert one_card.categories[0].share == 1.0


@pytest.mark.asyncio
async def test_naming_a_card_and_clearing_the_name(
    session: AsyncSession, test_user: User, test_workspace: Workspace
):
    account = await _make_card_account(session, test_user, test_workspace)
    today = date.today()
    await _charge(session, test_user, test_workspace, account, "10.00", today, last4="2925")
    await card_service.attribute_cards_for_account(session, account)
    await session.commit()

    cards = await card_service.get_cards(session, test_workspace.id)
    # Exactly two shapes exist: the account's catch-all, and what a bank named.
    assert sorted(bool(card.last4) for card in cards) == [False, True]
    provider_card = next(card for card in cards if card.last4 == "2925")

    named = await card_service.update_card(
        session, provider_card.id, test_workspace.id, CardUpdate(name="Mine")
    )
    assert named.name == "Mine"
    # Clearing the name restores the fallback rather than storing a blank.
    cleared = await card_service.update_card(
        session, provider_card.id, test_workspace.id, CardUpdate(name="  ")
    )
    assert cleared.name is None


@pytest.mark.asyncio
async def test_transaction_list_filters_by_card(
    client: AsyncClient,
    auth_headers,
    session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
):
    account = await _make_card_account(session, test_user, test_workspace)
    today = date.today()
    await _charge(
        session, test_user, test_workspace, account, "100.00", today,
        last4="2925", description="Named card",
    )
    await _charge(
        session, test_user, test_workspace, account, "7.00", today, description="Account fee",
    )
    await card_service.attribute_cards_for_account(session, account)
    await session.commit()

    listed = await client.get("/api/cards", headers=auth_headers)
    assert listed.status_code == 200
    cards = listed.json()
    provider_card = next(card for card in cards if card["last4"] == "2925")
    default_card = next(card for card in cards if card["is_default"])

    response = await client.get(
        "/api/transactions", headers=auth_headers, params={"card_id": provider_card["id"]}
    )
    assert [item["description"] for item in response.json()["items"]] == ["Named card"]

    # The default card owns what the account never attributed, which an
    # equality on card_id would miss entirely.
    response = await client.get(
        "/api/transactions", headers=auth_headers, params={"card_id": default_card["id"]}
    )
    assert [item["description"] for item in response.json()["items"]] == ["Account fee"]

    unknown = await client.get(
        "/api/transactions", headers=auth_headers, params={"card_id": str(uuid.uuid4())}
    )
    assert unknown.json()["items"] == []


@pytest.mark.asyncio
async def test_cards_are_scoped_to_their_workspace(
    client: AsyncClient,
    auth_headers,
    session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
):
    other = Workspace(
        id=uuid.uuid4(),
        name="Other",
        created_by_user_id=test_user.id,
        default_currency="BRL",
    )
    session.add(other)
    await session.commit()

    foreign_account = await _make_card_account(session, test_user, other, name="Elsewhere")
    foreign_card = Card(
        id=uuid.uuid4(),
        workspace_id=other.id,
        account_id=foreign_account.id,
        is_default=True,
    )
    session.add(foreign_card)
    await session.commit()

    listed = await client.get("/api/cards", headers=auth_headers)
    assert all(card["account_name"] != "Elsewhere" for card in listed.json())

    renamed = await client.patch(
        f"/api/cards/{foreign_card.id}", headers=auth_headers, json={"name": "Nope"}
    )
    assert renamed.status_code == 404

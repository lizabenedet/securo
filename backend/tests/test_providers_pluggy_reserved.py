"""Reserved balances ("cofrinhos") reported inside a Pluggy bank account.

Mercado Pago (and other accounts flagged `hasReservedBalance`) keep money set
aside in `bankData.reservedBalances`, outside the account's `balance` and
absent from /investments. `get_holdings` surfaces each one as a holding.
"""

from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.providers.pluggy import PluggyProvider, _build_reserved_holdings


def _account(reserved, *, name="Mercado Pago", id_="acc-mp"):
    return {
        "id": id_,
        "name": name,
        "currencyCode": "BRL",
        "balance": 30478.62,
        "bankData": {"hasReservedBalance": True, "reservedBalances": reserved},
    }


def _reserved(identification, amount, *, name=None, pct=1.199983):
    entry = {
        "identification": identification,
        "availableAmounts": [
            {
                "amount": amount,
                "currencyCode": "BRL",
                "remuneration": {"indexer": "CDI", "postFixedIndexerPercentage": pct},
            }
        ],
    }
    if name is not None:
        entry["name"] = name
    return entry


def test_each_reserved_balance_becomes_a_holding_on_its_account():
    holdings = _build_reserved_holdings(
        _account([
            _reserved("r-ml", 2021.67, name="Cofrinho Mercado Livre", pct=1.399982),
            _reserved("r-cdi", 10270.75),
        ])
    )

    assert [h.external_id for h in holdings] == ["reserved:r-ml", "reserved:r-cdi"]
    ml, cdi = holdings
    assert ml.name == "Cofrinho Mercado Livre"
    assert ml.current_value == Decimal("2021.67")
    assert ml.currency == "BRL"
    assert ml.account_external_id == "acc-mp"
    assert ml.account_name == "Mercado Pago"
    assert ml.metadata["remuneration"]["postFixedIndexerPercentage"] == 1.399982
    assert not ml.is_withdrawn
    # Pluggy sends no name for some of them.
    assert cdi.name == "Cofrinho"


def test_account_without_reserved_balances_yields_nothing():
    assert _build_reserved_holdings({"id": "a", "name": "Inter", "bankData": None}) == []
    assert _build_reserved_holdings({"id": "a", "name": "Nubank", "bankData": {"hasReservedBalance": True}}) == []
    assert _build_reserved_holdings({"id": "a", "name": "Card", "creditData": {}}) == []


def test_reserved_balance_without_identification_is_skipped():
    holdings = _build_reserved_holdings(_account([{"availableAmounts": [{"amount": 5}]}]))
    assert holdings == []


def test_amounts_in_several_lines_are_added_up():
    entry = _reserved("r", 100)
    entry["availableAmounts"].append({"amount": 0.5, "currencyCode": "BRL"})
    (holding,) = _build_reserved_holdings(_account([entry]))
    assert holding.current_value == Decimal("100.5")


def test_emptied_reserved_balance_is_reported_withdrawn():
    """An emptied cofrinho closes the position (history stays) instead of
    recording a zero; a refilled one reopens through the ACTIVE status."""
    (empty,) = _build_reserved_holdings(_account([_reserved("r", 0)]))
    assert empty.is_withdrawn
    assert empty.metadata["status"] == "TOTAL_WITHDRAWAL"

    (full,) = _build_reserved_holdings(_account([_reserved("r", 10)]))
    assert full.metadata["status"] == "ACTIVE"


def _response(payload):
    resp = MagicMock(raise_for_status=MagicMock())
    resp.json = MagicMock(return_value=payload)
    return resp


@pytest.mark.asyncio
async def test_get_holdings_appends_reserved_balances_to_investments():
    investment = {"id": "inv-1", "name": "CDB", "balance": 500, "currencyCode": "BRL", "type": "FIXED_INCOME"}
    client = MagicMock()
    client.get = AsyncMock(side_effect=[
        _response({"results": [investment], "totalPages": 1}),
        _response({"results": [_account([_reserved("r-cdi", 10270.75)]), {"id": "x", "name": "Inter", "bankData": {}}]}),
    ])
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=None)

    with patch.object(
        PluggyProvider, "_ensure_api_key", new=AsyncMock(return_value="k")
    ), patch("app.providers.pluggy.httpx.AsyncClient", return_value=client):
        holdings = await PluggyProvider().get_holdings({"item_id": "item-1"})

    assert [h.external_id for h in holdings] == ["inv-1", "reserved:r-cdi"]
    accounts_call = client.get.await_args_list[1]
    assert accounts_call.args[0].endswith("/accounts")
    assert accounts_call.kwargs["params"] == {"itemId": "item-1"}


@pytest.mark.asyncio
async def test_get_holdings_fails_whole_when_accounts_call_fails():
    """Returning only the investments would make the sync archive every
    cofrinho as gone; failing lets it skip the run untouched."""
    bad = MagicMock()
    bad.raise_for_status = MagicMock(side_effect=RuntimeError("500"))
    client = MagicMock()
    client.get = AsyncMock(side_effect=[_response({"results": [], "totalPages": 1}), bad])
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=None)

    with patch.object(
        PluggyProvider, "_ensure_api_key", new=AsyncMock(return_value="k")
    ), patch("app.providers.pluggy.httpx.AsyncClient", return_value=client):
        with pytest.raises(RuntimeError):
            await PluggyProvider().get_holdings({"item_id": "item-1"})

from datetime import date

import pytest
from httpx import AsyncClient

from app.schemas.report import (
    CategoryTrendItem,
    ReportDataPoint,
    ReportMeta,
    ReportResponse,
    ReportSummary,
)
from app.services import fixed_variable_report_service, report_service
from app.services.fixed_variable_report_service import closed_period_count


def _series(values: dict[str, float]) -> list[ReportDataPoint]:
    return [ReportDataPoint(date=label, value=value, breakdowns={}) for label, value in values.items()]


def _base_report(category_trend, trend_points):
    return ReportResponse(
        summary=ReportSummary(primary_value=0, change_amount=0, change_percent=None, breakdowns=[]),
        trend=[
            ReportDataPoint(date=label, value=income - expenses, breakdowns={"income": income, "expenses": expenses})
            for label, income, expenses in trend_points
        ],
        meta=ReportMeta(type="income_expenses", series_keys=[], currency="BRL", interval="monthly"),
        category_trend=category_trend,
    )


def _patch_base(monkeypatch, report):
    captured = {}

    async def fake_report(session, workspace_id, user_id, months, interval, currency, **kwargs):
        captured.update(kwargs, months=months, interval=interval)
        return report

    monkeypatch.setattr(report_service, "get_income_expenses_report", fake_report)
    return captured


def test_the_period_holding_today_is_not_closed():
    labels = ["2026-08", "2026-09", "2026-10"]
    assert closed_period_count(labels, "monthly", date(2026, 10, 13), date(2026, 10, 13)) == 2


def test_a_window_ending_before_today_is_all_closed():
    labels = ["2026-07", "2026-08", "2026-09"]
    assert closed_period_count(labels, "monthly", date(2026, 9, 30), date(2026, 10, 13)) == 3


def test_a_single_period_window_keeps_its_period():
    assert closed_period_count(["2026-10"], "monthly", date(2026, 10, 13), date(2026, 10, 13)) == 1


@pytest.mark.asyncio
async def test_expenses_are_split_by_the_category_flag(
    session, test_user, test_workspace, test_categories, monkeypatch
):
    rent, transport, salary = test_categories
    rent.is_fixed = True
    await session.commit()

    monkeypatch.setattr(fixed_variable_report_service, "app_today", lambda: date(2026, 10, 13))
    _patch_base(monkeypatch, _base_report(
        category_trend=[
            CategoryTrendItem(
                key=str(rent.id), label=rent.name, color=rent.color, total=3000, group="expenses",
                series=_series({"2026-08": 1000, "2026-09": 1000, "2026-10": 1000}),
            ),
            CategoryTrendItem(
                key=str(transport.id), label=transport.name, color=transport.color, total=900, group="expenses",
                series=_series({"2026-08": 200, "2026-09": 600, "2026-10": 100}),
            ),
            CategoryTrendItem(
                key=str(salary.id), label=salary.name, color=salary.color, total=15000, group="income",
                series=_series({"2026-08": 5000, "2026-09": 5000, "2026-10": 5000}),
            ),
        ],
        # Expenses carry 50 more than the categories in September: spending
        # with no category row of its own (a friend's split) lands as variable.
        trend_points=[("2026-08", 5000, 1200), ("2026-09", 5000, 1650), ("2026-10", 5000, 1100)],
    ))

    report = await fixed_variable_report_service.get_fixed_variable_report(
        session, test_workspace.id, test_user.id, currency="BRL",
    )

    by_month = {p.date: p.breakdowns for p in report.trend}
    assert by_month["2026-08"] == {"fixed": 1000, "variable": 200, "income": 5000}
    assert by_month["2026-09"] == {"fixed": 1000, "variable": 650, "income": 5000}
    for point in report.trend:
        assert point.breakdowns["fixed"] + point.breakdowns["variable"] == point.value

    summary = {b.key: b.value for b in report.summary.breakdowns}
    # October is still running, so the averages use August and September only.
    assert summary["closedPeriods"] == 2
    assert summary["fixedAverage"] == 1000
    assert summary["variableAverage"] == 425
    assert summary["fixedShareOfIncome"] == 20.0

    groups = {item.label: item.group for item in report.category_trend}
    assert groups == {rent.name: "fixed", transport.name: "variable"}
    assert report.meta.type == "fixed_variable"


@pytest.mark.asyncio
async def test_an_unmarked_workspace_is_all_variable(
    session, test_user, test_workspace, test_categories, monkeypatch
):
    food = test_categories[0]
    monkeypatch.setattr(fixed_variable_report_service, "app_today", lambda: date(2026, 10, 13))
    _patch_base(monkeypatch, _base_report(
        category_trend=[
            CategoryTrendItem(
                key=str(food.id), label=food.name, color=food.color, total=800, group="expenses",
                series=_series({"2026-09": 500, "2026-10": 300}),
            ),
        ],
        trend_points=[("2026-09", 0, 500), ("2026-10", 0, 300)],
    ))

    report = await fixed_variable_report_service.get_fixed_variable_report(
        session, test_workspace.id, test_user.id,
    )

    assert [p.breakdowns["fixed"] for p in report.trend] == [0, 0]
    summary = {b.key: b.value for b in report.summary.breakdowns}
    assert summary["variableAverage"] == 500
    # No income in the window: a share of nothing is left out, not 0%.
    assert "fixedShareOfIncome" not in summary


@pytest.mark.asyncio
async def test_empty_leading_months_stay_out_of_the_averages(
    session, test_user, test_workspace, test_categories, monkeypatch
):
    # A year the user ignored on purpose comes back as months of zeros.
    food = test_categories[0]
    monkeypatch.setattr(fixed_variable_report_service, "app_today", lambda: date(2026, 10, 13))
    _patch_base(monkeypatch, _base_report(
        category_trend=[
            CategoryTrendItem(
                key=str(food.id), label=food.name, color=food.color, total=1200, group="expenses",
                series=_series({"2025-12": 0, "2026-01": 600, "2026-02": 600, "2026-10": 0}),
            ),
        ],
        trend_points=[("2025-12", 0, 0), ("2026-01", 3000, 600), ("2026-02", 3000, 600), ("2026-10", 0, 0)],
    ))

    report = await fixed_variable_report_service.get_fixed_variable_report(
        session, test_workspace.id, test_user.id,
    )

    assert [p.date for p in report.trend] == ["2026-01", "2026-02", "2026-10"]
    assert [p.date for p in report.category_trend[0].series] == ["2026-01", "2026-02", "2026-10"]
    summary = {b.key: b.value for b in report.summary.breakdowns}
    assert summary["closedPeriods"] == 2
    assert summary["variableAverage"] == 600


@pytest.mark.asyncio
async def test_endpoint_forwards_the_window(client: AsyncClient, auth_headers, monkeypatch):
    captured = _patch_base(monkeypatch, _base_report(category_trend=[], trend_points=[]))

    response = await client.get(
        "/api/reports/fixed-variable",
        params={"start_date": "2026-02-01", "end_date": "2026-09-30", "interval": "monthly"},
        headers=auth_headers,
    )

    assert response.status_code == 200
    assert response.json()["meta"]["type"] == "fixed_variable"
    assert captured["start_date"] == date(2026, 2, 1)
    assert captured["end_date"] == date(2026, 9, 30)


@pytest.mark.asyncio
async def test_a_category_can_be_marked_fixed(client: AsyncClient, auth_headers, test_categories):
    category_id = str(test_categories[0].id)

    response = await client.patch(
        f"/api/categories/{category_id}", headers=auth_headers, json={"is_fixed": True},
    )

    assert response.status_code == 200
    assert response.json()["is_fixed"] is True

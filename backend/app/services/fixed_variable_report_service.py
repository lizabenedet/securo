"""Spending split into fixed and variable, period by period.

"Fixed" is a property of the category (``Category.is_fixed``): spending that
comes every month whatever its amount. An unmarked category counts as
variable, so the report works before the user has marked anything.

Built on top of the income/expenses report rather than beside it. That report
already decides what counts as spending — paired transfers, card payments,
ignored rows and other people's split shares are out — and re-deriving those
rules here would let the two tabs disagree. Only the grouping is new: each
period's expenses are cut into the fixed categories and everything else, so
fixed + variable equals the income/expenses bar for the same period exactly.
"""
import uuid
from datetime import date
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.app_clock import app_today
from app.models.category import Category
from app.schemas.report import (
    CategoryTrendItem,
    ReportBreakdown,
    ReportDataPoint,
    ReportMeta,
    ReportResponse,
    ReportSummary,
)
from app.services import report_service

FIXED_COLOR = "#6366F1"
VARIABLE_COLOR = "#F59E0B"
INCOME_COLOR = "#10B981"


def closed_period_count(labels: list[str], interval: str, axis_end: date, today: date) -> int:
    """How many leading periods are complete.

    The period holding today is still filling up; averaging it in would drag
    every mean down. A single-period window keeps its only period, so the
    report never averages over nothing.
    """
    if (
        len(labels) > 1
        and axis_end >= today
        and labels[-1] == report_service._format_date_label(today, interval)
    ):
        return len(labels) - 1
    return len(labels)


async def get_fixed_variable_report(
    session: AsyncSession,
    workspace_id: uuid.UUID,
    user_id: uuid.UUID,
    months: int = 12,
    interval: str = "monthly",
    currency: str = "USD",
    account_ids: Optional[list[uuid.UUID]] = None,
    period: str | None = None,
    days: int | None = None,
    financial_year_start_month: int = 1,
    start_date: date | None = None,
    end_date: date | None = None,
) -> ReportResponse:
    base = await report_service.get_income_expenses_report(
        session, workspace_id, user_id, months, interval, currency,
        account_ids=account_ids, period=period, days=days,
        financial_year_start_month=financial_year_start_month,
        start_date=start_date, end_date=end_date,
    )

    fixed_ids = {
        str(category_id)
        for category_id in (
            await session.execute(
                select(Category.id).where(
                    Category.workspace_id == workspace_id, Category.is_fixed.is_(True)
                )
            )
        ).scalars()
    }

    # Leading periods with no movement at all are cut: they are history the
    # app has nothing for (or that the user ignored on purpose, like a whole
    # year before the books were clean), and averaging them in as zeros would
    # understate every monthly figure.
    first_active = next(
        (
            index
            for index, point in enumerate(base.trend)
            if point.breakdowns.get("expenses", 0.0) or point.breakdowns.get("income", 0.0)
        ),
        max(len(base.trend) - 1, 0),
    )
    base.trend = base.trend[first_active:]
    for item in base.category_trend:
        item.series = item.series[first_active:]

    labels = [point.date for point in base.trend]
    closed = closed_period_count(labels, interval, end_date or app_today(), app_today())

    fixed_by_period = {label: 0.0 for label in labels}
    categories: list[tuple[float, CategoryTrendItem]] = []
    for item in base.category_trend:
        if item.group != "expenses":
            continue
        group = "fixed" if item.key in fixed_ids else "variable"
        if group == "fixed":
            for point in item.series:
                fixed_by_period[point.date] = fixed_by_period.get(point.date, 0.0) + point.value
        closed_sum = sum(point.value for point in item.series[:closed])
        categories.append((
            closed_sum,
            CategoryTrendItem(
                key=item.key, label=item.label, color=item.color,
                total=item.total, group=group, series=item.series,
            ),
        ))
    categories.sort(key=lambda pair: pair[0], reverse=True)

    trend: list[ReportDataPoint] = []
    for point in base.trend:
        expenses = point.breakdowns.get("expenses", 0.0)
        # Variable is whatever the fixed categories leave, so the two always
        # add up to the income/expenses total — including spending that has
        # no category row of its own, such as a friend's split.
        fixed = min(round(fixed_by_period.get(point.date, 0.0), 2), expenses)
        variable = round(expenses - fixed, 2)
        trend.append(ReportDataPoint(
            date=point.date,
            value=round(expenses, 2),
            breakdowns={
                "fixed": fixed,
                "variable": variable,
                "income": point.breakdowns.get("income", 0.0),
            },
        ))

    closed_points = trend[:closed]
    fixed_total = sum(p.breakdowns["fixed"] for p in closed_points)
    variable_total = sum(p.breakdowns["variable"] for p in closed_points)
    income_total = sum(p.breakdowns["income"] for p in closed_points)
    divisor = max(closed, 1)
    fixed_average = round(fixed_total / divisor, 2)
    variable_average = round(variable_total / divisor, 2)
    fixed_share = round(fixed_total / income_total * 100, 1) if income_total > 0 else None

    # Change compares the last two complete periods' fixed spending.
    change_amount = 0.0
    change_percent = None
    if closed >= 2:
        last, previous = closed_points[-1].breakdowns["fixed"], closed_points[-2].breakdowns["fixed"]
        change_amount = round(last - previous, 2)
        change_percent = round(change_amount / previous * 100, 2) if previous else None

    breakdowns = [
        ReportBreakdown(key="fixedAverage", label="Fixed", value=fixed_average, color=FIXED_COLOR),
        ReportBreakdown(key="variableAverage", label="Variable", value=variable_average, color=VARIABLE_COLOR),
        ReportBreakdown(key="closedPeriods", label="Closed periods", value=closed, color="#6B7280"),
    ]
    if fixed_share is not None:
        breakdowns.append(
            ReportBreakdown(key="fixedShareOfIncome", label="Fixed share of income", value=fixed_share, color=INCOME_COLOR)
        )

    return ReportResponse(
        summary=ReportSummary(
            primary_value=fixed_average,
            change_amount=change_amount,
            change_percent=change_percent,
            breakdowns=breakdowns,
        ),
        trend=trend,
        meta=ReportMeta(
            type="fixed_variable",
            series_keys=["fixed", "variable", "income"],
            currency=base.meta.currency,
            interval=interval,
        ),
        category_trend=[item for _, item in categories],
    )

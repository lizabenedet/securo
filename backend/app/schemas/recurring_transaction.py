import uuid
from datetime import date as _Date
from decimal import Decimal
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict

WeekendAdjustment = Literal["none", "previous_friday", "next_monday"]


class RecurringTransactionCreate(BaseModel):
    description: str
    amount: Decimal
    currency: str = "USD"
    type: str  # debit, credit
    frequency: str  # weekly, monthly, quarterly, yearly
    weekend_adjustment: WeekendAdjustment = "none"
    day_of_month: Optional[int] = None
    start_date: _Date
    end_date: Optional[_Date] = None
    account_id: uuid.UUID
    category_id: Optional[uuid.UUID] = None
    skip_first: bool = False  # Set true when first occurrence already created as a transaction
    auto_generate: bool = True  # Materialize occurrences; when false, wait for the real charge


class RecurringTransactionUpdate(BaseModel):
    description: Optional[str] = None
    amount: Optional[Decimal] = None
    currency: Optional[str] = None
    type: Optional[str] = None
    frequency: Optional[str] = None  # weekly, monthly, quarterly, yearly
    weekend_adjustment: Optional[WeekendAdjustment] = None
    day_of_month: Optional[int] = None
    start_date: Optional[_Date] = None
    end_date: Optional[_Date] = None
    account_id: Optional[uuid.UUID] = None
    category_id: Optional[uuid.UUID] = None
    is_active: Optional[bool] = None
    auto_generate: Optional[bool] = None


class RecurringTransactionRead(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    account_id: Optional[uuid.UUID] = None
    category_id: Optional[uuid.UUID] = None
    description: str
    amount: Decimal
    currency: str
    type: str
    frequency: str
    weekend_adjustment: WeekendAdjustment = "none"
    day_of_month: Optional[int] = None
    start_date: _Date
    end_date: Optional[_Date] = None
    is_active: bool
    auto_generate: bool = True
    next_occurrence: _Date
    amount_primary: Optional[float] = None
    fx_rate_used: Optional[float] = None

    model_config = ConfigDict(from_attributes=True)


class RecurringSuggestionRead(BaseModel):
    """A commitment the ledger shows but no bill covers yet.

    Carries what the create form needs to be prefilled plus what the row shows
    for the user to judge: how many charges back it, how regular they were, and
    whether the amount moves.
    """

    fingerprint: str
    description: str
    amount: Decimal
    amount_varies: bool
    currency: str
    type: str
    frequency: str
    # Share of the gaps that landed on schedule (0..1).
    confidence: float
    occurrences: int
    first_date: _Date
    last_date: _Date
    next_date: _Date
    day_of_month: Optional[int] = None
    # The account that paid most recently; the create form needs exactly one.
    account_id: uuid.UUID
    # Every account the charges came from. More than one means the same
    # commitment moved between accounts over time.
    account_ids: list[uuid.UUID] = []
    category_id: Optional[uuid.UUID] = None

    model_config = ConfigDict(from_attributes=True)


class RecurringSuggestionDismiss(BaseModel):
    """Hide one suggestion, or everything in a category.

    The category flavour retires bank fees and interest without naming a
    category in code — they arrive under whatever the user called them.
    """

    fingerprint: Optional[str] = None
    category_id: Optional[uuid.UUID] = None

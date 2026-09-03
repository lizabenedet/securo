import uuid
from datetime import date as _Date
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class CardRead(BaseModel):
    id: uuid.UUID
    account_id: uuid.UUID
    account_name: Optional[str] = None
    #: Brand of the account the card is billed to (MASTERCARD, VISA…), so a
    #: renamed card still shows what it is.
    card_brand: Optional[str] = None
    last4: Optional[str] = None
    #: Null until the user names it. The UI falls back to the digits, or to
    #: the account name for the default card, rather than the API inventing
    #: a label in one language.
    name: Optional[str] = None
    is_default: bool = False

    model_config = ConfigDict(from_attributes=True)


class CardUpdate(BaseModel):
    """The one thing about a card that is ours to say: what to call it.

    Which cards exist, and which charge belongs to which, comes from the
    bank. There is no create or assign here on purpose — a card nobody's
    feed reports could never be filled, and moving a charge by hand would
    only ever make the attribution less true than the bank's own.
    """

    name: Optional[str] = Field(default=None, max_length=60)


class CardSummaryItem(CardRead):
    #: Spend in the requested window, in the user's primary currency.
    total: float = 0
    #: Share of the window's total spend across every card, 0..1.
    share: float = 0
    transaction_count: int = 0
    #: Last charge of any kind, ignoring the window — this is what tells a
    #: card that stopped being used apart from one that never was.
    last_used: Optional[_Date] = None


class CardMonthlyPoint(BaseModel):
    period: str
    #: {card id: spend}. Cards absent from a month spent nothing in it.
    totals: dict[uuid.UUID, float] = {}


class CardCategoryItem(BaseModel):
    category_id: Optional[uuid.UUID] = None
    name: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None
    total: float = 0
    share: float = 0


class CardSummaryResponse(BaseModel):
    currency: str
    start: _Date
    end: _Date
    total: float = 0
    cards: list[CardSummaryItem] = []
    monthly: list[CardMonthlyPoint] = []
    #: Categories of the selected card, or of every card when none is selected.
    categories: list[CardCategoryItem] = []

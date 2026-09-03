import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

if TYPE_CHECKING:
    from app.models.account import Account


class Card(Base):
    """One physical or virtual card inside a credit-card account.

    A card account is not a card: an Inter statement carries the holder's
    card, the extra cards given to family, and the virtual ones minted per
    merchant, all billed together. Providers say which card made a charge
    (Pluggy's `creditCardMetadata.cardNumber`), so the split is theirs to
    hand us — this table only adds the part they cannot know, the name a
    person recognises.

    Every credit-card account owns exactly one `is_default` row, with `last4`
    null. It stands for the account itself and collects what belongs to no
    card: interest, IOF, the annual fee, and every transaction from a source
    that never reports a card (a CSV import, a manual entry).

    So a row is either that one or a card some provider named. There is no
    way to add one by hand, deliberately: nothing would ever attribute a
    charge to it, and a card that stays empty forever is a worse answer than
    not offering it.
    """

    __tablename__ = "cards"
    __table_args__ = (
        # A provider's card number identifies the card within its account;
        # the attribution pass relies on that to be able to upsert.
        UniqueConstraint("account_id", "last4", name="uq_cards_account_last4"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("accounts.id", ondelete="CASCADE"), index=True
    )
    # Last 4 digits as the provider reports them. Null on the account's
    # default row and on cards created by hand, which no feed can match.
    last4: Mapped[Optional[str]] = mapped_column(String(4), nullable=True)
    # The name the user gave it ("cartão da mãe"). Null until they name it,
    # so the UI can fall back to the digits (or the account name) rather
    # than storing a label in whichever language happened to be active.
    name: Mapped[Optional[str]] = mapped_column(String(60), nullable=True)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    account: Mapped["Account"] = relationship(back_populates="cards")

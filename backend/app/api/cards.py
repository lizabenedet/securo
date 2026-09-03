import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_async_session
from app.core.workspace_context import (
    WorkspaceContext,
    current_workspace,
    current_writable_workspace,
)
from app.models.card import Card
from app.schemas.card import CardRead, CardSummaryResponse, CardUpdate
from app.services import card_service

router = APIRouter(prefix="/api/cards", tags=["cards"])


def _to_read(card: Card) -> CardRead:
    return CardRead(
        id=card.id,
        account_id=card.account_id,
        account_name=(card.account.display_name or card.account.name)
        if card.account
        else None,
        card_brand=card.account.card_brand if card.account else None,
        last4=card.last4,
        name=card.name,
        is_default=card.is_default,
    )


@router.get("", response_model=list[CardRead])
async def list_cards(
    ctx: WorkspaceContext = Depends(current_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    cards = await card_service.get_cards(session, ctx.workspace.id)
    return [_to_read(card) for card in cards]


@router.get("/summary", response_model=CardSummaryResponse)
async def card_summary(
    months: int = Query(12, ge=1, le=60),
    period: Optional[str] = Query(None, regex="^(ytd)$"),
    days: Optional[int] = Query(None, ge=1, le=1000),
    card_id: Optional[uuid.UUID] = Query(None),
    ctx: WorkspaceContext = Depends(current_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    return await card_service.get_card_summary(
        session,
        ctx.workspace.id,
        ctx.user_id,
        months=months,
        period=period,
        days=days,
        card_id=card_id,
    )


@router.patch("/{card_id}", response_model=CardRead)
async def update_card(
    card_id: uuid.UUID,
    data: CardUpdate,
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    card = await card_service.update_card(session, card_id, ctx.workspace.id, data)
    if card is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Card not found")
    return _to_read(card)

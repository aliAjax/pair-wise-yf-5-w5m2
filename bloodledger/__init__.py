"""血品账:献血登记 -> 成分制备 -> 血库发放 一体化台账。

支持采血车离线登记、回站合并、复检待定/追回、效期管理。
纯标准库实现(Python 3.8+ / SQLite)。
"""

from .db import connect, init_schema
from .service import (
    BloodLedger,
    MergeInterrupted,
    ComponentPending,
    ComponentUnavailable,
    ComponentExpired,
    UnknownComponent,
    UnknownDonation,
    SHELF_LIFE_DAYS,
    CTYPE_NAMES,
)

__all__ = [
    "connect",
    "init_schema",
    "BloodLedger",
    "MergeInterrupted",
    "ComponentPending",
    "ComponentUnavailable",
    "ComponentExpired",
    "UnknownComponent",
    "UnknownDonation",
    "SHELF_LIFE_DAYS",
    "CTYPE_NAMES",
]

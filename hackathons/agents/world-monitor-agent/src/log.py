"""Structured logging with SSE broadcast support."""

import asyncio
import datetime
import logging
from typing import Optional

_web_log_queue: Optional[asyncio.Queue] = None


def enable_web_logging(queue: asyncio.Queue):
    global _web_log_queue
    _web_log_queue = queue


def get_logger(name: str) -> logging.Logger:
    logger = logging.getLogger(name)
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(asctime)s [%(name)s] %(message)s"))
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
    return logger


def log(logger: logging.Logger, component: str, action: str, message: str):
    entry = {
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "component": component,
        "action": action,
        "message": message,
    }
    logger.info(f"[{component}] {action}: {message}")
    if _web_log_queue is not None:
        try:
            _web_log_queue.put_nowait(entry)
        except asyncio.QueueFull:
            pass

from __future__ import annotations

import json
import queue
import threading
from typing import Any

_subs: dict[int, list[queue.Queue]] = {}
_lock = threading.Lock()


def subscribe(user_id: int) -> queue.Queue:
    q: queue.Queue = queue.Queue(maxsize=64)
    with _lock:
        _subs.setdefault(user_id, []).append(q)
    return q


def unsubscribe(user_id: int, q: queue.Queue) -> None:
    with _lock:
        if user_id in _subs and q in _subs[user_id]:
            _subs[user_id].remove(q)


def publish(user_id: int, event_type: str, payload: dict[str, Any] | None = None) -> None:
    msg = f"data: {json.dumps({'type': event_type, 'data': payload or {}})}\n\n"
    with _lock:
        subs = list(_subs.get(user_id, []))
    for q in subs:
        try:
            q.put_nowait(msg)
        except queue.Full:
            pass

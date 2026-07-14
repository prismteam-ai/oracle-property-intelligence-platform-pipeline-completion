"""Shared pipeline run state, read by the UI while loaders run."""
import json
import threading
import time

from .config import STATE_FILE

_lock = threading.Lock()


def _read():
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except json.JSONDecodeError:
            pass
    return {"running": False, "sources": {}, "started_at": None, "finished_at": None}


def get_state():
    with _lock:
        return _read()


def reset(source_names):
    with _lock:
        state = {
            "running": True,
            "started_at": time.time(),
            "finished_at": None,
            "sources": {
                name: {"status": "pending", "records": 0, "message": "", "url": "", "cid": None}
                for name in source_names
            },
        }
        STATE_FILE.write_text(json.dumps(state))


def update(source, **kwargs):
    with _lock:
        state = _read()
        src = state["sources"].setdefault(
            source, {"status": "pending", "records": 0, "message": "", "url": "", "cid": None}
        )
        src.update(kwargs)
        STATE_FILE.write_text(json.dumps(state))


def finish():
    with _lock:
        state = _read()
        state["running"] = False
        state["finished_at"] = time.time()
        STATE_FILE.write_text(json.dumps(state))

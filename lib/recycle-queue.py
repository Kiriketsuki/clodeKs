"""Read pending queue metadata from the verified Codex app-server process."""

import json
import os
from pathlib import Path
import sqlite3
import stat
import sys


QUEUE_COLUMNS = [
    ("id", "TEXT"),
    ("thread_id", "TEXT"),
    ("payload_json", "TEXT"),
    ("queue_order", "INTEGER"),
    ("created_at_ms", "INTEGER"),
    ("updated_at_ms", "INTEGER"),
]


def queue_path(pid: int) -> Path:
    databases = set()
    for fd in Path(f"/proc/{pid}/fd").iterdir():
        try:
            path = Path(os.readlink(fd))
            if path.name != "queue_1.sqlite" or not path.is_absolute():
                continue
            opened = fd.stat()
            current = path.lstat()
        except FileNotFoundError:
            continue
        if not stat.S_ISREG(current.st_mode) or current.st_uid != os.getuid():
            raise ValueError("queue database is not a regular file owned by this user")
        if (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino):
            raise ValueError("queue database identity changed")
        databases.add(path)
    if len(databases) != 1:
        raise ValueError("cannot identify the app-server queue database")
    return databases.pop()


def pending_queue(path: Path, limit: int) -> dict:
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=0.3) as db:
        db.execute("PRAGMA query_only = ON")
        db.execute("BEGIN")
        columns = [(row[1], row[2]) for row in db.execute("PRAGMA table_info(queued_items)")]
        if columns != QUEUE_COLUMNS:
            raise ValueError("unknown pending queue schema")
        count = db.execute("SELECT COUNT(*) FROM queued_items").fetchone()[0]
        rows = db.execute(
            "SELECT id, thread_id, created_at_ms FROM queued_items ORDER BY created_at_ms, id LIMIT ?",
            (limit,),
        )
        return {
            "pending_count": count,
            "entries": [
                {"submission_id": item_id, "thread_id": thread_id, "created_at_ms": created}
                for item_id, thread_id, created in rows
            ],
        }


if __name__ == "__main__":
    try:
        print(json.dumps(pending_queue(queue_path(int(sys.argv[1])), int(sys.argv[2]))))
    except (OSError, ValueError, sqlite3.Error):
        print("null")

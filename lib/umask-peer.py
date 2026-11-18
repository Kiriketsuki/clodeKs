"""Read the Linux Unix-socket owner mask without a protocol request."""

import json
import os
import re
import socket
import struct
import sys
from pathlib import Path


def process_start(folder: Path) -> str:
    # The command name can contain spaces and parentheses. Fields follow its last ')'.
    return (folder / "stat").read_text().rsplit(")", 1)[1].split()[19]


def measure_peer(peer: socket.socket) -> dict | None:
    credentials = peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    pid, uid, _ = struct.unpack("3i", credentials)
    if pid <= 0 or uid != os.getuid():
        return None
    folder = Path("/proc") / str(pid)
    before = process_start(folder)
    status = (folder / "status").read_text()
    mask = re.search(r"^Umask:[ \t]*(0[0-7]{3})[ \t]*$", status, re.MULTILINE)
    if not mask or process_start(folder) != before:
        return None
    return {"mask": mask[1], "pid": pid, "stable": True, "start": before}


def measure(path: str) -> dict | None:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
        peer.settimeout(0.5)
        peer.connect(path)
        result = measure_peer(peer)
        if result is None:
            return None
        # Reconnect to reject a replaced listener while the process status was read.
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as check:
            check.settimeout(0.5)
            check.connect(path)
            if measure_peer(check) != result:
                return None
        return result


if __name__ == "__main__":
    try:
        print(json.dumps(measure(sys.argv[1])))
    except (OSError, ValueError, IndexError, AttributeError):
        print("null")

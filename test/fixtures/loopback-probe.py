import json
import os
import socket
from urllib.parse import urlparse


def connect(host: str, port: int) -> dict[str, bool | int | None]:
    try:
        with socket.create_connection((host, port), timeout=1):
            return {"connected": True}
    except OSError as error:
        return {"connected": False, "errno": error.errno}


if os.environ.get("CLODEKS_PROBE_SCOPE_ONLY"):
    try:
        with open(os.environ["CLODEKS_PROBE_WRITE_PATH"], "x") as output:
            output.write("scope probe")
        writable = True
    except OSError:
        writable = False
    print(json.dumps({"writable": writable}))
    raise SystemExit(0)


result = {
    "public_tcp": connect("1.1.1.1", 443),
    "host_loopback": connect("127.0.0.1", int(os.environ["CLODEKS_PROBE_HOST_PORT"])),
}
try:
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(1)
        client.connect(os.environ["CLODEKS_PROBE_HOST_SOCKET"])
        result["host_unix_connected"] = True
except OSError:
    result["host_unix_connected"] = False

result["binds"] = {}
for family, host in [(socket.AF_INET, "127.0.0.1"), (socket.AF_INET, "0.0.0.0"),
                     (socket.AF_INET, "127.0.0.2"), (socket.AF_INET6, "::1")]:
    try:
        with socket.socket(family) as listener:
            listener.bind((host, 0))
            listener.listen(1)
            result["binds"][host] = True
    except OSError:
        result["binds"][host] = False

try:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        with socket.create_connection(listener.getsockname(), timeout=1) as client:
            with listener.accept()[0] as accepted:
                client.sendall(b"isolated")
                result["local_exchange"] = accepted.recv(8).decode()
except OSError:
    result["local_exchange"] = None

proxy = urlparse(os.environ.get("HTTP_PROXY", ""))
if proxy.hostname and proxy.port and not os.environ.get("CLODEKS_PROBE_SKIP_PROXY"):
    for name, target in [("public_proxy", "1.1.1.1:443"),
                         ("host_proxy", f"127.0.0.1:{os.environ['CLODEKS_PROBE_HOST_PORT']}")]:
        try:
            with socket.create_connection((proxy.hostname, proxy.port), timeout=2) as client:
                client.sendall(f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n".encode())
                result[name] = client.recv(256).split(b"\r\n")[0].decode()
        except OSError:
            result[name] = None

if os.environ.get("CLODEKS_PROBE_WRITE_DIRS"):
    result["writes"] = {}
    for directory in json.loads(os.environ["CLODEKS_PROBE_WRITE_DIRS"]):
        try:
            with open(os.path.join(directory, "resume-denied.txt"), "x") as output:
                output.write("resume scope probe")
            result["writes"][directory] = True
        except OSError:
            result["writes"][directory] = False

print(json.dumps(result))

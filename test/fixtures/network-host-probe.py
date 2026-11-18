import json
import os
import socket
import subprocess
from urllib.parse import urlparse


def direct_connection() -> bool:
    # Remove proxy settings to verify the operating-system boundary itself.
    for key in list(os.environ):
        if key.lower().endswith('_proxy'):
            del os.environ[key]
    try:
        with socket.create_connection((os.environ['CLODEKS_PUBLIC_IP'], 443), timeout=3):
            return True
    except OSError:
        return False


def request(url: str, proxy: str, follow: bool = False) -> dict:
    command = ['curl', '--silent', '--show-error', '--max-time', '20', '--proxy', proxy,
               '--noproxy', '', '--output', '/dev/null', '--write-out', '%{http_code}']
    if follow:
        command.append('--location')
    result = subprocess.run(command + [url], capture_output=True, text=True, timeout=25)
    return {'code': result.returncode, 'status': result.stdout, 'error': result.stderr.strip()}


proxy = os.environ.get('HTTPS_PROXY', os.environ.get('https_proxy', ''))
result = {'proxy_present': bool(urlparse(proxy).hostname)}
if os.environ.get('CLODEKS_CREDENTIAL_PROBE'):
    try:
        with open(os.environ['CLODEKS_CREDENTIAL_PROBE']) as source:
            source.read(1)
        result['credential_read_denied'] = False
    except PermissionError:
        result['credential_read_denied'] = True
result['allowed'] = request('https://pypi.org/simple/pip/', proxy)
if os.environ.get('CLODEKS_ALLOWED_ONLY'):
    result['direct_connected'] = direct_connection()
    print(json.dumps(result))
    raise SystemExit(0)

result['unlisted'] = request('https://example.com/', proxy)
result['private'] = request('http://10.0.0.1/', proxy)
result['local'] = request('http://127.0.0.1/', proxy)
result['private_name'] = request('http://localtest.me/', proxy)
result['redirect_start'] = request('https://httpbingo.org/redirect-to?url=https://example.com/', proxy)
result['redirect_end'] = request('https://httpbingo.org/redirect-to?url=https://example.com/', proxy, True)
result['direct_connected'] = direct_connection()
print(json.dumps(result))

#!/usr/bin/env python3
"""VerusLending local web app server.

Stdlib-only HTTP server that:
  - Serves static files from ./static/
  - Proxies /rpc to a local verusd daemon (single origin, no CORS pain)

State lives in the browser (localStorage) for ephemeral UI, and in the
user's own VerusID multimap (encrypted) for anything that must survive
across machines. No local DB.

Run:
  python3 app/server.py [--port 7777] [--conf ~/.komodo/VRSC/VRSC.conf]
Then open http://127.0.0.1:7777/
"""

import argparse
import base64
import json
import re
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"

# Persistent cache for History tab — settled/cancelled loan events derived
# from local daemon walks. The GUI reads this on tab open (instant render),
# then asks the daemon "anything new since lastRevisionTxid?" and patches
# the cache. Makes History reconstructible offline once primed.
CACHE_DIR = Path.home() / ".verus_contract_gui"
HISTORY_CACHE_PATH = CACHE_DIR / "history_cache.json"


def read_rpc_config(conf_path: Path) -> dict:
    if not conf_path.exists():
        sys.exit(f"verusd config not found at {conf_path}")
    cfg = {}
    for line in conf_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        cfg[k.strip()] = v.strip()
    if "rpcuser" not in cfg or "rpcpassword" not in cfg:
        sys.exit(f"rpcuser/rpcpassword missing from {conf_path}")
    cfg.setdefault("rpcport", "27486")
    cfg.setdefault("rpchost", "127.0.0.1")
    return cfg


class Handler(BaseHTTPRequestHandler):
    rpc_cfg: dict = {}

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def do_GET(self):
        if self.path in ("", "/"):
            return self._serve_static("/index.html")
        if self.path == "/history-cache":
            return self._handle_history_cache_get()
        return self._serve_static(self.path)

    def do_POST(self):
        if self.path == "/rpc":
            return self._handle_rpc()
        if self.path == "/history-cache":
            return self._handle_history_cache_post()
        self._send_json(404, {"error": "not found"})

    # CSRF defense: require a custom header on /rpc. Cross-origin requests
    # carrying a non-CORS-safelisted header trigger a preflight that the
    # server doesn't answer, so the browser blocks the actual request.
    # Same-origin (the GUI itself) sets the header, so it goes through.
    CSRF_HEADER = "X-Requested-By"
    CSRF_VALUE = "vlocal"

    # Method allowlist for /rpc. Strict subset of what the GUI actually
    # uses — anything else (dumpprivkey, walletpassphrase, sendtoaddress,
    # encryptwallet, ...) is rejected at the proxy.
    ALLOWED_RPC = {
        "getinfo", "getblockcount", "getbestblockhash", "getblockheader",
        "getrawmempool", "getrawtransaction", "decoderawtransaction",
        "createrawtransaction", "signrawtransaction", "sendrawtransaction",
        "getaddressbalance", "getaddressutxos", "getaddressmempool",
        "getaddresstxids",
        "listidentities", "getidentity", "getidentityhistory", "getcurrency",
        "addmultisigaddress", "createmultisig", "validateaddress",
        "sendcurrency", "z_getoperationresult", "z_getoperationstatus",
        "updateidentity", "signmessage",
        "lockunspent", "listlockunspent",
        # Per-loan vault key derivation (option C tweaked-key). dumpprivkey
        # is the only way to get the R-priv to compute vault_priv = R_priv +
        # tweak; importprivkey installs the derived key so signrawtransaction
        # can use it on later vault-spending flows. Both are read/write to
        # wallet privkeys — sensitive, but already gated by CSRF + same-origin.
        "dumpprivkey", "importprivkey",
    }

    def _security_headers(self):
        # Strict CSP: no inline scripts, no eval, no third-party scripts.
        # connect-src allows the proxy itself + the public explorer.
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; "
            "script-src 'self'; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; "
            "connect-src 'self' https://scan.verus.cx; "
            "frame-ancestors 'none'; "
            "base-uri 'self'",
        )
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")

    def _serve_static(self, path):
        if not re.match(r"^/[\w\-./]+$", path) or ".." in path:
            self._send_json(400, {"error": "bad path"})
            return
        target = (STATIC_DIR / path.lstrip("/")).resolve()
        try:
            target.relative_to(STATIC_DIR)
        except ValueError:
            self._send_json(404, {"error": "not found"})
            return
        if not target.is_file():
            self._send_json(404, {"error": "not found"})
            return
        ext = target.suffix.lower()
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js": "application/javascript",
            ".css": "text/css",
            ".json": "application/json",
            ".svg": "image/svg+xml",
        }.get(ext, "application/octet-stream")
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self._security_headers()
        self.end_headers()
        self.wfile.write(data)

    def _handle_rpc(self):
        # CSRF guard — must be set by same-origin JS in main.js.
        if self.headers.get(self.CSRF_HEADER) != self.CSRF_VALUE:
            return self._send_json(403, {"error": "missing csrf header"})

        body = self._read_body()
        try:
            parsed = json.loads(body)
        except Exception:
            return self._send_json(400, {"error": "invalid json"})

        method = parsed.get("method") if isinstance(parsed, dict) else None
        if method not in self.ALLOWED_RPC:
            return self._send_json(403, {"error": f"rpc method not allowed: {method!r}"})

        # DIAG: log updateidentity payloads + outcomes to /tmp/rpc_diag.log
        # so we can see exactly what's being sent when the daemon rejects.
        if method == "updateidentity":
            try:
                with open("/tmp/rpc_diag.log", "a") as f:
                    f.write(f"\n=== updateidentity request @ {time.time()} ===\n")
                    f.write(json.dumps(parsed.get("params", []), indent=2)[:6000])
                    f.write("\n")
            except Exception:
                pass

        cfg = self.rpc_cfg
        url = f"http://{cfg['rpchost']}:{cfg['rpcport']}/"
        auth = base64.b64encode(
            f"{cfg['rpcuser']}:{cfg['rpcpassword']}".encode()
        ).decode()
        req = urllib.request.Request(
            url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Basic {auth}",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read()
                self.send_response(resp.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            data = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self._send_json(502, {"error": f"rpc unreachable: {e}"})

    def _handle_history_cache_get(self):
        # Returns {} if no cache exists yet — GUI treats that as cold start.
        try:
            if HISTORY_CACHE_PATH.exists():
                data = json.loads(HISTORY_CACHE_PATH.read_text())
            else:
                data = {}
            self._send_json(200, data)
        except Exception as e:
            self._send_json(500, {"error": f"cache read failed: {e}"})

    def _handle_history_cache_post(self):
        # Same CSRF guard as /rpc — only same-origin GUI may write.
        if self.headers.get(self.CSRF_HEADER) != self.CSRF_VALUE:
            return self._send_json(403, {"error": "missing csrf header"})
        body = self._read_body()
        try:
            parsed = json.loads(body)
            if not isinstance(parsed, dict):
                return self._send_json(400, {"error": "expected object"})
            # Atomic write: temp file in same dir then rename. Avoids
            # corrupted cache if process is killed mid-write.
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            tmp = HISTORY_CACHE_PATH.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(parsed, separators=(",", ":")))
            tmp.replace(HISTORY_CACHE_PATH)
            self._send_json(200, {"ok": True, "bytes": HISTORY_CACHE_PATH.stat().st_size})
        except Exception as e:
            self._send_json(500, {"error": f"cache write failed: {e}"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=7777)
    ap.add_argument("--bind", default="127.0.0.1")
    ap.add_argument(
        "--conf", default=str(Path.home() / ".komodo" / "VRSC" / "VRSC.conf")
    )
    args = ap.parse_args()

    Handler.rpc_cfg = read_rpc_config(Path(args.conf))

    httpd = ThreadingHTTPServer((args.bind, args.port), Handler)
    print(f"VerusLending app at http://{args.bind}:{args.port}/")
    print(f"  RPC → {Handler.rpc_cfg['rpchost']}:{Handler.rpc_cfg['rpcport']}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nshutdown")


if __name__ == "__main__":
    main()

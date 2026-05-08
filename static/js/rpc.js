// Thin RPC client. Talks to /rpc on the local server which forwards to verusd.

let nextId = 1;

export async function rpc(method, params = []) {
  const body = {
    jsonrpc: "1.0",
    id: nextId++,
    method,
    params,
  };
  const res = await fetch("/rpc", {
    method: "POST",
    // X-Requested-By is the CSRF guard — the server rejects /rpc without it.
    // Browsers preflight requests with non-safelisted headers, blocking
    // cross-origin POST attempts from a hostile page.
    headers: { "Content-Type": "application/json", "X-Requested-By": "vlocal" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON response (often the daemon dying or HTTP-level error). Surface
    // the method + status so the call site / browser console pinpoints the
    // failing call instead of just "500 Internal Server Error".
    console.error(`[rpc] ${method} → ${res.status} ${res.statusText}: non-JSON response: ${text.slice(0, 300)}`);
    throw new Error(`${method} (${res.status}): non-JSON response: ${text.slice(0, 200)}`);
  }
  if (json.error) {
    console.error(`[rpc] ${method} → error:`, json.error);
    throw new Error(`${method}: ${json.error.message || JSON.stringify(json.error)}`);
  }
  return json.result;
}

export async function ping() {
  try {
    const info = await rpc("getinfo");
    return { ok: true, blocks: info.blocks, version: info.version };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Decode a raw tx hex to its inputs/outputs (calls verusd).
export async function decodeRawTx(hex) {
  return rpc("decoderawtransaction", [hex]);
}

// Resolve an i-address to a VerusID friendly name (or return the i-address if not found).
const idCache = new Map();
export async function resolveId(addrOrId) {
  if (!addrOrId) return addrOrId;
  if (idCache.has(addrOrId)) return idCache.get(addrOrId);
  if (!addrOrId.startsWith("i")) {
    idCache.set(addrOrId, addrOrId);
    return addrOrId;
  }
  try {
    const r = await rpc("getidentity", [addrOrId]);
    const name = r?.identity?.name ? `${r.identity.name}@` : addrOrId;
    idCache.set(addrOrId, name);
    return name;
  } catch {
    idCache.set(addrOrId, addrOrId);
    return addrOrId;
  }
}

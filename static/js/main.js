// VerusLending GUI — minimal Phase A.
//
// What this does:
//   1. Pings local verusd, shows status in header.
//   2. Lists wallet identities (My identities tab) with per-ID contract badges.
//   3. Browses open requests/offers/matches from the explorer API (Marketplace tab).
//   4. Lists active loans where any local ID is a party (Active loans tab).
//
// What clicking does (right now):
//   - "Refresh" buttons re-fetch the data on each tab.
//   - Identity rows expand to show decoded contentmultimap entries.
//   - Marketplace rows show full payload + a disabled "Match" / "Accept" button
//     (Phase C will wire those up).

import { rpc, ping } from "./rpc.js";

const EXPLORER_API = "https://scan.verus.cx/api";

// Common Verus currencies (full canonical names). Used for dropdowns + toggles.
const CURRENCIES = [
  "VRSC",
  "DAI.vETH",
  "vETH",
  "MKR.vETH",
  "vUSDC.vETH",
  "vUSDT.vETH",
  "LINK.vETH",
  "tBTC.vETH",
  "EURC.vETH",
  "vARRR",
  "vDEX",
  "CHIPS",
];

function currencyOptions(selected = "VRSC") {
  return CURRENCIES.map((c) => `<option value="${c}"${c === selected ? " selected" : ""}>${c}</option>`).join("");
}

// VDXF key transition: vrsc::contract.* → vcs::contract.*
//
// New (active write) keys — what new entries get posted under from now on.
// Legacy keys — what entries were posted under before the rename. Reads on
// the History tab consult BOTH so past loans keep surfacing; reads on
// Marketplace / Active Loans look only at the new keys (nothing live
// remains under the legacy keys).
const VDXF_LOAN_REQUEST  = "iFg76F9M8CV5xEg3L2NvCDBXufaxjUWhaW"; // vcs::contract.loan.request
const VDXF_LOAN_MATCH    = "i4G69W7e3UJRCinuP7TFBRnm3ZUiXzPkFt"; // vcs::contract.loan.match
const VDXF_LOAN_STATUS   = "iPnrakyY951QEy6xUYBuJoobHA9JKY6G8j"; // vcs::contract.loan.status
const VDXF_LOAN_HISTORY  = "iBGuPDeeHHYpvKdM7VG2d7LR1Lct9itcpT"; // vcs::contract.loan.history

const VDXF_LOAN_REQUEST_LEGACY = "iPmnErqWbf5NhhWZEoccuX8yU8CgFt2d28";
const VDXF_LOAN_MATCH_LEGACY   = "iBvgGuNNVxEQYCeDD4uPykgrGbWnyTQhGT";
const VDXF_LOAN_STATUS_LEGACY  = "iP5b6uX8SM7ZSiiMbVWwGj9wG76KuJWZys";
const VDXF_LOAN_HISTORY_LEGACY = "i92jad9CSjBNPCHgnHqQP4hK1facXBFDWb";

// Read-set: new + legacy. Iterate to surface entries posted under either.
const VDXF_LOAN_REQUEST_KEYS = [VDXF_LOAN_REQUEST, VDXF_LOAN_REQUEST_LEGACY];
const VDXF_LOAN_MATCH_KEYS   = [VDXF_LOAN_MATCH,   VDXF_LOAN_MATCH_LEGACY];
const VDXF_LOAN_STATUS_KEYS  = [VDXF_LOAN_STATUS,  VDXF_LOAN_STATUS_LEGACY];
const VDXF_LOAN_HISTORY_KEYS = [VDXF_LOAN_HISTORY, VDXF_LOAN_HISTORY_LEGACY];

const VDXF = {
  "iA1vgVBV5B29h5pxQ67gxqCoEaLDZ8WbmY": { slug: "loan.offer",    label: "Loan offer" },
  // Active (vcs::contract.*) — written by current code.
  [VDXF_LOAN_REQUEST]:                   { slug: "loan.request",  label: "Loan request" },
  [VDXF_LOAN_MATCH]:                     { slug: "loan.match",    label: "Loan match" },
  [VDXF_LOAN_STATUS]:                    { slug: "loan.status",   label: "Loan active" },
  [VDXF_LOAN_HISTORY]:                   { slug: "loan.history",  label: "Loan settled" },
  // Legacy (vrsc::contract.*) — read-only, kept so historical entries label
  // correctly in the UI.
  [VDXF_LOAN_REQUEST_LEGACY]:            { slug: "loan.request",  label: "Loan request (legacy)" },
  [VDXF_LOAN_MATCH_LEGACY]:              { slug: "loan.match",    label: "Loan match (legacy)" },
  [VDXF_LOAN_STATUS_LEGACY]:             { slug: "loan.status",   label: "Loan active (legacy)" },
  [VDXF_LOAN_HISTORY_LEGACY]:            { slug: "loan.history",  label: "Loan settled (legacy)" },
  "i4a42EUWLvJTHYGW7F8RifY1Rvs5AQGioY":  { slug: "option.offer",  label: "Option offer" },
  "iDE4csgPBx9Rn7H4zkn4VhSShcxcwmknQo":  { slug: "option.request",label: "Option request" },
};

// ---------- helpers ----------

function decodeMultimapEntry(entry) {
  let hex;
  if (typeof entry === "string") hex = entry;
  else if (entry?.serializedhex) hex = entry.serializedhex;
  else if (entry?.message) hex = entry.message;
  if (!hex || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  try {
    const bytes = new Uint8Array(hex.match(/.{2}/g).map((b) => parseInt(b, 16)));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

// ---------- Sapling tx parser/serializer for extending pre-signed partials ----------
// Borrower-side: take the lender's SIGHASH_SINGLE|ANYONECANPAY-signed Tx-A,
// add the borrower's collateral input + vault P2SH output + change output,
// without touching the lender's input 0 or output 0. Direct port of
// helpers/extend_tx.py — see TESTING.md §25 for the validated pattern.

function _hexToBytes(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < h.length; i += 2) out[i / 2] = parseInt(h.slice(i, i + 2), 16);
  return out;
}
function _bytesToHex(b) {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
function _readVarint(b, off) {
  const v = b[off];
  if (v < 0xfd) return [v, off + 1];
  if (v === 0xfd) return [b[off + 1] | (b[off + 2] << 8), off + 3];
  if (v === 0xfe) return [(b[off + 1] | (b[off + 2] << 8) | (b[off + 3] << 16) | (b[off + 4] << 24)) >>> 0, off + 5];
  // 64-bit varint — JS bitwise can't handle. Use BigInt.
  let n = 0n;
  for (let i = 0; i < 8; i++) n |= BigInt(b[off + 1 + i]) << BigInt(8 * i);
  return [Number(n), off + 9];
}
function _writeVarint(n) {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) return new Uint8Array([0xfd, n & 0xff, (n >> 8) & 0xff]);
  if (n <= 0xffffffff) {
    return new Uint8Array([0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
  }
  const out = new Uint8Array(9); out[0] = 0xff;
  let big = BigInt(n);
  for (let i = 0; i < 8; i++) { out[1 + i] = Number(big & 0xffn); big >>= 8n; }
  return out;
}
function _readU32(b, off) {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}
function _writeU32(n) {
  return new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
}
function _readI64LE(b, off) {
  let n = 0n;
  for (let i = 0; i < 8; i++) n |= BigInt(b[off + i]) << BigInt(8 * i);
  return n;
}
function _writeI64LE(n) {
  const out = new Uint8Array(8);
  let big = BigInt(n);
  for (let i = 0; i < 8; i++) { out[i] = Number(big & 0xffn); big >>= 8n; }
  return out;
}
function _parseTx(hex) {
  const b = _hexToBytes(hex);
  let off = 0;
  const versionRaw = _readU32(b, off); off += 4;
  const fOverwintered = (versionRaw >>> 31) & 1;
  const nVersion = versionRaw & 0x7fffffff;
  let nVersionGroupId = 0;
  if (fOverwintered) { nVersionGroupId = _readU32(b, off); off += 4; }
  let vinCount; [vinCount, off] = _readVarint(b, off);
  const vins = [];
  for (let i = 0; i < vinCount; i++) {
    const prevTxid = b.slice(off, off + 32); off += 32;
    const prevVout = _readU32(b, off); off += 4;
    let ssLen; [ssLen, off] = _readVarint(b, off);
    const scriptSig = b.slice(off, off + ssLen); off += ssLen;
    const sequence = _readU32(b, off); off += 4;
    vins.push({ prevTxid, prevVout, scriptSig, sequence });
  }
  let voutCount; [voutCount, off] = _readVarint(b, off);
  const vouts = [];
  for (let i = 0; i < voutCount; i++) {
    const value = _readI64LE(b, off); off += 8;
    let spkLen; [spkLen, off] = _readVarint(b, off);
    const scriptPubKey = b.slice(off, off + spkLen); off += spkLen;
    vouts.push({ value, scriptPubKey });
  }
  const nLockTime = _readU32(b, off); off += 4;
  let nExpiryHeight = 0;
  if (fOverwintered) { nExpiryHeight = _readU32(b, off); off += 4; }
  const remainder = b.slice(off);
  return { fOverwintered, nVersion, nVersionGroupId, vins, vouts, nLockTime, nExpiryHeight, remainder };
}
function _serializeTx(tx) {
  const parts = [];
  const versionRaw = ((tx.nVersion & 0x7fffffff) | ((tx.fOverwintered & 1) << 31)) >>> 0;
  parts.push(_writeU32(versionRaw));
  if (tx.fOverwintered) parts.push(_writeU32(tx.nVersionGroupId));
  parts.push(_writeVarint(tx.vins.length));
  for (const v of tx.vins) {
    parts.push(v.prevTxid);
    parts.push(_writeU32(v.prevVout));
    parts.push(_writeVarint(v.scriptSig.length));
    parts.push(v.scriptSig);
    parts.push(_writeU32(v.sequence));
  }
  parts.push(_writeVarint(tx.vouts.length));
  for (const o of tx.vouts) {
    parts.push(_writeI64LE(o.value));
    parts.push(_writeVarint(o.scriptPubKey.length));
    parts.push(o.scriptPubKey);
  }
  parts.push(_writeU32(tx.nLockTime));
  if (tx.fOverwintered) parts.push(_writeU32(tx.nExpiryHeight));
  parts.push(tx.remainder);
  let total = 0; for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return _bytesToHex(out);
}
const _B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function _b58dec(s) {
  let n = 0n;
  for (const c of s) { const idx = _B58.indexOf(c); if (idx < 0) throw new Error("bad base58"); n = n * 58n + BigInt(idx); }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  let pad = 0;
  for (const c of s) { if (c === "1") pad++; else break; }
  return new Uint8Array([...new Array(pad).fill(0), ...bytes]);
}
function _addrToHash160(addr) {
  const raw = _b58dec(addr);
  if (raw.length !== 25) throw new Error(`expected 25 bytes for ${addr}, got ${raw.length}`);
  return raw.slice(1, 21);
}
function _addrToP2pkhSpk(addr) {
  const h = _addrToHash160(addr);
  // OP_DUP OP_HASH160 push20 hash160 OP_EQUALVERIFY OP_CHECKSIG
  return new Uint8Array([0x76, 0xa9, 0x14, ...h, 0x88, 0xac]);
}
function _addrToP2shSpk(addr) {
  const h = _addrToHash160(addr);
  // OP_HASH160 push20 hash160 OP_EQUAL
  return new Uint8Array([0xa9, 0x14, ...h, 0x87]);
}
// Look up the compressed pubkey for an R-address by finding any prior tx
// where it spent. For P2PKH inputs the scriptSig is `<sig> <pubkey>` —
// the pubkey is the second push and is exactly 33 bytes (compressed).
async function getPubkeyForRAddress(rAddr) {
  // validateaddress is fast if the address is in the local wallet.
  try {
    const v = await rpc("validateaddress", [rAddr]);
    if (v?.pubkey) return v.pubkey;
  } catch {}
  // Otherwise scan the address's tx history for a spending input.
  let txids = [];
  try {
    txids = await rpc("getaddresstxids", [{ addresses: [rAddr] }]);
  } catch { return null; }
  for (let i = txids.length - 1; i >= 0; i--) {
    try {
      const tx = await rpc("getrawtransaction", [txids[i], 1]);
      for (const vin of tx?.vin || []) {
        const ssHex = vin?.scriptSig?.hex;
        if (!ssHex) continue;
        const inAddrs = vin?.addresses || [];
        if (!inAddrs.includes(rAddr)) continue;
        const bytes = _hexToBytes(ssHex);
        let off = 0;
        const sigLen = bytes[off]; off += 1 + sigLen;
        if (off >= bytes.length) continue;
        const pkLen = bytes[off]; off += 1;
        if ((pkLen !== 33 && pkLen !== 65) || off + pkLen > bytes.length) continue;
        return _bytesToHex(bytes.slice(off, off + pkLen));
      }
    } catch {}
  }
  return null;
}

// Pull a loan.request payload directly from the local daemon by reading the
// originating tx and decoding the contentmultimap update. Used as a fallback
// when scan.verus.cx is rate-limiting the explorer API.
async function fetchRequestFromLocalDaemon(txid) {
  const VDXF_LOAN_REQUEST = "iFg76F9M8CV5xEg3L2NvCDBXufaxjUWhaW";
  const tx = await rpc("getrawtransaction", [txid, 1]);
  // The identity update is in tx.vout — find the one that has an identity
  // primary output and pull the contentmultimap from its scriptPubKey.
  for (const vout of tx?.vout || []) {
    const cm = vout?.scriptPubKey?.identityprimary?.contentmultimap;
    if (cm && cm[VDXF_LOAN_REQUEST]) {
      const entry = cm[VDXF_LOAN_REQUEST][0];
      const hex = typeof entry === "string" ? entry : entry?.serializedhex || entry?.message || "";
      if (!hex) continue;
      try {
        const json = JSON.parse(new TextDecoder().decode(_hexToBytes(hex)));
        return { principal: json.principal, collateral: json.collateral, repay: json.repay, term_days: json.term_days };
      } catch {}
    }
  }
  return null;
}

// Borrower-first Tx-A skeleton builder: constructs Tx-A with borrower's
// collateral input + 3 outputs (principal → borrower, collateral → vault,
// change → borrower) and signs the borrower's input only with
// SIGHASH_ALL|ANYONECANPAY. The lender at match time will add their input
// (input 0) and sign theirs without invalidating the borrower's signature.
async function buildAndSignBorrowerTxA({
  borrowerInputTxid,
  borrowerInputVout,
  borrowerR,
  principalCurrency,
  principalAmount,
  collateralCurrency,
  collateralAmount,
  vaultP2sh,
  utxoAmount,    // optional — when caller already knows the UTXO size (e.g., just split it).
                 //   Skips a getaddressutxos call (which doesn't see mempool).
}) {
  const FEE = 0.0001;
  // Look up the borrower's input UTXO size to compute change — only if not provided.
  if (utxoAmount === undefined) {
    const utxos = await rpc("getaddressutxos", [{ addresses: [borrowerR], currencynames: true }]);
    const u = utxos.find((x) => x.txid === borrowerInputTxid && x.outputIndex === borrowerInputVout);
    if (!u) throw new Error(`UTXO ${borrowerInputTxid.slice(0, 16)}…:${borrowerInputVout} not found at ${borrowerR}`);
    utxoAmount = collateralCurrency === "VRSC"
      ? u.satoshis / 1e8
      : parseFloat(u.currencyvalues?.[collateralCurrency] ?? 0);
  }

  // Resolve currency iaddrs for non-native principal/collateral
  const ccyIaddr = async (name) => {
    if (name === "VRSC") return "i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV";
    return (await rpc("getcurrency", [name]))?.currencyid;
  };
  const principalCcyId  = await ccyIaddr(principalCurrency);
  const collateralCcyId = await ccyIaddr(collateralCurrency);
  if (!principalCcyId || !collateralCcyId) throw new Error("could not resolve currency ids");

  // Borrower's change in the collateral currency (from the same UTXO).
  // Compare in integer satoshis to avoid float-precision bugs
  // (0.5001 - 0.5 - 0.0001 ≈ -1e-17 in JS floats).
  const utxoSats = Math.round(utxoAmount * 1e8);
  const collateralSats = Math.round(collateralAmount * 1e8);
  const feeSats = Math.round(FEE * 1e8);
  const changeSats = utxoSats - collateralSats - feeSats;
  if (changeSats < 0) throw new Error(`UTXO too small: have ${utxoSats} sats ${collateralCurrency}, need ${collateralSats + feeSats}`);
  const change = changeSats / 1e8;

  // Outputs: order matters because lender will SIGHASH_SINGLE|ANYONECANPAY
  // input 0 → output 0 (principal). So output 0 = principal, output 1 = vault,
  // output 2 = borrower's change.
  // (Lender's input 0 is added later — we build with just borrower's input here.)
  const principalOutputKey = borrowerR;
  const principalOutputVal = principalCurrency === "VRSC"
    ? principalAmount
    : { [principalCcyId]: principalAmount };
  const vaultOutputVal = collateralCurrency === "VRSC"
    ? collateralAmount
    : { [collateralCcyId]: collateralAmount };
  const changeOutputVal = collateralCurrency === "VRSC"
    ? change
    : { [collateralCcyId]: change };

  const tip = await rpc("getblockcount");
  const expiryHeight = tip + 720; // ~12h
  // For the placeholder Tx-A skeleton, we include only the borrower's input
  // and the 3 outputs. The lender's input will be appended later.
  const outputs = {};
  outputs[principalOutputKey] = principalOutputVal;
  outputs[vaultP2sh] = vaultOutputVal;
  // Two outputs to borrowerR with different values would clash in the
  // {address: amount} dict. Hack: use the address twice — but createrawtransaction
  // dict can't represent two outputs to the same address. Workaround: route
  // change to a different known borrower address, OR consolidate. For now,
  // require change to go to borrowerR but raise if there's a clash.
  if (principalOutputKey === borrowerR && change > 0) {
    // We can't have two outputs to the same R-address via createrawtransaction's
    // dict-based form. So we use sendmany-style serialization not directly
    // supported. As a workaround, omit the change output and absorb it into
    // a higher output. But that's wrong for amount.
    // Cleanest fix: leave change for the lender to handle by overpaying fee,
    // but that changes the contract. For now we hand-build the tx with the
    // raw createrawtransaction "address" key supporting only one entry per
    // address, so we accept that the borrower's change in collateral currency
    // won't be sent to borrowerR if the principal also goes there.
    // BUT — principal goes to borrower in PRINCIPAL currency, change goes
    // back in COLLATERAL currency. They're DIFFERENT currencies, so the
    // dict's {borrowerR: principalVal} doesn't conflict with {borrowerR: changeVal}
    // unless principal and collateral are the same currency.
    if (principalCurrency === collateralCurrency) {
      throw new Error("principal and collateral cannot be the same currency in this builder yet");
    }
    // Different currencies: merge into one entry as a multi-currency map
    outputs[borrowerR] = (typeof outputs[borrowerR] === "number")
      ? { [principalCcyId]: outputs[borrowerR], [collateralCcyId]: change }
      : { ...outputs[borrowerR], [collateralCcyId]: change };
  } else if (change > 0) {
    outputs[borrowerR] = changeOutputVal;
  }

  const unsignedHex = await rpc("createrawtransaction", [
    [{ txid: borrowerInputTxid, vout: borrowerInputVout }],
    outputs,
    0,
    expiryHeight,
  ]);

  // Sign the (only) input with SIGHASH_ALL|ANYONECANPAY
  const signed = await rpc("signrawtransaction", [unsignedHex, null, null, "ALL|ANYONECANPAY"]);
  if (!signed.complete) throw new Error("borrower signrawtransaction did not complete: " + JSON.stringify(signed.errors || {}));
  return signed.hex;
}

// Lender-side: take the borrower's signed Tx-A skeleton (1 input, 3 outputs)
// and prepend the lender's principal input as input 0 (with empty scriptSig
// to be filled by signrawtransaction). Outputs are NOT touched — the
// borrower locked them with SIGHASH_ALL|ANYONECANPAY. Borrower's signature
// stays valid after their input shifts from index 0 to index 1 because the
// SIGHASH hash doesn't include the input index.
function prependLenderInput(borrowerSkeletonHex, lenderInputTxid, lenderInputVout) {
  const tx = _parseTx(borrowerSkeletonHex);
  if (tx.vins.length !== 1) throw new Error(`expected 1 input in borrower skeleton, got ${tx.vins.length}`);
  if (tx.vouts.length < 2 || tx.vouts.length > 3) throw new Error(`expected 2 or 3 outputs in borrower skeleton, got ${tx.vouts.length}`);
  const txidBytes = _hexToBytes(lenderInputTxid).reverse();
  // Prepend (unshift) the lender's input as index 0
  tx.vins.unshift({ prevTxid: txidBytes, prevVout: lenderInputVout, scriptSig: new Uint8Array(0), sequence: 0xffffffff });
  return _serializeTx(tx);
}

function extendPresignedLoanTxA({ presignedHex, borrowerInputTxid, borrowerInputVout, vaultP2sh, collateralSats, borrowerChangeAddr, borrowerChangeSats }) {
  const tx = _parseTx(presignedHex);
  if (tx.vins.length !== 1 || tx.vouts.length !== 1) {
    throw new Error(`expected pre-signed Tx-A with 1 input + 1 output, got ${tx.vins.length}/${tx.vouts.length}`);
  }
  // Append borrower input (empty scriptSig — to be signed by daemon)
  const txidBytes = _hexToBytes(borrowerInputTxid).reverse(); // LE
  tx.vins.push({ prevTxid: txidBytes, prevVout: borrowerInputVout, scriptSig: new Uint8Array(0), sequence: 0xffffffff });
  // Append vault collateral output (P2SH)
  tx.vouts.push({ value: BigInt(collateralSats), scriptPubKey: _addrToP2shSpk(vaultP2sh) });
  // Append borrower change output (P2PKH)
  tx.vouts.push({ value: BigInt(borrowerChangeSats), scriptPubKey: _addrToP2pkhSpk(borrowerChangeAddr) });
  return _serializeTx(tx);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function formatAmount(a) {
  if (!a || typeof a !== "object") return "—";
  // Chain-controlled (anyone with a VerusID can post arbitrary multimap
  // entries), so always escape before returning — safe to inline into
  // innerHTML at call sites.
  return `${escapeHtml(a.amount ?? "?")} ${escapeHtml(a.currency ?? "")}`;
}

// ---------- header status ----------

async function refreshStatus() {
  const el = document.getElementById("status");
  const r = await ping();
  if (r.ok) {
    el.innerHTML = `<span class="ok">●</span> verusd v${r.version} · block ${r.blocks}`;
  } else {
    el.innerHTML = `<span class="err">●</span> verusd unreachable: ${escapeHtml(r.error)}`;
  }
}

// ---------- tabs ----------

document.querySelectorAll("nav button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll("nav button").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".section").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    document.getElementById(b.dataset.section).classList.add("active");
  };
});

// ---------- My identities ----------

async function loadIdentities() {
  const el = document.getElementById("ids-list");
  if (!el) return; // My identities tab removed
  el.textContent = "Loading…";
  let ids;
  try {
    ids = await rpc("listidentities", []);
  } catch (e) {
    el.innerHTML = `<div class="review bad">listidentities failed: ${escapeHtml(e.message)}</div>`;
    return;
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    el.innerHTML = `<div class="empty">No identities in this wallet.</div>`;
    return;
  }
  // Sort: spendable+sign first, then by name
  ids.sort((a, b) => {
    const ca = (a.canspendfor ? 1 : 0) + (a.cansignfor ? 1 : 0);
    const cb = (b.canspendfor ? 1 : 0) + (b.cansignfor ? 1 : 0);
    if (ca !== cb) return cb - ca;
    return (a.identity?.name || "").localeCompare(b.identity?.name || "");
  });
  el.innerHTML = ids.map((wrap) => renderIdentityCard(wrap)).join("");
  // Wire expand toggles
  el.querySelectorAll(".id-card").forEach((card) => {
    card.querySelector(".id-head").onclick = () => card.classList.toggle("expanded");
  });
}

function renderIdentityCard(wrap) {
  const id = wrap.identity || {};
  const name = id.fullyqualifiedname || `${id.name}@`;
  const iaddr = id.identityaddress;
  const cm = id.contentmultimap || {};
  const counts = countContractEntries(cm);
  const can = wrap.canspendfor && wrap.cansignfor ? "" :
              wrap.canspendfor ? "spend-only" :
              wrap.cansignfor ? "sign-only" : "watch-only";

  const badges = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([slug, n]) => {
      const label = Object.values(VDXF).find((v) => v.slug === slug)?.label || slug;
      return `<span class="badge ${slug.replace('.', '-')}">${label}: ${n}</span>`;
    }).join(" ");
  const noBadges = !badges ? `<span class="muted">no contract entries</span>` : "";

  // Decoded entries (shown when expanded)
  const decoded = [];
  for (const [vdxfId, arr] of Object.entries(cm)) {
    const meta = VDXF[vdxfId];
    if (!meta) continue;
    const items = Array.isArray(arr) ? arr : [arr];
    for (let i = 0; i < items.length; i++) {
      const p = decodeMultimapEntry(items[i]);
      decoded.push(renderEntryDetail({ ...meta, vdxfId }, p, i));
    }
  }

  return `
    <div class="card id-card" data-iaddr="${escapeHtml(iaddr)}" data-name="${escapeHtml(id.name || "")}" data-parent="${escapeHtml(id.parent || "")}">
      <div class="id-head row">
        <strong style="flex:1">${escapeHtml(name)}</strong>
        ${can ? `<span class="badge muted">${can}</span>` : ""}
      </div>
      <div class="kv">
        <div><span class="k">i-address</span><span class="v">${escapeHtml(iaddr)}</span></div>
        <div><span class="k">primary</span><span class="v">${escapeHtml((id.primaryaddresses || [])[0] || "—")}</span></div>
      </div>
      <div style="margin-top:8px">${badges}${noBadges}</div>
      <div class="id-detail" style="margin-top:12px">
        ${decoded.length ? decoded.join("") : `<div class="muted">— no decodable contract entries —</div>`}
      </div>
    </div>
  `;
}

function countContractEntries(cm) {
  const out = {};
  for (const [vdxfId, arr] of Object.entries(cm || {})) {
    const meta = VDXF[vdxfId];
    if (!meta) continue;
    const n = Array.isArray(arr) ? arr.length : 1;
    out[meta.slug] = (out[meta.slug] || 0) + n;
  }
  return out;
}

function renderEntryDetail(meta, payload, idx) {
  if (!payload) {
    return `<div class="entry"><strong>${meta.label} #${idx}</strong> <span class="muted">(undecoded)</span></div>`;
  }
  let summary = "";
  if (meta.slug === "loan.request") {
    summary = `Borrow ${formatAmount(payload.principal)} · ${formatAmount(payload.collateral)} collateral · repay ${formatAmount(payload.repay)} / ${payload.term_days ?? "?"}d`;
  } else if (meta.slug === "loan.offer") {
    summary = `Up to ${formatAmount(payload.max_principal)} · ≥${payload.min_collateral_ratio?.toFixed?.(2) ?? "?"}× collateral · ${payload.rate != null ? (payload.rate * 100).toFixed(1) + "%" : "?"} / ${payload.term_days ?? "?"}d`;
  } else if (meta.slug === "loan.status") {
    summary = `${payload.role} · ${formatAmount(payload.principal)} → repay ${formatAmount(payload.repay)} · maturity block ${payload.maturity_block ?? "?"} · ${payload.settled ? "SETTLED" : "active"}`;
  } else {
    summary = JSON.stringify(payload).slice(0, 120) + (JSON.stringify(payload).length > 120 ? "…" : "");
  }
  return `
    <div class="entry">
      <div class="row">
        <div style="flex:1"><strong>${meta.label} #${idx}</strong>
          <div class="muted" style="font-size:13px">${escapeHtml(summary)}</div>
        </div>
        <button class="ghost remove-btn" data-act="remove-entry" data-vdxf="${meta.vdxfId || ''}" data-slug="${meta.slug}" data-idx="${idx}" style="flex:0 0 auto;font-size:11px;padding:4px 10px">Remove</button>
      </div>
    </div>
  `;
}

document.getElementById("ids-refresh")?.addEventListener("click", loadIdentities);

// ---------- Phase B: post loan.request / loan.offer from a local ID ----------

document.getElementById("ids-list")?.addEventListener("click", async (ev) => {
  // Phase B: open the post form
  const btn = ev.target.closest("[data-act]");
  if (btn) {
    ev.stopPropagation();
    const card = btn.closest(".id-card");
    const act = btn.dataset.act;

    if (act === "post-request") {
      card.querySelector(".post-form").innerHTML = renderRequestForm();
      card.querySelector(".post-form").style.display = "block";
    } else if (act === "post-offer") {
      card.querySelector(".post-form").innerHTML = renderOfferForm();
      card.querySelector(".post-form").style.display = "block";
    } else if (act === "remove-entry") {
      const vdxfId = btn.dataset.vdxf;
      const slug = btn.dataset.slug;
      if (!confirm(`Remove the ${slug} entry from this identity? This posts an updateidentity that drops this VDXF key from the multimap.`)) return;
      btn.disabled = true;
      btn.textContent = "Removing…";
      try {
        const info = await rpc("getidentity", [card.dataset.iaddr, -1]);
        const cm = info?.identity?.contentmultimap || {};
        const newCm = {};
        for (const [k, v] of Object.entries(cm)) {
          if (k === vdxfId) continue; // drop this VDXF key
          newCm[k] = (Array.isArray(v) ? v : [v]).map((entry) => {
            if (typeof entry === "string") return entry;
            return entry?.serializedhex || entry?.message || JSON.stringify(entry);
          });
        }
        const updateArg = {
          name: card.dataset.name,
          parent: card.dataset.parent,
          contentmultimap: newCm,
        };
        const txid = await rpc("updateidentity", [updateArg]);
        btn.textContent = `✓ ${txid.slice(0, 10)}…`;
        setTimeout(() => loadIdentities(), 3000);
      } catch (e) {
        btn.disabled = false;
        btn.textContent = "Remove";
        alert(`Remove failed: ${e.message}`);
      }
    }
    return;
  }
  // Collateral toggle on the offer form
  const tog = ev.target.closest(".ctog");
  if (tog) {
    ev.stopPropagation();
    tog.classList.toggle("selected");
    return;
  }
});

function renderRequestForm() {
  return `
    <div class="post-box">
      <h3>Post a loan request from this identity</h3>
      <div class="row">
        <label style="flex:1">Borrow amount<input type="number" data-f="principal_amount" value="5" step="0.01" /></label>
        <label style="flex:1">Currency<select data-f="principal_currency">${currencyOptions("VRSC")}</select></label>
      </div>
      <div class="row">
        <label style="flex:1">Collateral amount<input type="number" data-f="collateral_amount" value="10" step="0.01" /></label>
        <label style="flex:1">Currency<select data-f="collateral_currency">${currencyOptions("VRSC")}</select></label>
      </div>
      <div class="row">
        <label style="flex:1">Repay amount<input type="number" data-f="repay_amount" value="5.05" step="0.01" /></label>
        <label style="flex:1">Term (days)<input type="number" data-f="term_days" value="30" /></label>
      </div>
      <div class="muted" style="font-size:11px;margin-top:4px">Repay is paid in the same currency as the loan.</div>
      <div class="row" style="margin-top:8px;gap:8px">
        <button class="primary" data-do="preview-request" style="flex:0 0 auto">Preview</button>
        <button class="ghost"   data-do="cancel" style="flex:0 0 auto">Cancel</button>
      </div>
      <div class="preview" style="display:none;margin-top:12px"></div>
    </div>
  `;
}

function renderOfferForm() {
  return `
    <div class="post-box">
      <h3>Post a loan offer from this identity</h3>
      <div class="row">
        <label style="flex:1">Max principal<input type="number" data-f="max_principal_amount" value="100" step="0.01" /></label>
        <label style="flex:1">Currency<select data-f="max_principal_currency">${currencyOptions("VRSC")}</select></label>
      </div>
      <div>
        <label>Accepted collateral (click to toggle)</label>
        <div class="collateral-toggle" data-f="accepted_collateral">
          ${CURRENCIES.map((c) => `
            <button type="button" class="ctog ${c === "VRSC" || c === "DAI.vETH" ? "selected" : ""}" data-cur="${c}">${c}</button>
          `).join("")}
        </div>
      </div>
      <div class="row" style="margin-top:8px">
        <label style="flex:1">Min collateral ratio<input type="number" data-f="min_ratio" value="2" step="0.1" /></label>
        <label style="flex:1">Rate (decimal)<input type="number" data-f="rate" value="0.01" step="0.001" /></label>
      </div>
      <div class="row"><label style="flex:1">Term (days)<input type="number" data-f="term_days" value="30" /></label></div>
      <div class="row" style="margin-top:8px;gap:8px">
        <button class="primary" data-do="preview-offer" style="flex:0 0 auto">Preview</button>
        <button class="ghost"   data-do="cancel" style="flex:0 0 auto">Cancel</button>
      </div>
      <div class="preview" style="display:none;margin-top:12px"></div>
    </div>
  `;
}

// Build payload, preview hex + the literal updateidentity command, allow broadcast
document.getElementById("ids-list")?.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-do]");
  if (!btn) return;
  ev.stopPropagation();
  const card = btn.closest(".id-card");
  const form = card.querySelector(".post-form");
  const previewEl = form.querySelector(".preview");
  const f = (k) => form.querySelector(`[data-f="${k}"]`)?.value;
  const do_ = btn.dataset.do;

  if (do_ === "cancel") { form.style.display = "none"; form.innerHTML = ""; return; }

  let payload, vdxfId, slug;
  if (do_ === "preview-request") {
    slug = "loan.request";
    vdxfId = "iFg76F9M8CV5xEg3L2NvCDBXufaxjUWhaW";
    const principalCurrency = f("principal_currency");
    payload = {
      version: 1,
      principal:  { currency: principalCurrency,        amount: parseFloat(f("principal_amount"))  },
      collateral: { currency: f("collateral_currency"), amount: parseFloat(f("collateral_amount")) },
      repay:      { currency: principalCurrency,        amount: parseFloat(f("repay_amount"))      },
      term_days:  parseInt(f("term_days"), 10),
      active:     true,
    };
  } else if (do_ === "preview-offer") {
    slug = "loan.offer";
    vdxfId = "iA1vgVBV5B29h5pxQ67gxqCoEaLDZ8WbmY";
    const collateralBtns = form.querySelectorAll(".collateral-toggle .ctog.selected");
    const acceptedCollateral = Array.from(collateralBtns).map((b) => b.dataset.cur);
    payload = {
      version: 1,
      max_principal:        { currency: f("max_principal_currency"), amount: parseFloat(f("max_principal_amount")) },
      accepted_collateral:  acceptedCollateral,
      min_collateral_ratio: parseFloat(f("min_ratio")),
      rate:                 parseFloat(f("rate")),
      term_days:            parseInt(f("term_days"), 10),
      active:               true,
    };
  } else if (do_ === "broadcast") {
    return broadcastEntry(card, form);
  } else {
    return;
  }

  // Build the full updateidentity payload, preserving any existing entries on this VDXF id
  const iaddr = card.dataset.iaddr;
  const name  = card.dataset.name;
  const parent = card.dataset.parent;
  let existing = {};
  try {
    const info = await rpc("getidentity", [iaddr, -1]);
    existing = info?.identity?.contentmultimap || {};
  } catch (e) { /* ignore */ }
  const json = JSON.stringify(payload);
  const hex  = Array.from(new TextEncoder().encode(json)).map((b) => b.toString(16).padStart(2, "0")).join("");
  // Replace this VDXF id's array with a single entry; preserve other VDXF entries as-is
  const newCm = { ...existing, [vdxfId]: [hex] };
  // Stringify each existing array entry properly — getidentity returns objects; we need hex strings
  for (const [k, v] of Object.entries(newCm)) {
    if (k === vdxfId) continue;
    newCm[k] = (Array.isArray(v) ? v : [v]).map((entry) => {
      if (typeof entry === "string") return entry;
      return entry?.serializedhex || entry?.message || JSON.stringify(entry);
    });
  }
  const updateArg = {
    name,
    parent,
    contentmultimap: newCm,
  };
  const cmd = `verus updateidentity '${JSON.stringify(updateArg)}'`;

  // Stash the prepared update arg on the card so the broadcast button can read it
  // without round-tripping through HTML-escaped JSON in a data-attr.
  pendingBroadcasts.set(card.dataset.iaddr, updateArg);

  previewEl.innerHTML = `
    <div class="review">
      <strong>Decoded payload (${slug})</strong>
      <pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>
      <strong>Hex-encoded entry</strong>
      <div style="font-family:monospace;font-size:11px;word-break:break-all;background:#0e1116;padding:8px;border:1px solid #30363d;border-radius:4px">${escapeHtml(hex)}</div>
      <strong>Equivalent CLI command</strong>
      <pre style="font-size:11px;white-space:pre-wrap;word-break:break-all">${escapeHtml(cmd)}</pre>
      <div class="row" style="margin-top:10px;gap:8px">
        <button class="primary" data-do="broadcast" style="flex:0 0 auto">Broadcast</button>
        <button class="ghost" data-do="cancel" style="flex:0 0 auto">Cancel</button>
      </div>
      <div class="result" style="margin-top:8px"></div>
    </div>
  `;
  previewEl.style.display = "block";
});

const pendingBroadcasts = new Map();

async function broadcastEntry(card, form) {
  const previewEl = form.querySelector(".preview");
  const resEl = previewEl.querySelector(".result");
  const updateArg = pendingBroadcasts.get(card.dataset.iaddr);
  if (!updateArg) {
    resEl.innerHTML = `<span class="err">no pending broadcast (open the preview again)</span>`;
    return;
  }
  resEl.innerHTML = `<span class="muted">Broadcasting…</span>`;
  try {
    const txid = await rpc("updateidentity", [updateArg]);
    resEl.innerHTML = `<span class="ok">✓ Broadcast: <code>${escapeHtml(txid)}</code></span>`;
    pendingBroadcasts.delete(card.dataset.iaddr);
    // Invalidate so the next loadMarket re-fetches and surfaces the new post.
    invalidateMarketCache();
    setTimeout(() => { loadIdentities(); loadMarket(); }, 3000);
  } catch (e) {
    resEl.innerHTML = `<span class="err">✗ ${escapeHtml(e.message)}</span>`;
  }
}

// ---------- Marketplace ----------
//
// Three sub-tabs (flat, network-wide):
//   - requests : all open loan.request entries
//   - offers   : all open loan.offer entries
//   - matches  : all loan.match entries
//
// "Acting as" picker decorates rows with "yours" or "← addressed to you" badges
// but doesn't filter visibility. Each tab shows a count.

const LS_KEY_ACTING = "vl_acting_iaddr";
let mpTab = "loans";

// Map new lifecycle-organised tabs to the underlying VDXF list each
// renders from. The bigger /loans/by-party-driven joined view is
// future work; for now this restructure regroups existing per-VDXF
// data into the user-task tabs.
function mpTabToLegacy(tab) {
  switch (tab) {
    case "inbox":    return "matches";   // matches addressed to me
    case "myposts":  return "requests";  // my requests + addressed-to-me requests
    case "active":   return "active";    // active loans (special-cased below)
    case "history":  return "history";   // settled/defaulted (special-cased)
    case "market":   return "offers";    // others' offers
    default:         return "requests";
  }
}

// History tab filters (state + role). Persisted in localStorage so the
// user's preferred slice survives reloads.
const LS_KEY_HISTORY_FILTER = "vl_history_filter";
const LS_KEY_HISTORY_ROLE   = "vl_history_role";
let historyFilter = localStorage.getItem(LS_KEY_HISTORY_FILTER) || "all";
let historyRole   = localStorage.getItem(LS_KEY_HISTORY_ROLE)   || "all";

function applyHistoryFilterUi() {
  document.querySelectorAll('[data-history-filter]').forEach((b) => {
    b.classList.toggle("active", b.dataset.historyFilter === historyFilter);
  });
  document.querySelectorAll('[data-history-role]').forEach((b) => {
    b.classList.toggle("active", b.dataset.historyRole === historyRole);
  });
}
applyHistoryFilterUi();

// Hide marketplace-only toggles on tabs where they don't apply, and toggle
// History's filter row visibility.
function syncSubControls() {
  const showStaleWrap = document.getElementById("mp-show-stale-wrap");
  const histRow       = document.getElementById("history-filter-row");
  if (showStaleWrap) showStaleWrap.style.display = (mpTab === "market") ? "flex" : "none";
  if (histRow)       histRow.style.display       = (mpTab === "history") ? "flex" : "none";
}
syncSubControls();

document.querySelectorAll('#market [data-mp-tab]').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('#market [data-mp-tab]').forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    mpTab = b.dataset.mpTab;
    syncSubControls();
    // Clear any in-flight op markers from the previous tab — those guard
    // against re-render clobbering an active panel, but tab switches are
    // explicit user navigation, so the guard shouldn't apply.
    document.querySelectorAll('#market-list [data-op-active="1"]').forEach((p) => {
      delete p.dataset.opActive;
      p.style.display = "none";
      p.innerHTML = "";
    });
    loadMarket();
  };
});

document.querySelectorAll('[data-history-filter]').forEach((b) => {
  b.onclick = () => {
    historyFilter = b.dataset.historyFilter;
    localStorage.setItem(LS_KEY_HISTORY_FILTER, historyFilter);
    applyHistoryFilterUi();
    if (mpTab === "history") loadMarket();
  };
});
document.querySelectorAll('[data-history-role]').forEach((b) => {
  b.onclick = () => {
    historyRole = b.dataset.historyRole;
    localStorage.setItem(LS_KEY_HISTORY_ROLE, historyRole);
    applyHistoryFilterUi();
    if (mpTab === "history") loadMarket();
  };
});

// "Show stale" toggle (Marketplace only) — persist + reload on change.
const LS_KEY_SHOW_STALE = "vl_show_stale";
const showStaleEl = document.getElementById("mp-show-stale");
if (showStaleEl) {
  showStaleEl.checked = localStorage.getItem(LS_KEY_SHOW_STALE) === "1";
  showStaleEl.onchange = () => {
    localStorage.setItem(LS_KEY_SHOW_STALE, showStaleEl.checked ? "1" : "0");
    loadMarket();
  };
}

// Two-level picker:
//   R-address (your wallet root) → list of IDs under that R
// If the chosen R has a single ID, the ID picker hides.
// If the chosen R has multiple IDs, the ID picker exposes them.
const LS_KEY_R = "vl_picked_r";
const LS_KEY_IADDR = LS_KEY_ACTING; // reuse key

async function populateActingPicker() {
  // listidentities already returns primaryaddresses inline — no per-ID
  // getidentity RPC needed.
  const enriched = await ensureSpendableIds();

  // Group by R-address
  const byR = new Map();
  for (const e of enriched) {
    if (!e.primaryR) continue;
    if (!byR.has(e.primaryR)) byR.set(e.primaryR, []);
    byR.get(e.primaryR).push(e);
  }
  // Cache for actingIaddr/R helpers
  pickerByR = byR;

  const rSel = document.getElementById("mp-r-picker");
  const iSel = document.getElementById("mp-id-picker");
  const iLabel = document.getElementById("mp-id-picker-label");

  // R-address dropdown options
  const rs = Array.from(byR.keys()).sort();
  rSel.innerHTML = `
    <option value="all">All R-addresses</option>
    ${rs.map((r) => {
      const idsUnder = byR.get(r);
      const label = idsUnder.length === 1
        ? `${r.slice(0, 10)}… — ${idsUnder[0].fqn}`
        : `${r.slice(0, 10)}… (${idsUnder.length} IDs)`;
      return `<option value="${escapeHtml(r)}">${escapeHtml(label)}</option>`;
    }).join("")}
  `;
  // Restore stored R
  const storedR = localStorage.getItem(LS_KEY_R);
  rSel.value = (storedR && (rs.includes(storedR) || storedR === "all")) ? storedR : (rs.length === 1 ? rs[0] : "all");

  function refreshIdPicker() {
    const chosenR = rSel.value;
    if (chosenR === "all") {
      iSel.innerHTML = `<option value="all">All identities</option>` +
        enriched.map((x) => `<option value="${escapeHtml(x.iaddr)}">${escapeHtml(x.fqn)}</option>`).join("");
      iLabel.style.display = "flex";
    } else {
      const idsUnder = byR.get(chosenR) || [];
      iSel.innerHTML = idsUnder.length > 1
        ? `<option value="all">All under this R</option>` + idsUnder.map((x) => `<option value="${escapeHtml(x.iaddr)}">${escapeHtml(x.fqn)}</option>`).join("")
        : idsUnder.map((x) => `<option value="${escapeHtml(x.iaddr)}">${escapeHtml(x.fqn)}</option>`).join("");
      // Hide ID picker entirely if the R only has one ID
      iLabel.style.display = idsUnder.length > 1 ? "flex" : "none";
    }
    // Restore stored iaddr if still valid
    const storedIaddr = localStorage.getItem(LS_KEY_IADDR);
    const validVals = Array.from(iSel.options).map((o) => o.value);
    iSel.value = validVals.includes(storedIaddr) ? storedIaddr : validVals[0];
  }

  refreshIdPicker();

  rSel.onchange = () => {
    localStorage.setItem(LS_KEY_R, rSel.value);
    refreshIdPicker();
    loadMarket();
  };
  iSel.onchange = () => {
    localStorage.setItem(LS_KEY_IADDR, iSel.value);
    loadMarket();
  };
}

let pickerByR = new Map();

function actingIaddr() {
  const v = document.getElementById("mp-id-picker")?.value;
  return v || "all";
}
function pickedR() {
  return document.getElementById("mp-r-picker")?.value || "all";
}
// Iaddrs the GUI considers "yours" right now. Computes from the live
// cachedSpendableIds — no separate pickerByR cache to drift.
async function inScopeIaddrs() {
  const id = actingIaddr();
  if (id && id !== "all") return [id];
  const r = pickedR();
  const ids = await ensureSpendableIds();
  if (r && r !== "all") return ids.filter((x) => x.primaryR === r).map((x) => x.iaddr);
  return ids.map((x) => x.iaddr);
}
async function actingIaddrs() {
  const v = actingIaddr();
  if (v && v !== "all") return [v];
  const ids = await ensureSpendableIds();
  return ids.map((x) => x.iaddr);
}

let _marketLoadToken = 0;
// Per-endpoint cache. Rapid tab clicks used to fire 3 fresh fetches per tab
// switch and trip scan.verus.cx 429 rate limits, leaving the row list empty.
// Each endpoint caches independently for 15s; if a fetch fails (429/network)
// we fall back to last-known-good data rather than wiping the list.
const _marketEndpointCache = new Map(); // path -> { at, data, inflight }
const MARKET_CACHE_TTL_MS = 15000;

// Shared cache for /loans/by-party. Multiple GUI surfaces call this
// (loadLoans, Inbox filter, My posts filter, auto-accept watcher) — without
// a shared cache they each fire an explorer call per acting iaddr per
// load, which 429s scan.verus.cx fast. Cache keyed by `address:state`.
const _byPartyCache = new Map();
async function fetchLoansByParty(address, state) {
  const key = `${address}:${state || 'all'}`;
  const slot = _byPartyCache.get(key);
  const now = Date.now();
  if (slot && slot.data && (now - slot.at) < MARKET_CACHE_TTL_MS) return slot.data;
  if (slot && slot.inflight) return slot.inflight;
  const inflight = (async () => {
    try {
      const stateQ = state ? `&state=${encodeURIComponent(state)}` : '';
      const r = await fetch(`${EXPLORER_API}/contracts/loans/by-party?address=${encodeURIComponent(address)}${stateQ}&pageSize=200&include_mempool=true`);
      if (r.status === 429) {
        // Surface stale data if any; otherwise empty fallback
        return slot?.data || { results: [] };
      }
      const json = await r.json();
      _byPartyCache.set(key, { at: Date.now(), data: json, inflight: null });
      return json;
    } catch {
      return slot?.data || { results: [] };
    }
  })();
  if (!slot) _byPartyCache.set(key, { at: 0, data: null, inflight });
  else slot.inflight = inflight;
  try { return await inflight; }
  finally { const s = _byPartyCache.get(key); if (s) s.inflight = null; }
}
async function fetchOneMarketTab(path) {
  const now = Date.now();
  let slot = _marketEndpointCache.get(path);
  if (slot && slot.data && (now - slot.at) < MARKET_CACHE_TTL_MS) {
    return slot.data;
  }
  if (slot && slot.inflight) return slot.inflight;
  if (!slot) { slot = { at: 0, data: null, inflight: null }; _marketEndpointCache.set(path, slot); }
  slot.inflight = (async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(`${EXPLORER_API}${path}`);
        if (r.status === 429) {
          if (attempt === 0) {
            await new Promise((res) => setTimeout(res, 700 + Math.random() * 400));
            continue;
          }
          // Fall back to stale data if we have it; otherwise an empty result
          // marked __failed so the caller can keep existing rows.
          return slot.data || { __failed: true, results: [] };
        }
        const json = await r.json();
        slot.data = json;
        slot.at = Date.now();
        return json;
      } catch {
        if (attempt === 0) {
          await new Promise((res) => setTimeout(res, 500));
          continue;
        }
        return slot.data || { __failed: true, results: [] };
      }
    }
    return slot.data || { __failed: true, results: [] };
  })();
  try {
    return await slot.inflight;
  } finally {
    slot.inflight = null;
  }
}
async function fetchMarketBundle() {
  return Promise.all([
    fetchOneMarketTab("/contracts/loans/requests?pageSize=200"),
    fetchOneMarketTab("/contracts/loans/offers?pageSize=200"),
    fetchOneMarketTab("/contracts/loans/matches?pageSize=200"),
  ]);
}
function invalidateMarketCache() {
  for (const slot of _marketEndpointCache.values()) {
    slot.at = 0;
    slot.data = null;
    slot.inflight = null;
  }
}
async function loadMarket() {
  const myToken = ++_marketLoadToken;
  const el = document.getElementById("market-list");
  // Only show "Loading…" if the row list is currently empty. Otherwise
  // keep showing the previous rows until the new fetch resolves — prevents
  // the "shows then goes away" flicker on rapid tab switches.
  if (!el.querySelector(".mp-row")) el.textContent = "Loading…";
  const acting = actingIaddr();

  const bundle = await fetchMarketBundle();
  if (myToken !== _marketLoadToken) return;
  const [reqRes, offRes, mchRes] = bundle;
  // If the active tab's data fetch failed (rate-limited) and we already have
  // rows rendered, keep them — don't replace with "No matches for this scope".
  const activeFailed =
    (mpTab === "requests" && reqRes.__failed) ||
    (mpTab === "offers" && offRes.__failed) ||
    (mpTab === "myoffers" && offRes.__failed) ||
    (mpTab === "matches" && mchRes.__failed);
  if (activeFailed && el.querySelector(".mp-row")) {
    return;
  }

  // Counts respect the picker scope. HTML id naming is unfortunate:
  //   ct-requests → "Open requests"     (loan.request)
  //   ct-matches  → "Open offers"       (loan.match — matches addressed to acting)
  //   ct-offers   → "Marketplace offers"(loan.offer)
  let scopeSet = null;
  if (acting !== "all" || pickedR() !== "all") {
    scopeSet = new Set(await inScopeIaddrs());
  }
  const reqAll = reqRes.results || [];
  const offAll = offRes.results || [];
  const mchAll = mchRes.results || [];
  const reqCount = scopeSet ? reqAll.filter((r) => scopeSet.has(r.iaddr) || (r.target_lender_iaddr && scopeSet.has(r.target_lender_iaddr))).length : reqAll.length;
  // My offers: offers posted by an in-scope identity.
  const myOffCount = scopeSet ? offAll.filter((r) => scopeSet.has(r.iaddr)).length : 0;
  // Market offers: external offers (others'). When acting="all" and R="all"
  // there's no "yours" to subtract, so it's the network total.
  const offCount = scopeSet ? offAll.filter((r) => !scopeSet.has(r.iaddr)).length : offAll.length;
  const mchCount = scopeSet ? mchAll.filter((r) => scopeSet.has(r.match_iaddr) || scopeSet.has(r.request?.iaddr)).length : mchAll.length;
  // Count badges for the new lifecycle tabs (Inbox / My posts / Marketplace).
  // Active and History counts are derived async from local identity state
  // and updated by their respective load functions.
  const setCt = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = String(n); };
  setCt("ct-inbox",   mchCount);                       // matches addressed to me
  setCt("ct-myposts", reqCount + myOffCount);          // my requests + my offers
  setCt("ct-market",  offCount);                       // others' offers
  // Legacy badges (in case any older HTML is still cached)
  setCt("ct-requests", reqCount);
  setCt("ct-matches",  mchCount);
  setCt("ct-myoffers", myOffCount);
  setCt("ct-offers",   offCount);

  // For "yours" / "local" decorations:
  //   - acting=specific: only need to compare against acting iaddr (no RPC needed)
  //   - acting=all: pull cached spendable IDs (RPC) so we can mark any local post
  let mySet = new Set();
  let myMap = new Map();
  if (acting === "all") {
    const myIds = await ensureSpendableIds();
    mySet = new Set(myIds.map((x) => x.iaddr));
    myMap = new Map(myIds.map((x) => [x.iaddr, x]));
  } else {
    mySet.add(acting);
    // Best-effort: enrich with name/parent if we already have it cached, otherwise look up
    const cached = (cachedSpendableIds || []).find((x) => x.iaddr === acting);
    if (cached) myMap.set(acting, cached);
  }

  let rows, render;
  // Unified "Loans" tab: combines what used to be three separate tabs
  // (Inbox / My posts / Active) into one section-based view. Sections
  // group by who's blocking progress:
  //   1. Active loans (Tx-A broadcast, in flight)
  //   2. Awaiting your action (matches sent to you as borrower; requests
  //      directed at you as lender)
  //   3. Awaiting counterparty (your open requests/offers/matches)
  // History stays separate (terminal-state browsing); Marketplace stays
  // separate (browsing other people's posts).
  if (mpTab === "loans") {
    const myIaddrs = await inScopeIaddrs();
    const partyAddrs = (acting && acting !== "all") ? [acting] : myIaddrs;

    // Pre-fetch joined loan-thread state so we know which open posts are
    // already past pending (and thus don't belong here).
    const acceptedTxAtxids = new Set();
    const acceptedRequestTxids = new Set();
    const matchedRequestTxids = new Set();
    try {
      for (const ia of partyAddrs) {
        const j = await fetchLoansByParty(ia);
        for (const l of (j?.results || [])) {
          if (l.state === 'active' || l.state === 'repaid' || l.state === 'defaulted') {
            if (l.loan_id)      acceptedTxAtxids.add(l.loan_id);
            if (l.request_txid) acceptedRequestTxids.add(l.request_txid);
          }
          if (l.state !== 'pending' && l.request_txid && l.lender_iaddr && partyAddrs.includes(l.lender_iaddr)) {
            matchedRequestTxids.add(l.request_txid);
          }
        }
      }
    } catch {}
    // If the acting lender already has an active loan.match for a given
    // borrower, suppress that borrower's pending request from "Awaiting
    // your action" — they've already committed; the request shouldn't
    // appear actionable. Walks the lender's loan.match entries directly
    // via daemon (NOT /loans/by-party) so it catches orphan matches whose
    // request_txid points to a now-replaced version of the request.
    const matchedWithBorrowers = new Set();
    const VDXF_LOAN_MATCH = "i4G69W7e3UJRCinuP7TFBRnm3ZUiXzPkFt";
    for (const ia of partyAddrs) {
      try {
        const info = await rpc("getidentity", [ia, -1]);
        const cm = info?.identity?.contentmultimap || {};
        for (const e of (cm[VDXF_LOAN_MATCH] || [])) {
          const hex = typeof e === "string" ? e : (e?.serializedhex || e?.message || "");
          if (!hex) continue;
          try {
            const m = JSON.parse(new TextDecoder().decode(_hexToBytes(hex)));
            if (m?.active === false) continue;
            // Skip matches whose Tx-A has already opened — those are
            // active loans, separate filter (acceptedTxAtxids) handles them.
            if (m?.tx_a_txid && acceptedTxAtxids.has(m.tx_a_txid)) continue;
            if (m?.request?.iaddr) matchedWithBorrowers.add(m.request.iaddr);
          } catch {}
        }
      } catch {}
    }

    // Pending requests directed at me as lender — these need my action.
    // Skip if I already have a matched/active loan with this borrower —
    // that case is "waiting on borrower," not "awaiting my action."
    const reqsAtMe = (reqRes.results || []).filter((r) =>
      r.target_lender_iaddr && mySet.has(r.target_lender_iaddr) &&
      !mySet.has(r.iaddr) &&
      !matchedRequestTxids.has(r.posted_tx) &&
      !matchedWithBorrowers.has(r.iaddr)
    );
    // My own requests waiting for a lender match.
    const myReqs = (reqRes.results || []).filter((r) =>
      mySet.has(r.iaddr) && !matchedRequestTxids.has(r.posted_tx)
    );
    // My offers (lender side, awaiting borrowers).
    const myOffs = (offRes.results || []).filter((r) => mySet.has(r.iaddr));
    // Matches addressed to me as borrower (lender posted a match for my request).
    const matchesAtMe = (mchRes.results || []).filter((r) =>
      r.request?.iaddr && mySet.has(r.request.iaddr) && !mySet.has(r.match_iaddr) &&
      !acceptedRequestTxids.has(r.request?.txid) && !acceptedTxAtxids.has(r.tx_a_txid)
    );
    // My posted matches (I'm lender, waiting for borrower to accept).
    let myMchs = (mchRes.results || []).filter((r) =>
      mySet.has(r.match_iaddr) && !acceptedTxAtxids.has(r.tx_a_txid)
    );

    // Active loans — daemon-first walk per acting/local iaddr.
    let activeRows = [];
    try {
      activeRows = (await Promise.all(partyAddrs.map(fetchActiveLoansFromDaemon))).flat();
    } catch {}
    const seenLoanIds = new Set();
    activeRows = activeRows.filter((l) => {
      const id = l.loan_id || l.tx_a_txid;
      if (seenLoanIds.has(id)) return false;
      seenLoanIds.add(id);
      return true;
    });

    // Dedupe: any of our own matches that's already in the Active section
    // shouldn't also appear as a raw match row in "Awaiting counterparty".
    // Includes BOTH 'matched' (borrower hasn't broadcast Tx-A yet) AND
    // 'active' (Tx-A confirmed, loan running) — both are the same thread.
    // /loans/matches doesn't expose tx_a_txid flat so we dedupe by
    // counterparty_iaddr (the borrower).
    const activeBorrowers = new Set(
      activeRows
        .filter((l) => l.role === 'lender' && (l.state === 'matched' || l.state === 'active'))
        .map((l) => l.counterparty_iaddr)
        .filter(Boolean)
    );
    if (activeBorrowers.size > 0) {
      myMchs = myMchs.filter((m) => !activeBorrowers.has(m.request?.iaddr));
    }

    // Counts for the Loans tab badge — actionable items only.
    const actionCount = matchesAtMe.length + reqsAtMe.length;
    const waitingCount = myReqs.length + myOffs.length + myMchs.length;
    const ctLoans = document.getElementById("ct-loans");
    if (ctLoans) ctLoans.textContent = String(actionCount + waitingCount + activeRows.length);

    if (myToken !== _marketLoadToken) return;
    const hasActiveOp = !!el.querySelector('.post-match-panel[data-op-active="1"], .accept-panel[data-op-active="1"]');
    if (hasActiveOp) return;

    const sectionHeader = (label) =>
      `<div style="margin:14px 0 6px 0;font-size:11px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:var(--muted)">${label}</div>`;
    // Tip height drives the lender Claim collateral countdown.
    const _tipHeight = await rpc("getblockcount", []).catch(() => 0);
    const parts = [];
    if (activeRows.length) {
      parts.push(sectionHeader("Active loans"));
      parts.push(activeRows.map((r) => renderActiveLoan(r, _tipHeight)).join(""));
    }
    if (actionCount > 0) {
      parts.push(sectionHeader("Awaiting your action"));
      parts.push(matchesAtMe.map((r) => renderMarketMatch(r, mySet, myMap, acting)).join(""));
      parts.push(reqsAtMe.map((r) => renderMarketRequest(r, mySet, myMap, acting)).join(""));
    }
    if (waitingCount > 0) {
      parts.push(sectionHeader("Awaiting counterparty"));
      parts.push(myReqs.map((r) => renderMarketRequest(r, mySet, myMap, acting)).join(""));
      parts.push(myOffs.map((r) => renderMarketOffer(r, mySet, myMap, acting)).join(""));
      parts.push(myMchs.map((r) => renderMarketMatch(r, mySet, myMap, acting)).join(""));
    }
    if (parts.length === 0) {
      el.innerHTML = `<div class="empty">No loans yet — <a href="#" id="goto-market-empty">browse the marketplace</a> to find a counterparty, or post a loan request/offer above.</div>`;
      const link = document.getElementById("goto-market-empty");
      if (link) link.onclick = (e) => { e.preventDefault(); document.querySelector('[data-mp-tab="market"]')?.click(); };
    } else {
      el.innerHTML = parts.join("");
      enrichActiveLoanBalances();
    }

    // Auto-load action panels: same pattern as the lender's Fund flow.
    // For "Awaiting your action" rows, eagerly trigger the prep so the
    // confirm panel shows inline without an extra click.
    if (acting && acting !== "all") {
      queueMicrotask(() => {
        // Auto-fund: pending requests directed at acting as lender.
        el.querySelectorAll('.mp-row[data-request-key]').forEach((rowEl) => {
          const r = requestByKey.get(rowEl.dataset.requestKey);
          if (!r) return;
          if (r.target_lender_iaddr !== acting) return;
          if (r.iaddr === acting) return;
          const btn = rowEl.querySelector('[data-mp-row-act="post-match"]');
          if (!btn) return;
          btn.style.display = 'none';
          btn.click();
        });
        // Auto-accept (manual review): matches addressed to acting as
        // borrower. Auto-loads the confirm panel; user clicks "Confirm
        // — accept & broadcast Tx-A" to commit. This is separate from
        // the silent auto-accept watcher (which runs only when
        // auto_accept=true was set on the request).
        el.querySelectorAll('.mp-row[data-match-key]').forEach((rowEl) => {
          const k = rowEl.dataset.matchKey;
          const r = matchByKey.get(k);
          if (!r) return;
          if (!r.request?.iaddr || r.request.iaddr !== acting) return;
          if (r.match_iaddr === acting) return;     // not your own match
          const btn = rowEl.querySelector('[data-mp-row-act="accept"]');
          if (!btn) return;
          btn.style.display = 'none';
          btn.click();
        });
      });
    }
    // Enrich match rows in this branch too (terms + R balance). The
    // tail-of-loadMarket call only fires for legacy tabs; this branch
    // returns early.
    enrichMatchRows(myToken);
    return;
  }

  // Legacy lifecycle tabs — kept for any deep links / older HTML caches.
  if (mpTab === "inbox" || mpTab === "matches") {
    // Inbox: match proposals addressed to me as borrower. Filter out
    // matches that have already been accepted — those have a
    // corresponding loan.status entry on my own identity with matching
    // loan_id (= match.tx_a_txid). Already-accepted matches show in
    // Active until settled, then in History.
    let inboxRows = mchRes.results || [];
    try {
      // Filter out matches whose loan has already opened (state >= active).
      // Use /loans/by-party as the single source of truth — works on both
      // borrower side (status on own iaddr) AND lender side (status on
      // counterparty iaddr; lender doesn't post one of their own).
      const acceptedTxAtxids = new Set();
      const acceptedRequestTxids = new Set();
      const myIaddrs = await inScopeIaddrs();
      for (const ia of myIaddrs) {
        const j = await fetchLoansByParty(ia);
        for (const l of (j?.results || [])) {
          if (l.state === 'active' || l.state === 'repaid' || l.state === 'defaulted') {
            if (l.loan_id)      acceptedTxAtxids.add(l.loan_id);
            if (l.request_txid) acceptedRequestTxids.add(l.request_txid);
          }
        }
      }
      inboxRows = inboxRows.filter((r) =>
        !acceptedRequestTxids.has(r.request?.txid) &&
        !acceptedTxAtxids.has(r.tx_a_txid)
      );
    } catch {}
    rows = inboxRows;
    render = (r) => renderMarketMatch(r, mySet, myMap, acting);
  } else if (mpTab === "myposts") {
    // My posts: combined view of my open requests + my open offers + my
    // open matches. Each row keeps its original render fn, so type-specific
    // actions (cancel request / cancel offer / cancel match) still work.
    //
    // Filter out matches that have been accepted by the borrower — those
    // belong in Active now. Discovered via the joined /loans/by-party
    // feed which already derives accepted state across both sides.
    let reqs = (reqRes.results || []).map((r) => ({ __kind: 'request', ...r }));
    const ofrs = (offRes.results || []).map((r) => ({ __kind: 'offer',   ...r }));
    let mchs = (mchRes.results || []).map((r) => ({ __kind: 'match',   ...r }));
    try {
      const myIaddrs = await inScopeIaddrs();
      const acceptedTxAtxids = new Set();
      const matchedRequestTxids = new Set();
      for (const ia of myIaddrs) {
        const j = await fetchLoansByParty(ia);
        for (const l of (j?.results || [])) {
          if (l.state === 'active' || l.state === 'repaid' || l.state === 'defaulted') {
            if (l.loan_id) acceptedTxAtxids.add(l.loan_id);
          }
          // If a local identity has progressed past 'pending' for a request
          // (i.e. they matched it as lender), drop that request from My posts.
          // It belongs in Active (as matched) or History now, not as a
          // pending-fund actionable entry.
          if (l.state !== 'pending' && l.request_txid && l.lender_iaddr && myIaddrs.includes(l.lender_iaddr)) {
            matchedRequestTxids.add(l.request_txid);
          }
        }
      }
      mchs = mchs.filter((m) => !acceptedTxAtxids.has(m.tx_a_txid));
      reqs = reqs.filter((r) => !matchedRequestTxids.has(r.posted_tx));
    } catch {}
    rows = [...reqs, ...ofrs, ...mchs];
    render = (r) => r.__kind === 'request' ? renderMarketRequest(r, mySet, myMap, acting)
                  : r.__kind === 'offer'   ? renderMarketOffer(r,   mySet, myMap, acting)
                  : renderMarketMatch(r, mySet, myMap, acting);
  } else if (mpTab === "active") {
    // Active loans: delegate to loadLoans which renders one row per
    // active loan from local identity multimaps + localStorage.
    return loadLoans(el);
  } else if (mpTab === "history") {
    // History: settled / defaulted loans + the full activity feed for
    // now. (Reuses loadActivity until we ship a state-filtered view.)
    return loadActivity(el);
  } else if (mpTab === "market" || mpTab === "offers") {
    // Marketplace: others' offers
    rows = offRes.results || [];
    render = (r) => renderMarketOffer(r, mySet, myMap, acting);
  } else if (mpTab === "myoffers") {
    rows = offRes.results || [];
    render = (r) => renderMarketOffer(r, mySet, myMap, acting);
  } else if (mpTab === "requests") {
    rows = reqRes.results || [];
    render = (r) => renderMarketRequest(r, mySet, myMap, acting);
  } else if (mpTab === "comms") { return renderCommsTab(el, acting, myToken); }

  // Strict filter: when a specific ID/R is picked, only show entries that involve them.
  //   - requests: posted by an in-scope iaddr OR directed at an in-scope iaddr
  //     (target_lender_iaddr — for lenders to see directed requests)
  //   - myoffers: offers POSTED by in-scope iaddrs (your own listings)
  //   - offers (Market): offers NOT posted by in-scope iaddrs (others')
  //   - matches: posted by in-scope (yours) OR pointing at in-scope (to-you)
  if (acting !== "all" || pickedR() !== "all") {
    const inScope = await inScopeIaddrs();
    const inSet = new Set(inScope);
    if (mpTab === "inbox" || mpTab === "matches") {
      // Inbox: matches addressed to me (my request was matched) OR
      // matches I posted that the borrower hasn't accepted yet.
      rows = rows.filter((r) => inSet.has(r.match_iaddr) || inSet.has(r.request?.iaddr));
    } else if (mpTab === "myposts") {
      // My posts: union of my own request/offer/match entries.
      rows = rows.filter((r) =>
        (r.__kind === 'request' && (inSet.has(r.iaddr) || (r.target_lender_iaddr && inSet.has(r.target_lender_iaddr)))) ||
        (r.__kind === 'offer'   && inSet.has(r.iaddr)) ||
        (r.__kind === 'match'   && inSet.has(r.match_iaddr))
      );
    } else if (mpTab === "requests") {
      rows = rows.filter((r) => inSet.has(r.iaddr) || (r.target_lender_iaddr && inSet.has(r.target_lender_iaddr)));
    } else if (mpTab === "myoffers") {
      rows = rows.filter((r) => inSet.has(r.iaddr));
    } else if (mpTab === "market" || mpTab === "offers") {
      // Marketplace: external only. Hide your own.
      rows = rows.filter((r) => !inSet.has(r.iaddr));
    }
  }

  // Staleness filter — hide entries past their explicit expiry (valid_until_block /
  // expires_block) or, for entries with no expiry, anything posted more than
  // STALE_BLOCK_AGE blocks ago (~7 days). Toggle off via the "Show stale" checkbox.
  const showStale = document.getElementById("mp-show-stale")?.checked;
  if (!showStale) {
    const tip = await rpc("getblockcount").catch(() => null);
    if (tip) {
      const STALE_BLOCK_AGE = 7 * 1440; // ~7 days at 1-minute blocks
      rows = rows.filter((r) => {
        const expiry = r.valid_until_block ?? r.expires_block ?? null;
        if (expiry !== null) return tip <= expiry;
        if (r.posted_block) return tip - r.posted_block <= STALE_BLOCK_AGE;
        return true;
      });
    }
  }

  if (!rows || rows.length === 0) {
    if (myToken !== _marketLoadToken) return; // a newer load has started; abandon
    const scopeDbg = scopeSet ? Array.from(scopeSet).join(", ") : "(no filter)";
    const totalDbg = mpTab === "requests" ? (reqRes.results?.length ?? 0)
                   : mpTab === "offers"   ? (offRes.results?.length ?? 0)
                   : mpTab === "myoffers" ? (offRes.results?.length ?? 0)
                   : (mchRes.results?.length ?? 0);
    el.innerHTML = `
      <div class="empty">
        No ${mpTab} for this scope.
        <div class="muted" style="font-size:11px;margin-top:8px">
          scope: ${escapeHtml(scopeDbg)}<br>
          network total: ${totalDbg}
        </div>
        <div style="margin-top:10px"><button class="ghost" onclick="document.getElementById('mp-r-picker').value='all';document.getElementById('mp-r-picker').onchange();">Switch to All R-addresses</button></div>
      </div>`;
    return;
  }

  // Sort: rows tied to acting identity first ("yours" or "addressed to you"), then by block desc
  const tieScore = (r) => {
    if (!acting || acting === "all") return 0;
    if (r.iaddr === acting) return 2;                              // posted by acting
    if (r.match_iaddr === acting) return 2;                        // 107-side: their own match
    if (r.request?.iaddr === acting) return 1;                     // match addressed to acting (borrower)
    return 0;
  };
  rows.sort((a, b) => (tieScore(b) - tieScore(a)) || ((b.posted_block ?? 0) - (a.posted_block ?? 0)));

  if (myToken !== _marketLoadToken) return; // newer load wins
  // Skip the wholesale innerHTML replacement if any row currently has an
  // active operation panel open (post-match, accept, etc.). Otherwise the
  // user's mid-flight click handler ends up writing to a detached DOM node.
  const hasActiveOp = !!el.querySelector('.post-match-panel[data-op-active="1"], .accept-panel[data-op-active="1"]');
  if (hasActiveOp) return;
  el.innerHTML = rows.map(render).join("");

  // Auto-fund: for any request row that's targeted at the acting lender
  // (target_lender_iaddr === acting) and NOT yet matched by anyone,
  // eagerly trigger the post-match prep so the lender sees the confirm
  // panel immediately instead of having to click "Fund this loan" first.
  if (acting && acting !== "all") {
    (async () => {
      // Build a set of request_txids that already have a non-pending
      // loan thread involving acting (matched/active/repaid/defaulted).
      // Skip auto-fund for those — the lender already committed.
      let alreadyMatched = new Set();
      try {
        const byParty = await fetchLoansByParty(acting);
        for (const l of (byParty?.results || [])) {
          if (l.state !== 'pending' && l.request_txid) {
            alreadyMatched.add(l.request_txid);
          }
        }
      } catch {}
      el.querySelectorAll('.mp-row[data-request-key]').forEach((rowEl) => {
        const key = rowEl.dataset.requestKey;
        const r = requestByKey.get(key);
        if (!r) return;
        if (r.target_lender_iaddr !== acting) return;
        if (r.iaddr === acting) return; // can't fund your own
        if (r.posted_tx && alreadyMatched.has(r.posted_tx)) return; // already matched
        const btn = rowEl.querySelector('[data-mp-row-act="post-match"]');
        if (!btn) return;
        btn.style.display = 'none';
        btn.click();
      });
    })();
  }

  // For matches: enrich each row with the linked request's terms + lender's R-balance.
  // Pass myToken so each enrichment can bail if a newer load fires mid-fetch.
  if (mpTab === "matches" || mpTab === "loans" || mpTab === "inbox") enrichMatchRows(myToken);
}

async function enrichMatchRows(token) {
  const rowEls = document.querySelectorAll(".mp-row[data-match-key]");
  for (const rowEl of rowEls) {
    const r = matchByKey.get(rowEl.dataset.matchKey);
    if (!r) continue;
    // Terms first — sets dataset.collateralCurrency / repayCurrency /
    // principalCurrency, which the balance enrichment then uses to
    // filter out unrelated currencies.
    await enrichMatchRowTerms(rowEl, r, token);
    enrichMatchRowBalance(rowEl, r, token);
  }
}

// Per-URL cache + retry, persisted to localStorage. Match terms don't change
// once posted, so a 24h TTL means most page loads serve straight from cache
// and don't even touch the explorer — fixing the "(linked request not found)"
// flicker on reloads when scan.verus.cx 429s us.
const ENRICH_LS_KEY = "vl_enrich_cache_v1";
const ENRICH_TTL_MS = 24 * 3600 * 1000;
const _enrichCache = (() => {
  try {
    const raw = localStorage.getItem(ENRICH_LS_KEY);
    if (!raw) return new Map();
    const obj = JSON.parse(raw);
    const now = Date.now();
    return new Map(Object.entries(obj).filter(([_, v]) => v && (now - v.at) < ENRICH_TTL_MS));
  } catch { return new Map(); }
})();
let _enrichCacheDirty = false;
function _persistEnrichCache() {
  if (!_enrichCacheDirty) return;
  _enrichCacheDirty = false;
  try {
    const obj = {};
    for (const [k, v] of _enrichCache) obj[k] = v;
    localStorage.setItem(ENRICH_LS_KEY, JSON.stringify(obj));
  } catch {}
}
setInterval(_persistEnrichCache, 2000);
function _enrichGet(url) {
  const slot = _enrichCache.get(url);
  if (!slot) return null;
  if ((Date.now() - slot.at) > ENRICH_TTL_MS) { _enrichCache.delete(url); return null; }
  return slot.data;
}
function _enrichSet(url, data) {
  _enrichCache.set(url, { at: Date.now(), data });
  _enrichCacheDirty = true;
}
async function fetchJsonWithRetry(url, { useCacheFirst = false } = {}) {
  // If cache-first: return cached immediately if present, fetch in background only on misses.
  if (useCacheFirst) {
    const cached = _enrichGet(url);
    if (cached) return cached;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url);
      if (r.status === 429) {
        if (attempt < 2) {
          await new Promise((res) => setTimeout(res, 800 + attempt * 600 + Math.random() * 400));
          continue;
        }
        return _enrichGet(url);
      }
      const json = await r.json();
      _enrichSet(url, json);
      return json;
    } catch {
      if (attempt < 2) {
        await new Promise((res) => setTimeout(res, 500));
        continue;
      }
      return _enrichGet(url);
    }
  }
  return _enrichGet(url);
}
async function enrichMatchRowTerms(rowEl, r, token) {
  const cell = rowEl.querySelector(".terms-summary");
  if (!cell || !r.request?.iaddr) return;
  let req = null;
  let lastError = null;
  try {
    // Daemon-first: pull the original loan.request payload from the on-chain
    // tx that posted it. Cheaper than the explorer and not rate-limited.
    if (r.request?.txid) {
      try { req = await fetchRequestFromLocalDaemon(r.request.txid); } catch {}
    }
    // Explorer fallback: only hit it if the daemon couldn't resolve.
    if (!req) {
      const cur = await fetchJsonWithRetry(`${EXPLORER_API}/contracts/loans/requests?iaddr=${encodeURIComponent(r.request.iaddr)}&include_inactive=true&pageSize=10`, { useCacheFirst: true });
      if (cur) {
        req = (cur.results || []).find((x) => !r.request.txid || x.posted_tx === r.request.txid) || (cur.results || [])[0];
      }
    }
    if (!req) {
      // History fallback: the request may have been removed from current state
      const hist = await fetchJsonWithRetry(`${EXPLORER_API}/identity/events?type=loan.request&iAddress=${encodeURIComponent(r.request.iaddr)}&history=true&pageSize=20`, { useCacheFirst: true });
      if (hist) {
        const ev = (hist.results || []).find((x) => !r.request.txid || x.chain?.txid === r.request.txid)
                || (hist.results || [])[0];
        const p = ev?.entries?.[0]?.decoded;
        if (p) req = { principal: p.principal, collateral: p.collateral, repay: p.repay, term_days: p.term_days };
      } else if (!cur) {
        lastError = "rate-limited";
      }
    }
  } catch (e) {
    lastError = e.message;
  }

  // Bail if a newer load has started OR the row was detached
  if (token !== undefined && token !== _marketLoadToken) return;
  if (!rowEl.isConnected) return;

  if (!req || !req.principal) {
    cell.textContent = lastError ? `(fetch error: ${lastError})` : "(linked request not found)";
    return;
  }
  const rate = req.principal && req.repay && req.principal.amount > 0
    ? (((req.repay.amount / req.principal.amount) - 1) * 100).toFixed(2) + "%"
    : "?";
  cell.classList.remove("muted");
  // Role-aware perspective: borrower sees "You give collateral, receive
  // principal, repay X". Lender sees "You give principal, receive repayment
  // (or collateral on default)". Decided per-row by whether acting iaddr is
  // the request's poster (borrower) or the match's poster (lender).
  const acting = actingIaddr();
  const isLender = acting && acting !== "all" && r.match_iaddr === acting;
  if (isLender) {
    cell.innerHTML = `
      <div>You give: <strong>${formatAmount(req.principal)}</strong> as principal</div>
      <div>You receive: <strong>${formatAmount(req.repay)}</strong> on repayment (${rate} return)</div>
      <div>If borrower defaults: claim <strong>${formatAmount(req.collateral)}</strong> from vault after maturity</div>
      <div class="muted" style="margin-top:4px">Term: <strong>${escapeHtml(req.term_days ?? "?")}</strong> days</div>
    `;
  } else {
    cell.innerHTML = `
      <div>You give: <strong>${formatAmount(req.collateral)}</strong> as collateral</div>
      <div>You receive: <strong>${formatAmount(req.principal)}</strong></div>
      <div>You repay: <strong>${formatAmount(req.repay)}</strong> in <strong>${escapeHtml(req.term_days ?? "?")} days</strong> (${rate})</div>
    `;
  }
  // Stash the full resolved request keyed by matchKey so the Accept handler
  // can reuse it after subsequent loadMarket re-renders.
  const mKey = `match-${r.match_iaddr}-${r.posted_tx || ""}`;
  matchResolvedRequest.set(mKey, req);
  // Stash currencies on the row so the balance enrichment can filter to
  // just the loan's currencies (collateral + repay for borrower; principal
  // for lender).
  rowEl.dataset.collateralCurrency = req.collateral?.currency || "";
  rowEl.dataset.collateralAmount   = String(req.collateral?.amount ?? "");
  rowEl.dataset.repayCurrency      = req.repay?.currency || "";
  rowEl.dataset.principalCurrency  = req.principal?.currency || "";
  // Once terms are ready, refresh borrower balance check
  enrichBorrowerCollateralBalance(rowEl, r, token);
}

async function enrichMatchRowBalance(rowEl, r, token) {
  const cell = rowEl.querySelector(".balance-cell");
  if (!cell) return;
  // If the borrower is the acting identity, the contextual
  // "✓/✗ Your wallet has X collateral" note (appended by
  // enrichBorrowerCollateralBalance to .match-terms) already
  // tells them whether they have enough — listing all wallet
  // balances here is redundant noise. Hide the row entirely.
  const acting = actingIaddr();
  const actingIsBorrower = acting && acting !== "all" && r.request?.iaddr === acting;
  if (actingIsBorrower) {
    const lenderRow = cell.closest(".lender-row");
    if (lenderRow) lenderRow.style.display = "none";
    return;
  }
  let address = r.lender_address;
  if (!address) return;
  // Restrict the displayed balances to currencies relevant to this loan:
  //   - borrower side: collateral (what they commit) + repay (what they
  //     pay back). Skips noise like "you have 0.49 VRSC" when neither
  //     side of the loan is in VRSC.
  //   - lender side:   principal (what they fund). The lender's other
  //     balances aren't useful from the borrower's POV.
  const loanCcyIds = new Set();
  const loanCcyNames = new Set();
  const collCcy = rowEl.dataset.collateralCurrency;
  const repayCcy = rowEl.dataset.repayCurrency;
  const principalCcy = rowEl.dataset.principalCurrency;
  if (actingIsBorrower) {
    if (collCcy)  loanCcyNames.add(collCcy);
    if (repayCcy) loanCcyNames.add(repayCcy);
  } else {
    if (principalCcy) loanCcyNames.add(principalCcy);
  }
  // Map currency names to known i-addresses so we can match the keys
  // returned by getaddressbalance (which are i-addresses, not names).
  const NAME_TO_ID = {
    "VRSC": "i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV",
    "DAI.vETH": "iGBs4DWztRNvNEJBt4mqHszLxfKTNHTkhM",
    "vETH": "iCkKJuJScy4Z6NSDK7Mt42ZAB2NEnAE1o4",
  };
  for (const name of loanCcyNames) {
    if (NAME_TO_ID[name]) loanCcyIds.add(NAME_TO_ID[name]);
  }
  let result, error;
  try {
    const bal = await rpc("getaddressbalance", [{ addresses: [address] }]);
    const cb = bal?.currencybalance || { [NAME_TO_ID.VRSC]: (bal?.balance ?? 0) / 1e8 };
    const filtered = {};
    for (const [k, v] of Object.entries(cb)) {
      if (loanCcyIds.size === 0 || loanCcyIds.has(k) || loanCcyNames.has(k)) {
        filtered[k] = v;
      }
    }
    result = `<code>${escapeHtml(address)}</code> · ${fmtBalances(filtered)}`;
  } catch (e) {
    error = e.message;
  }
  if (token !== undefined && token !== _marketLoadToken) return;
  if (!rowEl.isConnected) return;
  if (error) {
    cell.textContent = `(balance error: ${error})`;
    return;
  }
  cell.innerHTML = result;
  cell.classList.remove("muted");
}

// After terms load, append borrower's collateral check to the terms panel
async function enrichBorrowerCollateralBalance(rowEl, r, token) {
  const acting = actingIaddr();
  if (!acting || acting === "all") return;
  const collCcy = rowEl.dataset.collateralCurrency;
  const collAmt = parseFloat(rowEl.dataset.collateralAmount || "0");
  if (!collCcy || !collAmt) return;
  // Borrower's primary R-address balance
  try {
    const info = await rpc("getidentity", [acting, -1]);
    const primaryR = (info?.identity?.primaryaddresses || [])[0];
    if (!primaryR) return;
    const bal = await rpc("getaddressbalance", [{ addresses: [primaryR] }]);
    const cb = bal?.currencybalance || { VRSC: (bal?.balance ?? 0) / 1e8 };
    // map currency name → balance
    const KNOWN_NAME_BY_ID = {
      "i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV": "VRSC",
      "iGBs4DWztRNvNEJBt4mqHszLxfKTNHTkhM": "DAI.vETH",
      "iCkKJuJScy4Z6NSDK7Mt42ZAB2NEnAE1o4": "vETH",
    };
    let have = 0;
    for (const [k, v] of Object.entries(cb)) {
      const name = KNOWN_NAME_BY_ID[k] || k;
      if (name === collCcy || k === collCcy) { have = parseFloat(v); break; }
    }
    if (token !== undefined && token !== _marketLoadToken) return;
    if (!rowEl.isConnected) return;
    const sufficient = have >= collAmt;
    const termsEl = rowEl.querySelector(".match-terms");
    if (!termsEl) return;
    // Idempotent: remove any prior note before appending
    termsEl.querySelectorAll(".borrower-collateral-note").forEach((n) => n.remove());
    const note = document.createElement("div");
    note.className = "muted borrower-collateral-note";
    note.style.fontSize = "12px";
    note.style.marginTop = "4px";
    note.innerHTML = sufficient
      ? `<span style="color:var(--good)">✓ Your wallet has ${have} ${collCcy}</span> at <code>${escapeHtml(primaryR)}</code>`
      : `<span style="color:var(--bad)">✗ Your wallet only has ${have} ${collCcy}</span> at <code>${escapeHtml(primaryR)}</code> (need ${collAmt})`;
    termsEl.appendChild(note);
  } catch (e) {
    // Surface but quietly — borrower balance is auxiliary
    if (rowEl.isConnected) {
      const termsEl = rowEl.querySelector(".match-terms");
      if (termsEl && !termsEl.querySelector(".borrower-collateral-note")) {
        const note = document.createElement("div");
        note.className = "muted borrower-collateral-note";
        note.style.fontSize = "11px";
        note.style.marginTop = "4px";
        note.textContent = `(balance check failed: ${e.message})`;
        termsEl.appendChild(note);
      }
    }
  }
}

function renderMarketRequest(r, mySet, myMap, acting) {
  const mine = mySet.has(r.iaddr);
  const isActing = acting && acting !== "all" && r.iaddr === acting;
  const me = myMap.get(r.iaddr);
  const requestKey = `req-${r.iaddr}-${r.posted_tx || ""}`;
  requestByKey.set(requestKey, r);
  return `
    <div class="card mp-row" data-iaddr="${escapeHtml(r.iaddr)}" data-name="${escapeHtml(me?.name || "")}" data-parent="${escapeHtml(me?.parent || "")}" data-vdxf="iFg76F9M8CV5xEg3L2NvCDBXufaxjUWhaW" data-request-key="${escapeHtml(requestKey)}">
      <div class="row">
        <strong style="flex:1">${escapeHtml(r.fullyQualifiedName || r.name + "@")}</strong>
        <span class="badge loan-request">Loan request</span>
        ${isActing ? `<span class="badge yours" style="margin-left:6px">yours</span>` : mine ? `<span class="badge muted" style="margin-left:6px">local</span>` : ""}
      </div>
      <div class="kv">
        <div><span class="k">borrow</span><span class="v">${formatAmount(r.principal)}</span></div>
        <div><span class="k">collateral</span><span class="v">${formatAmount(r.collateral)}</span></div>
        <div><span class="k">repay</span><span class="v">${formatAmount(r.repay)}</span></div>
        <div><span class="k">term</span><span class="v">${escapeHtml(r.term_days ?? "?")} days</span></div>
        <div><span class="k">posted</span><span class="v">block ${escapeHtml(r.posted_block ?? "?")}</span></div>
      </div>
      <div class="row" style="margin-top:10px">
        ${mine
          ? `<button class="ghost remove-btn" data-mp-row-act="cancel" style="flex:0 0 auto">Cancel request</button>`
          : `<button class="primary" data-mp-row-act="post-match" style="flex:0 0 auto">Fund this loan</button>`}
      </div>
      <div class="post-match-panel" style="display:none;margin-top:10px"></div>
    </div>
  `;
}
const requestByKey = new Map();
const lenderInfoCache = new Map();

function renderMarketOffer(r, mySet, myMap, acting) {
  const mine = mySet.has(r.iaddr);
  const isActing = acting && acting !== "all" && r.iaddr === acting;
  const me = myMap.get(r.iaddr);
  // Pre-fill values for "Post request to this lender" — borrower's form
  // honors target_lender + a starting principal/collateral guess pulled
  // from the offer's terms (max_principal as ceiling, min_collateral_ratio
  // as the principal→collateral multiplier).
  const prefillName = r.fullyQualifiedName || (r.name ? r.name + "@" : r.iaddr);
  return `
    <div class="card mp-row" data-iaddr="${escapeHtml(r.iaddr)}" data-name="${escapeHtml(me?.name || "")}" data-parent="${escapeHtml(me?.parent || "")}" data-vdxf="iA1vgVBV5B29h5pxQ67gxqCoEaLDZ8WbmY"
         data-offer-fqn="${escapeHtml(prefillName)}"
         data-offer-rate="${r.rate ?? ""}" data-offer-term="${r.term_days ?? ""}"
         data-offer-max-principal="${(r.max_principal && r.max_principal.amount) || ""}"
         data-offer-principal-ccy="${escapeHtml((r.max_principal && r.max_principal.currency) || "")}"
         data-offer-min-ratio="${r.min_collateral_ratio ?? ""}"
         data-offer-collaterals="${escapeHtml((r.accepted_collateral || []).join(","))}">
      <div class="row">
        <strong style="flex:1">${escapeHtml(prefillName)}</strong>
        <span class="badge loan-offer">Loan offer</span>
        ${isActing ? `<span class="badge yours" style="margin-left:6px">yours</span>` : mine ? `<span class="badge muted" style="margin-left:6px">local</span>` : ""}
      </div>
      <div class="kv">
        <div><span class="k">max</span><span class="v">${formatAmount(r.max_principal)}</span></div>
        <div><span class="k">accepts</span><span class="v">${(r.accepted_collateral || []).join(", ") || "—"}</span></div>
        <div><span class="k">min ratio</span><span class="v">${r.min_collateral_ratio?.toFixed?.(2) ?? "?"}×</span></div>
        <div><span class="k">rate</span><span class="v">${r.rate != null ? (r.rate * 100).toFixed(1) + "%" : "?"}</span></div>
        <div><span class="k">term</span><span class="v">${escapeHtml(r.term_days ?? "?")} days</span></div>
      </div>
      ${mine
        ? `<div class="row" style="margin-top:10px"><button class="ghost remove-btn" data-mp-row-act="cancel" style="flex:0 0 auto">Cancel offer</button></div>`
        : `<div class="row" style="margin-top:10px"><button class="primary" data-mp-row-act="post-request-to-lender" style="flex:0 0 auto">Post request to this lender</button></div>`}
    </div>
  `;
}

const matchByKey = new Map();
// Survives loadMarket re-renders so the Accept handler always sees terms
// resolved by a prior enrichMatchRowTerms call.
const matchResolvedRequest = new Map();

async function renderCommsTab(el, acting, myToken) {
  // Communications via VerusID privateaddress (sapling z-memos).
  // Real wallet z-memo integration is a follow-up; this stub explains what
  // will land here and shows the relevant z-address per acting identity.
  document.getElementById("ct-comms").textContent = "·";
  let actingInfo = null;
  if (acting && acting !== "all") {
    try { actingInfo = await rpc("getidentity", [acting, -1]); } catch {}
  }
  const zAddr = actingInfo?.identity?.privateaddress;
  const fqn = actingInfo?.identity?.fullyqualifiedname || (acting === "all" ? "All identities" : "—");

  if (myToken !== undefined && myToken !== _marketLoadToken) return; // newer load wins
  el.innerHTML = `
    <div class="card">
      <h3 style="margin-top:0">Direct messages</h3>
      <div class="muted" style="font-size:13px;line-height:1.6">
        Verus identities can carry encrypted messages between counterparties via the identity's
        <strong>privateaddress</strong> (sapling z-address). A future wallet build will let you
        send/receive these directly from this tab — useful for negotiating loan match terms
        without leaving the protocol.
      </div>
      <div class="kv" style="margin-top:12px">
        <div><span class="k">acting as</span><span class="v">${escapeHtml(fqn)}</span></div>
        <div><span class="k">privateaddress</span><span class="v">${zAddr ? `<code>${escapeHtml(zAddr)}</code>` : '<span class="muted">— not set on this identity —</span>'}</span></div>
      </div>
      <div class="muted" style="font-size:12px;margin-top:12px;padding:8px;border:1px dashed var(--border);border-radius:4px">
        TODO (Phase C+):<br>
        • <code>z_listreceivedbyaddress</code> on this z-address → render as inbox<br>
        • <code>z_sendmany</code> compose dialog → send to counterparty's privateaddress<br>
        • Memos formatted as <code>{type, thread_id, step, payload}</code> per the spec
      </div>
    </div>
  `;
}

function renderMarketMatch(r, mySet, myMap, acting) {
  const mine = mySet.has(r.match_iaddr);
  const me = myMap.get(r.match_iaddr);
  const isActing = acting && acting !== "all" && r.match_iaddr === acting;
  // "Addressed to acting" = match's request points at acting iaddr
  const toActing = acting && acting !== "all" && r.request?.iaddr === acting;
  // Key on (lender_iaddr + borrower_iaddr). Both fields are present in
  // explorer responses and on-chain payloads, so the auto-accept watcher
  // (which reads from getidentity directly) constructs the same key as
  // the renderer. Active protocol invariant: at most one active match
  // per (lender, borrower) pair.
  const matchKey = `match-${r.match_iaddr}-${r.request?.iaddr || ""}`;
  matchByKey.set(matchKey, r);
  return `
    <div class="card mp-row" data-iaddr="${escapeHtml(r.match_iaddr)}" data-name="${escapeHtml(me?.name || "")}" data-parent="${escapeHtml(me?.parent || "")}" data-vdxf="i4G69W7e3UJRCinuP7TFBRnm3ZUiXzPkFt" data-match-key="${escapeHtml(matchKey)}">
      <div class="row">
        <strong style="flex:1">From <span style="color:var(--accent)">${escapeHtml(r.fullyQualifiedName || r.name + "@")}</span></strong>
        <span class="badge loan-match">Loan match</span>
        ${isActing ? `<span class="badge yours" style="margin-left:6px">yours</span>`
          : toActing ? `<span class="badge to-you" style="margin-left:6px">← to you</span>`
          : mine ? `<span class="badge muted" style="margin-left:6px">local</span>` : ""}
      </div>
      <div class="match-terms" style="margin-top:8px;padding:10px;border:1px solid var(--border);border-radius:6px;background:rgba(0,0,0,0.15)">
        <div class="muted" style="font-size:11px;margin-bottom:6px">${isActing ? "You posted this match — terms:" : toActing ? "If you accept:" : "Match terms:"}</div>
        <div class="terms-summary muted" style="font-size:13px">fetching terms…</div>
      </div>
      <div class="kv" style="margin-top:8px;font-size:12px">
        <div><span class="k">vault</span><span class="v"><code>${escapeHtml(r.vault_address || "—")}</code></span></div>
        <div><span class="k">expires</span><span class="v">block ${r.expires_block ?? "—"}</span></div>
        <div class="lender-row"><span class="k">${toActing ? "your R balance" : "lender R balance"}</span><span class="v"><span class="muted balance-cell">checking…</span></span></div>
      </div>
      <div style="margin-top:8px">
        <button class="ghost" data-mp-row-act="toggle-raw" style="font-size:11px;padding:3px 8px">▸ Show raw payload</button>
        <div class="raw-panel" style="display:none;margin-top:8px"></div>
      </div>
      <div class="row" style="margin-top:10px;gap:8px">
        ${mine
          ? `<button class="ghost remove-btn" data-mp-row-act="cancel" style="flex:0 0 auto">Cancel match</button>`
          : toActing
            ? `<button class="primary" data-mp-row-act="accept" style="flex:0 0 auto">Accept this loan</button>`
            : `<button class="primary" disabled title="Set 'Acting as' to the borrower of this request to enable Accept">Accept</button>`
        }
        ${mine
          ? `<button class="ghost" data-mp-row-act="message-borrower" style="flex:0 0 auto">Send message to borrower</button>`
          : toActing
            ? `<button class="ghost" data-mp-row-act="message-lender" style="flex:0 0 auto">Send message to lender</button>`
            : ""}
      </div>
      <div class="accept-panel" style="display:none;margin-top:10px"></div>
    </div>
  `;
}

// ── Match safety verification ──────────────────────────────────────
// Run before the borrower broadcasts Tx-A. Returns array of human-
// readable error strings; empty array = all checks pass.
//
// What's checked:
//   1. Tx-A vout 0 (principal) pays borrower's primary R, with the
//      currency + amount the borrower asked for in their request
//   2. Tx-A vout 1 (vault) pays the expected 2-of-2 P2SH derived from
//      both parties' actual pubkeys, with the collateral amount
//   3. Tx-Repay vout 0 pays the lender's primary R (looked up from
//      lender_iaddr's identity at receipt time), with the currency
//      + amount from the request
//   4. Tx-Repay vault input references Tx-A's vault output exactly
//   5. Tx-B vout 0 same as Tx-Repay but for collateral on default
//   6. Tx-B nLockTime >= request.maturity_block (so lender can't
//      claim collateral before maturity)
//   7. Tx-B vault input references Tx-A's vault output exactly
//
// Tx-A outputs aren't strictly verified here because the borrower's
// own pre-signed input (SIGHASH_ALL|ANYONECANPAY) would reject the
// broadcast if the lender altered them. We verify anyway so the
// borrower sees exactly why a malformed match got rejected.
async function verifyMatchSafety(matchPayload, requestPayload, borrowerIaddr) {
  const errors = [];
  try {
    // Resolve the lender's primary R from chain (current state — bound
    // to this verification snapshot; later rotations don't affect the
    // pre-signed bytes).
    const lenderInfo = await rpc("getidentity", [matchPayload.match_iaddr || requestPayload.target_lender_iaddr, -1]).catch(() => null);
    const lenderR = lenderInfo?.identity?.primaryaddresses?.[0];
    if (!lenderR) {
      errors.push("can't resolve lender's primary R-address from their identity");
      return errors;
    }
    const borrowerInfo = await rpc("getidentity", [borrowerIaddr, -1]).catch(() => null);
    const borrowerR = borrowerInfo?.identity?.primaryaddresses?.[0];
    if (!borrowerR) {
      errors.push("can't resolve your own primary R-address");
      return errors;
    }

    // Decode all 3 partials
    const [decA, decRepay, decB] = await Promise.all([
      rpc("decoderawtransaction", [matchPayload.tx_a_full]).catch(() => null),
      rpc("decoderawtransaction", [matchPayload.tx_repay_partial]).catch(() => null),
      rpc("decoderawtransaction", [matchPayload.tx_b_partial]).catch(() => null),
    ]);
    if (!decA)     { errors.push("can't decode Tx-A"); return errors; }
    if (!decRepay) { errors.push("can't decode Tx-Repay partial"); return errors; }
    if (!decB)     { errors.push("can't decode Tx-B partial"); return errors; }

    const txAtxid = decA.txid;
    const vaultVout = (typeof matchPayload.vault_vout === "number")
      ? matchPayload.vault_vout
      : decA.vout.findIndex((o) => (o.scriptPubKey?.addresses || []).includes(matchPayload.vault_address));
    if (vaultVout < 0) errors.push("vault output not found in Tx-A");

    // Check 1: Tx-A vout 0 — principal to borrower
    const principalOut = decA.vout[0];
    const principalAddrs = principalOut?.scriptPubKey?.addresses || [];
    if (!principalAddrs.includes(borrowerR)) {
      errors.push(`Tx-A principal output pays ${principalAddrs[0] || "?"} — expected your R ${borrowerR}`);
    }
    const principalCcy = requestPayload.principal?.currency;
    const principalAmt = parseFloat(requestPayload.principal?.amount ?? 0);
    if (principalCcy === "VRSC") {
      if (Math.round((principalOut?.value ?? 0) * 1e8) !== Math.round(principalAmt * 1e8)) {
        errors.push(`Tx-A principal amount ${principalOut?.value} VRSC — expected ${principalAmt}`);
      }
    } else {
      const cv = principalOut?.scriptPubKey?.reserveoutput?.currencyvalues || {};
      const got = parseFloat(Object.values(cv)[0] ?? 0);
      if (Math.round(got * 1e8) !== Math.round(principalAmt * 1e8)) {
        errors.push(`Tx-A principal amount ${got} — expected ${principalAmt} ${principalCcy}`);
      }
    }

    // Check 2: vault P2SH derived from real pubkeys
    if (vaultVout >= 0) {
      const vaultAddrs = decA.vout[vaultVout]?.scriptPubKey?.addresses || [];
      if (!vaultAddrs.includes(matchPayload.vault_address)) {
        errors.push(`Tx-A vault output address mismatch: ${vaultAddrs[0]} vs claimed ${matchPayload.vault_address}`);
      }
      // Collateral amount in vault
      const collateralCcy = requestPayload.collateral?.currency;
      const collateralAmt = parseFloat(requestPayload.collateral?.amount ?? 0);
      const vaultOut = decA.vout[vaultVout];
      if (collateralCcy === "VRSC") {
        if (Math.round((vaultOut?.value ?? 0) * 1e8) !== Math.round(collateralAmt * 1e8)) {
          errors.push(`Tx-A vault holds ${vaultOut?.value} VRSC — expected ${collateralAmt}`);
        }
      } else {
        const cv = vaultOut?.scriptPubKey?.reserveoutput?.currencyvalues || {};
        const got = parseFloat(Object.values(cv)[0] ?? 0);
        if (Math.round(got * 1e8) !== Math.round(collateralAmt * 1e8)) {
          errors.push(`Tx-A vault holds ${got} — expected ${collateralAmt} ${collateralCcy}`);
        }
      }
    }

    // Check 3+4: Tx-Repay output 0 + vault input
    const repayOut = decRepay.vout[0];
    const repayAddrs = repayOut?.scriptPubKey?.addresses || [];
    if (!repayAddrs.includes(lenderR)) {
      errors.push(`Tx-Repay output 0 pays ${repayAddrs[0] || "?"} — expected lender's R ${lenderR}`);
    }
    const repayCcy = requestPayload.repay?.currency;
    const repayAmt = parseFloat(requestPayload.repay?.amount ?? 0);
    if (repayCcy === "VRSC") {
      if (Math.round((repayOut?.value ?? 0) * 1e8) !== Math.round(repayAmt * 1e8)) {
        errors.push(`Tx-Repay output 0 amount ${repayOut?.value} VRSC — expected ${repayAmt}`);
      }
    } else {
      const cv = repayOut?.scriptPubKey?.reserveoutput?.currencyvalues || {};
      const got = parseFloat(Object.values(cv)[0] ?? 0);
      if (Math.round(got * 1e8) !== Math.round(repayAmt * 1e8)) {
        errors.push(`Tx-Repay output 0 amount ${got} — expected ${repayAmt} ${repayCcy}`);
      }
    }
    if (decRepay.vin[0]?.txid !== txAtxid || decRepay.vin[0]?.vout !== vaultVout) {
      errors.push(`Tx-Repay vault input references ${decRepay.vin[0]?.txid?.slice(0,16)}:${decRepay.vin[0]?.vout} — expected ${txAtxid.slice(0,16)}:${vaultVout}`);
    }

    // Check 5+6+7: Tx-B output 0 + nLockTime + vault input
    const bOut = decB.vout[0];
    const bAddrs = bOut?.scriptPubKey?.addresses || [];
    if (!bAddrs.includes(lenderR)) {
      errors.push(`Tx-B output 0 pays ${bAddrs[0] || "?"} — expected lender's R ${lenderR}`);
    }
    const collateralCcy = requestPayload.collateral?.currency;
    const collateralAmt = parseFloat(requestPayload.collateral?.amount ?? 0);
    if (collateralCcy === "VRSC") {
      if (Math.round((bOut?.value ?? 0) * 1e8) !== Math.round(collateralAmt * 1e8)) {
        errors.push(`Tx-B output 0 amount ${bOut?.value} VRSC — expected ${collateralAmt}`);
      }
    } else {
      const cv = bOut?.scriptPubKey?.reserveoutput?.currencyvalues || {};
      const got = parseFloat(Object.values(cv)[0] ?? 0);
      if (Math.round(got * 1e8) !== Math.round(collateralAmt * 1e8)) {
        errors.push(`Tx-B output 0 amount ${got} — expected ${collateralAmt} ${collateralCcy}`);
      }
    }
    const maturity = matchPayload.maturity_block ?? 0;
    if ((decB.locktime ?? 0) < maturity) {
      errors.push(`Tx-B nLockTime ${decB.locktime} < maturity block ${maturity} — lender could claim collateral early`);
    }
    if (decB.vin[0]?.txid !== txAtxid || decB.vin[0]?.vout !== vaultVout) {
      errors.push(`Tx-B vault input references ${decB.vin[0]?.txid?.slice(0,16)}:${decB.vin[0]?.vout} — expected ${txAtxid.slice(0,16)}:${vaultVout}`);
    }
  } catch (e) {
    errors.push(`verification error: ${e.message}`);
  }
  return errors;
}

// Cancel handler — removes the relevant VDXF entry from the i-address's multimap
document.getElementById("market-list").addEventListener("click", async (ev) => {
  const btn = ev.target.closest('[data-mp-row-act]');
  if (!btn) return;
  const action = btn.dataset.mpRowAct;
  const row = btn.closest(".mp-row");

  if (action === "post-request-to-lender") {
    // Open the marketplace request form, pre-filled with this offer's
    // lender iaddr + sensible defaults pulled from the offer terms.
    ev.stopPropagation();
    const lenderIa = row.dataset.iaddr;
    const offerCcy = row.dataset.offerPrincipalCcy || "VRSC";
    const offerMaxAmt = parseFloat(row.dataset.offerMaxPrincipal || "5") || 5;
    const offerRatio  = parseFloat(row.dataset.offerMinRatio || "2") || 2;
    const offerTerm   = parseInt(row.dataset.offerTerm || "30") || 30;
    const offerRate   = parseFloat(row.dataset.offerRate || "0.01");
    const offerCols   = (row.dataset.offerCollaterals || "").split(",").filter(Boolean);
    const principal = Math.min(offerMaxAmt, 5);                  // start small by default
    const collateralCcy = offerCols[0] || "VRSC";
    const collateral = +(principal * offerRatio).toFixed(8);
    const repay = +(principal * (1 + offerRate * (offerTerm / 365))).toFixed(8);
    await openMarketPostForm("request", {
      target_lender: lenderIa,
      target_lender_label: row.dataset.offerFqn || lenderIa,
      principal_amount: principal,
      principal_currency: offerCcy,
      collateral_amount: collateral,
      collateral_currency: collateralCcy,
      repay_amount: repay,
      term_days: offerTerm,
      min_collateral_ratio: offerRatio,  // form validation gates Preview on collateral/principal ≥ this
    });
    return;
  }

  if (action === "toggle-raw") {
    const panel = row.querySelector(".raw-panel");
    const matchKey = row.dataset.matchKey;
    if (panel.style.display === "none") {
      const r = matchByKey.get(matchKey);
      if (!r) { panel.textContent = "(no data)"; }
      else {
        panel.innerHTML = `
          <pre style="background:#0e1116;border:1px solid #30363d;border-radius:4px;padding:8px;font-size:11px;max-height:300px;overflow:auto;white-space:pre-wrap;word-break:break-all">${escapeHtml(JSON.stringify({
            request: r.request,
            lender_address: r.lender_address,
            vault_address: r.vault_address,
            vault_redeem_script: r.vault_redeem_script,
            tx_a_partial: r.tx_a_partial || "(empty — Phase C makeoffer integration pending)",
            tx_repay_partial: r.tx_repay_partial || "(empty)",
            tx_b_partial: r.tx_b_partial || "(empty)",
            expires_block: r.expires_block,
            active: r.active,
          }, null, 2))}</pre>
        `;
      }
      panel.style.display = "block";
      btn.textContent = "▾ Hide raw payload";
    } else {
      panel.style.display = "none";
      btn.textContent = "▸ Show raw payload";
    }
    return;
  }

  if (action === "message-lender") {
    const matchKey = row.dataset.matchKey;
    const r = matchByKey.get(matchKey);
    const panel = row.querySelector(".accept-panel");
    panel.style.display = "block";
    panel.innerHTML = `<div class="review muted">looking up addresses…</div>`;
    // Look up both: lender's z-address (recipient) + acting ID's z-address (sender)
    const acting = actingIaddr();
    const [recipInfo, senderInfo] = await Promise.all([
      rpc("getidentity", [r.match_iaddr, -1]).catch(() => null),
      acting && acting !== "all" ? rpc("getidentity", [acting, -1]).catch(() => null) : null,
    ]);
    const toZ = recipInfo?.identity?.privateaddress || null;
    const fromZ = senderInfo?.identity?.privateaddress || null;
    const senderName = senderInfo?.identity?.fullyqualifiedname || (senderInfo?.identity?.name ? senderInfo.identity.name + "@" : "—");
    panel.innerHTML = `
      <div class="review">
        <strong>Send a message to the lender</strong>
        <div class="muted" style="font-size:12px;margin-top:4px">Encrypted z-memo between identity privateaddresses.</div>
        <div class="kv" style="margin-top:8px;font-size:12px">
          <div><span class="k">from</span><span class="v">${escapeHtml(senderName)} · <code>${escapeHtml(fromZ || "(no privateaddress on this ID)")}</code></span></div>
          <div><span class="k">to</span><span class="v">${escapeHtml(r.fullyQualifiedName || r.name + "@")} · <code>${escapeHtml(toZ || "(no privateaddress on this ID)")}</code></span></div>
        </div>
        ${(toZ && fromZ)
          ? `<textarea id="msg-${escapeHtml(matchKey)}" rows="3" placeholder="message…" style="width:100%;margin-top:8px"></textarea>
             <button class="primary" data-mp-row-act="message-send" style="margin-top:6px;flex:0 0 auto">Send</button>
             <span class="muted" style="font-size:11px;margin-left:8px">Sends 0.0001 VRSC + memo, sender pays fees. (Z-memo wallet integration pending — preview-only.)</span>`
          : !fromZ
            ? `<div class="muted" style="font-size:12px;margin-top:8px;color:var(--bad)">Acting identity has no privateaddress — set one before sending.</div>`
            : `<div class="muted" style="font-size:12px;margin-top:8px;color:var(--warn)">Lender hasn't published a privateaddress yet — no encrypted channel available.</div>`}
      </div>
    `;
    return;
  }

  if (action === "message-send") {
    alert("Z-memo send: Phase C — z_sendmany call not wired in this build yet. The privateaddress lookup works; only the actual broadcast is pending.");
    return;
  }

  if (action === "post-match") {
    const requestKey = row.dataset.requestKey;
    const r = requestByKey.get(requestKey);
    const panel = row.querySelector(".post-match-panel");
    panel.style.display = "block";
    panel.dataset.opActive = "1";   // marker so loadMarket can skip clobbering
    panel.innerHTML = `<div class="review muted">looking up your funding options…</div>`;
    try {
      let acting = actingIaddr();
      // For v2 requests we'll prefer target_lender_iaddr if it matches a local
      // identity (resolved further down once we re-fetch the v2 fields).
      if (acting === r.iaddr) throw new Error("can't post a match against your own request");
      // Borrower's primary R + pubkey — needed for the 2-of-2 vault.
      // Also pulls the FULL loan.request payload from the multimap (the
      // explorer's typed endpoint strips v2-only fields like the borrower's
      // signed Tx-A skeleton, so we have to read it directly).
      const borrowerInfo = await rpc("getidentity", [r.iaddr, -1]);
      try {
        const VDXF_LOAN_REQUEST = "iFg76F9M8CV5xEg3L2NvCDBXufaxjUWhaW";
        const cm = borrowerInfo?.identity?.contentmultimap || {};
        const entries = cm[VDXF_LOAN_REQUEST] || [];
        for (const e of entries) {
          const hex = typeof e === "string" ? e : (e?.serializedhex || e?.message || "");
          if (!hex) continue;
          try {
            const json = JSON.parse(new TextDecoder().decode(_hexToBytes(hex)));
            if (!r.posted_tx || !json) {
              Object.assign(r, json);
            } else {
              if (Math.abs((json.principal?.amount || 0) - (r.principal?.amount || 0)) < 1e-8 &&
                  json.principal?.currency === r.principal?.currency &&
                  Math.abs((json.collateral?.amount || 0) - (r.collateral?.amount || 0)) < 1e-8) {
                Object.assign(r, json);
              }
            }
          } catch {}
        }
      } catch {}

      // If this is a v2 directed request and we have target_lender_iaddr,
      // and the picker isn't already pointed at a specific lender, snap acting
      // to the targeted lender (must be one of the local wallet's identities).
      if (r.target_lender_iaddr && (!acting || acting === "all")) {
        const ids = await ensureSpendableIds();
        if (ids.some((x) => x.iaddr === r.target_lender_iaddr)) {
          acting = r.target_lender_iaddr;
        }
      }
      if (!acting || acting === "all") throw new Error("select your lender identity in the picker first (or this request isn't directed at you)");
      if (r.target_lender_iaddr && r.target_lender_iaddr !== acting) {
        throw new Error(`request directed at ${r.target_lender_iaddr}, you are acting as ${acting}`);
      }
      const borrowerR = (borrowerInfo?.identity?.primaryaddresses || [])[0];
      if (!borrowerR) throw new Error("borrower identity has no primary R-address");
      // Lender's primary R + pubkey.
      const lenderInfo = await rpc("getidentity", [acting, -1]);
      const lenderR = (lenderInfo?.identity?.primaryaddresses || [])[0];
      if (!lenderR) throw new Error("acting identity has no primary R-address");
      const [lenderPubkey, borrowerPubkey] = await Promise.all([
        getPubkeyForRAddress(lenderR),
        getPubkeyForRAddress(borrowerR),
      ]);
      if (!lenderPubkey) throw new Error(`couldn't resolve lender pubkey from ${lenderR} — has this address ever signed a tx?`);
      if (!borrowerPubkey) throw new Error(`couldn't resolve borrower pubkey from ${borrowerR} — has this address ever signed a tx?`);
      // Find a UTXO at lender's R that has the principal currency.
      const principalCcy = r.principal?.currency;
      const principalAmt = parseFloat(r.principal?.amount ?? 0);
      const principalSats = Math.round(principalAmt * 1e8);
      if (!principalCcy || !principalAmt) throw new Error("request principal missing");
      // Aligned with the borrower's request flow: always auto-split a fresh
      // single-currency UTXO via sendcurrency, regardless of what the wallet
      // currently holds. Predictable Tx-A skeleton building, no UTXO picker.
      const utxos = await rpc("getaddressutxos", [{ addresses: [lenderR], currencynames: true }]);
      const candidates = utxos.filter((u) => {
        const cv = u.currencyvalues || {};
        if (principalCcy === "VRSC" || principalCcy === "i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV") {
          return u.satoshis >= principalSats;
        }
        return Object.entries(cv).some(([k, v]) => k && parseFloat(v) >= principalAmt);
      });
      panel.innerHTML = `
        <div class="review">
          <strong>Post a pre-signed match for ${escapeHtml(r.fullyQualifiedName || r.name + "@")}</strong>
          <div class="kv" style="margin-top:8px;font-size:12px">
            <div><span class="k">you commit</span><span class="v">${formatAmount(r.principal)} (principal)</span></div>
            <div><span class="k">borrower commits</span><span class="v">${formatAmount(r.collateral)} (collateral)</span></div>
            <div><span class="k">repayment</span><span class="v">${formatAmount(r.repay)} in ${escapeHtml(r.term_days ?? "?")} days</span></div>
            <div><span class="k">acting as</span><span class="v">${escapeHtml(lenderInfo?.identity?.fullyqualifiedname || acting)}</span></div>
            <div><span class="k">vault P2SH</span><span class="v"><span class="muted vault-preview">computing…</span></span></div>
          </div>
          ${candidates.length
            ? `<div style="margin-top:10px;font-size:12px;color:var(--muted)">Will split a fresh ${escapeHtml(principalCcy)} UTXO via sendcurrency, then post the match.</div>`
            : `<div style="margin-top:10px;color:var(--bad);font-size:12px">No ${escapeHtml(principalCcy)} balance at ${escapeHtml(lenderR)} large enough to fund ${formatAmount(r.principal)}.</div>`}
          ${candidates.length ? `<div class="row" style="margin-top:10px;gap:8px"><button class="primary" data-mp-row-act="post-match-go" style="flex:0 0 auto">Confirm — build, sign &amp; broadcast</button><button class="ghost" data-mp-row-act="post-match-cancel" style="flex:0 0 auto">Cancel</button></div>` : ""}
          <div class="post-match-result" style="margin-top:8px"></div>
        </div>
      `;
      // Compute vault P2SH async (cosmetic preview).
      try {
        const ms = await rpc("createmultisig", [2, [lenderPubkey, borrowerPubkey]]);
        const vp = panel.querySelector(".vault-preview");
        if (vp) vp.innerHTML = `<code>${escapeHtml(ms.address)}</code>`;
        // Stash for the submit handler.
        panel.dataset.lenderPubkey = lenderPubkey;
        panel.dataset.borrowerPubkey = borrowerPubkey;
        panel.dataset.lenderR = lenderR;
        panel.dataset.borrowerR = borrowerR;
        panel.dataset.vaultAddress = ms.address;
        panel.dataset.vaultRedeem = ms.redeemScript;
        panel.dataset.acting = acting;
        panel.dataset.requestIaddr = r.iaddr;
        panel.dataset.requestTxid = r.posted_tx || r.request?.txid || "";
        panel.dataset.requestBlock = String(r.posted_block || 0);
        panel.dataset.principalCurrency = principalCcy;
        panel.dataset.principalAmount = String(principalAmt);
        panel.dataset.collateralCurrency = r.collateral?.currency || "";
        panel.dataset.collateralAmount = String(r.collateral?.amount ?? "");
        panel.dataset.repayCurrency = r.repay?.currency || principalCcy;
        panel.dataset.repayAmount = String(r.repay?.amount ?? "");
        panel.dataset.termDays = String(r.term_days ?? 30);
        panel.dataset.actingFqn = lenderInfo?.identity?.fullyqualifiedname || acting;
        panel.dataset.actingParent = lenderInfo?.identity?.parent || "";
        panel.dataset.actingName = lenderInfo?.identity?.name || "";
      } catch (e) {
        const vp = panel.querySelector(".vault-preview");
        if (vp) vp.textContent = `(could not derive vault: ${e.message})`;
      }
    } catch (e) {
      panel.innerHTML = `<div class="review" style="color:var(--bad)">✗ ${escapeHtml(e.message)}</div>`;
    }
    return;
  }

  if (action === "accept-cancel") {
    const panel = row.querySelector(".accept-panel");
    if (panel) {
      panel.style.display = "none";
      panel.innerHTML = "";
      delete panel.dataset.opActive;
    }
    return;
  }

  if (action === "post-match-cancel") {
    const panel = row.querySelector(".post-match-panel");
    if (panel) {
      panel.style.display = "none";
      panel.innerHTML = "";
      delete panel.dataset.opActive;
    }
    return;
  }

  if (action === "post-match-go") {
    const panel = row.querySelector(".post-match-panel");
    const resultEl = panel.querySelector(".post-match-result") || panel;
    btn.disabled = true; btn.textContent = "Working…";
    try {
      const ds = panel.dataset;
      const requestKey = row.dataset.requestKey;
      const r = requestByKey.get(requestKey);
      if (!r) throw new Error("request data missing — refresh and retry");
      const principalCcy = ds.principalCurrency;
      const principalAmt = parseFloat(ds.principalAmount);
      const principalSats = Math.round(principalAmt * 1e8);
      const lenderR = ds.lenderR;
      const borrowerR = ds.borrowerR;
      const acting = ds.acting;

      // v2 borrower-first: read borrower's signed Tx-A skeleton from the request.
      // v1 fallback: borrower never signed; we'd build Tx-A from scratch (legacy).
      const borrowerSkeleton = r.borrower_input_signed_hex;
      const isV2 = !!(borrowerSkeleton && r.target_lender_iaddr);
      if (!isV2) throw new Error("v1 requests no longer supported in this build — borrower must repost as v2");
      // Sanity: target_lender_iaddr must match our acting identity.
      if (r.target_lender_iaddr && r.target_lender_iaddr !== acting) {
        throw new Error(`request directed at ${r.target_lender_iaddr}, you are acting as ${acting}`);
      }

      // Decode the skeleton to verify shape. 2 outputs (bundled change to
      // borrower) or 3 outputs (separate change address) both valid.
      const decoded = await rpc("decoderawtransaction", [borrowerSkeleton]);
      if (decoded.vin.length !== 1 || decoded.vout.length < 2 || decoded.vout.length > 3) {
        throw new Error(`borrower skeleton has ${decoded.vin.length} inputs / ${decoded.vout.length} outputs (expected 1/2 or 1/3)`);
      }
      const vaultVout = decoded.vout.findIndex((o) => (o.scriptPubKey?.addresses || []).includes(ds.vaultAddress));
      if (vaultVout < 0) throw new Error(`vault P2SH ${ds.vaultAddress} not found in borrower's skeleton outputs`);

      // Always auto-split a fresh single-currency UTXO via sendcurrency
      // (matches the borrower's request flow — predictable, no UTXO picker).
      let utxos;
      let exact = null;
      {
        btn.textContent = "Splitting UTXO via sendcurrency…";
        const out = principalCcy === "VRSC"
          ? [{ address: lenderR, amount: principalAmt }]
          : [{ currency: principalCcy, amount: principalAmt, address: lenderR }];
        const opid = await rpc("sendcurrency", [lenderR, out]);
        let splitTxid = null;
        for (let i = 0; i < 30 && !splitTxid; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const res = await rpc("z_getoperationresult", [[opid]]);
          const op = (res || [])[0];
          if (op?.status === "success") splitTxid = op.result?.txid;
          if (op?.status === "failed") throw new Error("split sendcurrency failed: " + JSON.stringify(op.error || {}));
        }
        if (!splitTxid) throw new Error("split sendcurrency timed out");
        // Don't wait for confirmation — Verus supports chained mempool. Decode
        // the split tx from the local mempool to find the new clean output.
        btn.textContent = "Locating split output in mempool (no confirm wait)…";
        const splitTx = await rpc("getrawtransaction", [splitTxid, 1]);
        if (!splitTx) throw new Error("split tx not visible to local daemon yet");
        // Find the single-currency output going back to lenderR with the right amount.
        let splitVout = -1;
        for (let i = 0; i < (splitTx.vout || []).length; i++) {
          const o = splitTx.vout[i];
          const spk = o?.scriptPubKey || {};
          const addrs = spk.addresses || [];
          if (!addrs.includes(lenderR)) continue;
          const cv = spk.reserveoutput?.currencyvalues || {};
          const cvKeys = Object.keys(cv);
          if (principalCcy !== "VRSC") {
            // Cryptocondition output, single currency, exact amount
            if (o.valueSat === 0 && cvKeys.length === 1 && parseFloat(Object.values(cv)[0]) === principalAmt) {
              splitVout = i; break;
            }
          } else {
            // VRSC P2PKH output of exactly the principal amount
            if (o.valueSat === principalSats && cvKeys.length === 0) {
              splitVout = i; break;
            }
          }
        }
        if (splitVout < 0) throw new Error("split tx didn't produce a clean single-currency output");
        // Reserve the freshly-split UTXO via lockunspent so no other
        // wallet operation accidentally consumes it before Tx-A
        // broadcasts. Without this, subsequent sendcurrency / repay /
        // consolidate could pick this UTXO as input, invalidating the
        // pre-signed Tx-A. The lock is in-memory; on cancel we unlock,
        // on Tx-A broadcast it's spent naturally.
        try {
          await rpc("lockunspent", [false, [{ txid: splitTxid, vout: splitVout }]]);
        } catch (e) {
          console.warn("lockunspent failed (non-fatal):", e?.message);
        }
        // Synthesize a UTXO record matching what getaddressutxos would return.
        const splitOut = splitTx.vout[splitVout];
        exact = {
          txid: splitTxid,
          outputIndex: splitVout,
          satoshis: splitOut.valueSat,
          currencyvalues: splitOut.scriptPubKey?.reserveoutput?.currencyvalues || {},
          script: splitOut.scriptPubKey?.hex,
        };
      }

      btn.textContent = "Extending borrower's Tx-A skeleton…";
      // Prepend lender's input to borrower's skeleton — borrower's input shifts
      // from index 0 to index 1; their SIGHASH_ALL|ANYONECANPAY signature
      // remains valid because the hash doesn't include the input index.
      const extendedHex = prependLenderInput(borrowerSkeleton, exact.txid, exact.outputIndex);

      btn.textContent = "Signing lender input (SIGHASH_SINGLE|ANYONECANPAY)…";
      const signedFull = await rpc("signrawtransaction", [extendedHex, null, null, "SINGLE|ANYONECANPAY"]);
      // signrawtransaction may report incomplete because borrower's input 1
      // isn't signed by the lender's wallet — but it should NOT touch borrower's
      // pre-existing scriptSig. Verify input 0 (lender's) is signed.
      const verifyDecoded = await rpc("decoderawtransaction", [signedFull.hex]);
      if (!verifyDecoded.vin[0]?.scriptSig?.hex) {
        throw new Error("lender input 0 still unsigned after signrawtransaction");
      }
      if (!verifyDecoded.vin[1]?.scriptSig?.hex) {
        throw new Error("borrower's pre-signed input 1 was clobbered — extend bug");
      }

      // Now Tx-A's bytes are complete (both scriptSigs in) → its txid is stable.
      const txAFinalHex = signedFull.hex;
      const txATxid = verifyDecoded.txid;
      btn.textContent = `Tx-A txid stable: ${txATxid.slice(0,16)}… — building Tx-Repay…`;

      // Register the 2-of-2 vault on the lender's wallet so signrawtransaction
      // can attach the lender's vault-half sig on Tx-Repay/Tx-B (idempotent).
      try { await rpc("addmultisigaddress", [2, [ds.lenderPubkey, ds.borrowerPubkey]]); } catch {}

      // ── Build Tx-Repay ────────────────────────────────────────────────
      // Input 0: vault UTXO (Tx-A txid, vault_vout)
      // Output 0: repay amount → lender's R-address (sig-locked by lender)
      // Lender signs vault input with SIGHASH_SINGLE|ANYONECANPAY (vault-half).
      // Borrower at accept time adds borrower-half + repayment input + outputs.
      const repayCcy = principalCcy; // repay is in principal currency by convention
      const repayAmt = parseFloat(ds.repayAmount);
      const repayCcyId = repayCcy === "VRSC"
        ? "i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV"
        : (await rpc("getcurrency", [repayCcy]))?.currencyid;
      if (!repayCcyId) throw new Error(`could not resolve currency id for ${repayCcy}`);
      const tipNow = await rpc("getblockcount");
      const matchExpiry = tipNow + 720;
      const repayOutputs = repayCcy === "VRSC"
        ? { [lenderR]: repayAmt }
        : { [lenderR]: { [repayCcyId]: repayAmt } };
      const txRepayUnsigned = await rpc("createrawtransaction", [
        [{ txid: txATxid, vout: vaultVout }],
        repayOutputs,
        0,
        matchExpiry,
      ]);
      // Provide prevtxs hint with redeemScript so signrawtransaction can sign
      // the vault P2SH input.
      const collateralAmt = parseFloat(ds.collateralAmount);
      const prevtxsHint = [{
        txid: txATxid,
        vout: vaultVout,
        scriptPubKey: decoded.vout[vaultVout].scriptPubKey.hex,
        redeemScript: ds.vaultRedeem,
        amount: collateralAmt,
      }];
      const txRepaySigned = await rpc("signrawtransaction", [txRepayUnsigned, prevtxsHint, null, "SINGLE|ANYONECANPAY"]);
      // Will be incomplete (only lender vault-half signed) — that's expected.
      const txRepayPartial = txRepaySigned.hex;

      // ── Build Tx-B ────────────────────────────────────────────────────
      btn.textContent = "Building Tx-B (default-claim, nLockTime=maturity)…";
      const termDays = parseInt(ds.termDays || "30", 10);
      const maturityBlock = tipNow + termDays * 1440;
      const collateralCcy = ds.collateralCurrency;
      const collateralCcyId = collateralCcy === "VRSC"
        ? "i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV"
        : (await rpc("getcurrency", [collateralCcy]))?.currencyid;
      const txBOutputs = collateralCcy === "VRSC"
        ? { [lenderR]: collateralAmt }
        : { [lenderR]: { [collateralCcyId]: collateralAmt } };
      const txBUnsigned = await rpc("createrawtransaction", [
        [{ txid: txATxid, vout: vaultVout }],
        txBOutputs,
        maturityBlock,             // nLockTime — chain rejects before this block
        Math.max(maturityBlock + 100, tipNow + 720),  // expiryHeight must be > nLockTime
      ]);
      const txBSigned = await rpc("signrawtransaction", [txBUnsigned, prevtxsHint, null, "SINGLE|ANYONECANPAY"]);
      const txBPartial = txBSigned.hex;

      btn.textContent = "Posting loan.match…";
      // Build the match payload — full Tx-A (both inputs signed) + 2 partials.
      const match = {
        version: 2,
        request: {
          iaddr: ds.requestIaddr,
          txid: ds.requestTxid,
          block: parseInt(ds.requestBlock || "0"),
        },
        lender_address:      lenderR,
        vault_address:       ds.vaultAddress,
        vault_redeem_script: ds.vaultRedeem,
        tx_a_full:           txAFinalHex,         // borrower can broadcast as-is
        tx_a_txid:           txATxid,
        vault_vout:          vaultVout,
        tx_repay_partial:    txRepayPartial,      // needs borrower vault-half + repayment input at repay time
        tx_b_partial:        txBPartial,          // needs borrower vault-half at accept; lender adds fee input + broadcasts after maturity
        maturity_block:      maturityBlock,
        expires_block:       matchExpiry,
        active: true,
      };
      const payloadHex = Array.from(new TextEncoder().encode(JSON.stringify(match)))
        .map((b) => b.toString(16).padStart(2, "0")).join("");

      // Read existing multimap entries on lender's identity to merge with our new one.
      const existing = (lenderInfoCache.get(acting) || (await rpc("getidentity", [acting, -1])).identity)?.contentmultimap || {};
      const VDXF_LOAN_MATCH = "i4G69W7e3UJRCinuP7TFBRnm3ZUiXzPkFt";
      const newMultimap = { ...existing };
      // Normalize preserved entries to hex strings (defensive — see
      // accept-v2 for context).
      for (const [k, v] of Object.entries(newMultimap)) {
        newMultimap[k] = (Array.isArray(v) ? v : [v]).map((entry) => {
          if (typeof entry === "string") return entry;
          return entry?.serializedhex || entry?.message || JSON.stringify(entry);
        });
      }
      newMultimap[VDXF_LOAN_MATCH] = [payloadHex];

      const updateTxid = await rpc("updateidentity", [{
        name: ds.actingName,
        parent: ds.actingParent,
        contentmultimap: newMultimap,
      }]);
      resultEl.innerHTML = `<div class="muted" style="color:var(--ok)">✓ Match posted: <a href="https://scan.verus.cx/vrsc/tx/${escapeHtml(updateTxid)}" target="_blank"><code>${escapeHtml(updateTxid.slice(0,16))}…</code></a><br>Switching to Active in 3s…</div>`;
      btn.style.display = "none";
      invalidateMarketCache();
      // Navigate to Active tab once mempool propagation has had a moment.
      // The match is in 'matched' state immediately; once the borrower's
      // auto-accept broadcasts Tx-A (within ~30s on auto-accept requests),
      // the loan moves to 'active' and surfaces in the Active tab.
      setTimeout(() => {
        // Clear the active-op marker so loadMarket can re-render
        const panelEl = row.querySelector(".post-match-panel");
        if (panelEl) {
          delete panelEl.dataset.opActive;
          panelEl.style.display = "none";
          panelEl.innerHTML = "";
        }
        // Switch to Active tab
        const activeTabBtn = document.querySelector('[data-mp-tab="active"]');
        if (activeTabBtn) {
          activeTabBtn.click();
        } else {
          loadMarket();
        }
      }, 3000);
    } catch (e) {
      resultEl.innerHTML = `<div class="muted" style="color:var(--bad)">✗ ${escapeHtml(e.message)}</div>`;
      btn.disabled = false;
      btn.textContent = "Retry";
      // Release the op-active guard so balance checks + other rows can refresh.
      const panel = row.querySelector(".post-match-panel");
      if (panel) delete panel.dataset.opActive;
    }
    return;
  }

  if (action === "accept") {
    const matchKey = row.dataset.matchKey;
    const r = matchByKey.get(matchKey);
    const panel = row.querySelector(".accept-panel");
    panel.style.display = "block";
    panel.dataset.opActive = "1";   // marker so loadMarket can skip clobbering
    panel.innerHTML = `<div class="review muted">looking up request terms…</div>`;
    // Reuse what enrichMatchRowTerms already resolved if present — saves a
    // round-trip and keeps Accept usable when the explorer is rate-limiting.
    let req = matchResolvedRequest.get(matchKey) || null;
    try {
      if (!req) {
        const cur = await fetchJsonWithRetry(`${EXPLORER_API}/contracts/loans/requests?iaddr=${encodeURIComponent(r.request.iaddr)}&include_inactive=true&pageSize=10`, { useCacheFirst: true });
        if (cur) req = (cur.results || []).find((x) => !r.request.txid || x.posted_tx === r.request.txid) || (cur.results || [])[0];
      }
      if (!req) {
        const hist = await fetchJsonWithRetry(`${EXPLORER_API}/identity/events?type=loan.request&iAddress=${encodeURIComponent(r.request.iaddr)}&history=true&pageSize=20`, { useCacheFirst: true });
        if (hist) {
          const ev = (hist.results || []).find((x) => !r.request.txid || x.chain?.txid === r.request.txid) || (hist.results || [])[0];
          const p = ev?.entries?.[0]?.decoded;
          if (p) req = { principal: p.principal, collateral: p.collateral, repay: p.repay, term_days: p.term_days };
        }
      }
      // Local daemon fallback — works without the explorer.
      if (!req && r.request?.txid) {
        try { req = await fetchRequestFromLocalDaemon(r.request.txid); } catch {}
      }
    } catch {}
    if (req) matchResolvedRequest.set(matchKey, req);
    // Explorer strips v2-only fields like tx_a_full. Re-fetch the raw match
    // multimap entry from the lender's iaddr so we know which UI flow to show.
    try {
      const lenderInfo = await rpc("getidentity", [r.match_iaddr, -1]);
      const VDXF_LOAN_MATCH = "i4G69W7e3UJRCinuP7TFBRnm3ZUiXzPkFt";
      const cm = lenderInfo?.identity?.contentmultimap || {};
      const entries = cm[VDXF_LOAN_MATCH] || [];
      for (const e of entries) {
        const hex = typeof e === "string" ? e : (e?.serializedhex || e?.message || "");
        if (!hex) continue;
        try {
          const json = JSON.parse(new TextDecoder().decode(_hexToBytes(hex)));
          if (json.request?.iaddr === r.request?.iaddr) { Object.assign(r, json); break; }
        } catch {}
      }
    } catch {}
    // v2 match has tx_a_full (full Tx-A, both inputs signed) + Tx-Repay/Tx-B partials.
    // v1 (legacy) has tx_a_partial only.
    const isV2 = !!(r.tx_a_full && r.tx_repay_partial && r.tx_b_partial);
    const hasV1Partial = !isV2 && !!(r.tx_a_partial && r.tx_a_partial.length > 50);
    panel.innerHTML = `
      <div class="review">
        <strong>If you accept this match…</strong>
        <ul style="margin:6px 0 6px 18px;font-size:13px">
          <li>Lender ${escapeHtml(r.fullyQualifiedName || r.name + "@")} commits <strong>${formatAmount(req?.principal)}</strong> to your address (per Tx-A)</li>
          <li>You commit <strong>${formatAmount(req?.collateral)}</strong> to vault <code>${escapeHtml(r.vault_address)}</code></li>
          <li>You repay <strong>${formatAmount(req?.repay)}</strong> within <strong>${escapeHtml(req?.term_days ?? "?")} days</strong></li>
          ${isV2 ? `<li>Tx-Repay + Tx-B are pre-signed by lender — you complete the 2-of-2 sigs locally; settlement is unilateral.</li>` : ""}
        </ul>
        ${isV2
          ? `<div class="row" style="margin-top:6px;gap:8px">
               <button class="primary" data-mp-row-act="accept-v2" style="flex:0 0 auto">Confirm — accept &amp; broadcast Tx-A</button>
               <button class="ghost" data-mp-row-act="accept-cancel" style="flex:0 0 auto">Cancel</button>
             </div>
             <span class="muted" style="font-size:11px;display:block;margin-top:4px">Completes 2-of-2 sigs on Tx-Repay/Tx-B, broadcasts Tx-A, posts Tx-B back via loan.status.</span>
             <div class="accept-result" style="margin-top:8px"></div>`
          : hasV1Partial
            ? `<div class="row" style="margin-top:6px;gap:8px">
                 <button class="primary" data-mp-row-act="accept-broadcast" style="flex:0 0 auto">[v1] Broadcast Tx-A — borrow ${formatAmount(req?.principal)}</button>
                 <button class="ghost" data-mp-row-act="accept-cancel" style="flex:0 0 auto">Cancel</button>
               </div>
               <span class="muted" style="font-size:11px;display:block;margin-top:4px">Legacy match: extends Tx-A skeleton + adds collateral. Settlement requires later cosig handshake.</span>
               <div class="accept-result" style="margin-top:8px"></div>`
            : `<strong style="color:var(--warn)">Match has no pre-signed Tx-A.</strong>
               <div class="muted" style="font-size:11px;margin-top:4px">
                 Ask the lender to repost a v2 match.
               </div>`}
      </div>
    `;
    return;
  }

  if (action === "accept-v2") {
    const matchKey = row.dataset.matchKey;
    const r = matchByKey.get(matchKey);
    const panel = row.querySelector(".accept-panel");
    panel.dataset.opActive = "1";
    const resultEl = panel.querySelector(".accept-result") || panel;
    btn.disabled = true; btn.textContent = "Verifying match…";
    try {
      // Explorer's typed endpoint strips v2-only fields (e.g., tx_a_full).
      // Re-fetch the raw multimap entry from the lender's iaddr to get them.
      try {
        const lenderInfo = await rpc("getidentity", [r.match_iaddr, -1]);
        const VDXF_LOAN_MATCH = "i4G69W7e3UJRCinuP7TFBRnm3ZUiXzPkFt";
        const cm = lenderInfo?.identity?.contentmultimap || {};
        const entries = cm[VDXF_LOAN_MATCH] || [];
        for (const e of entries) {
          const hex = typeof e === "string" ? e : (e?.serializedhex || e?.message || "");
          if (!hex) continue;
          try {
            const json = JSON.parse(new TextDecoder().decode(_hexToBytes(hex)));
            // Match by request reference equality
            if (json.request?.iaddr === r.request?.iaddr) {
              Object.assign(r, json);
              break;
            }
          } catch {}
        }
      } catch {}
      if (!r.tx_a_full || !r.tx_repay_partial || !r.tx_b_partial || !r.vault_address || !r.vault_redeem_script) {
        throw new Error("v2 match missing required fields (tx_a_full / tx_repay_partial / tx_b_partial / vault_*)");
      }
      const acting = actingIaddr();
      if (!acting || acting === "all") throw new Error("select your borrower identity in the picker first");

      // ── Safety verification ──────────────────────────────────────────
      // Verify the lender's match honors the borrower's request terms
      // exactly. Tx-A outputs are protected by the borrower's pre-signed
      // input (any tampering invalidates the sig — broadcast would fail).
      // Tx-Repay and Tx-B outputs are pre-signed by the LENDER with
      // SIGHASH_SINGLE|ANYONECANPAY: lender freely chose the recipient
      // and amount, so we must verify they match the request and pay
      // the lender's verified primary R-address.
      btn.textContent = "Verifying match safety…";
      const _req = matchResolvedRequest.get(matchKey) || (r.request?.txid ? await fetchRequestFromLocalDaemon(r.request.txid).catch(() => null) : null);
      if (!_req) throw new Error("can't verify match — original request payload not found");
      const safetyErrors = await verifyMatchSafety(r, _req, acting);
      if (safetyErrors.length > 0) {
        throw new Error("Match safety check failed:\n  • " + safetyErrors.join("\n  • "));
      }

      // Decode tx_a_full to verify it makes sense; pull the vault scriptPubKey for prevtxs hint.
      btn.textContent = "Decoding Tx-A & locating vault output…";
      const decodedA = await rpc("decoderawtransaction", [r.tx_a_full]);
      const txATxid = decodedA.txid;
      const vaultVout = (typeof r.vault_vout === "number")
        ? r.vault_vout
        : decodedA.vout.findIndex((o) => (o.scriptPubKey?.addresses || []).includes(r.vault_address));
      if (vaultVout < 0) throw new Error("vault output not found in Tx-A");
      const vaultScriptPubKey = decodedA.vout[vaultVout].scriptPubKey.hex;

      // Make sure the borrower's wallet knows about the 2-of-2 vault — required
      // for signrawtransaction to attach the borrower's vault-half.
      btn.textContent = "Registering vault address (idempotent)…";
      // Extract the two pubkeys from the redeemScript: 52 21<33> 21<33> 52 ae
      const rs = _hexToBytes(r.vault_redeem_script);
      if (rs.length !== 71 || rs[0] !== 0x52 || rs[1] !== 0x21 || rs[35] !== 0x21 || rs[69] !== 0x52 || rs[70] !== 0xae) {
        throw new Error("unexpected vault redeemScript shape — only 2-of-2 with two 33-byte compressed pubkeys supported");
      }
      const pubA = _bytesToHex(rs.slice(2, 35));
      const pubB = _bytesToHex(rs.slice(36, 69));
      try { await rpc("addmultisigaddress", [2, [pubA, pubB]]); } catch {}

      // Build prevtxs hint for the vault input (used by both Tx-Repay and Tx-B sigs).
      const req = matchResolvedRequest.get(matchKey) || (r.request?.txid ? await fetchRequestFromLocalDaemon(r.request.txid).catch(() => null) : null);
      if (!req?.collateral?.amount) throw new Error("collateral amount missing — refresh the marketplace and retry");
      const collateralAmt = parseFloat(req.collateral.amount);
      const prevtxsHint = [{
        txid: txATxid,
        vout: vaultVout,
        scriptPubKey: vaultScriptPubKey,
        redeemScript: r.vault_redeem_script,
        amount: collateralAmt,
      }];

      // Complete Tx-Repay: borrower adds their vault-half → 2-of-2 done.
      btn.textContent = "Completing Tx-Repay 2-of-2…";
      const repaySigned = await rpc("signrawtransaction", [r.tx_repay_partial, prevtxsHint, null, "SINGLE|ANYONECANPAY"]);
      if (!repaySigned.complete) throw new Error("Tx-Repay did not complete: " + JSON.stringify(repaySigned.errors || {}));

      // Complete Tx-B similarly.
      btn.textContent = "Completing Tx-B 2-of-2…";
      const bSigned = await rpc("signrawtransaction", [r.tx_b_partial, prevtxsHint, null, "SINGLE|ANYONECANPAY"]);
      if (!bSigned.complete) throw new Error("Tx-B did not complete: " + JSON.stringify(bSigned.errors || {}));

      // Broadcast Tx-A.
      btn.textContent = "Broadcasting Tx-A…";
      const txABroadcastTxid = await rpc("sendrawtransaction", [r.tx_a_full]);

      // Stash Tx-Repay locally (browser localStorage keyed by Tx-A txid).
      // Will be retrieved later when borrower clicks Repay.
      try {
        localStorage.setItem(`vl_tx_repay_${txABroadcastTxid}`, repaySigned.hex);
      } catch {}

      // Post Tx-B back to chain via loan.status on the borrower's identity so
      // the lender can find it for the default-claim path.
      btn.textContent = "Posting Tx-B + loan.status to your VerusID…";
      const idInfo = await rpc("getidentity", [acting, -1]);
      const existing = idInfo?.identity?.contentmultimap || {};
      const VDXF_LOAN_STATUS = "iPnrakyY951QEy6xUYBuJoobHA9JKY6G8j";
      const statusPayload = {
        version: 3,
        role: "borrower",
        loan_id: txABroadcastTxid,
        // v3: propagate the request's txid as the loan's canonical
        // cross-lifecycle id. Lets anyone join all 4 entries by one
        // key (request_txid) without walking the request_txid → match
        // → tx_a_txid → loan_id chain.
        request_txid: r.request?.txid ?? null,
        match_iaddr: r.match_iaddr,
        vault_address: r.vault_address,
        vault_redeem_script: r.vault_redeem_script,
        principal: req.principal,
        collateral: req.collateral,
        repay: req.repay,
        term_days: req.term_days ?? null,
        maturity_block: r.maturity_block,
        tx_b_complete: bSigned.hex,       // borrower-completed Tx-B for lender's default-claim
        // Borrower-half-signed Tx-Repay (lender's vault-half from match +
        // borrower's vault-half added). Stored on the borrower's own
        // identity so repay-time recovery doesn't depend on the lender
        // keeping their loan.match entry around. The borrower's
        // localStorage cache is still the fast path; this is the durable
        // fallback they fully control.
        tx_repay_signed: repaySigned.hex,
        active: true,
      };
      const statusHex = Array.from(new TextEncoder().encode(JSON.stringify(statusPayload)))
        .map((b) => b.toString(16).padStart(2, "0")).join("");
      // Build newCm from scratch — only valid i-address keys with valid
      // hex entries. Anything else trips daemon's "Invalid JSON ID
      // parameter".
      const newCm = {};
      const isHex = (s) => typeof s === "string" && s.length > 0 && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s);
      const isIaddr = (k) => typeof k === "string" && /^i[1-9A-HJ-NP-Za-km-z]{33}$/.test(k);
      for (const [k, v] of Object.entries(existing)) {
        if (!isIaddr(k)) continue;
        const entries = (Array.isArray(v) ? v : [v])
          .map((entry) => typeof entry === "string" ? entry : (entry?.serializedhex || entry?.message || ""))
          .filter(isHex);
        if (entries.length) newCm[k] = entries;
      }
      newCm[VDXF_LOAN_STATUS] = [...(newCm[VDXF_LOAN_STATUS] || []), statusHex];
      // Consume the loan.request: this updateidentity is the moment the
      // request transitions from "intent" to "active loan." Dropping the
      // entry atomically with adding loan.status keeps the borrower's
      // multimap reflecting current truth and removes the stale request
      // from lender-side discovery views.
      const VDXF_LOAN_REQUEST = "iFg76F9M8CV5xEg3L2NvCDBXufaxjUWhaW";
      delete newCm[VDXF_LOAN_REQUEST];
      // Diag: log the exact payload shape being sent. Helps debug
      // "Invalid JSON ID parameter" errors from the daemon.
      const cmKeys = Object.keys(newCm);
      const cmDiag = cmKeys.map((k) => `${k}:${(newCm[k]||[]).length}`).join(",");
      console.log(`[accept-v2] posting updateidentity name=${idInfo.identity.name} parent=${idInfo.identity.parent || "(empty)"} cm keys=[${cmDiag}]`);
      // Validate every entry hex one more time and log invalid ones.
      for (const [k, arr] of Object.entries(newCm)) {
        for (const e of arr) {
          if (typeof e !== "string" || !/^[0-9a-fA-F]+$/.test(e)) {
            console.warn(`[accept-v2] INVALID entry under key ${k}: type=${typeof e} val=${JSON.stringify(e)?.slice(0,100)}`);
          }
        }
      }
      const updateTxid = await rpc("updateidentity", [{
        name: idInfo.identity.name,
        parent: idInfo.identity.parent || "",
        contentmultimap: newCm,
      }]);

      resultEl.innerHTML = `<div class="muted" style="color:var(--ok)">
        ✓ Loan opened end-to-end:<br>
        &nbsp;&nbsp;Tx-A: <a href="https://scan.verus.cx/vrsc/tx/${escapeHtml(txABroadcastTxid)}" target="_blank"><code>${escapeHtml(txABroadcastTxid)}</code></a><br>
        &nbsp;&nbsp;loan.status: <a href="https://scan.verus.cx/vrsc/tx/${escapeHtml(updateTxid)}" target="_blank"><code>${escapeHtml(updateTxid.slice(0,16))}…</code></a><br>
        &nbsp;&nbsp;Refreshing Loans tab in 3s…
      </div>`;
      btn.style.display = "none";
      invalidateMarketCache();
      // Clear the panel + reload so the loan moves to the Active section
      // of the Loans tab (it'll appear with state=active once mempool
      // propagates).
      setTimeout(() => {
        const panelEl = row.querySelector(".accept-panel");
        if (panelEl) {
          delete panelEl.dataset.opActive;
          panelEl.style.display = "none";
          panelEl.innerHTML = "";
        }
        loadMarket();
      }, 3000);
    } catch (e) {
      resultEl.innerHTML = `<div class="muted" style="color:var(--bad)">✗ ${escapeHtml(e.message)}</div>`;
      btn.disabled = false;
      btn.textContent = "Retry";
      // Release the op-active guard so other rows + balance checks can
      // refresh. The panel stays visible with the error + Retry button;
      // a subsequent loadMarket may re-render the row, but the user
      // can re-trigger Accept normally.
      const panel = row.querySelector(".accept-panel");
      if (panel) delete panel.dataset.opActive;
    }
    return;
  }

  if (action === "accept-broadcast") {
    const matchKey = row.dataset.matchKey;
    const r = matchByKey.get(matchKey);
    const panel = row.querySelector(".accept-panel");
    const resultEl = panel.querySelector(".accept-result") || panel;
    btn.disabled = true; btn.textContent = "Building Tx-A…";
    try {
      // Reuse the already-resolved request if available.
      let req = matchResolvedRequest.get(matchKey) || null;
      if (!req) {
        const cur = await fetchJsonWithRetry(`${EXPLORER_API}/contracts/loans/requests?iaddr=${encodeURIComponent(r.request.iaddr)}&include_inactive=true&pageSize=10`, { useCacheFirst: true });
        if (cur) req = (cur.results || []).find((x) => !r.request.txid || x.posted_tx === r.request.txid) || (cur.results || [])[0];
      }
      if (!req) {
        const hist = await fetchJsonWithRetry(`${EXPLORER_API}/identity/events?type=loan.request&iAddress=${encodeURIComponent(r.request.iaddr)}&history=true&pageSize=20`, { useCacheFirst: true });
        const ev = (hist?.results || []).find((x) => !r.request.txid || x.chain?.txid === r.request.txid) || (hist?.results || [])[0];
        const p = ev?.entries?.[0]?.decoded;
        if (p) req = p;
      }
      if (!req) throw new Error("can't find linked request — terms unknown");
      const acting = actingIaddr();
      if (!acting || acting === "all") throw new Error("select your borrower identity in the picker first");
      // Resolve borrower R-address.
      const idInfo = await rpc("getidentity", [acting, -1]);
      const borrowerR = (idInfo?.identity?.primaryaddresses || [])[0];
      if (!borrowerR) throw new Error("borrower identity has no primary R-address");

      // Find a UTXO at borrower R that covers collateral + fee.
      const collCcy = req.collateral?.currency;
      const collAmt = parseFloat(req.collateral?.amount ?? 0);
      if (!collAmt) throw new Error("collateral amount missing in request");
      const FEE = 0.0001;
      const utxos = await rpc("getaddressutxos", [{ addresses: [borrowerR], currencynames: true }]);
      // For VRSC collateral, pick a P2PKH UTXO whose VRSC value >= collateral + fee.
      let chosenUtxo = null;
      if (collCcy === "VRSC" || collCcy === "i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV") {
        chosenUtxo = utxos
          .filter((u) => u.satoshis >= Math.round((collAmt + FEE) * 1e8))
          .sort((a, b) => a.satoshis - b.satoshis)[0];
        if (!chosenUtxo) throw new Error(`no VRSC UTXO at ${borrowerR} covers ${collAmt + FEE} VRSC`);
      } else {
        throw new Error(`borrower-side accept for ${collCcy} collateral not wired yet (only VRSC for now)`);
      }
      const inputSats = chosenUtxo.satoshis;
      const collSats = Math.round(collAmt * 1e8);
      const changeSats = inputSats - collSats - Math.round(FEE * 1e8);
      if (changeSats < 0) throw new Error(`UTXO ${chosenUtxo.txid}:${chosenUtxo.outputIndex} too small`);

      btn.textContent = "Extending pre-signed Tx-A…";
      const extendedHex = extendPresignedLoanTxA({
        presignedHex: r.tx_a_partial,
        borrowerInputTxid: chosenUtxo.txid,
        borrowerInputVout: chosenUtxo.outputIndex,
        vaultP2sh: r.vault_address,
        collateralSats: collSats,
        borrowerChangeAddr: borrowerR,
        borrowerChangeSats: changeSats,
      });

      btn.textContent = "Signing your input…";
      const signed = await rpc("signrawtransaction", [extendedHex]);
      if (!signed.complete) throw new Error("signing did not complete: " + JSON.stringify(signed.errors || {}));

      btn.textContent = "Broadcasting…";
      const txid = await rpc("sendrawtransaction", [signed.hex]);
      resultEl.innerHTML = `<div class="muted" style="color:var(--ok)">✓ Tx-A broadcast: <a href="https://scan.verus.cx/vrsc/tx/${escapeHtml(txid)}" target="_blank"><code>${escapeHtml(txid)}</code></a></div>`;
      btn.style.display = "none";
    } catch (e) {
      resultEl.innerHTML = `<div class="muted" style="color:var(--bad)">✗ ${escapeHtml(e.message)}</div>`;
      btn.disabled = false;
      btn.textContent = "Retry broadcast";
    }
    return;
  }

  if (action === "cancel") {
    const vdxfId = row.dataset.vdxf;
    const iaddr = row.dataset.iaddr;
    const name = row.dataset.name;
    const parent = row.dataset.parent;
    if (!confirm("Cancel this entry? This posts an updateidentity that drops it from the multimap.")) return;
    btn.disabled = true; btn.textContent = "Cancelling…";
    try {
      const info = await rpc("getidentity", [iaddr, -1]);
      const cm = info?.identity?.contentmultimap || {};
      // Best-effort: unlock any UTXOs reserved for the entries we're
      // about to drop. Releases the wallet's hold on principal/collateral
      // funding inputs that were locked at request/match-post time.
      for (const oldEntry of (cm[vdxfId] || [])) {
        await unlockEntryUtxos(vdxfId, oldEntry);
      }
      const newCm = {};
      for (const [k, v] of Object.entries(cm)) {
        if (k === vdxfId) continue;
        newCm[k] = (Array.isArray(v) ? v : [v]).map((entry) => {
          if (typeof entry === "string") return entry;
          return entry?.serializedhex || entry?.message || JSON.stringify(entry);
        });
      }
      const txid = await rpc("updateidentity", [{ name, parent, contentmultimap: newCm }]);
      btn.textContent = `✓ ${txid.slice(0, 10)}…`;
      setTimeout(() => { loadMarket(); loadIdentities(); }, 3000);
    } catch (e) {
      btn.disabled = false; btn.textContent = "Cancel";
      alert(`Cancel failed: ${e.message}`);
    }
    return;
  }
});

document.getElementById("market-refresh").onclick = async () => {
  // Hard refresh: invalidate the listidentities cache so any rotation, new ID,
  // or balance change is picked up. Then repopulate picker + reload tabs.
  cachedSpendableIds = [];
  pickerByR = new Map();
  invalidateMarketCache();
  await populateActingPicker();
  loadMarket();
};

// Decode a multimap entry payload and unlock any UTXOs the entry's
// pre-signed transactions reference (best-effort; failures are silent).
// Used when cancelling a loan.request or loan.match — the underlying
// principal/collateral funding inputs were lockunspent at post time and
// need to be released so the wallet can reuse them.
async function unlockEntryUtxos(vdxfId, entry) {
  try {
    const hex = typeof entry === "string" ? entry : (entry?.serializedhex || entry?.message || "");
    if (!hex) return;
    const payload = JSON.parse(new TextDecoder().decode(_hexToBytes(hex)));
    const VDXF_LOAN_REQUEST = "iFg76F9M8CV5xEg3L2NvCDBXufaxjUWhaW";
    const VDXF_LOAN_MATCH   = "i4G69W7e3UJRCinuP7TFBRnm3ZUiXzPkFt";
    const txHex = vdxfId === VDXF_LOAN_REQUEST ? payload.borrower_input_signed_hex
                : vdxfId === VDXF_LOAN_MATCH   ? payload.tx_a_full
                : null;
    if (!txHex) return;
    const decoded = await rpc("decoderawtransaction", [txHex]).catch(() => null);
    const vin = decoded?.vin?.[0];
    if (!vin?.txid || typeof vin.vout !== "number") return;
    await rpc("lockunspent", [true, [{ txid: vin.txid, vout: vin.vout }]]).catch(() => {});
  } catch (e) {
    console.warn("unlockEntryUtxos:", e?.message);
  }
}

// Cache spendable identities for the ID picker. Includes primaryR so we
// don't need a per-ID getidentity RPC for grouping.
let cachedSpendableIds = [];
async function ensureSpendableIds() {
  if (cachedSpendableIds.length > 0) return cachedSpendableIds;
  const ids = await rpc("listidentities", []);
  cachedSpendableIds = (ids || [])
    .filter((w) => w.canspendfor && w.cansignfor)
    .map((w) => ({
      iaddr: w.identity?.identityaddress,
      name: w.identity?.name,
      fqn: w.identity?.fullyqualifiedname || (w.identity?.name + "@"),
      parent: w.identity?.parent,
      primaryR: (w.identity?.primaryaddresses || [])[0] || null,
    }))
    .filter((x) => x.iaddr);
  return cachedSpendableIds;
}
const ensureSpendableIdsWithPrimaries = ensureSpendableIds;

async function balanceFor(iaddr) {
  // Check the i-address itself + the primary R-address (where partial-tx-flow funds live)
  try {
    const info = await rpc("getidentity", [iaddr, -1]);
    const primaryR = (info?.identity?.primaryaddresses || [])[0];
    const out = { iaddrBalance: {}, rBalance: {}, primaryR };
    const iaddrBal = await rpc("getaddressbalance", [{ addresses: [iaddr] }]);
    out.iaddrBalance = iaddrBal?.currencybalance || { VRSC: (iaddrBal?.balance ?? 0) / 1e8 };
    if (primaryR) {
      const rBal = await rpc("getaddressbalance", [{ addresses: [primaryR] }]);
      out.rBalance = rBal?.currencybalance || { VRSC: (rBal?.balance ?? 0) / 1e8 };
    }
    return out;
  } catch {
    return { iaddrBalance: {}, rBalance: {}, primaryR: null };
  }
}

function fmtBalances(bal, currencyMap = {}) {
  // bal is { currency_id_or_name: amount }. Map known IDs to names.
  const KNOWN_IDS = {
    "i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV": "VRSC",
    "iGBs4DWztRNvNEJBt4mqHszLxfKTNHTkhM": "DAI.vETH",
    "iCkKJuJScy4Z6NSDK7Mt42ZAB2NEnAE1o4": "vETH",
    "iJ3WZocnjG9ufv7GKUA4LijQno5gTMb7tP": "CHIPS",
    "iExBJfZYK7KREDpuhj6PzZBzqMAKaFg7d2": "vARRR",
    "iHog9UCTrn95qpUBFCZ7kKz7qWdMA8MQ6N": "vDEX",
  };
  const items = [];
  for (const [k, v] of Object.entries(bal || {})) {
    const name = KNOWN_IDS[k] || currencyMap[k] || k;
    if (parseFloat(v) > 0) items.push(`${parseFloat(v)} ${name}`);
  }
  return items.length ? items.join(" · ") : "—";
}

async function openMarketPostForm(kind, prefill) {
  const formEl = document.getElementById("mp-post-form");
  const ids = await ensureSpendableIds();
  if (ids.length === 0) {
    formEl.innerHTML = `<div class="card review bad">No spendable identities in this wallet.</div>`;
    formEl.style.display = "block";
    return;
  }
  const acting = actingIaddr();
  if (acting === "all") {
    formEl.innerHTML = `<div class="card review bad">Select a specific identity in "Acting as" before posting (currently "All identities").</div>`;
    formEl.style.display = "block";
    return;
  }
  const me = ids.find((x) => x.iaddr === acting);
  if (!me) {
    formEl.innerHTML = `<div class="card review bad">Selected identity isn't spendable in this wallet.</div>`;
    formEl.style.display = "block";
    return;
  }
  const inner = kind === "request" ? renderRequestFormBody() : renderOfferFormBody();
  formEl.innerHTML = `
    <div class="card post-box">
      <h3>${kind === "request" ? "Post a loan request" : "Post a loan offer"} from ${escapeHtml(me.fqn)}${prefill?.target_lender_label ? ` &rarr; ${escapeHtml(prefill.target_lender_label)}` : ""}</h3>
      <div id="mp-id-info" class="muted" style="font-size:12px;margin-bottom:10px">fetching balance…</div>
      ${inner}
    </div>
  `;
  formEl.style.display = "block";
  formEl.dataset.kind = kind;
  await renderActingInfo(me);

  // Apply prefill (e.g. clicked "Post request to this lender" on a
  // marketplace offer). Each field is a data-f attribute on an input/select.
  if (prefill) {
    const setVal = (selector, val) => {
      const el = formEl.querySelector(selector);
      if (el && val != null && val !== "") el.value = String(val);
    };
    setVal('[data-f="target_lender"]',       prefill.target_lender);
    setVal('[data-f="principal_amount"]',    prefill.principal_amount);
    setVal('[data-f="principal_currency"]',  prefill.principal_currency);
    setVal('[data-f="collateral_amount"]',   prefill.collateral_amount);
    setVal('[data-f="collateral_currency"]', prefill.collateral_currency);
    setVal('[data-f="repay_amount"]',        prefill.repay_amount);
    setVal('[data-f="term_days"]',           prefill.term_days);
    if (prefill.min_collateral_ratio != null) {
      formEl.dataset.minCollateralRatio = String(prefill.min_collateral_ratio);
    }
    formEl.scrollIntoView({ behavior: "smooth", block: "start" });
    runFormValidation(formEl);
  }
}

async function renderActingInfo(me) {
  const info = document.getElementById("mp-id-info");
  if (!info) return;
  const b = await balanceFor(me.iaddr);
  info.innerHTML = `
    i-address: <code>${escapeHtml(me.iaddr)}</code><br>
    primary R: <code>${escapeHtml(b.primaryR || "—")}</code><br>
    R-address balance: <span class="r-balance-line">${fmtBalances(b.rBalance)}</span><br>
    i-address balance: ${fmtBalances(b.iaddrBalance)}
    <div class="form-validation" style="margin-top:8px;font-size:12px;line-height:1.6"></div>
  `;
  info.dataset.iaddr = me.iaddr;
  info.dataset.name = me.name;
  info.dataset.parent = me.parent || "";
  info.dataset.rBalance  = JSON.stringify(b.rBalance || {});
  info.dataset.primaryR  = b.primaryR || "";
  // Run validation now + after every form input change.
  const formEl = document.getElementById("mp-post-form");
  if (formEl) {
    runFormValidation(formEl);
    formEl.addEventListener("input", () => runFormValidation(formEl));
    formEl.addEventListener("change", () => runFormValidation(formEl));
  }
}

// Map currency names → their canonical iaddr key in getaddressbalance results.
const CURRENCY_NAME_TO_IADDR = {
  "VRSC":     "i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV",
  "DAI.vETH": "iGBs4DWztRNvNEJBt4mqHszLxfKTNHTkhM",
  "vETH":     "iCkKJuJScy4Z6NSDK7Mt42ZAB2NEnAE1o4",
  "CHIPS":    "iJ3WZocnjG9ufv7GKUA4LijQno5gTMb7tP",
};
function _balanceForCurrency(rBalance, currencyName) {
  if (!rBalance) return 0;
  // rBalance keys are i-addresses; map back via CURRENCY_NAME_TO_IADDR.
  const iaddrKey = CURRENCY_NAME_TO_IADDR[currencyName];
  if (iaddrKey != null && rBalance[iaddrKey] != null) return parseFloat(rBalance[iaddrKey]);
  // Fallback: maybe the key is already the name.
  if (rBalance[currencyName] != null) return parseFloat(rBalance[currencyName]);
  return 0;
}

// Form validation runs on every input change. Three checks per form:
//  1. Borrower has enough of the COLLATERAL currency on their R-address
//     (collateralAmount + 0.0002 fee budget). Renders green / red inline.
//  2. If the form was opened from a marketplace lender offer (the offer's
//     `min_collateral_ratio` was prefilled), verify
//     collateralAmount / principalAmount ≥ min_ratio. Inline error if not.
//  3. Highlight the R-address balance line green/red so it's scannable.
function runFormValidation(formEl) {
  const out  = formEl.querySelector(".form-validation");
  const balLine = formEl.querySelector(".r-balance-line");
  if (!out) return;

  const principalAmt = parseFloat(formEl.querySelector('[data-f="principal_amount"]')?.value || "0");
  const collAmt      = parseFloat(formEl.querySelector('[data-f="collateral_amount"]')?.value || "0");
  const collCcy      = formEl.querySelector('[data-f="collateral_currency"]')?.value || "VRSC";
  const minRatio     = parseFloat(formEl.dataset.minCollateralRatio || "0");
  const info = document.getElementById("mp-id-info");
  let rBalance = {};
  try { rBalance = JSON.parse(info?.dataset?.rBalance || "{}"); } catch {}

  const have = _balanceForCurrency(rBalance, collCcy);
  const needCollateral = collAmt + 0.0002; // +fee budget for the auto-split
  const collOk = have >= needCollateral;

  const messages = [];
  // Check 1: balance for collateral
  messages.push(collOk
    ? `<span style="color:var(--ok)">✓ enough ${escapeHtml(collCcy)} on R for collateral</span> <span class="muted">(have ${have.toFixed(8)}, need ${needCollateral.toFixed(4)})</span>`
    : `<span style="color:var(--bad)">✗ insufficient ${escapeHtml(collCcy)} on R</span> <span class="muted">(have ${have.toFixed(8)}, need ${needCollateral.toFixed(4)})</span>`
  );
  // Check 2: collateral ratio (only if form was prefilled with an offer)
  if (minRatio > 0 && principalAmt > 0) {
    const ratio = collAmt / principalAmt;
    const ratioOk = ratio >= minRatio - 1e-9;
    messages.push(ratioOk
      ? `<span style="color:var(--ok)">✓ collateral ratio ${ratio.toFixed(2)}× ≥ lender's ${minRatio.toFixed(2)}×</span>`
      : `<span style="color:var(--bad)">✗ collateral ratio ${ratio.toFixed(2)}× &lt; lender's required ${minRatio.toFixed(2)}×</span>`
    );
  }
  out.innerHTML = messages.join("<br>");

  // Color the R-balance line based on the collateral check.
  if (balLine) balLine.style.color = collOk ? "var(--ok)" : "var(--bad)";

  // Disable Preview & sign on hard-fail (insufficient balance OR ratio under).
  const preview = formEl.querySelector('[data-mp-do="preview-request"]');
  const ratioFail = (minRatio > 0 && principalAmt > 0 && (collAmt / principalAmt) < minRatio - 1e-9);
  if (preview) {
    preview.disabled = !collOk || ratioFail;
    preview.title = !collOk ? "Insufficient collateral balance"
                  : ratioFail ? "Collateral ratio below lender's minimum"
                  : "";
  }
}

// Smart UTXO reuse: scan the wallet's locked UTXOs for one at borrowerR
// that matches the requested currency + amount AND isn't already
// referenced by an active loan.request (i.e. the original request was
// cancelled / dropped, leaving the lock orphaned). Returns
// { txid, vout, amount } or null. Eliminates stranded lockunspent
// reservations across cancel/repost cycles.
async function findReusableSplitUtxo(iaddr, borrowerR, currency, splitAmount) {
  const locked = await rpc("listlockunspent", []).catch(() => []);
  if (!Array.isArray(locked) || locked.length === 0) return null;

  // Build set of (txid:vout) pairs used by current active loan.requests.
  const inUse = new Set();
  const myInfo = await rpc("getidentity", [iaddr, -1]).catch(() => null);
  const myCm = myInfo?.identity?.contentmultimap || {};
  for (const k of VDXF_LOAN_REQUEST_KEYS) {
    for (const e of (myCm[k] || [])) {
      const payload = decodeMultimapEntry(e);
      const hex = payload?.borrower_input_signed_hex;
      if (!hex) continue;
      try {
        const dec = await rpc("decoderawtransaction", [hex]);
        const vin = dec?.vin?.[0];
        if (vin?.txid) inUse.add(`${vin.txid}:${vin.vout}`);
      } catch {}
    }
  }

  // Pull the live unspent set at borrowerR so we can confirm the locked
  // UTXO is still actually unspent. lockunspent state can lag reality —
  // a UTXO may have been consumed by a tx without the lock being cleared
  // (e.g. early termination of a flow), leaving a "stale" lock that
  // would otherwise be picked up here and crash signrawtransaction with
  // "Input not found or already spent."
  const liveUtxos = await rpc("getaddressutxos", [{ addresses: [borrowerR] }]).catch(() => []);
  const liveSet = new Set(liveUtxos.map((u) => `${u.txid}:${u.outputIndex}`));

  for (const u of locked) {
    const key = `${u.txid}:${u.vout}`;
    if (inUse.has(key)) continue; // still bound to a live request
    if (!liveSet.has(key)) {
      // Stale lock — UTXO has been spent on chain. Best-effort unlock so
      // we don't keep tripping over this entry on every preview.
      await rpc("lockunspent", [true, [{ txid: u.txid, vout: u.vout }]]).catch(() => {});
      continue;
    }
    const tx = await rpc("getrawtransaction", [u.txid, 1]).catch(() => null);
    const out = tx?.vout?.[u.vout];
    if (!out) continue;
    const addrs = out.scriptPubKey?.addresses || [];
    if (!addrs.includes(borrowerR)) continue;
    const cv = out.scriptPubKey?.reserveoutput?.currencyvalues || {};
    const cvKeys = Object.keys(cv);
    if (currency === "VRSC") {
      if (cvKeys.length === 0 && Math.abs((out.value || 0) - splitAmount) < 1e-7) {
        return { txid: u.txid, vout: u.vout, amount: out.value };
      }
    } else {
      // Non-native: single-currency UTXO with no bundled VRSC.
      const expectedKeys = [currency, CURRENCY_NAME_TO_IADDR[currency]].filter(Boolean);
      if ((out.valueSat ?? Math.round(out.value * 1e8)) === 0 && cvKeys.length === 1 && expectedKeys.includes(cvKeys[0])) {
        const amt = parseFloat(Object.values(cv)[0]);
        if (Math.abs(amt - splitAmount) < 1e-7) return { txid: u.txid, vout: u.vout, amount: amt };
      }
    }
  }
  return null;
}

function renderRequestFormBody() {
  return `
    <div class="row">
      <label style="flex:1">Lender (their VerusID iaddr or name@)<input type="text" data-f="target_lender" placeholder="i7A9fa8c3xZnA3uLK3SLYa58cUipganewg" /></label>
    </div>
    <div class="muted lender-resolve" style="font-size:11px;margin-top:-4px">Paste the lender's VerusID. We'll resolve their pubkey and derive the vault address from it.</div>
    <div class="row">
      <label style="flex:1">Borrow amount<input type="number" data-f="principal_amount" value="5" step="0.01" /></label>
      <label style="flex:1">Currency<select data-f="principal_currency">${currencyOptions("VRSC")}</select></label>
    </div>
    <div class="row">
      <label style="flex:1">Collateral amount<input type="number" data-f="collateral_amount" value="10" step="0.01" /></label>
      <label style="flex:1">Currency<select data-f="collateral_currency">${currencyOptions("VRSC")}</select></label>
    </div>
    <div class="muted" style="font-size:11px;margin-top:-4px">When you click Preview &amp; sign, the GUI auto-splits a fresh single-currency UTXO from your wallet for the collateral commitment. ~0.0001 VRSC fee.</div>
    <div class="row">
      <label style="flex:1">Repay amount<input type="number" data-f="repay_amount" value="5.05" step="0.01" /></label>
      <label style="flex:1">Term (days)<input type="number" data-f="term_days" value="30" /></label>
    </div>
    <div class="muted" style="font-size:11px;margin-top:4px">Repay is paid in the same currency as the loan.</div>
    <div class="row" style="margin-top:6px">
      <label style="display:flex;gap:8px;align-items:center;cursor:pointer;font-size:12px">
        <input type="checkbox" data-f="auto_accept" ${localStorage.getItem("vl_auto_accept") === "0" ? "" : "checked"} />
        <span>Auto-confirm if the lender's match honors these exact terms</span>
      </label>
    </div>
    <div class="muted" style="font-size:11px;margin-top:-2px;margin-left:24px">When the lender posts a match: if the 7-check safety verification passes (recipients/amounts/maturity/vault all match this request), Tx-A is broadcast automatically — no second click needed. If anything is off, the match shows in Inbox for manual review.</div>
    <div class="row" style="margin-top:8px;gap:8px">
      <button class="primary" data-mp-do="preview-request" style="flex:0 0 auto">Preview &amp; sign</button>
      <button class="ghost"   data-mp-do="cancel" style="flex:0 0 auto">Cancel</button>
    </div>
    <div class="preview" style="display:none;margin-top:12px"></div>
  `;
}

// Populate the collateral UTXO dropdown for the borrower's "Post request"
// form. Filtered to UTXOs at the borrower's R-address that hold the chosen
// collateral currency in sufficient quantity.
async function populateCollateralUtxoPicker(formEl, rAddr, collateralCurrency, collateralAmount) {
  const sel = formEl.querySelector('[data-f="collateral_utxo"]');
  if (!sel) return;
  sel.innerHTML = '<option value="">— loading…</option>';
  try {
    const utxos = await rpc("getaddressutxos", [{ addresses: [rAddr], currencynames: true }]);
    // Resolve the currency name → iaddr lookup so we can match either form.
    const ccyIaddr = await rpc("getcurrency", [collateralCurrency]).then((c) => c?.currencyid).catch(() => null);
    const minSats = Math.round((collateralAmount + 0.0001) * 1e8);
    const usable = utxos.filter((u) => {
      if (collateralCurrency === "VRSC") {
        // Pure VRSC UTXO (P2PKH with no currencyvalues, or zero-VRSC sats with empty cv).
        return u.satoshis >= minSats && (!u.currencyvalues || Object.keys(u.currencyvalues).length === 0);
      }
      // Non-native: SINGLE-currency UTXO with no bundled VRSC (sats=0) and exactly one cv entry.
      // A multi-currency UTXO would dump its non-collateral currencies as Tx-A "fee".
      const cv = u.currencyvalues || {};
      const keys = Object.keys(cv);
      if (u.satoshis !== 0 || keys.length !== 1) return false;
      const key = keys[0];
      if (key !== collateralCurrency && key !== ccyIaddr) return false;
      return parseFloat(cv[key]) >= collateralAmount;
    });
    if (usable.length === 0) {
      sel.innerHTML = `<option value="">no ${escapeHtml(collateralCurrency)} UTXO at ${escapeHtml(rAddr)} ≥ ${collateralAmount} (+fee)</option>`;
      return;
    }
    // Sort smallest-first so the UI nudges users to commit the smallest
    // sufficient UTXO. Avoids accidentally locking 1000 VRSC for a 10 VRSC
    // collateral commitment.
    const utxoAmount = (u) => collateralCurrency === "VRSC"
      ? u.satoshis / 1e8
      : parseFloat(u.currencyvalues?.[collateralCurrency] ?? u.currencyvalues?.[ccyIaddr] ?? 0);
    usable.sort((a, b) => utxoAmount(a) - utxoAmount(b));
    sel.innerHTML = usable.map((u, i) => {
      const amt = utxoAmount(u);
      const overcommit = amt > collateralAmount * 5 ? " ⚠ much larger than needed" : "";
      const badge = i === 0 ? " ✓ best fit" : "";
      return `<option value="${escapeHtml(u.txid)}:${u.outputIndex}">${escapeHtml(u.txid.slice(0, 16))}…:${u.outputIndex} (${amt.toFixed(8)} ${escapeHtml(collateralCurrency)})${badge}${overcommit}</option>`;
    }).join("");
  } catch (e) {
    sel.innerHTML = `<option value="">error: ${escapeHtml(e.message)}</option>`;
  }
}

function renderOfferFormBody() {
  return `
    <div class="row">
      <label style="flex:1">Max principal<input type="number" data-f="max_principal_amount" value="100" step="0.01" /></label>
      <label style="flex:1">Currency<select data-f="max_principal_currency">${currencyOptions("VRSC")}</select></label>
    </div>
    <div>
      <label>Accepted collateral (click to toggle)</label>
      <div class="collateral-toggle" data-f="accepted_collateral">
        ${CURRENCIES.map((c) => `<button type="button" class="ctog ${c === "VRSC" || c === "DAI.vETH" ? "selected" : ""}" data-cur="${c}">${c}</button>`).join("")}
      </div>
    </div>
    <div class="row" style="margin-top:8px">
      <label style="flex:1">Min collateral ratio<input type="number" data-f="min_ratio" value="2" step="0.1" /></label>
      <label style="flex:1">Rate (decimal)<input type="number" data-f="rate" value="0.01" step="0.001" /></label>
    </div>
    <div class="row"><label style="flex:1">Term (days)<input type="number" data-f="term_days" value="30" /></label></div>
    <div class="row" style="margin-top:8px;gap:8px">
      <button class="primary" data-mp-do="preview-offer" style="flex:0 0 auto">Preview</button>
      <button class="ghost"   data-mp-do="cancel" style="flex:0 0 auto">Cancel</button>
    </div>
    <div class="preview" style="display:none;margin-top:12px"></div>
  `;
}

document.getElementById("mp-post-request").onclick = () => openMarketPostForm("request");
document.getElementById("mp-post-offer").onclick   = () => openMarketPostForm("offer");

// Handle preview / cancel / broadcast / collateral toggle inside the marketplace form
document.getElementById("mp-post-form").addEventListener("click", async (ev) => {
  const tog = ev.target.closest(".ctog");
  if (tog) { tog.classList.toggle("selected"); return; }

  const btn = ev.target.closest("[data-mp-do]");
  if (!btn) return;
  const formEl = document.getElementById("mp-post-form");
  const idInfo = document.getElementById("mp-id-info");
  const previewEl = formEl.querySelector(".preview");
  const f = (k) => formEl.querySelector(`[data-f="${k}"]`)?.value;
  const action = btn.dataset.mpDo;

  if (action === "cancel") { formEl.style.display = "none"; formEl.innerHTML = ""; return; }

  if (action === "broadcast") {
    const resEl = previewEl.querySelector(".result");
    const updateArg = pendingMarketBroadcast;
    if (!updateArg) { resEl.innerHTML = `<span class="err">no pending broadcast</span>`; return; }
    resEl.innerHTML = `<span class="muted">Broadcasting…</span>`;
    try {
      const txid = await rpc("updateidentity", [updateArg]);
      resEl.innerHTML = `<span class="ok">✓ Broadcast: <code>${escapeHtml(txid)}</code></span> <span class="muted">— closing in a moment, refreshing marketplace…</span>`;
      pendingMarketBroadcast = null;
      // Invalidate so the next loadMarket re-fetches and surfaces the new post.
      invalidateMarketCache();
      // Auto-dismiss the form so the user isn't left staring at the preview.
      setTimeout(() => {
        formEl.style.display = "none";
        formEl.innerHTML = "";
      }, 2500);
      setTimeout(() => { loadIdentities(); loadMarket(); }, 3000);
    } catch (e) {
      resEl.innerHTML = `<span class="err">✗ ${escapeHtml(e.message)}</span>`;
    }
    return;
  }

  // Preview path — build payload + the updateidentity command
  const iaddr = idInfo.dataset.iaddr;
  const name = idInfo.dataset.name;
  const parent = idInfo.dataset.parent;
  console.log(`[preview] action=${action} iaddr=${iaddr || '(EMPTY)'} name=${name} parent=${parent}`);
  if (!iaddr) { console.warn(`[preview] EARLY RETURN: idInfo.dataset.iaddr is empty`); return; }

  let slug, vdxfId, payload;
  if (action === "preview-request") {
    console.log(`[preview] entered. iaddr=${iaddr} name=${name} parent=${parent}`);
    slug = "loan.request";
    vdxfId = "iFg76F9M8CV5xEg3L2NvCDBXufaxjUWhaW";
    const principalCurrency = f("principal_currency");
    const collateralCurrency = f("collateral_currency");
    const principalAmount = parseFloat(f("principal_amount"));
    const collateralAmount = parseFloat(f("collateral_amount"));
    const repayAmount = parseFloat(f("repay_amount"));
    const termDays = parseInt(f("term_days"), 10);

    // 1. Resolve target lender — accept iaddr or name@; resolve to iaddr + R + pubkey
    const lenderInput = (f("target_lender") || "").trim();
    if (!lenderInput) {
      previewEl.innerHTML = `<div class="review" style="color:var(--bad)">✗ Enter the target lender's VerusID before previewing.</div>`;
      previewEl.style.display = "block";
      return;
    }
    let lenderInfo = null;
    try { lenderInfo = await rpc("getidentity", [lenderInput, -1]); } catch {}
    if (!lenderInfo?.identity) {
      previewEl.innerHTML = `<div class="review" style="color:var(--bad)">✗ Could not resolve lender VerusID "${escapeHtml(lenderInput)}".</div>`;
      previewEl.style.display = "block";
      return;
    }
    const lenderIaddr = lenderInfo.identity.identityaddress || lenderInfo.identity.iaddr;
    const lenderR = (lenderInfo.identity.primaryaddresses || [])[0];
    if (!lenderR) {
      previewEl.innerHTML = `<div class="review" style="color:var(--bad)">✗ Lender ${escapeHtml(lenderInput)} has no primary R-address.</div>`;
      previewEl.style.display = "block";
      return;
    }
    let lenderPubkey = null;
    try { lenderPubkey = await getPubkeyForRAddress(lenderR); } catch {}
    if (!lenderPubkey) {
      previewEl.innerHTML = `<div class="review" style="color:var(--bad)">✗ Could not resolve lender pubkey from ${escapeHtml(lenderR)} (need a prior tx signed by them).</div>`;
      previewEl.style.display = "block";
      return;
    }

    // 2. Resolve borrower's pubkey + R-address
    const borrowerR = (await balanceFor(iaddr)).primaryR;
    let borrowerPubkey = null;
    try { borrowerPubkey = await getPubkeyForRAddress(borrowerR); } catch {}
    if (!borrowerPubkey) {
      previewEl.innerHTML = `<div class="review" style="color:var(--bad)">✗ Could not resolve borrower pubkey from ${escapeHtml(borrowerR || "primary R")} — sign any tx from this address first.</div>`;
      previewEl.style.display = "block";
      return;
    }

    // 3. Auto-split a fresh clean collateral UTXO via sendcurrency
    //    (collateral + 0.0001 fee budget on borrower's R), OR — if a
    //    locked UTXO from a previously-cancelled request happens to
    //    match the same currency + amount — reuse it. Reuse keeps cancel
    //    + repost cycles from leaving stranded lockunspent reservations.
    const splitAmount = collateralAmount + 0.0001;
    let borrowerInputTxid, borrowerInputVout = -1;
    const reusable = await findReusableSplitUtxo(iaddr, borrowerR, collateralCurrency, splitAmount).catch(() => null);
    if (reusable) {
      previewEl.innerHTML = `<div class="review muted">Reusing locked ${collateralCurrency} UTXO from a cancelled request: <code>${escapeHtml(reusable.txid.slice(0,16))}…:${reusable.vout}</code></div>`;
      previewEl.style.display = "block";
      borrowerInputTxid = reusable.txid;
      borrowerInputVout = reusable.vout;
    } else {
      previewEl.innerHTML = `<div class="review muted">Splitting a fresh ${collateralCurrency} UTXO via sendcurrency…</div>`;
      previewEl.style.display = "block";
      let splitTxid;
      try {
        const out = collateralCurrency === "VRSC"
          ? [{ address: borrowerR, amount: splitAmount }]
          : [{ currency: collateralCurrency, amount: splitAmount, address: borrowerR }];
        const opid = await rpc("sendcurrency", [borrowerR, out]);
        for (let i = 0; i < 30 && !splitTxid; i++) {
          await new Promise((res) => setTimeout(res, 2000));
          const r = await rpc("z_getoperationresult", [[opid]]);
          const op = (r || [])[0];
          if (op?.status === "success") splitTxid = op.result?.txid;
          if (op?.status === "failed") throw new Error("split sendcurrency failed: " + JSON.stringify(op.error || {}));
        }
        if (!splitTxid) throw new Error("split sendcurrency timed out");
      } catch (e) {
        previewEl.innerHTML = `<div class="review" style="color:var(--bad)">✗ collateral split failed: ${escapeHtml(e.message)}</div>`;
        return;
      }
      // Locate the new clean UTXO in the split tx (mempool view).
      const splitTx = await rpc("getrawtransaction", [splitTxid, 1]);
      for (let i = 0; i < (splitTx?.vout || []).length; i++) {
        const o = splitTx.vout[i];
        const spk = o?.scriptPubKey || {};
        const addrs = spk.addresses || [];
        if (!addrs.includes(borrowerR)) continue;
        const cv = spk.reserveoutput?.currencyvalues || {};
        const cvKeys = Object.keys(cv);
        if (collateralCurrency === "VRSC") {
          if (cvKeys.length === 0 && Math.abs((o.value || 0) - splitAmount) < 1e-8) { borrowerInputVout = i; break; }
        } else {
          if (o.valueSat === 0 && cvKeys.length === 1 && Math.abs(parseFloat(Object.values(cv)[0]) - splitAmount) < 1e-8) { borrowerInputVout = i; break; }
        }
      }
      if (borrowerInputVout < 0) {
        previewEl.innerHTML = `<div class="review" style="color:var(--bad)">✗ split tx didn't produce a clean ${escapeHtml(collateralCurrency)} output</div>`;
        return;
      }
      borrowerInputTxid = splitTxid;
      // Reserve the freshly-split UTXO via lockunspent so no other wallet
      // operation accidentally consumes it before Tx-A broadcasts. Lock
      // is in-memory; on request cancel we unlock, on Tx-A broadcast it's
      // spent naturally. (Reused UTXOs are already locked from their
      // original split — no second lock needed.)
      try {
        await rpc("lockunspent", [false, [{ txid: borrowerInputTxid, vout: borrowerInputVout }]]);
      } catch (e) {
        console.warn("lockunspent failed (non-fatal):", e?.message);
      }
    }

    // 4. Compute vault P2SH from both pubkeys (same vault for the same
    //    [borrower_R, lender_R] pair across loans — UTXOs are still
    //    differentiated by Tx-A's txid:vout, so cross-loan replay isn't
    //    possible. v4 per-loan-tweaked-vault was rolled back: the
    //    address-reuse cost is cosmetic and the complexity wasn't worth
    //    it. tweaked-key.js stays in the tree for potential future use.)
    let vault;
    try {
      vault = await rpc("createmultisig", [2, [lenderPubkey, borrowerPubkey]]);
    } catch (e) {
      previewEl.innerHTML = `<div class="review" style="color:var(--bad)">✗ Vault derivation failed: ${escapeHtml(e.message)}</div>`;
      previewEl.style.display = "block";
      return;
    }

    // 5. Build Tx-A skeleton (1 input, 3 outputs) and sign borrower's input.
    //    With SIGHASH_ALL|ANYONECANPAY the lender can later add their input
    //    without invalidating the borrower's signature.
    let signedHex;
    try {
      signedHex = await buildAndSignBorrowerTxA({
        borrowerInputTxid,
        borrowerInputVout,
        borrowerR,
        principalCurrency,
        principalAmount,
        collateralCurrency,
        collateralAmount,
        vaultP2sh: vault.address,
        utxoAmount: splitAmount,  // we just split this exact amount — skip the lookup
      });
    } catch (e) {
      previewEl.innerHTML = `<div class="review" style="color:var(--bad)">✗ Tx-A build/sign failed: ${escapeHtml(e.message)}</div>`;
      previewEl.style.display = "block";
      return;
    }

    // Read auto-accept preference and persist for next time
    const autoAcceptCheckbox = formEl.querySelector('[data-f="auto_accept"]');
    const autoAccept = !!(autoAcceptCheckbox && autoAcceptCheckbox.checked);
    try { localStorage.setItem("vl_auto_accept", autoAccept ? "1" : "0"); } catch {}

    payload = {
      version: 3,
      principal:  { currency: principalCurrency,  amount: principalAmount  },
      collateral: { currency: collateralCurrency, amount: collateralAmount },
      repay:      { currency: principalCurrency,  amount: repayAmount      },
      term_days:  termDays,
      target_lender_iaddr:        lenderIaddr,
      borrower_input_signed_hex:  signedHex,
      // v3: auto_accept flag tells the borrower's GUI (this device or any
      // other one logged into this iaddr) to auto-broadcast Tx-A when a
      // match arrives that passes verifyMatchSafety against this request.
      auto_accept: autoAccept,
      active:     true,
    };
  } else if (action === "preview-offer") {
    slug = "loan.offer";
    vdxfId = "iA1vgVBV5B29h5pxQ67gxqCoEaLDZ8WbmY";
    const collateralBtns = formEl.querySelectorAll(".collateral-toggle .ctog.selected");
    payload = {
      version: 1,
      max_principal:        { currency: f("max_principal_currency"), amount: parseFloat(f("max_principal_amount")) },
      accepted_collateral:  Array.from(collateralBtns).map((b) => b.dataset.cur),
      min_collateral_ratio: parseFloat(f("min_ratio")),
      rate:                 parseFloat(f("rate")),
      term_days:            parseInt(f("term_days"), 10),
      active:               true,
    };
  } else {
    return;
  }

  // Merge with existing entries
  let existing = {};
  try { existing = (await rpc("getidentity", [iaddr, -1]))?.identity?.contentmultimap || {}; } catch {}
  const json = JSON.stringify(payload);
  const hex  = Array.from(new TextEncoder().encode(json)).map((b) => b.toString(16).padStart(2, "0")).join("");
  const newCm = { ...existing, [vdxfId]: [hex] };
  for (const [k, v] of Object.entries(newCm)) {
    if (k === vdxfId) continue;
    newCm[k] = (Array.isArray(v) ? v : [v]).map((entry) => {
      if (typeof entry === "string") return entry;
      return entry?.serializedhex || entry?.message || JSON.stringify(entry);
    });
  }
  const updateArg = { name, parent, contentmultimap: newCm };
  pendingMarketBroadcast = updateArg;
  const cmd = `verus updateidentity '${JSON.stringify(updateArg)}'`;

  previewEl.innerHTML = `
    <div class="review">
      <strong>Decoded payload (${slug})</strong>
      <pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>
      <strong>Hex-encoded entry</strong>
      <div style="font-family:monospace;font-size:11px;word-break:break-all;background:#0e1116;padding:8px;border:1px solid #30363d;border-radius:4px">${escapeHtml(hex)}</div>
      <strong>Equivalent CLI command</strong>
      <pre style="font-size:11px;white-space:pre-wrap;word-break:break-all">${escapeHtml(cmd)}</pre>
      <div class="row" style="margin-top:10px;gap:8px">
        <button class="primary" data-mp-do="broadcast" style="flex:0 0 auto">Broadcast</button>
        <button class="ghost" data-mp-do="cancel" style="flex:0 0 auto">Cancel</button>
      </div>
      <div class="result" style="margin-top:8px"></div>
    </div>
  `;
  previewEl.style.display = "block";
});
let pendingMarketBroadcast = null;

// ---------- Active loans ----------

// Walk an identity's contentMultimap directly via local daemon to surface
// active loans where this iaddr is borrower OR lender. Authoritative when
// reachable; throws if any RPC fails so the caller can fall back to the
// explorer API.
async function fetchActiveLoansFromDaemon(actingIa) {
  if (!actingIa || actingIa === "all") return [];
  const VDXF_LOAN_REQUEST = "iFg76F9M8CV5xEg3L2NvCDBXufaxjUWhaW";
  const VDXF_LOAN_MATCH   = "i4G69W7e3UJRCinuP7TFBRnm3ZUiXzPkFt";
  const VDXF_LOAN_STATUS  = "iPnrakyY951QEy6xUYBuJoobHA9JKY6G8j";
  const VDXF_LOAN_HISTORY = "iBGuPDeeHHYpvKdM7VG2d7LR1Lct9itcpT";

  const decode = (e) => {
    const hex = typeof e === "string" ? e : (e?.serializedhex || e?.message || "");
    if (!hex) return null;
    try { return JSON.parse(new TextDecoder().decode(_hexToBytes(hex))); }
    catch { return null; }
  };
  const isStillActive = (status, history) =>
    !history && status && status.active !== false && status.settled !== true;

  const info = await rpc("getidentity", [actingIa, -1]);
  const cm = info?.identity?.contentmultimap || {};

  const out = [];
  const seen = new Set();

  // Borrower path: my own loan.status entries (status is posted on the
  // borrower's identity at acceptance). loan.history (also posted on
  // borrower) terminates the loan.
  const myStatuses  = (cm[VDXF_LOAN_STATUS]  || []).map(decode).filter(Boolean);
  const myHistories = (cm[VDXF_LOAN_HISTORY] || []).map(decode).filter(Boolean);
  const histByLoanId = new Map(myHistories.filter((h) => h.loan_id).map((h) => [h.loan_id, h]));
  for (const s of myStatuses) {
    if (!s.loan_id || s.role !== "borrower") continue;
    if (!isStillActive(s, histByLoanId.get(s.loan_id))) continue;
    if (seen.has(s.loan_id)) continue;
    seen.add(s.loan_id);
    out.push({
      loan_id:        s.loan_id,
      tx_a_txid:      s.loan_id,
      fullyQualifiedName: info.identity.fullyqualifiedname || "",
      name:           info.identity.name || "",
      role:           "borrower",
      counterparty_iaddr: s.match_iaddr,
      vault_address:  s.vault_address,
      principal:      s.principal,
      collateral:     s.collateral,
      repay:          s.repay,
      maturity_block: s.maturity_block,
    });
  }

  // Lender path: my loan.match entries → pull borrower's loan.status to
  // confirm origination + active state. If borrower hasn't broadcast Tx-A
  // yet (no loan.status), surface as 'matched' with a "waiting for borrower"
  // indicator so the lender sees their pending commitment immediately
  // after posting the match instead of an empty Active tab.
  const myMatches = (cm[VDXF_LOAN_MATCH] || []).map(decode).filter(Boolean);
  for (const m of myMatches) {
    const txAtxid = m.tx_a_txid;
    const borrowerIa = m.request?.iaddr;
    if (!txAtxid || !borrowerIa) continue;
    if (seen.has(txAtxid)) continue;
    if (m.active === false) continue; // lender cancelled this match

    const bInfo = await rpc("getidentity", [borrowerIa, -1]).catch(() => null);
    const bcm = bInfo?.identity?.contentmultimap || {};
    let bStatus = null, bHistory = null;
    for (const e of (bcm[VDXF_LOAN_STATUS] || [])) {
      const j = decode(e);
      if (j?.loan_id === txAtxid) { bStatus = j; break; }
    }
    for (const e of (bcm[VDXF_LOAN_HISTORY] || [])) {
      const j = decode(e);
      if (j?.loan_id === txAtxid) { bHistory = j; break; }
    }
    // Past terminal state — skip (already in History).
    if (bHistory) continue;
    // Past 'active' (settled flag flipped) — skip.
    if (bStatus && (bStatus.active === false || bStatus.settled === true)) continue;
    seen.add(txAtxid);
    const isMatched = !bStatus; // borrower hasn't broadcast Tx-A yet
    out.push({
      loan_id:        txAtxid,
      tx_a_txid:      txAtxid,
      fullyQualifiedName: info.identity.fullyqualifiedname || "",
      name:           info.identity.name || "",
      role:           "lender",
      state:          isMatched ? "matched" : "active",
      counterparty_iaddr: borrowerIa,
      vault_address:  bStatus?.vault_address || m.vault_address,
      principal:      bStatus?.principal     || m.principal,
      collateral:     bStatus?.collateral    || m.collateral,
      repay:          bStatus?.repay         || m.repay,
      maturity_block: bStatus?.maturity_block || m.maturity_block,
    });
  }

  return out;
}

async function loadLoans(targetEl) {
  // Render into the Active sub-tab of the Loans section by default; the
  // legacy top-level "Active loans" section is gone but callers can still
  // pass a different el if needed.
  const el = targetEl || document.getElementById("market-list") || document.getElementById("loans-list");
  if (!el) return;
  el.textContent = "Loading…";
  const myIaddrs = await inScopeIaddrs();
  if (myIaddrs.length === 0) {
    el.innerHTML = `<div class="empty">No local identities to query.</div>`;
    return;
  }

  // Source 1: walk our own identity's contentMultimap via local daemon to
  // build the active-loans view. Catches both sides:
  //   - borrower role: my loan.status entries directly (filter active)
  //   - lender   role: my loan.match entries → fetch borrower's loan.status
  //                    to confirm Tx-A originated and not yet settled
  // Falls back to /by-party explorer API only if any RPC throws — daemon
  // is the authoritative source when reachable.
  const acting = actingIaddr();
  const partyAddrs = (acting && acting !== "all") ? [acting] : myIaddrs;
  let explorerLoans;
  try {
    explorerLoans = (await Promise.all(partyAddrs.map(fetchActiveLoansFromDaemon))).flat();
  } catch (e) {
    console.warn("[active] daemon walk failed, falling back to API:", e?.message);
    explorerLoans = (await Promise.all(
      partyAddrs.map((ia) =>
        fetchLoansByParty(ia, 'active')
          .then((j) => (j.results || []).map((row) => {
            const isBorrower = ia === row.borrower_iaddr;
            return {
              loan_id:        row.loan_id,
              tx_a_txid:      row.loan_id,
              fullyQualifiedName: '',
              name:           '',
              role:           isBorrower ? 'borrower' : 'lender',
              counterparty_iaddr: isBorrower ? row.lender_iaddr : row.borrower_iaddr,
              vault_address:  row.vault_address,
              principal:      row.principal,
              collateral:     row.collateral,
              repay:          row.repay,
              maturity_block: row.maturity_block,
            };
          }))
          .catch(() => [])
      )
    )).flat();
  }

  // Source 2: borrower-side localStorage. Every accept-v2 stashes Tx-Repay
  // under `vl_tx_repay_<txAtxid>`. Parse loan.status entries on each
  // local identity to pair them with on-chain context (loan_id, vault, etc.).
  const localLoans = [];
  for (const ia of myIaddrs) {
    let info;
    try { info = await rpc("getidentity", [ia, -1]); } catch { continue; }
    const cm = info?.identity?.contentmultimap || {};
    const VDXF_LOAN_STATUS = "iPnrakyY951QEy6xUYBuJoobHA9JKY6G8j";
    for (const e of (cm[VDXF_LOAN_STATUS] || [])) {
      const hex = typeof e === "string" ? e : (e?.serializedhex || e?.message || "");
      if (!hex) continue;
      try {
        const json = JSON.parse(new TextDecoder().decode(_hexToBytes(hex)));
        if (!json?.active || json?.role !== "borrower" || !json?.loan_id) continue;
        const txRepayHex = localStorage.getItem(`vl_tx_repay_${json.loan_id}`);
        if (!txRepayHex) continue;
        localLoans.push({
          fullyQualifiedName: info.identity.fullyqualifiedname,
          name: info.identity.name,
          role: "borrower",
          counterparty_iaddr: json.match_iaddr,
          vault_address: json.vault_address,
          vault_redeem_script: json.vault_redeem_script,
          principal: json.principal,
          collateral: json.collateral,
          repay: json.repay,
          maturity_block: json.maturity_block,
          loan_id: json.loan_id,
          tx_a_txid: json.loan_id,
          tx_repay_local: true,
        });
      } catch {}
    }
  }

  // De-dupe by loan_id (explorer + local may overlap)
  const byId = new Map();
  for (const r of explorerLoans) byId.set(r.loan_id || r.tx_a_txid, r);
  for (const r of localLoans) {
    const existing = byId.get(r.loan_id);
    byId.set(r.loan_id, existing ? { ...existing, ...r } : r);
  }
  const flat = Array.from(byId.values());

  // Update the Active count badge while we know the answer
  const _ctActive = document.getElementById("ct-active");
  if (_ctActive) _ctActive.textContent = String(flat.length);

  if (flat.length === 0) {
    const acting = actingIaddr();
    // Don't wipe the list if a repay/claim op is mid-flight (the empty
    // state would clobber the active card and detach .repay-result).
    if (el.querySelector('.mp-row[data-op-active="1"]')) return;
    el.innerHTML = `<div class="empty">No active loans${acting !== "all" ? " for this identity" : " on any local identity"}.</div>`;
    return;
  }
  // Skip wholesale re-render if any card has an active op panel open —
  // otherwise the repay handler ends up writing to a detached node.
  if (el.querySelector('.mp-row[data-op-active="1"]')) return;
  // Tip height drives the Claim collateral lockout — lender can only
  // sweep the vault via Tx-B once tipHeight ≥ maturity_block.
  const tipHeight = await rpc("getblockcount", []).catch(() => 0);
  el.innerHTML = flat.map((r) => renderActiveLoan(r, tipHeight)).join("");
  enrichActiveLoanBalances();
}

function renderActiveLoan(r, tipHeight) {
  const hasRepay = r.role === "borrower" && r.tx_repay_local;
  const isMatched = r.state === "matched";
  // Lender's collateral-claim window: only after maturity_block has been
  // reached. Before that, Tx-B's nLockTime won't be valid yet — the
  // network would reject it. Show the countdown instead of a dead button.
  const tip = tipHeight || 0;
  const maturity = r.maturity_block || 0;
  const blocksToMaturity = maturity - tip;
  const isLender = r.role === "lender";
  const claimable = isLender && maturity > 0 && tip >= maturity;
  const minutesPerBlock = 1; // Verus ~60s blocks
  const eta = blocksToMaturity > 0
    ? `~${Math.round(blocksToMaturity * minutesPerBlock / 1440 * 10) / 10} days`
    : null;
  return `
    <div class="card mp-row" data-loan-id="${escapeHtml(r.loan_id || r.tx_a_txid || "")}" data-repay-currency="${escapeHtml(r.repay?.currency || "")}" data-repay-amount="${escapeHtml(r.repay?.amount ?? "")}">
      <div class="row">
        <strong style="flex:1">${escapeHtml(r.fullyQualifiedName || r.name + "@")}</strong>
        ${isMatched
          ? `<span class="badge" style="background:rgba(255,193,7,0.15);color:#e6b800">waiting for borrower</span>`
          : `<span class="badge ${r.role}">${escapeHtml(r.role)}</span>`}
      </div>
      <div class="kv">
        <div><span class="k">counterparty</span><span class="v">${escapeHtml(r.counterparty_iaddr || "—")}</span></div>
        <div><span class="k">vault</span><span class="v">${escapeHtml(r.vault_address || "—")}</span></div>
        <div><span class="k">principal</span><span class="v">${formatAmount(r.principal)}</span></div>
        <div><span class="k">collateral</span><span class="v">${formatAmount(r.collateral)}</span></div>
        <div><span class="k">repay</span><span class="v">${formatAmount(r.repay)}</span></div>
        ${!isMatched ? `<div><span class="k">your balance</span><span class="v repay-balance muted">checking…</span></div>` : ""}
        <div><span class="k">maturity</span><span class="v">${isMatched ? "—" : `block ${r.maturity_block ?? "?"}${eta ? ` <span class="muted">· ${blocksToMaturity} blocks (${eta}) to go</span>` : (claimable ? ` <span style="color:var(--ok)">· reached</span>` : "")}`}</span></div>
        <div><span class="k">loan_id</span><span class="v"><code>${escapeHtml((r.loan_id || "—").slice(0, 20))}…</code></span></div>
      </div>
      <div class="row" style="margin-top:10px;gap:8px">
        ${isMatched
          ? `<button class="ghost remove-btn" data-loan-act="cancel-match" data-counterparty-iaddr="${escapeHtml(r.counterparty_iaddr || '')}" style="flex:0 0 auto">Cancel match</button>
             <span class="muted" style="font-size:11px;align-self:center">Borrower's auto-accept broadcasts Tx-A within ~30s. Cancel only if you want to withdraw your commitment before they do.</span>`
          : r.role === "borrower"
            // Borrower can repay any time; if Tx-Repay isn't in this
            // browser's localStorage the click handler recovers it from
            // the borrower's own loan.status.tx_repay_signed (and falls
            // back to the lender's loan.match.tx_repay_partial). So the
            // button is always actionable — no disabled state.
          ? `<button class="primary" data-loan-act="repay">Repay</button>
             <span class="muted" style="font-size:11px;margin-left:8px">${hasRepay
               ? "Auto-splits a fresh repayment UTXO + extends Tx-Repay + broadcasts. Then posts loan.history (settled)."
               : "Will recover Tx-Repay from your loan.status (or the lender's match) before broadcasting."}</span>`
          : claimable
            ? `<button class="primary" disabled title="GUI Tx-B claim flow not yet wired — for now broadcast Tx-B manually via the SPEC's recipe (lender extends pre-signed Tx-B with their input, signs, sendrawtransaction)">Claim collateral (manual — see SPEC)</button>
               <span style="color:var(--ok);font-size:11px;align-self:center">Maturity reached.</span>`
            : `<button class="primary" disabled title="Tx-B's nLockTime is set to the maturity block; the network rejects it until tipHeight ≥ maturity">Collateral not claimable until block ${maturity || "?"}</button>
               ${eta ? `<span class="muted" style="font-size:11px;align-self:center">~${blocksToMaturity} blocks (${eta}) to go</span>` : ""}`}
      </div>
      <div class="repay-result" style="margin-top:8px"></div>
    </div>
  `;
}

// After the Active loans cards render, fill in each card's "your
// balance" line. Verus network fees are always paid in VRSC, so for
// non-VRSC repay loans the borrower needs:
//   - exactly repayAmt of the loan currency (sent to lender on Tx-Repay
//     output 0; loan-currency math must balance to zero, no fee in it)
//   - ~0.0003 VRSC across three side-effect txs (split sendcurrency +
//     Tx-Repay broadcast + loan.history updateidentity)
// For VRSC repay loans, all three come out of the same VRSC balance.
const REPAY_VRSC_FEE = 0.0003;
async function enrichActiveLoanBalances() {
  const cards = document.querySelectorAll('#market-list .mp-row[data-loan-id]');
  console.log(`[enrich] running for ${cards.length} active loan cards`);
  for (const card of cards) {
    const cell = card.querySelector('.repay-balance');
    if (!cell) continue;
    const repayCcy = card.dataset.repayCurrency;
    const repayAmt = parseFloat(card.dataset.repayAmount);
    if (!repayCcy || !repayAmt) { cell.textContent = '—'; continue; }
    const acting = actingIaddr();
    if (!acting || acting === 'all') { cell.textContent = '(set acting ID)'; continue; }
    try {
      const info = await rpc('getidentity', [acting, -1]);
      const r = (info?.identity?.primaryaddresses || [])[0];
      if (!r) { cell.textContent = '(no R)'; continue; }
      // Sum confirmed utxos + mempool deltas. getaddressbalance lags the
      // tip; getaddressutxos is confirmed-only (Tx-A principal output goes
      // to borrower in mempool first); getaddressmempool gives deltas. Sum
      // both to get the true post-Tx-A balance the moment Tx-A is broadcast.
      const VRSC_ID = "i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV";
      const cb = {};
      const utxos = await rpc('getaddressutxos', [{ addresses: [r], currencynames: false }]);
      for (const u of (utxos || [])) {
        if (u.satoshis) cb[VRSC_ID] = (cb[VRSC_ID] || 0) + (u.satoshis / 1e8);
        for (const [ccyId, amt] of Object.entries(u.currencyvalues || {})) {
          cb[ccyId] = (cb[ccyId] || 0) + parseFloat(amt);
        }
      }
      // Mempool deltas — positive = received, negative = spent.
      const mempool = await rpc('getaddressmempool', [{ addresses: [r] }]).catch(() => []);
      for (const m of (mempool || [])) {
        if (m.satoshis) cb[VRSC_ID] = (cb[VRSC_ID] || 0) + (m.satoshis / 1e8);
        for (const [ccyId, amt] of Object.entries(m.currencyvalues || {})) {
          cb[ccyId] = (cb[ccyId] || 0) + parseFloat(amt);
        }
      }
      const bal = { balance: Math.round((cb[VRSC_ID] || 0) * 1e8), currencybalance: cb };
      const vrscHave = (bal?.balance ?? 0) / 1e8;
      const fmt = (n) => n.toFixed(8).replace(/\.?0+$/, '');

      if (repayCcy === 'VRSC') {
        // All-VRSC: repay + network fees from a single balance.
        const need = repayAmt + REPAY_VRSC_FEE;
        const enough = vrscHave >= need;
        cell.classList.remove('muted');
        cell.innerHTML = enough
          ? `<span style="color:var(--ok)">${fmt(vrscHave)} VRSC</span> <span class="muted" style="font-size:11px">(need ${need.toFixed(4)}: ${repayAmt} repay + ${REPAY_VRSC_FEE} network fees)</span>`
          : `<span style="color:var(--bad)">${fmt(vrscHave)} VRSC</span> <span class="muted" style="font-size:11px">(need ${need.toFixed(4)} — short ${(need - vrscHave).toFixed(4)})</span>`;
        if (!enough) {
          const btn = card.querySelector('[data-loan-act="repay"]');
          if (btn) { btn.disabled = true; btn.title = `Insufficient VRSC: have ${vrscHave}, need ${need}.`; }
        }
        continue;
      }

      // Non-VRSC repay: loan currency covers exactly the repayment;
      // VRSC covers all network fees.
      const ccyId = (await rpc('getcurrency', [repayCcy]).catch(() => null))?.currencyid;
      const ccyHave = parseFloat(cb[repayCcy] ?? cb[ccyId] ?? 0);
      const ccyOk  = ccyHave  >= repayAmt;
      const vrscOk = vrscHave >= REPAY_VRSC_FEE;
      const enough = ccyOk && vrscOk;
      console.log(`[repay-bal] acting=${acting} R=${r} ccyId=${ccyId} | rawCb=${JSON.stringify(cb)} | ${repayCcy}: have=${ccyHave} need=${repayAmt} ok=${ccyOk} | VRSC have=${vrscHave} need=${REPAY_VRSC_FEE} ok=${vrscOk} | enough=${enough}`);
      cell.classList.remove('muted');
      const ccyLine = `<span style="color:var(${ccyOk  ? '--ok' : '--bad'})">${fmt(ccyHave)} ${escapeHtml(repayCcy)}</span> <span class="muted" style="font-size:11px">(need ${repayAmt} to lender)</span>`;
      const feeLine = `<span style="color:var(${vrscOk ? '--ok' : '--bad'})">${fmt(vrscHave)} VRSC</span> <span class="muted" style="font-size:11px">(need ${REPAY_VRSC_FEE} for network fees)</span>`;
      cell.innerHTML = `${ccyLine}<br>${feeLine}`;
      if (!enough) {
        const btn = card.querySelector('[data-loan-act="repay"]');
        if (btn) {
          btn.disabled = true;
          const shortMsg = [
            !ccyOk  ? `${repayCcy}: short ${(repayAmt - ccyHave).toFixed(4)}` : null,
            !vrscOk ? `VRSC: short ${(REPAY_VRSC_FEE - vrscHave).toFixed(4)}` : null,
          ].filter(Boolean).join(', ');
          btn.title = `Insufficient balance — ${shortMsg}`;
        }
      }
    } catch (e) {
      cell.textContent = `(${e.message})`;
    }
  }
}

// Click handler for the Active loans rows — Repay (and Claim collateral
// when wired). Attached to #market-list now that Active is a sub-tab of
// the Loans section, with a fallback to the legacy #loans-list for any
// older layout that might still exist.
(document.getElementById("market-list") || document.getElementById("loans-list"))?.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-loan-act]");
  if (!btn) return;
  const card = btn.closest(".mp-row");
  const loanId = card.dataset.loanId;
  // Mark the card so loadLoans / picker-change re-renders can't clobber it.
  card.dataset.opActive = "1";
  const resultEl = card.querySelector(".repay-result");

  if (btn.dataset.loanAct === "cancel-match") {
    if (!confirm("Cancel your loan.match for this borrower? Your pre-signed partials will be withdrawn from chain.")) {
      delete card.dataset.opActive;
      return;
    }
    btn.disabled = true; btn.textContent = "Cancelling…";
    resultEl.innerHTML = `<div class="muted" style="font-size:12px">Posting updateidentity to drop the loan.match entry — this typically takes 5-10 seconds for mempool propagation…</div>`;
    try {
      const acting = actingIaddr();
      if (!acting || acting === "all") throw new Error("set acting identity first");
      const idInfo = await rpc("getidentity", [acting, -1]);
      const existing = idInfo?.identity?.contentmultimap || {};
      const VDXF_LOAN_MATCH = "i4G69W7e3UJRCinuP7TFBRnm3ZUiXzPkFt";
      const counterpartyIa = btn.dataset.counterpartyIaddr || "";
      // Drop any active match where request.iaddr matches the borrower
      // we're cancelling against. Other matches (different borrowers)
      // are preserved.
      const newCm = { ...existing };
      const allEntries = newCm[VDXF_LOAN_MATCH] || [];
      const kept = [];
      for (const e of allEntries) {
        const hex = typeof e === "string" ? e : (e?.serializedhex || e?.message || "");
        if (!hex) { kept.push(e); continue; }
        let toCancel = false;
        try {
          const j = JSON.parse(new TextDecoder().decode(_hexToBytes(hex)));
          toCancel = j?.request?.iaddr === counterpartyIa;
        } catch {}
        if (toCancel) {
          // Release the lender's principal funding UTXO so the wallet can
          // reuse it. Match's pre-signatures become void after cancellation.
          await unlockEntryUtxos(VDXF_LOAN_MATCH, e);
        } else {
          kept.push(e);
        }
      }
      if (kept.length === 0) delete newCm[VDXF_LOAN_MATCH];
      else newCm[VDXF_LOAN_MATCH] = kept;
      // Normalize all preserved entries to hex strings.
      for (const [k, v] of Object.entries(newCm)) {
        newCm[k] = (Array.isArray(v) ? v : [v]).map((entry) => {
          if (typeof entry === "string") return entry;
          return entry?.serializedhex || entry?.message || JSON.stringify(entry);
        });
      }
      const txid = await rpc("updateidentity", [{
        name: idInfo.identity.name,
        parent: idInfo.identity.parent || "",
        contentmultimap: newCm,
      }]);
      resultEl.innerHTML = `<div class="muted" style="color:var(--ok)">✓ Match cancelled: <a href="https://scan.verus.cx/vrsc/tx/${escapeHtml(txid)}" target="_blank"><code>${escapeHtml(txid.slice(0,16))}…</code></a></div>`;
      invalidateMarketCache();
      setTimeout(() => { delete card.dataset.opActive; loadMarket(); }, 3000);
    } catch (e) {
      resultEl.innerHTML = `<div class="muted" style="color:var(--bad)">✗ ${escapeHtml(e.message)}</div>`;
      btn.disabled = false; btn.textContent = "Cancel match";
      delete card.dataset.opActive;
    }
    return;
  }

  if (btn.dataset.loanAct === "repay") {
    // Confirm before broadcasting — repay sends the principal + interest
    // to the lender and is irreversible. Read terms off the card so the
    // dialog shows what's being paid, not just "are you sure".
    const repayCcy = card.dataset.repayCurrency || "?";
    const repayAmt = card.dataset.repayAmount   || "?";
    const counterparty = card.querySelector('.kv .v')?.textContent?.trim() || "(lender)";
    if (!confirm(`Repay ${repayAmt} ${repayCcy} now?\n\nThis broadcasts Tx-Repay (your repayment + the vault's collateral release) and posts loan.history(repaid). Both legs are irreversible.\n\nLender: ${counterparty}`)) {
      delete card.dataset.opActive;
      return;
    }
    btn.disabled = true; btn.textContent = "Loading Tx-Repay…";
    try {
      // Load borrower's loan.status first — needed for repay terms AND
      // for the on-chain recovery fallback if localStorage is empty.
      const acting = actingIaddr();
      const idInfo = await rpc("getidentity", [acting, -1]);
      const cm = idInfo?.identity?.contentmultimap || {};
      const VDXF_LOAN_STATUS = "iPnrakyY951QEy6xUYBuJoobHA9JKY6G8j";
      let status = null;
      for (const e of (cm[VDXF_LOAN_STATUS] || [])) {
        const hex = typeof e === "string" ? e : (e?.serializedhex || e?.message || "");
        try {
          const j = JSON.parse(new TextDecoder().decode(_hexToBytes(hex)));
          if (j.loan_id === loanId) { status = j; break; }
        } catch {}
      }
      // Fallback: walk identity history if loan.status was wiped from
      // current state (e.g., user posted an updateidentity that didn't
      // preserve it). The chain still remembers prior revisions.
      if (!status) {
        console.log("[repay] tier4.5: walking identityhistory for loan.status");
        btn.textContent = "Recovering loan.status from your identity history…";
        try {
          const hist = await rpc("getidentityhistory", [acting, 0, -1]);
          const revs = hist?.history || [];
          console.log(`[repay] tier4.5: ${revs.length} revisions to scan for loanId=${loanId.slice(0,12)}`);
          for (const rev of revs) {
            const rcm = rev?.identity?.contentmultimap || {};
            for (const e of (rcm[VDXF_LOAN_STATUS] || [])) {
              const hex = typeof e === "string" ? e : (e?.serializedhex || e?.message || "");
              if (!hex) continue;
              try {
                const j = JSON.parse(new TextDecoder().decode(_hexToBytes(hex)));
                if (j.loan_id === loanId) { status = j; break; }
              } catch {}
            }
            if (status) break;
          }
          console.log(`[repay] tier4.5 result: status ${status ? "found" : "still null"}`);
        } catch (e) {
          console.warn("[repay] identityhistory status fallback failed:", e?.message);
        }
      }
      if (!status) throw new Error("loan.status entry not found on this identity (current state OR identity history)");

      // Tx-Repay recovery cascade:
      //   1. localStorage cache — fastest path, no RPC
      //   2. borrower's own loan.status.tx_repay_signed — durable + self-
      //      controlled (added at accept time post-Verus-loans-v3.1).
      //      Doesn't depend on the lender keeping their loan.match.
      //   3. lender's loan.match.tx_repay_partial (current state) — re-sign
      //      borrower's vault-half via signrawtransaction. Trust dependency
      //      on the lender; works for older accept flows that didn't mirror
      //      the partial into loan.status.
      //   4. lender's loan.match.tx_repay_partial (identity history) —
      //      same as 3 but walks getidentityhistory. Catches the case where
      //      lender (or someone with control of the lender ID) overwrote
      //      the match key in current state but the chain still remembers
      //      the prior revision.
      let txRepayHex = localStorage.getItem(`vl_tx_repay_${loanId}`);
      if (!txRepayHex && status.tx_repay_signed) {
        // Borrower-half-signed Tx-Repay was mirrored into loan.status at
        // accept time. Just use it directly — no re-signing needed.
        btn.textContent = "Recovering Tx-Repay from your loan.status…";
        txRepayHex = status.tx_repay_signed;
        try { localStorage.setItem(`vl_tx_repay_${loanId}`, txRepayHex); } catch {}
      }
      if (!txRepayHex) {
        btn.textContent = "Recovering Tx-Repay from lender's loan.match…";
        const lenderIa = status.match_iaddr;
        if (!lenderIa) throw new Error("loan.status missing match_iaddr — can't recover Tx-Repay from chain");
        const VDXF_LOAN_MATCH = "i4G69W7e3UJRCinuP7TFBRnm3ZUiXzPkFt";
        let matchPayload = null;
        // Tier 3: current state.
        const lenderInfo = await rpc("getidentity", [lenderIa, -1]);
        const lcm = lenderInfo?.identity?.contentmultimap || {};
        for (const e of (lcm[VDXF_LOAN_MATCH] || [])) {
          const hex = typeof e === "string" ? e : (e?.serializedhex || e?.message || "");
          try {
            const j = JSON.parse(new TextDecoder().decode(_hexToBytes(hex)));
            if (j.tx_a_txid === loanId) { matchPayload = j; break; }
          } catch {}
        }
        // Tier 4: walk identity history for any prior revision that still
        // had our loan.match. Slower (~1s/100 revisions) but doesn't
        // depend on lender keeping current state intact.
        if (!matchPayload?.tx_repay_partial || !matchPayload?.vault_redeem_script) {
          btn.textContent = "Recovering Tx-Repay from lender's identity history…";
          try {
            const hist = await rpc("getidentityhistory", [lenderIa, 0, -1]);
            const revs = hist?.history || [];
            for (const rev of revs) {
              const cm = rev?.identity?.contentmultimap || {};
              for (const e of (cm[VDXF_LOAN_MATCH] || [])) {
                const hex = typeof e === "string" ? e : (e?.serializedhex || e?.message || "");
                if (!hex) continue;
                try {
                  const j = JSON.parse(new TextDecoder().decode(_hexToBytes(hex)));
                  if (j.tx_a_txid === loanId && j.tx_repay_partial && j.vault_redeem_script) {
                    matchPayload = j;
                    break;
                  }
                } catch {}
              }
              if (matchPayload?.tx_repay_partial) break;
            }
          } catch (e) {
            console.warn("[repay] identityhistory fallback failed:", e?.message);
          }
        }
        if (!matchPayload?.tx_repay_partial || !matchPayload?.vault_redeem_script) {
          throw new Error(`Tx-Repay partial not recoverable: not in your loan.status (older accept flow), not in lender ${lenderIa.slice(0,12)}'s current loan.match, AND not in their identity history. Cooperative manual recovery required (see SPEC §recovery).`);
        }
        // Make sure the wallet knows the vault P2SH so it can sign for it.
        const rs = _hexToBytes(matchPayload.vault_redeem_script);
        if (rs.length === 71 && rs[0] === 0x52 && rs[1] === 0x21 && rs[35] === 0x21 && rs[69] === 0x52 && rs[70] === 0xae) {
          const pubA = _bytesToHex(rs.slice(2, 35));
          const pubB = _bytesToHex(rs.slice(36, 69));
          try { await rpc("addmultisigaddress", [2, [pubA, pubB]]); } catch {}
        }
        // Locate the vault output in the on-chain Tx-A so signrawtransaction has
        // a proper prevtx pointer for the SINGLE|ANYONECANPAY vault input.
        const txA = await rpc("getrawtransaction", [loanId, 1]);
        const vaultVout = (txA.vout || []).findIndex((o) => (o.scriptPubKey?.addresses || []).includes(matchPayload.vault_address));
        if (vaultVout < 0) throw new Error("vault output not found in Tx-A");
        const vaultOut = txA.vout[vaultVout];
        const prevtxsHint = [{
          txid: loanId,
          vout: vaultVout,
          scriptPubKey: vaultOut.scriptPubKey?.hex,
          redeemScript: matchPayload.vault_redeem_script,
          amount: parseFloat(status.collateral?.amount ?? vaultOut.value),
        }];
        const repaySigned = await rpc("signrawtransaction", [matchPayload.tx_repay_partial, prevtxsHint, null, "SINGLE|ANYONECANPAY"]);
        if (!repaySigned.complete) throw new Error("Tx-Repay vault-half re-sign incomplete: " + JSON.stringify(repaySigned.errors || {}));
        txRepayHex = repaySigned.hex;
        try { localStorage.setItem(`vl_tx_repay_${loanId}`, txRepayHex); } catch {}
      }

      const repayCcy = status.repay?.currency;
      const repayAmt = parseFloat(status.repay?.amount);
      if (!repayCcy || !repayAmt) throw new Error("loan.status missing repay terms");

      const borrowerR = (idInfo.identity.primaryaddresses || [])[0];
      btn.textContent = "Splitting fresh repayment UTXO…";
      // Native fee policy: Tx-Repay's fee should always come out of VRSC,
      // not the loan currency, even though Verus's reserve-feepool would
      // accept reserve-currency fees. Two cases:
      //   - VRSC repay: split repayAmt + 0.0001 — the +0.0001 is consumed
      //     as the VRSC fee (only one input from the split needed).
      //   - Non-VRSC repay: split TWO clean UTXOs in one sendcurrency —
      //     repayAmt of the loan currency for the lender's output, AND
      //     0.0001 VRSC fully consumed as the network fee.
      const FEE_VRSC = 0.0001;
      const splitOut = repayCcy === "VRSC"
        ? [{ address: borrowerR, amount: repayAmt + FEE_VRSC }]
        : [
            { currency: repayCcy, amount: repayAmt, address: borrowerR },
            { address: borrowerR, amount: FEE_VRSC },
          ];
      const opid = await rpc("sendcurrency", [borrowerR, splitOut]);
      let splitTxid;
      for (let i = 0; i < 30 && !splitTxid; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const op = (await rpc("z_getoperationresult", [[opid]]))[0];
        if (op?.status === "success") splitTxid = op.result?.txid;
        if (op?.status === "failed") throw new Error("split failed: " + JSON.stringify(op.error || {}));
      }
      if (!splitTxid) throw new Error("split timed out");

      // Find clean UTXO(s) in the split tx (mempool).
      const splitTx = await rpc("getrawtransaction", [splitTxid, 1]);
      const repaySats = repayCcy === "VRSC"
        ? Math.round((repayAmt + FEE_VRSC) * 1e8)
        : Math.round(repayAmt * 1e8);
      const feeSats = Math.round(FEE_VRSC * 1e8);
      let splitVout = -1;        // index of the loan-currency repayment UTXO
      let feeVout = -1;          // index of the VRSC fee UTXO (non-VRSC case only)
      for (let i = 0; i < (splitTx?.vout || []).length; i++) {
        const o = splitTx.vout[i];
        const spk = o?.scriptPubKey || {};
        if (!(spk.addresses || []).includes(borrowerR)) continue;
        const cv = spk.reserveoutput?.currencyvalues || {};
        const cvKeys = Object.keys(cv);
        if (repayCcy === "VRSC") {
          if (cvKeys.length === 0 && o.valueSat === repaySats) { splitVout = i; break; }
        } else {
          if (splitVout < 0 && o.valueSat === 0 && cvKeys.length === 1 &&
              Math.round(parseFloat(Object.values(cv)[0]) * 1e8) === repaySats) {
            splitVout = i;
          } else if (feeVout < 0 && cvKeys.length === 0 && o.valueSat === feeSats) {
            feeVout = i;
          }
          if (splitVout >= 0 && feeVout >= 0) break;
        }
      }
      if (splitVout < 0) throw new Error("split tx didn't produce a clean repayment output");
      if (repayCcy !== "VRSC" && feeVout < 0) throw new Error("split tx didn't produce a clean VRSC fee output");

      btn.textContent = "Extending Tx-Repay…";
      // Extend Tx-Repay. SIGHASH_SINGLE|ANYONECANPAY on input 0 (vault)
      // commits to output 0 only — we can freely add inputs and outputs.
      // Order of new inputs: [repayment, fee?]; order of new outputs: [collateral-return].
      const tx = _parseTx(txRepayHex);
      const txidLE = _hexToBytes(splitTxid).reverse();
      tx.vins.push({ prevTxid: txidLE, prevVout: splitVout, scriptSig: new Uint8Array(0), sequence: 0xffffffff });
      if (repayCcy !== "VRSC") {
        tx.vins.push({ prevTxid: txidLE, prevVout: feeVout, scriptSig: new Uint8Array(0), sequence: 0xffffffff });
      }
      // Add output 1: collateral-return → borrower
      const collateralCcy = status.collateral?.currency;
      const collateralAmt = parseFloat(status.collateral?.amount);
      const collateralSats = Math.round(collateralAmt * 1e8);
      if (collateralCcy === "VRSC") {
        // P2PKH to borrower's R
        tx.vouts.push({ value: BigInt(collateralSats), scriptPubKey: _addrToP2pkhSpk(borrowerR) });
      } else {
        throw new Error(`non-VRSC collateral return at repay not wired yet (${collateralCcy})`);
      }
      const extendedHex = _serializeTx(tx);

      btn.textContent = "Signing borrower's input…";
      const signed = await rpc("signrawtransaction", [extendedHex]);
      if (!signed.complete) throw new Error("repay signing didn't complete: " + JSON.stringify(signed.errors || {}));

      btn.textContent = "Broadcasting Tx-Repay…";
      const repayBroadcastTxid = await rpc("sendrawtransaction", [signed.hex]);

      // Post loan.history (settled = repaid) on borrower's identity for credit-score
      btn.textContent = "Posting loan.history (settled)…";
      const VDXF_LOAN_HISTORY = "iBGuPDeeHHYpvKdM7VG2d7LR1Lct9itcpT";
      const historyPayload = {
        version: 3,
        role: "borrower",
        loan_id: loanId,
        // Propagate request_txid (read from the local loan.status entry
        // posted at accept time) so the canonical loan join works on
        // this entry alone — even after loan.status is cleaned up.
        request_txid: status.request_txid ?? null,
        outcome: "repaid",
        tx_repay_txid: repayBroadcastTxid,
        repaid_at_block: await rpc("getblockcount"),
        principal: status.principal,
        collateral: status.collateral,
        repay: status.repay,
        // v3: carry term_days + maturity_block forward so the explorer's
        // tx detail page can render "over X days" / due date without
        // depending on a still-present loan.status (which gets cleaned
        // up after settlement).
        term_days: status.term_days ?? null,
        maturity_block: status.maturity_block ?? null,
        posted_block: status.posted_block ?? status.originated_block ?? null,
        counterparty_iaddr: status.match_iaddr,
      };
      const historyHex = Array.from(new TextEncoder().encode(JSON.stringify(historyPayload)))
        .map((b) => b.toString(16).padStart(2, "0")).join("");
      // Re-fetch the borrower's CURRENT identity right before posting. The
      // multimap may have changed since the start of the repay handler
      // (other concurrent updateidentity, etc.), and updateidentity will
      // 500 if our `cm` is stale.
      const freshIdInfo = await rpc("getidentity", [acting, -1]);
      const freshCm = freshIdInfo?.identity?.contentmultimap || {};
      const newCm = {};
      // Normalize every existing entry to a plain hex string — daemon
      // rejects mixed shapes (some plain hex, some {serializedhex: "..."}).
      for (const [k, arr] of Object.entries(freshCm)) {
        newCm[k] = (Array.isArray(arr) ? arr : [arr])
          .map((entry) => typeof entry === "string" ? entry : (entry?.serializedhex || entry?.message || ""))
          .filter(Boolean);
      }
      newCm[VDXF_LOAN_HISTORY] = [...(newCm[VDXF_LOAN_HISTORY] || []), historyHex];
      // Flip the loan.status entry to inactive so it stops showing up.
      const updatedStatus = { ...status, active: false, repaid_tx: repayBroadcastTxid };
      newCm[VDXF_LOAN_STATUS] = (newCm[VDXF_LOAN_STATUS] || []).map((hex) => {
        try {
          const j = JSON.parse(new TextDecoder().decode(_hexToBytes(hex)));
          if (j.loan_id === loanId) {
            return Array.from(new TextEncoder().encode(JSON.stringify(updatedStatus)))
              .map((b) => b.toString(16).padStart(2, "0")).join("");
          }
        } catch {}
        return hex;
      });
      // Retry the updateidentity if it transiently fails. Tx-Repay is
      // already broadcast — failure here just leaves the on-chain
      // bookkeeping (loan.history) un-posted; it doesn't affect funds.
      let historyTxid = null;
      let lastErr = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          historyTxid = await rpc("updateidentity", [{
            name: freshIdInfo.identity.name,
            parent: freshIdInfo.identity.parent || "",
            contentmultimap: newCm,
          }]);
          break;
        } catch (e) {
          lastErr = e;
          console.warn(`[repay] loan.history post attempt ${attempt + 1}/5 failed: ${e.message}`);
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        }
      }
      if (!historyTxid) {
        // Don't throw — funds are settled. Surface the issue prominently
        // so the user can manually re-post; show success on Tx-Repay.
        resultEl.innerHTML = `<div class="muted" style="color:var(--warn)">
          ⚠ Tx-Repay broadcast successfully (${escapeHtml(repayBroadcastTxid.slice(0,20))}…) — vault drained, lender repaid — but loan.history posting failed: ${escapeHtml(lastErr?.message || "?")}<br>
          On-chain bookkeeping is incomplete (loan.status still shows active). Click Retry repay to re-post just the bookkeeping update.
        </div>`;
        btn.disabled = false;
        btn.textContent = "Retry post-bookkeeping";
        return;
      }

      // Clear stored Tx-Repay (loan is settled)
      try { localStorage.removeItem(`vl_tx_repay_${loanId}`); } catch {}

      resultEl.innerHTML = `<div class="muted" style="color:var(--ok)">
        ✓ Loan repaid:<br>
        &nbsp;&nbsp;Tx-Repay: <a href="https://scan.verus.cx/vrsc/tx/${escapeHtml(repayBroadcastTxid)}" target="_blank"><code>${escapeHtml(repayBroadcastTxid)}</code></a><br>
        &nbsp;&nbsp;loan.history: <a href="https://scan.verus.cx/vrsc/tx/${escapeHtml(historyTxid)}" target="_blank"><code>${escapeHtml(historyTxid.slice(0,20))}…</code></a><br>
        &nbsp;&nbsp;Lender received repayment; collateral returned to you.
      </div>`;
      btn.style.display = "none";
    } catch (e) {
      resultEl.innerHTML = `<div class="muted" style="color:var(--bad)">✗ ${escapeHtml(e.message)}</div>`;
      btn.disabled = false;
      btn.textContent = "Retry repay";
    }
    return;
  }
});

// Legacy refresh buttons — only attach if the corresponding section
// still exists. With the Loans-section restructure, refresh is via the
// shared #market-refresh button.
const _loansRefreshBtn = document.getElementById("loans-refresh");
if (_loansRefreshBtn) {
  _loansRefreshBtn.onclick = async () => {
    cachedSpendableIds = []; pickerByR = new Map();
    await populateActingPicker();
    loadMarket();
  };
}

// ---------- History tab: daemon-first cache ----------
//
// History is reconstructible offline from the local daemon. We persist
// derived rows to ~/.verus_contract_gui/history_cache.json via the GUI
// server's /history-cache endpoint, then on each load:
//   1. read cache → render immediately (no daemon round-trip)
//   2. ask the daemon "anything new since lastRevisionTxid?" → walk only
//      the new revisions, append rows, save cache, re-render
// Once a row's source revision is buried >REORG_DEPTH blocks, it is
// trusted unconditionally. Rows within REORG_DEPTH of tip are revalidated
// (their source txid must still be in best chain) on every load.

const HISTORY_CACHE_VERSION = 1;
const HISTORY_REORG_DEPTH = 100;

// History tab is the one place that needs to read BOTH the new (vcs::*)
// and legacy (vrsc::*) keys, so past loans surface alongside new activity.
// Other call sites only look at the new keys (nothing live remains on the
// legacy side after the migration cancellation pass).
const _HISTORY_KEY_SETS = [
  { logical: "request", keys: VDXF_LOAN_REQUEST_KEYS },
  { logical: "match",   keys: VDXF_LOAN_MATCH_KEYS },
  { logical: "status",  keys: VDXF_LOAN_STATUS_KEYS },
  { logical: "history", keys: VDXF_LOAN_HISTORY_KEYS },
];

function _readMergedEntries(cm, keys) {
  const out = [];
  for (const k of keys) if (cm?.[k]) out.push(...cm[k]);
  return out;
}

function _decodeMultimapEntry(e) {
  // getidentityhistory returns plain hex strings; getidentity returns
  // {serializedhex|message: hex}. Handle both.
  const hex = typeof e === "string" ? e : (e?.serializedhex || e?.message || "");
  if (!hex) return null;
  try { return JSON.parse(new TextDecoder().decode(_hexToBytes(hex))); }
  catch { return null; }
}

function _entryHexKey(e) {
  // Deterministic key for diffing. The raw serialized hex is the source
  // of truth — two entries with identical hex are the same entry.
  return typeof e === "string" ? e : (e?.serializedhex || e?.message || "");
}

async function loadHistoryCache() {
  try {
    const r = await fetch("/history-cache");
    if (!r.ok) return { version: HISTORY_CACHE_VERSION, perIaddr: {} };
    const j = await r.json();
    if (!j || typeof j !== "object" || j.version !== HISTORY_CACHE_VERSION) {
      return { version: HISTORY_CACHE_VERSION, perIaddr: {} };
    }
    return j;
  } catch {
    return { version: HISTORY_CACHE_VERSION, perIaddr: {} };
  }
}

async function saveHistoryCache(cache) {
  try {
    await fetch("/history-cache", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-By": "vlocal" },
      body: JSON.stringify(cache),
    });
  } catch (e) {
    console.warn("[history] cache save failed:", e?.message);
  }
}

// Walks getidentityhistory for one iaddr and derives history rows from
// revision-to-revision diffs. If `cachedHead` is set, only revisions
// AFTER that revision's txid are processed (incremental update).
//
// Fast-path: if cachedHead is provided, first call getidentity (~200ms,
// cheap) to peek the latest revision txid. If it equals cachedHead.txid,
// nothing has changed since the last walk — skip getidentityhistory
// entirely (which is much heavier, ~2s for 28 revisions). Returns {
// unchanged: true } so the caller can skip Path A processing.
//
// Returns { rows, headTxid, headHeight }: rows is the new rows discovered;
// headTxid/Height is the newest revision processed, to store as the
// next call's cachedHead.
async function walkHistoryFromDaemon(iaddr, cachedHead) {
  if (cachedHead?.txid) {
    const peek = await rpc("getidentity", [iaddr, -1]).catch(() => null);
    if (peek?.txid && peek.txid === cachedHead.txid) {
      // Identity hasn't been updated since last walk — Path A has no new
      // events to discover, and Path B's latest-state was captured then.
      return { rows: [], headTxid: cachedHead.txid, headHeight: cachedHead.height, unchanged: true };
    }
  }
  const resp = await rpc("getidentityhistory", [iaddr, 0, -1]);
  const history = resp?.history || [];
  if (history.length === 0) return { rows: [], headTxid: null, headHeight: null };

  // Find the index just past cachedHead (skip already-processed revisions).
  let startIdx = 0;
  if (cachedHead?.txid) {
    const i = history.findIndex((h) => h.output?.txid === cachedHead.txid);
    if (i >= 0) startIdx = i + 1;
  }

  const newRows = [];
  for (let i = startIdx; i < history.length; i++) {
    const cur  = history[i];
    const prev = history[i - 1] || null;
    const curCm  = cur?.identity?.contentmultimap || {};
    const prevCm = prev?.identity?.contentmultimap || {};
    const blockHeight = cur.height;
    const blockHash   = cur.blockhash;
    const txid        = cur.output?.txid;

    // Per-logical-type diff. Each logical type (request/match/status/history)
    // spans BOTH the new and legacy VDXF keys — we treat them as one bucket
    // so that, e.g., a loan.history entry posted under either key shows up
    // as a single "settled" event.
    const added = {}, removed = {};
    for (const { logical, keys } of _HISTORY_KEY_SETS) {
      const prevArr = _readMergedEntries(prevCm, keys);
      const curArr  = _readMergedEntries(curCm,  keys);
      const prevSet = new Set(prevArr.map(_entryHexKey));
      const curSet  = new Set(curArr.map(_entryHexKey));
      added[logical]   = curArr.filter((e) => !prevSet.has(_entryHexKey(e)));
      removed[logical] = prevArr.filter((e) => !curSet.has(_entryHexKey(e)));
    }

    // Settled events = loan.history added in this revision. The matching
    // loan.status (added or pre-existing, either key) carries the full
    // thread context.
    for (const histEntry of added.history) {
      const hp = _decodeMultimapEntry(histEntry);
      if (!hp || !hp.loan_id) continue;
      let statusPayload = null;
      for (const sEntry of _readMergedEntries(curCm, VDXF_LOAN_STATUS_KEYS)) {
        const sp = _decodeMultimapEntry(sEntry);
        if (sp?.loan_id === hp.loan_id) { statusPayload = sp; break; }
      }
      // Resolve role + counterparty from whichever payload has them; the
      // status entry usually does, but loan.history is the authoritative
      // fallback when status was already cleared.
      const role = statusPayload?.role || hp.role || "borrower";
      const counterparty = statusPayload?.counterparty || hp.counterparty;
      newRows.push({
        __kind: "settled",
        _myIaddr: iaddr,
        _myRole: role,
        loan_id: hp.loan_id,
        state: hp.outcome === "defaulted" ? "defaulted" : "repaid",
        principal:    statusPayload?.principal     || hp.principal,
        collateral:   statusPayload?.collateral    || hp.collateral,
        repay:        statusPayload?.repay         || hp.repay,
        term_days:    statusPayload?.term_days     ?? hp.term_days,
        borrower_iaddr: role === "lender" ? counterparty : iaddr,
        lender_iaddr:   role === "lender" ? iaddr : counterparty,
        posted_block:        statusPayload?.posted_block,
        settled_at_block:    hp.repaid_at_block ?? hp.defaulted_at_block ?? statusPayload?.repaid_at_block ?? blockHeight,
        tx_repay_txid:       hp.tx_repay_txid    || statusPayload?.tx_repay_txid,
        history_source_txid: txid,
        history_source_block: blockHeight,
        history_source_blockhash: blockHash,
      });
    }

    // Cancellation events: removed loan.request or loan.match entry.
    // Disambiguation for loan.request: if a loan.status with matching
    // loan_id was added in the SAME revision, this is an "accept" (atomic
    // request → status transition), NOT a cancellation.
    const addedStatusLoanIds = new Set(
      added.status.map(_decodeMultimapEntry).filter(Boolean).map((s) => s.loan_id)
    );
    for (const reqEntry of removed.request) {
      const rp = _decodeMultimapEntry(reqEntry);
      if (!rp) continue;
      const loanId = rp.request_txid || rp.loan_id;
      if (loanId && addedStatusLoanIds.has(loanId)) continue; // accept, not cancel
      newRows.push({
        __kind: "cancelled",
        _myIaddr: iaddr,
        _vdxfType: "loan.request",
        cancel_txid:  txid,
        cancel_block: blockHeight,
        cancel_blockhash: blockHash,
        payload: rp,
      });
    }
    for (const matchEntry of removed.match) {
      const mp = _decodeMultimapEntry(matchEntry);
      if (!mp) continue;
      newRows.push({
        __kind: "cancelled",
        _myIaddr: iaddr,
        _vdxfType: "loan.match",
        cancel_txid:  txid,
        cancel_block: blockHeight,
        cancel_blockhash: blockHash,
        payload: mp,
      });
    }
  }

  // Path B: scan the LATEST multimap for terminal-state loan.status
  // entries we haven't already emitted as settled rows. The lender protocol
  // doesn't always post loan.history; instead it flips `settled: true` on
  // the existing loan.status entry. Diff-based detection (Path A above) would
  // see this as add+remove of an entry — better to just trust the final
  // state for "is this loan settled from this iaddr's perspective?"
  //
  // Dedupe by loan_id so we don't double-emit when both paths fire.
  const seenSettledLoanIds = new Set(newRows.filter((r) => r.__kind === "settled").map((r) => r.loan_id));
  const latest = history[history.length - 1];
  const latestCm = latest?.identity?.contentmultimap || {};
  for (const sEntry of _readMergedEntries(latestCm, VDXF_LOAN_STATUS_KEYS)) {
    const sp = _decodeMultimapEntry(sEntry);
    if (!sp || !sp.loan_id) continue;
    if (sp.settled !== true && sp.active !== false) continue;       // still in flight
    if (seenSettledLoanIds.has(sp.loan_id)) continue;               // already emitted via Path A
    let hp = null;
    for (const hEntry of _readMergedEntries(latestCm, VDXF_LOAN_HISTORY_KEYS)) {
      const j = _decodeMultimapEntry(hEntry);
      if (j?.loan_id === sp.loan_id) { hp = j; break; }
    }
    newRows.push({
      __kind: "settled",
      _myIaddr: iaddr,
      _myRole: sp.role || (hp?.role) || "borrower",
      loan_id: sp.loan_id,
      state: (hp?.outcome === "defaulted" || sp.defaulted === true) ? "defaulted" : "repaid",
      principal:    sp.principal,
      collateral:   sp.collateral,
      repay:        sp.repay,
      term_days:    sp.term_days,
      borrower_iaddr: sp.role === "lender" ? sp.counterparty : iaddr,
      lender_iaddr:   sp.role === "lender" ? iaddr : sp.counterparty,
      posted_block:        sp.originated_block ?? sp.posted_block,
      settled_at_block:    hp?.repaid_at_block ?? hp?.defaulted_at_block ?? sp.repaid_at_block ?? null,
      tx_repay_txid:       hp?.tx_repay_txid    || sp.settled_tx,
      // No source_txid for Path B (no specific revision triggered it) — use
      // the latest revision as the witness, and let reorg pruning skip it.
      history_source_txid:  latest.output?.txid,
      history_source_block: latest.height,
      history_source_blockhash: latest.blockhash,
    });
  }

  const head = history[history.length - 1];
  return {
    rows: newRows,
    headTxid:   head.output?.txid,
    headHeight: head.height,
  };
}

// Reorg sentinel: drop any cached row whose source block is within
// REORG_DEPTH of tip and whose source txid is no longer in best chain.
// Older rows are trusted.
async function pruneCacheForReorgs(perIaddrEntry, tipHeight) {
  if (!perIaddrEntry?.rows?.length) return perIaddrEntry;
  const safeBoundary = tipHeight - HISTORY_REORG_DEPTH;
  const recent = perIaddrEntry.rows.filter((r) => {
    const b = r.__kind === "cancelled" ? r.cancel_block : r.history_source_block;
    return b != null && b > safeBoundary;
  });
  if (recent.length === 0) return perIaddrEntry;
  const checks = await Promise.all(recent.map((r) => {
    const tx = r.__kind === "cancelled" ? r.cancel_txid : r.history_source_txid;
    if (!tx) return Promise.resolve({ row: r, ok: true });
    return rpc("getrawtransaction", [tx, 1])
      .then((info) => ({ row: r, ok: (info?.confirmations ?? 0) > 0 }))
      .catch(() => ({ row: r, ok: false }));
  }));
  const orphaned = new Set(checks.filter((c) => !c.ok).map((c) => c.row));
  if (orphaned.size === 0) return perIaddrEntry;
  console.warn(`[history] reorg detected — dropping ${orphaned.size} orphan row(s) for re-walk`);
  const minOrphanBlock = Math.min(...[...orphaned].map((r) =>
    (r.__kind === "cancelled" ? r.cancel_block : r.history_source_block) || tipHeight
  ));
  // Drop everything from the orphaned block onwards + reset head so the
  // walker re-processes that range.
  return {
    ...perIaddrEntry,
    rows: perIaddrEntry.rows.filter((r) => {
      const b = r.__kind === "cancelled" ? r.cancel_block : r.history_source_block;
      return b != null && b < minOrphanBlock;
    }),
    headTxid: null,    // force walker to start from genesis-of-history
    headHeight: null,  // (cheap; getidentityhistory returns full list anyway)
  };
}

// For each lender match in the rows we collected, look up the borrower's
// loan.history to discover settlement outcomes that landed on the
// borrower's identity (not ours). Caches results; once finalized, never
// re-fetched.
async function resolveLenderOutcomes(cache, iaddr) {
  const entry = cache.perIaddr[iaddr];
  if (!entry) return entry;
  entry.borrowerOutcomes ||= {};

  // Distinct borrower iaddrs referenced by our active matches (current
  // multimap, not removed). For removed matches, we don't need outcome —
  // they're already cancelled rows.
  const myInfo = await rpc("getidentity", [iaddr, -1]).catch(() => null);
  const myCm = myInfo?.identity?.contentmultimap || {};
  // Read both vcs:: and vrsc:: keys: a lender match posted under the
  // legacy key still needs its outcome resolved during the transition.
  const myMatches = _readMergedEntries(myCm, VDXF_LOAN_MATCH_KEYS).map(_decodeMultimapEntry).filter(Boolean);

  for (const m of myMatches) {
    const borrowerIa = m.request?.iaddr;
    const loanId     = m.tx_a_txid;
    if (!borrowerIa || !loanId) continue;
    const cacheKey = `${borrowerIa}:${loanId}`;
    if (entry.borrowerOutcomes[cacheKey]) continue; // already finalized

    const bInfo = await rpc("getidentity", [borrowerIa, -1]).catch(() => null);
    const bcm = bInfo?.identity?.contentmultimap || {};
    let bHistory = null, bStatus = null;
    for (const e of _readMergedEntries(bcm, VDXF_LOAN_HISTORY_KEYS)) {
      const j = _decodeMultimapEntry(e);
      if (j?.loan_id === loanId) { bHistory = j; break; }
    }
    for (const e of _readMergedEntries(bcm, VDXF_LOAN_STATUS_KEYS)) {
      const j = _decodeMultimapEntry(e);
      if (j?.loan_id === loanId) { bStatus = j; break; }
    }
    if (!bHistory) continue; // not yet settled

    entry.borrowerOutcomes[cacheKey] = {
      loan_id: loanId,
      state: bHistory.outcome === "defaulted" ? "defaulted" : "repaid",
      principal:        bStatus?.principal  || bHistory.principal  || m.principal,
      collateral:       bStatus?.collateral || bHistory.collateral || m.collateral,
      repay:            bStatus?.repay      || bHistory.repay      || m.repay,
      term_days:        bStatus?.term_days  ?? m.term_days,
      borrower_iaddr:   borrowerIa,
      lender_iaddr:     iaddr,
      posted_block:     bStatus?.posted_block || m.request?.block,
      settled_at_block: bHistory.repaid_at_block ?? bHistory.defaulted_at_block,
      tx_repay_txid:    bHistory.tx_repay_txid,
    };
  }
  return entry;
}

async function loadActivity(targetEl) {
  const el = targetEl || document.getElementById("market-list") || document.getElementById("activity-list");
  if (!el) return;
  el.textContent = "Loading…";
  const myIaddrs = await inScopeIaddrs();
  if (myIaddrs.length === 0) {
    el.innerHTML = `<div class="empty">No local identities to query.</div>`;
    return;
  }
  const acting = actingIaddr();
  const partyAddrs = (acting && acting !== "all") ? [acting] : myIaddrs;

  // Step 1: read cache, render immediately.
  const cache = await loadHistoryCache();
  cache.perIaddr ||= {};
  const renderFromCache = () => {
    const flat = [];
    for (const ia of partyAddrs) {
      const entry = cache.perIaddr[ia];
      if (!entry?.rows) continue;
      for (const r of entry.rows) flat.push(r);
      // Lender outcomes (from borrower's identity) are stored as a separate
      // map; project them as settled rows under the lender's view.
      for (const out of Object.values(entry.borrowerOutcomes || {})) {
        flat.push({
          __kind: "settled",
          _myIaddr: ia,
          _myRole: "lender",
          ...out,
        });
      }
    }
    flat.sort((a, b) => {
      const aB = a.__kind === "cancelled" ? a.cancel_block : (a.settled_at_block ?? a.posted_block);
      const bB = b.__kind === "cancelled" ? b.cancel_block : (b.settled_at_block ?? b.posted_block);
      return (bB ?? 0) - (aB ?? 0);
    });

    // Apply user-selected History filters (state + role).
    // State chip → cancelled / repaid / defaulted; Role chip → borrower / lender.
    // _myRole on cancelled rows is inferred from _vdxfType: a removed
    // loan.request was posted by us-as-borrower; a removed loan.match was
    // posted by us-as-lender.
    const cancelRoleOf = (row) => row._vdxfType === "loan.match" ? "lender" : "borrower";
    const filtered = flat.filter((r) => {
      if (historyFilter !== "all") {
        if (historyFilter === "cancelled") { if (r.__kind !== "cancelled") return false; }
        else if (r.__kind !== "settled" || r.state !== historyFilter) return false;
      }
      if (historyRole !== "all") {
        const role = r.__kind === "cancelled" ? cancelRoleOf(r) : r._myRole;
        if (role !== historyRole) return false;
      }
      return true;
    });

    const _ctHistory = document.getElementById("ct-history");
    if (_ctHistory) {
      _ctHistory.textContent = (historyFilter === "all" && historyRole === "all")
        ? String(flat.length)
        : `${filtered.length}/${flat.length}`;
    }
    if (filtered.length === 0) {
      const empty = flat.length === 0
        ? `No completed loans yet. <span class="muted" style="font-size:11px">(checking daemon…)</span>`
        : `Nothing matches this filter — ${flat.length} hidden.`;
      el.innerHTML = `<div class="empty">${empty}</div>`;
    } else {
      el.innerHTML = filtered.map((row) =>
        row.__kind === "cancelled" ? renderCancelledRow(row) : renderHistoryRow(row)
      ).join("");
      enrichHistoryRows();
    }
  };
  renderFromCache();

  // Step 2: incremental walk per iaddr in parallel. For each iaddr we walk
  // only revisions newer than the cached head, append rows, refresh lender
  // outcomes. Parallel because each iaddr's walk is independent.
  const tipHeight = await rpc("getblockcount", []).catch(() => 0);
  const mutations = await Promise.all(partyAddrs.map(async (ia) => {
    cache.perIaddr[ia] ||= { headTxid: null, headHeight: null, rows: [], borrowerOutcomes: {} };
    let dirty = false;
    const pruned = await pruneCacheForReorgs(cache.perIaddr[ia], tipHeight);
    if (pruned !== cache.perIaddr[ia]) {
      cache.perIaddr[ia] = pruned;
      dirty = true;
    }
    try {
      const cachedHead = cache.perIaddr[ia].headTxid
        ? { txid: cache.perIaddr[ia].headTxid, height: cache.perIaddr[ia].headHeight }
        : null;
      const result = await walkHistoryFromDaemon(ia, cachedHead);
      if (result.rows.length > 0) {
        // Dedupe: settled rows by loan_id, cancelled rows by cancel_txid.
        // Path B (latest-state scan) re-emits known settled rows on every
        // walk; we filter them here so the cache stays clean.
        const existing = cache.perIaddr[ia].rows;
        const seenSettled  = new Set(existing.filter((r) => r.__kind === "settled").map((r) => r.loan_id));
        const seenCanceled = new Set(existing.filter((r) => r.__kind === "cancelled").map((r) => r.cancel_txid));
        const fresh = result.rows.filter((r) =>
          r.__kind === "settled"   ? !seenSettled.has(r.loan_id)
          : r.__kind === "cancelled" ? !seenCanceled.has(r.cancel_txid)
          : true
        );
        if (fresh.length > 0) {
          cache.perIaddr[ia].rows.push(...fresh);
          dirty = true;
        }
      }
      if (result.headTxid) {
        cache.perIaddr[ia].headTxid   = result.headTxid;
        cache.perIaddr[ia].headHeight = result.headHeight;
        dirty = true;
      }
      const before = JSON.stringify(cache.perIaddr[ia].borrowerOutcomes || {});
      await resolveLenderOutcomes(cache, ia);
      if (JSON.stringify(cache.perIaddr[ia].borrowerOutcomes || {}) !== before) dirty = true;
    } catch (e) {
      console.warn(`[history] daemon walk failed for ${ia}: ${e?.message}`);
    }
    return dirty;
  }));
  const mutated = mutations.some(Boolean);
  cache.tipHeight = tipHeight;

  if (mutated) {
    await saveHistoryCache(cache);
    renderFromCache();
  }
}

// One row per cancellation event (request or match withdrawn before the
// loan opened). Heading uses first-person "You withdrew…" when the
// cancelled entry was posted by the iaddr the user is currently acting
// as, otherwise third-person with the counterparty named.
//
// Stage: the user wants to know at what point the cancellation happened.
// We can derive it from the payload's reference graph:
//   - removed loan.request, no match field in payload → "before any match"
//   - removed loan.request, payload.matched_by present → "after lender [X] matched"
//   - removed loan.match, payload references request.iaddr → "before borrower
//     accepted" (active loan would have left a loan.history we'd surface
//     differently; cancellations reflect pre-acceptance state)
function renderCancelledRow(row) {
  const p = row.payload || {};
  const isRequest = row._vdxfType === "loan.request";
  const cancellerRole = isRequest ? "borrower" : "lender";
  const isMyEntry = !!row._myIaddr; // walker only emits cancellations for OUR own iaddr
  const counterparty = isRequest ? p.target_lender_iaddr : p.request?.iaddr;

  // Headline verb. First-person when the cancelled entry was posted by the
  // active iaddr (which is always the case for walker-emitted rows).
  const headline = isMyEntry
    ? (isRequest ? "You withdrew your loan request" : "You withdrew your match offer")
    : (isRequest ? "Borrower withdrew their loan request" : "Lender withdrew their match offer");

  // Stage indicator — best-effort from payload alone (no remote lookup).
  let stage;
  if (isRequest) {
    stage = p.target_lender_iaddr
      ? "after targeting a specific lender"
      : "before any lender matched";
  } else {
    // loan.match cancellation. payload always carries request.iaddr +
    // tx_a_full; if borrower had broadcast Tx-A (i.e. accepted), the loan
    // would have moved to loan.status — so a removed loan.match means
    // the borrower had NOT yet accepted at cancel time.
    stage = "before borrower accepted";
  }

  const ts = row.cancel_ts ? new Date(row.cancel_ts).toISOString().slice(0, 16).replace("T", " ") : "";
  const counterpartyLabel = isRequest ? "target lender" : "borrower";

  return `
    <div class="card" data-cancel-tx="${escapeHtml(row.cancel_txid || '')}">
      <div class="row" style="margin-bottom:6px">
        <strong style="flex:1">${escapeHtml(headline)}</strong>
        <span class="badge" title="role of cancelling party" style="background:rgba(120,120,120,0.2);color:#888">cancelled · ${escapeHtml(cancellerRole)}</span>
      </div>
      <div class="muted" style="font-size:13px;margin-bottom:6px">Stage: ${escapeHtml(stage)}</div>
      <div class="kv" style="font-size:12px">
        ${p.principal ? `<div><span class="k">principal</span><span class="v">${formatAmount(p.principal)}</span></div>` : ""}
        ${p.collateral ? `<div><span class="k">collateral</span><span class="v">${formatAmount(p.collateral)}</span></div>` : ""}
        ${p.repay ? `<div><span class="k">repay</span><span class="v">${formatAmount(p.repay)}</span></div>` : ""}
        ${p.term_days != null ? `<div><span class="k">term</span><span class="v">${escapeHtml(p.term_days)}d</span></div>` : ""}
        ${counterparty ? `<div><span class="k">${counterpartyLabel}</span><span class="v"><a href="/address/${escapeHtml(counterparty)}" class="font-mono">${escapeHtml(counterparty.slice(0, 16))}…</a></span></div>` : ""}
        <div><span class="k">cancelled</span><span class="v">block ${row.cancel_block ?? "?"} <span class="cancelled-ts ${ts ? '' : 'muted'}">${escapeHtml(ts)}${ts ? ' UTC' : ''}</span></span></div>
        <div><span class="k">cancel tx</span><span class="v"><a href="https://scan.verus.cx/vrsc/tx/${escapeHtml(row.cancel_txid || "")}" target="_blank"><code>${escapeHtml((row.cancel_txid || "").slice(0, 20))}…</code></a></span></div>
      </div>
    </div>
  `;
}

function renderActivityRow(ev) {
  const slug = ev.type || ev._slug;
  const fqn = ev.source?.fullyQualifiedName || ev.source?.name + "@" || "?";
  // Legacy renderActivityRow — replaced by renderHistoryRow.
  return "";
}

// One row per completed loan. Shows borrower↔lender, principal/repay,
// origination + settlement timestamps. The two timestamps come from
// looking up tx confirmation blocks via local daemon (enrichHistoryRows),
// not from the explorer API.
function renderHistoryRow(row) {
  const role = row._myRole;
  const borrowerIa = row.borrower_iaddr;
  const lenderIa   = row.lender_iaddr;
  const counterpartyIa = role === 'borrower' ? lenderIa : borrowerIa;
  const outcome = row.state === 'repaid' ? 'repaid' : 'defaulted';
  const youDid  = role === 'borrower'
    ? (outcome === 'repaid' ? 'You repaid' : 'You defaulted on')
    : (outcome === 'repaid' ? 'You were repaid' : 'You seized collateral on');
  return `
    <div class="card mp-row" data-loan-id="${escapeHtml(row.loan_id || '')}" data-tx-repay="${escapeHtml(row.tx_repay_txid || '')}">
      <div class="row" style="margin-bottom:6px">
        <strong style="flex:1">${escapeHtml(youDid)} ${formatAmount(row.principal)}</strong>
        <span class="badge ${outcome}">${escapeHtml(outcome)}</span>
      </div>
      <div class="kv" style="font-size:13px">
        <div><span class="k">borrower</span><span class="v"><span class="party-name" data-iaddr="${escapeHtml(borrowerIa || '')}">${escapeHtml((borrowerIa || '?').slice(0, 16))}…</span></span></div>
        <div><span class="k">lender</span><span class="v"><span class="party-name" data-iaddr="${escapeHtml(lenderIa || '')}">${escapeHtml((lenderIa || '?').slice(0, 16))}…</span></span></div>
        <div><span class="k">principal</span><span class="v">${formatAmount(row.principal)}</span></div>
        <div><span class="k">repay</span><span class="v">${formatAmount(row.repay)}</span></div>
        <div><span class="k">collateral</span><span class="v">${formatAmount(row.collateral)}</span></div>
        <div><span class="k">originated</span><span class="v originated-ts muted">looking up…</span></div>
        <div><span class="k">${outcome === 'repaid' ? 'repaid' : 'settled'}</span><span class="v settled-ts muted">${row.tx_repay_txid ? 'looking up…' : '—'}</span></div>
        <div><span class="k">loan_id</span><span class="v"><a href="https://scan.verus.cx/vrsc/tx/${escapeHtml(row.loan_id || '')}" target="_blank"><code>${escapeHtml((row.loan_id || '').slice(0, 20))}…</code></a></span></div>
      </div>
    </div>
  `;
}

// Look up tx confirmation blocks via local daemon to fill in the
// "originated" and "repaid"/"settled" rows. RPC, not explorer API.
const _txTimeCache = new Map();
const _identityNameCache = new Map();
async function enrichHistoryRows() {
  const lookup = (txid) => {
    if (!txid) return Promise.resolve(null);
    if (_txTimeCache.has(txid)) return _txTimeCache.get(txid);
    const p = rpc('getrawtransaction', [txid, 1]).catch(() => null);
    _txTimeCache.set(txid, p);
    return p;
  };
  const lookupName = (ia) => {
    if (!ia) return Promise.resolve(null);
    let p = _identityNameCache.get(ia);
    if (!p) {
      p = rpc('getidentity', [ia]).then((info) => info?.identity?.fullyqualifiedname || info?.identity?.name).catch(() => null);
      _identityNameCache.set(ia, p);
    }
    return p;
  };
  const fmtBlock = (tx) => {
    if (!tx) return '(not confirmed yet)';
    const t = tx.time ? new Date(tx.time * 1000).toISOString().slice(0, 16).replace('T', ' ') : '';
    return `block ${tx.height ?? '?'}${t ? ` · ${t} UTC` : ''}`;
  };
  const fmtTime = (tx) => {
    if (!tx?.time) return '';
    return new Date(tx.time * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  };

  // All enrichment runs in parallel — each card is independent. Sequential
  // awaits would block the whole UI on slow daemon responses.
  const tasks = [];

  for (const card of document.querySelectorAll('#market-list .mp-row[data-loan-id]')) {
    const loanId = card.dataset.loanId;
    const txRepay = card.dataset.txRepay;
    if (loanId) {
      tasks.push(lookup(loanId).then((tx) => {
        const cell = card.querySelector('.originated-ts');
        if (cell) { cell.classList.remove('muted'); cell.textContent = fmtBlock(tx); }
      }));
    }
    if (txRepay) {
      tasks.push(lookup(txRepay).then((tx) => {
        const cell = card.querySelector('.settled-ts');
        if (cell) { cell.classList.remove('muted'); cell.textContent = fmtBlock(tx); }
      }));
    }
    for (const span of card.querySelectorAll('.party-name')) {
      tasks.push(lookupName(span.dataset.iaddr).then((name) => {
        if (name) span.textContent = name;
      }));
    }
  }

  for (const card of document.querySelectorAll('#market-list .card[data-cancel-tx]')) {
    const cancelTx = card.dataset.cancelTx;
    if (!cancelTx) continue;
    const cell = card.querySelector('.cancelled-ts');
    if (!cell || cell.textContent.trim()) continue;
    tasks.push(lookup(cancelTx).then((tx) => {
      const t = fmtTime(tx);
      if (t) { cell.classList.remove('muted'); cell.textContent = t; }
    }));
  }

  await Promise.all(tasks);
}

const _activityRefreshBtn = document.getElementById("activity-refresh");
if (_activityRefreshBtn) {
  _activityRefreshBtn.onclick = async () => {
    cachedSpendableIds = []; pickerByR = new Map();
    await populateActingPicker();
    loadMarket();
  };
}

// ---------- init ----------

refreshStatus();
setInterval(refreshStatus, 15000);

// ── Auto-confirm watcher ──────────────────────────────────────────
// Periodically scan: for each local identity, find loan.request entries
// with auto_accept=true. For each, look for a corresponding loan.match
// addressed to that identity. If found and verifyMatchSafety passes,
// auto-fire the accept-v2 click handler (programmatically — same code
// path as the manual button so all checks + side effects happen).
//
// Runs every 30s. Cheap when no auto_accept requests exist (one local
// getidentity per local id). Safe to fire only once per match (we
// track loan.status already on chain — match with existing loan.status
// is excluded by verifyMatchSafety's vault input check).
const _autoAcceptInFlight = new Set();
async function autoAcceptWatcher() {
  try {
    const myIaddrs = await inScopeIaddrs();
    if (myIaddrs.length === 0) return;
    const VDXF_LOAN_REQUEST = "iFg76F9M8CV5xEg3L2NvCDBXufaxjUWhaW";
    const VDXF_LOAN_MATCH   = "i4G69W7e3UJRCinuP7TFBRnm3ZUiXzPkFt";
    const VDXF_LOAN_STATUS  = "iPnrakyY951QEy6xUYBuJoobHA9JKY6G8j";

    for (const ia of myIaddrs) {
      const info = await rpc("getidentity", [ia, -1]).catch(() => null);
      const cm = info?.identity?.contentmultimap || {};

      // Existing loan.status entries on this identity — skip auto-accept
      // for any loan we've already opened.
      const acceptedLoanIds = new Set();
      const acceptedRequestTxids = new Set();
      for (const e of (cm[VDXF_LOAN_STATUS] || [])) {
        const hex = typeof e === "string" ? e : (e?.serializedhex || e?.message || "");
        if (!hex) continue;
        try {
          const j = JSON.parse(new TextDecoder().decode(_hexToBytes(hex)));
          if (j?.loan_id) acceptedLoanIds.add(j.loan_id);
          if (j?.request_txid) acceptedRequestTxids.add(j.request_txid);
        } catch {}
      }

      // Find auto_accept requests
      const autoRequests = [];
      for (const e of (cm[VDXF_LOAN_REQUEST] || [])) {
        const hex = typeof e === "string" ? e : (e?.serializedhex || e?.message || "");
        if (!hex) continue;
        try {
          const json = JSON.parse(new TextDecoder().decode(_hexToBytes(hex)));
          if (!json?.auto_accept || !json?.target_lender_iaddr) continue;
          autoRequests.push(json);
        } catch {}
      }
      if (autoRequests.length === 0) continue;

      // For each auto request, look up the lender's loan.match entries
      // and find one whose request.iaddr matches us.
      for (const req of autoRequests) {
        const lenderIaddr = req.target_lender_iaddr;
        const lenderInfo = await rpc("getidentity", [lenderIaddr, -1]).catch(() => null);
        const lcm = lenderInfo?.identity?.contentmultimap || {};
        for (const e of (lcm[VDXF_LOAN_MATCH] || [])) {
          const hex = typeof e === "string" ? e : (e?.serializedhex || e?.message || "");
          if (!hex) continue;
          try {
            const match = JSON.parse(new TextDecoder().decode(_hexToBytes(hex)));
            // Our match? Only matches whose request.iaddr is us, and
            // not yet accepted.
            if (match.request?.iaddr !== ia) continue;
            const txAtxid = match.tx_a_txid;
            if (!txAtxid) continue;
            if (acceptedLoanIds.has(txAtxid)) continue;
            if (_autoAcceptInFlight.has(txAtxid)) continue;

            // Found a candidate — verify
            const errors = await verifyMatchSafety(match, req, ia);
            if (errors.length > 0) {
              console.warn(`[auto-accept] match for ${ia.slice(0,12)} failed verification:`, errors);
              continue; // Don't auto-cancel; user can manually review in Inbox
            }

            // Verification passed — auto-fire the accept-v2 flow. We do
            // it by setting up the same row state the manual handler
            // uses, then dispatching a synthetic click on its Accept
            // button. That keeps the entire flow on one code path.
            _autoAcceptInFlight.add(txAtxid);
            console.log(`[auto-accept] match for ${ia.slice(0,12)} verified, broadcasting Tx-A…`);
            // Bust the 15s market cache so loadMarket re-fetches and the
            // freshly-confirmed match row is in the DOM before we click.
            invalidateMarketCache();
            await loadMarket();
            const matchKey = `match-${match.match_iaddr || lenderIaddr}-${match.request?.iaddr || ""}`;
            // The accept-v2 button only exists AFTER the outer "accept"
            // button is clicked (it lives inside the .accept-panel which
            // is async-populated). The loans-tab auto-load microtask
            // should fire that click for us, but it races with the
            // watcher. So: click the outer accept button if no v2 yet,
            // then poll for v2 to populate.
            const rowEl = document.querySelector(`.mp-row[data-match-key="${matchKey}"]`);
            if (!rowEl) {
              const allRows = Array.from(document.querySelectorAll('.mp-row[data-match-key]')).map((r) => r.dataset.matchKey);
              const activeTab = document.querySelector('#market [data-mp-tab].active')?.dataset.mpTab || "?";
              console.warn(`[auto-accept] match row not in DOM yet for ${matchKey} | rows: ${allRows.slice(0,3).join(", ")} | tab: ${activeTab}`);
              _autoAcceptInFlight.delete(txAtxid);
              continue;
            }
            const outerBtn = rowEl.querySelector('[data-mp-row-act="accept"]');
            if (outerBtn && !rowEl.querySelector('.accept-panel[data-op-active="1"]')) {
              outerBtn.click();
            }
            // Wait up to 30s for accept-v2 to populate. The accept handler
            // does an async explorer fetch then renders the panel.
            let v2 = null;
            for (let i = 0; i < 30; i++) {
              v2 = rowEl.querySelector('[data-mp-row-act="accept-v2"]');
              if (v2) break;
              await new Promise((r) => setTimeout(r, 1000));
            }
            if (v2) {
              v2.click();
            } else {
              const panelHtml = rowEl.querySelector('.accept-panel')?.innerHTML?.slice(0, 200) || "(empty)";
              console.warn(`[auto-accept] accept-v2 button never appeared for ${matchKey}. panel state: ${panelHtml}`);
              _autoAcceptInFlight.delete(txAtxid);
            }
          } catch (e) {
            console.warn(`[auto-accept] match parse error:`, e);
          }
        }
      }
    }
  } catch (e) {
    console.warn("[auto-accept] watcher error:", e);
  }
}
setInterval(autoAcceptWatcher, 30000);
// Also fire shortly after page load so users don't wait 30s on first run.
setTimeout(autoAcceptWatcher, 5000);
// Critical: populate the picker before firing tab loaders, so they all see
// the same scope. Otherwise loadLoans/loadActivity see "all" and fan out
// across every spendable ID, then a later render with the actual selection
// clobbers them.
populateActingPicker().then(() => {
  loadMarket();
});

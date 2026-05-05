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

const VDXF = {
  "iA1vgVBV5B29h5pxQ67gxqCoEaLDZ8WbmY": { slug: "loan.offer",    label: "Loan offer" },
  "iPmnErqWbf5NhhWZEoccuX8yU8CgFt2d28": { slug: "loan.request",  label: "Loan request" },
  "iBvgGuNNVxEQYCeDD4uPykgrGbWnyTQhGT": { slug: "loan.match",    label: "Loan match" },
  "iP5b6uX8SM7ZSiiMbVWwGj9wG76KuJWZys": { slug: "loan.status",   label: "Loan active" },
  "i4a42EUWLvJTHYGW7F8RifY1Rvs5AQGioY": { slug: "option.offer",  label: "Option offer" },
  "iDE4csgPBx9Rn7H4zkn4VhSShcxcwmknQo": { slug: "option.request",label: "Option request" },
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
  const VDXF_LOAN_REQUEST = "iPmnErqWbf5NhhWZEoccuX8yU8CgFt2d28";
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
}) {
  const FEE = 0.0001;
  // Look up the borrower's input UTXO size to compute change.
  const utxos = await rpc("getaddressutxos", [{ addresses: [borrowerR], currencynames: true }]);
  const u = utxos.find((x) => x.txid === borrowerInputTxid && x.outputIndex === borrowerInputVout);
  if (!u) throw new Error(`UTXO ${borrowerInputTxid.slice(0, 16)}…:${borrowerInputVout} not found at ${borrowerR}`);

  // Resolve currency iaddrs for non-native principal/collateral
  const ccyIaddr = async (name) => {
    if (name === "VRSC") return "i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV";
    return (await rpc("getcurrency", [name]))?.currencyid;
  };
  const principalCcyId  = await ccyIaddr(principalCurrency);
  const collateralCcyId = await ccyIaddr(collateralCurrency);
  if (!principalCcyId || !collateralCcyId) throw new Error("could not resolve currency ids");

  // Borrower's change in the collateral currency (from the same UTXO)
  const utxoAmount = collateralCurrency === "VRSC"
    ? u.satoshis / 1e8
    : parseFloat(u.currencyvalues?.[collateralCurrency] ?? u.currencyvalues?.[collateralCcyId] ?? 0);
  const change = utxoAmount - collateralAmount - FEE;
  if (change < 0) throw new Error(`UTXO too small: have ${utxoAmount} ${collateralCurrency}, need ${collateralAmount + FEE}`);

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
  return `${a.amount ?? "?"} ${a.currency ?? ""}`;
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
        const info = await rpc("getidentity", [card.dataset.iaddr]);
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
    vdxfId = "iPmnErqWbf5NhhWZEoccuX8yU8CgFt2d28";
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
    const info = await rpc("getidentity", [iaddr]);
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
    setTimeout(() => loadIdentities(), 3000);
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
let mpTab = "requests";

document.querySelectorAll('#market [data-mp-tab]').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('#market [data-mp-tab]').forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    mpTab = b.dataset.mpTab;
    loadMarket();
  };
});

// "Show stale" toggle — persist + reload on change.
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
    loadLoans();
    loadActivity();
  };
  iSel.onchange = () => {
    localStorage.setItem(LS_KEY_IADDR, iSel.value);
    loadMarket();
    loadLoans();
    loadActivity();
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
  const reqCount = scopeSet ? reqAll.filter((r) => scopeSet.has(r.iaddr)).length                                          : reqAll.length;
  const offCount = scopeSet ? offAll.filter((r) => scopeSet.has(r.iaddr)).length                                          : offAll.length;
  const mchCount = scopeSet ? mchAll.filter((r) => scopeSet.has(r.match_iaddr) || scopeSet.has(r.request?.iaddr)).length : mchAll.length;
  document.getElementById("ct-requests").textContent = reqCount;
  document.getElementById("ct-matches").textContent  = mchCount;
  document.getElementById("ct-offers").textContent   = offCount;

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
  if (mpTab === "requests") { rows = reqRes.results || []; render = (r) => renderMarketRequest(r, mySet, myMap, acting); }
  else if (mpTab === "offers") { rows = offRes.results || []; render = (r) => renderMarketOffer(r, mySet, myMap, acting); }
  else if (mpTab === "matches") { rows = mchRes.results || []; render = (r) => renderMarketMatch(r, mySet, myMap, acting); }
  else if (mpTab === "comms") { return renderCommsTab(el, acting, myToken); }

  // Strict filter: when a specific ID/R is picked, only show entries that involve them.
  //   - requests: posted by an in-scope iaddr OR directed at an in-scope iaddr
  //     (target_lender_iaddr — for lenders to see directed requests)
  //   - offers: posted by an in-scope iaddr
  //   - matches: posted by in-scope (yours) OR pointing at in-scope (to-you)
  if (acting !== "all" || pickedR() !== "all") {
    const inScope = await inScopeIaddrs();
    const inSet = new Set(inScope);
    if (mpTab === "requests") {
      rows = rows.filter((r) => inSet.has(r.iaddr) || (r.target_lender_iaddr && inSet.has(r.target_lender_iaddr)));
    } else if (mpTab === "offers") {
      rows = rows.filter((r) => inSet.has(r.iaddr));
    } else if (mpTab === "matches") {
      rows = rows.filter((r) => inSet.has(r.match_iaddr) || inSet.has(r.request?.iaddr));
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
  el.innerHTML = rows.map(render).join("");

  // For matches: enrich each row with the linked request's terms + lender's R-balance.
  // Pass myToken so each enrichment can bail if a newer load fires mid-fetch.
  if (mpTab === "matches") enrichMatchRows(myToken);
}

async function enrichMatchRows(token) {
  const rowEls = document.querySelectorAll(".mp-row[data-match-key]");
  for (const rowEl of rowEls) {
    const r = matchByKey.get(rowEl.dataset.matchKey);
    if (!r) continue;
    enrichMatchRowTerms(rowEl, r, token);
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
  cell.innerHTML = `
    <div>You give: <strong>${formatAmount(req.collateral)}</strong> as collateral</div>
    <div>You receive: <strong>${formatAmount(req.principal)}</strong></div>
    <div>You repay: <strong>${formatAmount(req.repay)}</strong> in <strong>${req.term_days ?? "?"} days</strong> (${rate})</div>
  `;
  // Stash the full resolved request keyed by matchKey so the Accept handler
  // can reuse it after subsequent loadMarket re-renders.
  const mKey = `match-${r.match_iaddr}-${r.posted_tx || ""}`;
  matchResolvedRequest.set(mKey, req);
  // Stash collateral currency on the row for the balance enrichment
  rowEl.dataset.collateralCurrency = req.collateral?.currency || "";
  rowEl.dataset.collateralAmount = String(req.collateral?.amount ?? "");
  // Once terms are ready, refresh borrower balance check
  enrichBorrowerCollateralBalance(rowEl, r, token);
}

async function enrichMatchRowBalance(rowEl, r, token) {
  const cell = rowEl.querySelector(".balance-cell");
  if (!cell) return;
  // If the borrower is the acting identity, show THEIR R balance instead of
  // the lender's — the lender's balance isn't useful from the borrower's POV.
  const acting = actingIaddr();
  const actingIsBorrower = acting && acting !== "all" && r.request?.iaddr === acting;
  let address = r.lender_address;
  if (actingIsBorrower) {
    try {
      const info = await rpc("getidentity", [acting]);
      address = (info?.identity?.primaryaddresses || [])[0] || null;
    } catch {}
  }
  if (!address) return;
  let result, error;
  try {
    const bal = await rpc("getaddressbalance", [{ addresses: [address] }]);
    result = `<code>${escapeHtml(address)}</code> · ${fmtBalances(bal?.currencybalance || { VRSC: (bal?.balance ?? 0) / 1e8 })}`;
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
    const info = await rpc("getidentity", [acting]);
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
    <div class="card mp-row" data-iaddr="${escapeHtml(r.iaddr)}" data-name="${escapeHtml(me?.name || "")}" data-parent="${escapeHtml(me?.parent || "")}" data-vdxf="iPmnErqWbf5NhhWZEoccuX8yU8CgFt2d28" data-request-key="${escapeHtml(requestKey)}">
      <div class="row">
        <strong style="flex:1">${escapeHtml(r.fullyQualifiedName || r.name + "@")}</strong>
        <span class="badge loan-request">Loan request</span>
        ${isActing ? `<span class="badge yours" style="margin-left:6px">yours</span>` : mine ? `<span class="badge muted" style="margin-left:6px">local</span>` : ""}
      </div>
      <div class="kv">
        <div><span class="k">borrow</span><span class="v">${formatAmount(r.principal)}</span></div>
        <div><span class="k">collateral</span><span class="v">${formatAmount(r.collateral)}</span></div>
        <div><span class="k">repay</span><span class="v">${formatAmount(r.repay)}</span></div>
        <div><span class="k">term</span><span class="v">${r.term_days ?? "?"} days</span></div>
        <div><span class="k">posted</span><span class="v">block ${r.posted_block}</span></div>
      </div>
      <div class="row" style="margin-top:10px">
        ${mine
          ? `<button class="ghost remove-btn" data-mp-row-act="cancel" style="flex:0 0 auto">Cancel request</button>`
          : `<button class="primary" data-mp-row-act="post-match" style="flex:0 0 auto">Post match — fund this loan</button>`}
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
  return `
    <div class="card mp-row" data-iaddr="${escapeHtml(r.iaddr)}" data-name="${escapeHtml(me?.name || "")}" data-parent="${escapeHtml(me?.parent || "")}" data-vdxf="iA1vgVBV5B29h5pxQ67gxqCoEaLDZ8WbmY">
      <div class="row">
        <strong style="flex:1">${escapeHtml(r.fullyQualifiedName || r.name + "@")}</strong>
        <span class="badge loan-offer">Loan offer</span>
        ${isActing ? `<span class="badge yours" style="margin-left:6px">yours</span>` : mine ? `<span class="badge muted" style="margin-left:6px">local</span>` : ""}
      </div>
      <div class="kv">
        <div><span class="k">max</span><span class="v">${formatAmount(r.max_principal)}</span></div>
        <div><span class="k">accepts</span><span class="v">${(r.accepted_collateral || []).join(", ") || "—"}</span></div>
        <div><span class="k">min ratio</span><span class="v">${r.min_collateral_ratio?.toFixed?.(2) ?? "?"}×</span></div>
        <div><span class="k">rate</span><span class="v">${r.rate != null ? (r.rate * 100).toFixed(1) + "%" : "?"}</span></div>
        <div><span class="k">term</span><span class="v">${r.term_days ?? "?"} days</span></div>
      </div>
      ${mine ? `<div class="row" style="margin-top:10px"><button class="ghost remove-btn" data-mp-row-act="cancel" style="flex:0 0 auto">Cancel offer</button></div>` : ""}
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
    try { actingInfo = await rpc("getidentity", [acting]); } catch {}
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
  const matchKey = `match-${r.match_iaddr}-${r.posted_tx || ""}`;
  matchByKey.set(matchKey, r);
  return `
    <div class="card mp-row" data-iaddr="${escapeHtml(r.match_iaddr)}" data-name="${escapeHtml(me?.name || "")}" data-parent="${escapeHtml(me?.parent || "")}" data-vdxf="iBvgGuNNVxEQYCeDD4uPykgrGbWnyTQhGT" data-match-key="${escapeHtml(matchKey)}">
      <div class="row">
        <strong style="flex:1">From <span style="color:var(--accent)">${escapeHtml(r.fullyQualifiedName || r.name + "@")}</span></strong>
        <span class="badge loan-match">Loan match</span>
        ${isActing ? `<span class="badge yours" style="margin-left:6px">yours</span>`
          : toActing ? `<span class="badge to-you" style="margin-left:6px">← to you</span>`
          : mine ? `<span class="badge muted" style="margin-left:6px">local</span>` : ""}
      </div>
      <div class="match-terms" style="margin-top:8px;padding:10px;border:1px solid var(--border);border-radius:6px;background:rgba(0,0,0,0.15)">
        <div class="muted" style="font-size:11px;margin-bottom:6px">If you accept:</div>
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
        <button class="ghost" data-mp-row-act="message-lender" style="flex:0 0 auto">Send message to lender</button>
      </div>
      <div class="accept-panel" style="display:none;margin-top:10px"></div>
    </div>
  `;
}

// Cancel handler — removes the relevant VDXF entry from the i-address's multimap
document.getElementById("market-list").addEventListener("click", async (ev) => {
  const btn = ev.target.closest('[data-mp-row-act]');
  if (!btn) return;
  const action = btn.dataset.mpRowAct;
  const row = btn.closest(".mp-row");

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
      rpc("getidentity", [r.match_iaddr]).catch(() => null),
      acting && acting !== "all" ? rpc("getidentity", [acting]).catch(() => null) : null,
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
      const borrowerInfo = await rpc("getidentity", [r.iaddr]);
      try {
        const VDXF_LOAN_REQUEST = "iPmnErqWbf5NhhWZEoccuX8yU8CgFt2d28";
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
      const lenderInfo = await rpc("getidentity", [acting]);
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
      const utxos = await rpc("getaddressutxos", [{ addresses: [lenderR], currencynames: true }]);
      const candidates = utxos.filter((u) => {
        const cv = u.currencyvalues || {};
        if (principalCcy === "VRSC" || principalCcy === "i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV") {
          return u.satoshis >= principalSats;
        }
        const have = parseFloat(Object.values(cv)[0] ?? 0);
        // currencyvalues uses the currency i-address as the key — match by name resolved later
        return Object.entries(cv).some(([k, v]) => k && parseFloat(v) >= principalAmt);
      });
      const exact = candidates.find((u) => {
        if (principalCcy === "VRSC") return u.satoshis === principalSats;
        return Object.values(u.currencyvalues || {}).some((v) => parseFloat(v) === principalAmt);
      });
      // Render form with the discovered options.
      panel.innerHTML = `
        <div class="review">
          <strong>Post a pre-signed match for ${escapeHtml(r.fullyQualifiedName || r.name + "@")}</strong>
          <div class="kv" style="margin-top:8px;font-size:12px">
            <div><span class="k">you commit</span><span class="v">${escapeHtml(formatAmount(r.principal))} (principal)</span></div>
            <div><span class="k">borrower commits</span><span class="v">${escapeHtml(formatAmount(r.collateral))} (collateral)</span></div>
            <div><span class="k">repayment</span><span class="v">${escapeHtml(formatAmount(r.repay))} in ${r.term_days ?? "?"} days</span></div>
            <div><span class="k">acting as</span><span class="v">${escapeHtml(lenderInfo?.identity?.fullyqualifiedname || acting)}</span></div>
            <div><span class="k">vault P2SH</span><span class="v"><span class="muted vault-preview">computing…</span></span></div>
          </div>
          ${exact
            ? `<div style="margin-top:10px"><span class="muted" style="font-size:12px">Funding UTXO: <code>${escapeHtml(exact.txid.slice(0, 16))}…:${exact.outputIndex}</code> (exact match) ✓</span></div>`
            : candidates.length
              ? `<div style="margin-top:10px;color:var(--warn);font-size:12px">No exact-amount UTXO. Will split a larger UTXO first via sendcurrency, then post the match.</div>`
              : `<div style="margin-top:10px;color:var(--bad);font-size:12px">No ${escapeHtml(principalCcy)} UTXO at ${escapeHtml(lenderR)} large enough to fund ${escapeHtml(formatAmount(r.principal))}.</div>`}
          ${candidates.length ? `<button class="primary" data-mp-row-act="post-match-go" style="margin-top:10px">${exact ? "Build, sign, post match" : "Split UTXO, then build & post"}</button>` : ""}
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

      btn.textContent = "Finding exact-amount UTXO for principal…";
      // Find or create an exact UTXO for the principal currency. Prefer
      // SINGLE-CURRENCY UTXOs: a multi-currency UTXO would dump its
      // non-principal currencies as Tx-A "fee" because the borrower's
      // signed skeleton doesn't include outputs for them.
      let utxos = await rpc("getaddressutxos", [{ addresses: [lenderR], currencynames: true }]);
      const findExact = () => {
        // ONLY single-currency UTXOs of exactly the principal amount. A
        // multi-currency UTXO would dump its non-principal currencies as
        // "fee" because the borrower's signed skeleton can't accept new
        // outputs. If no single-currency UTXO exists, we MUST split first.
        if (principalCcy !== "VRSC") {
          return utxos.find((u) => {
            const cv = u.currencyvalues || {};
            const keys = Object.keys(cv);
            return u.satoshis === 0 && keys.length === 1 && parseFloat(cv[keys[0]]) === principalAmt;
          });
        }
        return utxos.find((u) => u.satoshis === principalSats && (!u.currencyvalues || Object.keys(u.currencyvalues).length === 0));
      };
      let exact = findExact();
      if (!exact) {
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
      const existing = (lenderInfoCache.get(acting) || (await rpc("getidentity", [acting])).identity)?.contentmultimap || {};
      const VDXF_LOAN_MATCH = "iBvgGuNNVxEQYCeDD4uPykgrGbWnyTQhGT";
      const newMultimap = { ...existing };
      newMultimap[VDXF_LOAN_MATCH] = [payloadHex];

      const updateTxid = await rpc("updateidentity", [{
        name: ds.actingName,
        parent: ds.actingParent,
        contentmultimap: newMultimap,
      }]);
      resultEl.innerHTML = `<div class="muted" style="color:var(--ok)">✓ Match posted with all 3 partials: <a href="https://scan.verus.cx/vrsc/tx/${escapeHtml(updateTxid)}" target="_blank"><code>${escapeHtml(updateTxid)}</code></a><br>Borrower can now click Accept — Tx-A will broadcast and the loan opens self-settling.</div>`;
      btn.style.display = "none";
      invalidateMarketCache();
    } catch (e) {
      resultEl.innerHTML = `<div class="muted" style="color:var(--bad)">✗ ${escapeHtml(e.message)}</div>`;
      btn.disabled = false;
      btn.textContent = "Retry";
    }
    return;
  }

  if (action === "accept") {
    const matchKey = row.dataset.matchKey;
    const r = matchByKey.get(matchKey);
    const panel = row.querySelector(".accept-panel");
    panel.style.display = "block";
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
      const lenderInfo = await rpc("getidentity", [r.match_iaddr]);
      const VDXF_LOAN_MATCH = "iBvgGuNNVxEQYCeDD4uPykgrGbWnyTQhGT";
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
          <li>You repay <strong>${formatAmount(req?.repay)}</strong> within <strong>${req?.term_days ?? "?"} days</strong></li>
          ${isV2 ? `<li>Tx-Repay + Tx-B are pre-signed by lender — you complete the 2-of-2 sigs locally; settlement is unilateral.</li>` : ""}
        </ul>
        ${isV2
          ? `<button class="primary" data-mp-row-act="accept-v2" style="margin-top:6px">Accept &amp; broadcast Tx-A</button>
             <span class="muted" style="font-size:11px;margin-left:8px">Completes 2-of-2 sigs on Tx-Repay/Tx-B, broadcasts Tx-A, posts Tx-B back via loan.status.</span>
             <div class="accept-result" style="margin-top:8px"></div>`
          : hasV1Partial
            ? `<button class="primary" data-mp-row-act="accept-broadcast" style="margin-top:6px">[v1] Broadcast Tx-A — borrow ${escapeHtml(formatAmount(req?.principal))}</button>
               <span class="muted" style="font-size:11px;margin-left:8px">Legacy match: extends Tx-A skeleton + adds collateral. Settlement requires later cosig handshake.</span>
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
    const resultEl = panel.querySelector(".accept-result") || panel;
    btn.disabled = true; btn.textContent = "Verifying match…";
    try {
      // Explorer's typed endpoint strips v2-only fields (e.g., tx_a_full).
      // Re-fetch the raw multimap entry from the lender's iaddr to get them.
      try {
        const lenderInfo = await rpc("getidentity", [r.match_iaddr]);
        const VDXF_LOAN_MATCH = "iBvgGuNNVxEQYCeDD4uPykgrGbWnyTQhGT";
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
      const idInfo = await rpc("getidentity", [acting]);
      const existing = idInfo?.identity?.contentmultimap || {};
      const VDXF_LOAN_STATUS = "iP5b6uX8SM7ZSiiMbVWwGj9wG76KuJWZys";
      const statusPayload = {
        version: 2,
        role: "borrower",
        loan_id: txABroadcastTxid,
        match_iaddr: r.match_iaddr,
        vault_address: r.vault_address,
        vault_redeem_script: r.vault_redeem_script,
        principal: req.principal,
        collateral: req.collateral,
        repay: req.repay,
        maturity_block: r.maturity_block,
        tx_b_complete: bSigned.hex,    // borrower-completed Tx-B for lender's default-claim
        active: true,
      };
      const statusHex = Array.from(new TextEncoder().encode(JSON.stringify(statusPayload)))
        .map((b) => b.toString(16).padStart(2, "0")).join("");
      const newCm = { ...existing };
      newCm[VDXF_LOAN_STATUS] = [...(newCm[VDXF_LOAN_STATUS] || []), statusHex];
      const updateTxid = await rpc("updateidentity", [{
        name: idInfo.identity.name,
        parent: idInfo.identity.parent || "",
        contentmultimap: newCm,
      }]);

      resultEl.innerHTML = `<div class="muted" style="color:var(--ok)">
        ✓ Loan opened end-to-end:<br>
        &nbsp;&nbsp;Tx-A: <a href="https://scan.verus.cx/vrsc/tx/${escapeHtml(txABroadcastTxid)}" target="_blank"><code>${escapeHtml(txABroadcastTxid)}</code></a><br>
        &nbsp;&nbsp;loan.status: <a href="https://scan.verus.cx/vrsc/tx/${escapeHtml(updateTxid)}" target="_blank"><code>${escapeHtml(updateTxid.slice(0,16))}…</code></a><br>
        &nbsp;&nbsp;Tx-Repay stored locally — click Repay anytime to settle.
      </div>`;
      btn.style.display = "none";
    } catch (e) {
      resultEl.innerHTML = `<div class="muted" style="color:var(--bad)">✗ ${escapeHtml(e.message)}</div>`;
      btn.disabled = false;
      btn.textContent = "Retry";
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
      const idInfo = await rpc("getidentity", [acting]);
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
      const info = await rpc("getidentity", [iaddr]);
      const cm = info?.identity?.contentmultimap || {};
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
      setTimeout(() => { loadMarket(); loadIdentities(); loadActivity(); }, 3000);
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
  loadLoans();
  loadActivity();
};

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
    const info = await rpc("getidentity", [iaddr]);
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

async function openMarketPostForm(kind) {
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
      <h3>${kind === "request" ? "Post a loan request" : "Post a loan offer"} from ${escapeHtml(me.fqn)}</h3>
      <div id="mp-id-info" class="muted" style="font-size:12px;margin-bottom:10px">fetching balance…</div>
      ${inner}
    </div>
  `;
  formEl.style.display = "block";
  formEl.dataset.kind = kind;
  await renderActingInfo(me);

  // Option A: no collateral UTXO picker — split happens at preview-request time.
}

async function renderActingInfo(me) {
  const info = document.getElementById("mp-id-info");
  if (!info) return;
  const b = await balanceFor(me.iaddr);
  info.innerHTML = `
    i-address: <code>${escapeHtml(me.iaddr)}</code><br>
    primary R: <code>${escapeHtml(b.primaryR || "—")}</code><br>
    R-address balance: ${fmtBalances(b.rBalance)}<br>
    i-address balance: ${fmtBalances(b.iaddrBalance)}
  `;
  info.dataset.iaddr = me.iaddr;
  info.dataset.name = me.name;
  info.dataset.parent = me.parent || "";
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
      resEl.innerHTML = `<span class="ok">✓ Broadcast: <code>${escapeHtml(txid)}</code></span>`;
      pendingMarketBroadcast = null;
      setTimeout(() => { loadIdentities(); loadMarket(); loadActivity(); }, 3000);
    } catch (e) {
      resEl.innerHTML = `<span class="err">✗ ${escapeHtml(e.message)}</span>`;
    }
    return;
  }

  // Preview path — build payload + the updateidentity command
  const iaddr = idInfo.dataset.iaddr;
  const name = idInfo.dataset.name;
  const parent = idInfo.dataset.parent;
  if (!iaddr) return;

  let slug, vdxfId, payload;
  if (action === "preview-request") {
    slug = "loan.request";
    vdxfId = "iPmnErqWbf5NhhWZEoccuX8yU8CgFt2d28";
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
    try { lenderInfo = await rpc("getidentity", [lenderInput]); } catch {}
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

    // 3. Option A: auto-split a fresh clean collateral UTXO via sendcurrency.
    //    Sends `collateralAmount + 0.0001` to borrower's R, gets a single-currency
    //    UTXO in mempool, uses it immediately (no confirmation wait — Verus
    //    supports chained mempool).
    previewEl.innerHTML = `<div class="review muted">Splitting a fresh ${collateralCurrency} UTXO via sendcurrency…</div>`;
    previewEl.style.display = "block";
    const splitAmount = collateralAmount + 0.0001;  // collateral + Tx-A fee budget
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
    let borrowerInputVout = -1;
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
    const borrowerInputTxid = splitTxid;

    // 4. Compute vault P2SH from both pubkeys
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
      });
    } catch (e) {
      previewEl.innerHTML = `<div class="review" style="color:var(--bad)">✗ Tx-A build/sign failed: ${escapeHtml(e.message)}</div>`;
      previewEl.style.display = "block";
      return;
    }

    payload = {
      version: 2,
      principal:  { currency: principalCurrency,  amount: principalAmount  },
      collateral: { currency: collateralCurrency, amount: collateralAmount },
      repay:      { currency: principalCurrency,  amount: repayAmount      },
      term_days:  termDays,
      target_lender_iaddr:        lenderIaddr,
      borrower_input_signed_hex:  signedHex,
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
  try { existing = (await rpc("getidentity", [iaddr]))?.identity?.contentmultimap || {}; } catch {}
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

async function loadLoans() {
  const el = document.getElementById("loans-list");
  el.textContent = "Loading…";
  const myIaddrs = await inScopeIaddrs();
  if (myIaddrs.length === 0) {
    el.innerHTML = `<div class="empty">No local identities to query.</div>`;
    return;
  }

  const all = await Promise.all(
    myIaddrs.map((ia) =>
      fetch(`${EXPLORER_API}/contracts/loans/active?iaddr=${encodeURIComponent(ia)}`)
        .then((r) => r.json())
        .then((j) => j.results || [])
        .catch(() => [])
    )
  );
  const flat = all.flat();
  if (flat.length === 0) {
    const acting = actingIaddr();
    el.innerHTML = `<div class="empty">No active loans${acting !== "all" ? " for this identity" : " on any local identity"}.</div>`;
    return;
  }
  el.innerHTML = flat.map(renderActiveLoan).join("");
}

function renderActiveLoan(r) {
  return `
    <div class="card">
      <div class="row">
        <strong style="flex:1">${escapeHtml(r.fullyQualifiedName || r.name + "@")}</strong>
        <span class="badge ${r.role}">${escapeHtml(r.role)}</span>
      </div>
      <div class="kv">
        <div><span class="k">counterparty</span><span class="v">${escapeHtml(r.counterparty_iaddr || "—")}</span></div>
        <div><span class="k">vault</span><span class="v">${escapeHtml(r.vault_address || "—")}</span></div>
        <div><span class="k">principal</span><span class="v">${formatAmount(r.principal)}</span></div>
        <div><span class="k">collateral</span><span class="v">${formatAmount(r.collateral)}</span></div>
        <div><span class="k">repay</span><span class="v">${formatAmount(r.repay)}</span></div>
        <div><span class="k">maturity</span><span class="v">block ${r.maturity_block ?? "?"}</span></div>
      </div>
      <div class="row" style="margin-top:10px">
        ${r.role === "borrower"
          ? `<button class="primary" disabled title="Phase C — broadcast pre-signed Tx-Repay">Repay</button>`
          : `<button class="primary" disabled title="Phase C — broadcast Tx-B if past maturity">Claim collateral</button>`}
      </div>
    </div>
  `;
}

document.getElementById("loans-refresh").onclick = async () => {
  cachedSpendableIds = []; pickerByR = new Map();
  await populateActingPicker();
  loadLoans();
};

// ---------- Activity feed ----------

async function loadActivity() {
  const el = document.getElementById("activity-list");
  el.textContent = "Loading…";
  const myIaddrs = await inScopeIaddrs();
  if (myIaddrs.length === 0) {
    el.innerHTML = `<div class="empty">No local identities to query.</div>`;
    return;
  }

  // Fetch full history for each local iaddr (all multimap-touching events, not just current state)
  const all = await Promise.all(
    myIaddrs.map((ia) =>
      Promise.all(
        ["loan.offer", "loan.request", "loan.match", "loan.status"].map((slug) =>
          fetch(`${EXPLORER_API}/identity/events?type=${slug}&iAddress=${encodeURIComponent(ia)}&history=true&pageSize=50`)
            .then((r) => r.json())
            .then((j) => (j.results || []).map((ev) => ({ ...ev, _slug: slug })))
            .catch(() => [])
        )
      ).then((rs) => rs.flat())
    )
  );
  const flat = all.flat();
  // Sort newest first by block then id
  flat.sort((a, b) => (b.chain?.blockHeight ?? 0) - (a.chain?.blockHeight ?? 0));
  if (flat.length === 0) {
    el.innerHTML = `<div class="empty">No contract activity on any local identity yet.</div>`;
    return;
  }
  el.innerHTML = flat.map(renderActivityRow).join("");
}

function renderActivityRow(ev) {
  const slug = ev.type || ev._slug;
  const fqn = ev.source?.fullyQualifiedName || ev.source?.name + "@" || "?";
  const p = ev.entries?.[0]?.decoded;
  let summary = "(undecoded)";
  if (slug === "loan.request" && p?.principal) {
    summary = `Borrow ${formatAmount(p.principal)} · ${formatAmount(p.collateral)} collateral · repay ${formatAmount(p.repay)} / ${p.term_days ?? "?"}d`;
  } else if (slug === "loan.offer" && p) {
    if (p.max_principal) {
      summary = `Up to ${formatAmount(p.max_principal)} · ≥${p.min_collateral_ratio?.toFixed?.(2) ?? "?"}× collateral · ${p.rate != null ? (p.rate*100).toFixed(1) + "%" : "?"} / ${p.term_days ?? "?"}d`;
    } else if (p.principal) {
      summary = `[legacy] Lend ${formatAmount(p.principal)} for ${formatAmount(p.collateral)} · ${p.rate != null ? (p.rate*100).toFixed(1) + "%" : "?"} / ${p.term_days ?? "?"}d`;
    }
  } else if (slug === "loan.match" && p) {
    summary = `Match for request ${p.request?.iaddr?.slice(0,12) || "?"}… · vault ${p.vault_address?.slice(0,12) || "?"}…`;
  } else if (slug === "loan.status" && p) {
    summary = `${p.role} · ${formatAmount(p.principal)} → repay ${formatAmount(p.repay)} · ${p.settled ? "SETTLED" : "active"}`;
  }
  const ts = ev.chain?.timestamp ? new Date(ev.chain.timestamp).toISOString().slice(0, 16).replace("T", " ") : "—";
  const txid = ev.chain?.txid || "";
  return `
    <div class="card">
      <div class="row" style="margin-bottom:6px">
        <strong style="flex:1">${escapeHtml(fqn)}</strong>
        <span class="badge ${slug.replace('.','-')}">${escapeHtml(slug)}</span>
      </div>
      <div class="muted" style="font-size:13px">${escapeHtml(summary)}</div>
      <div class="kv" style="margin-top:6px;font-size:12px">
        <div><span class="k">block</span><span class="v">${ev.chain?.blockHeight ?? "?"} · ${escapeHtml(ts)} UTC</span></div>
        <div><span class="k">tx</span><span class="v"><a href="https://scan.verus.cx/vrsc/tx/${escapeHtml(txid)}" target="_blank">${escapeHtml(txid.slice(0,18))}…</a></span></div>
      </div>
    </div>
  `;
}

document.getElementById("activity-refresh").onclick = async () => {
  cachedSpendableIds = []; pickerByR = new Map();
  await populateActingPicker();
  loadActivity();
};

// ---------- init ----------

refreshStatus();
setInterval(refreshStatus, 15000);
// Critical: populate the picker before firing tab loaders, so they all see
// the same scope. Otherwise loadLoans/loadActivity see "all" and fan out
// across every spendable ID, then a later render with the actual selection
// clobbers them.
populateActingPicker().then(() => {
  loadMarket();
  loadLoans();
  loadActivity();
});

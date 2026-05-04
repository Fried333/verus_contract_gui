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
  //   - requests/offers: posted by an in-scope iaddr
  //   - matches: posted by in-scope (yours) OR pointing at in-scope (to-you)
  if (acting !== "all" || pickedR() !== "all") {
    const inScope = await inScopeIaddrs();
    const inSet = new Set(inScope);
    if (mpTab === "requests" || mpTab === "offers") {
      rows = rows.filter((r) => inSet.has(r.iaddr));
    } else if (mpTab === "matches") {
      rows = rows.filter((r) => inSet.has(r.match_iaddr) || inSet.has(r.request?.iaddr));
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
    // Look up the linked request — try current state first, then history.
    // Use cache-first: matches don't change once posted, so localStorage hits
    // skip the network entirely on subsequent loads.
    const cur = await fetchJsonWithRetry(`${EXPLORER_API}/contracts/loans/requests?iaddr=${encodeURIComponent(r.request.iaddr)}&include_inactive=true&pageSize=10`, { useCacheFirst: true });
    if (cur) {
      req = (cur.results || []).find((x) => !r.request.txid || x.posted_tx === r.request.txid) || (cur.results || [])[0];
    }
    if (!req) {
      // Fallback: pull from history (the request may have been removed from current state)
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
  return `
    <div class="card mp-row" data-iaddr="${escapeHtml(r.iaddr)}" data-name="${escapeHtml(me?.name || "")}" data-parent="${escapeHtml(me?.parent || "")}" data-vdxf="iPmnErqWbf5NhhWZEoccuX8yU8CgFt2d28">
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
          : `<button class="primary" disabled title="Phase C — partial Tx-A construction">Set up loan</button>
             <button class="ghost"   disabled title="Phase C — encrypted z-memo via privateaddress">Contact</button>`}
      </div>
    </div>
  `;
}

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

  if (action === "accept") {
    const matchKey = row.dataset.matchKey;
    const r = matchByKey.get(matchKey);
    const panel = row.querySelector(".accept-panel");
    panel.style.display = "block";
    panel.innerHTML = `<div class="review muted">looking up request terms…</div>`;
    // Pull the linked request to know the exact amounts
    let req = null;
    try {
      const cur = await fetchJsonWithRetry(`${EXPLORER_API}/contracts/loans/requests?iaddr=${encodeURIComponent(r.request.iaddr)}&include_inactive=true&pageSize=10`, { useCacheFirst: true });
      if (cur) req = (cur.results || []).find((x) => !r.request.txid || x.posted_tx === r.request.txid) || (cur.results || [])[0];
      if (!req) {
        const hist = await fetchJsonWithRetry(`${EXPLORER_API}/identity/events?type=loan.request&iAddress=${encodeURIComponent(r.request.iaddr)}&history=true&pageSize=20`, { useCacheFirst: true });
        if (hist) {
          const ev = (hist.results || []).find((x) => !r.request.txid || x.chain?.txid === r.request.txid) || (hist.results || [])[0];
          const p = ev?.entries?.[0]?.decoded;
          if (p) req = { principal: p.principal, collateral: p.collateral, repay: p.repay, term_days: p.term_days };
        }
      }
    } catch {}
    panel.innerHTML = `
      <div class="review">
        <strong>If you accept this match…</strong>
        <ul style="margin:6px 0 6px 18px;font-size:13px">
          <li>Lender ${escapeHtml(r.fullyQualifiedName || r.name + "@")} commits <strong>${formatAmount(req?.principal)}</strong> to your address (per pre-signed Tx-A)</li>
          <li>You commit <strong>${formatAmount(req?.collateral)}</strong> to vault <code>${escapeHtml(r.vault_address)}</code></li>
          <li>You repay <strong>${formatAmount(req?.repay)}</strong> within <strong>${req?.term_days ?? "?"} days</strong></li>
          <li>Pre-signed Tx-Repay (cooperative) and Tx-B (default-after-maturity) are usable for either path</li>
        </ul>
        <strong style="color:var(--warn)">Acceptance not yet implemented in this build.</strong>
        <div class="muted" style="font-size:11px;margin-top:4px">
          Reason: this match's pre-signed templates are placeholder hex (Phase C makeoffer integration pending — DAI.vETH cryptocondition currencies don't support ANYONECANPAY signing).
        </div>
      </div>
    `;
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
      <button class="primary" data-mp-do="preview-request" style="flex:0 0 auto">Preview</button>
      <button class="ghost"   data-mp-do="cancel" style="flex:0 0 auto">Cancel</button>
    </div>
    <div class="preview" style="display:none;margin-top:12px"></div>
  `;
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
    payload = {
      version: 1,
      principal:  { currency: principalCurrency,        amount: parseFloat(f("principal_amount"))  },
      collateral: { currency: f("collateral_currency"), amount: parseFloat(f("collateral_amount")) },
      repay:      { currency: principalCurrency,        amount: parseFloat(f("repay_amount"))      },
      term_days:  parseInt(f("term_days"), 10),
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

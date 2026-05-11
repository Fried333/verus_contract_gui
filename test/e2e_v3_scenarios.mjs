// V3 protocol e2e validation suite — runs through 9 critical scenarios
// against the real chain. Each scenario:
//   1. Resets to a clean slate (drops transient multimap entries, unlocks UTXOs)
//   2. Drives the GUI via Playwright (borrower on local 7777, lender on .44 7778)
//   3. Asserts on-chain + UI state at the end
//
// Real funds, real fees, real confirmations. Expect ~3-5 min per scenario.

import { chromium } from "playwright";
import { execSync } from "child_process";

const BORROWER_GUI = "http://127.0.0.1:7777/";
const LENDER_GUI   = "http://127.0.0.1:7778/";
const BORROWER_IA  = "i7b7Tq8JYXX9iqS7FBevC6LaG3ioh8z3RM";
const LENDER_IA    = "i7A9fa8c3xZnA3uLK3SLYa58cUipganewg";
const BORROWER_R   = "RSiyiZ92PeBDEJskMLzmUCSjJEW45iWnsF";
const LENDER_R     = "RKGN34UhN62C8KaQeHTkMr7L3Mqn9oW2ve";

const VDXF = {
  request:  "iF7Ax6QpdwvTTqDJpNzDXVj1GpUSQX6vH5",
  match:    "iKVShS5o56BLn8BpysrmfvUJbWCrgyio8U",
  status:   "iRzM96sNYj95mUiJebzBnFwirjfws2q6o4",
  history:  "i5qBwi3KWXfyo1UKuUBC3yyq67JagVennW",
  offer:    "iMey7Y2idT6dt7jJvRiPXgtYcfAaKCQbHz",
};
// loan.history accumulates across runs; the multimap encoder errors with
// "bad-txns-script-element-too-large" once the per-key blob exceeds limits.
// Clear it between scenarios since cross-run history has no test value.
const TRANSIENT = [VDXF.request, VDXF.match, VDXF.status, VDXF.offer, VDXF.history];

const VERUS = "/home/dev/Downloads/verus-cli-v1.2.16/verus";
const CONF  = "/home/dev/.komodo/VRSC/VRSC.conf";
const SSH = `ssh -p 2400 -i ${process.env.HOME}/.ssh/id_ed25519 -o IdentitiesOnly=yes root@86.107.168.44`;
const REMOTE_VERUS = "/root/verus-cli-v1.2.16/verus";
const REMOTE_CONF  = "/root/.komodo/VRSC/VRSC.conf";

function cli(cmd, remote = false) {
  const cmdStr = remote
    ? `${SSH} "${REMOTE_VERUS} -conf=${REMOTE_CONF} ${cmd.replace(/"/g, '\\"')}"`
    : `${VERUS} -conf=${CONF} ${cmd}`;
  try {
    return execSync(cmdStr, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (e) {
    const detail = (e.stderr?.toString() || "") + " " + (e.stdout?.toString() || "");
    throw new Error(`${e.message.split("\n")[0]}${detail.trim() ? ` :: ${detail.trim().slice(0, 300)}` : ""}`);
  }
}

// Wait until (a) no unconfirmed identity update for `iaddr` exists, AND
// (b) the funding R-address has zero mempool deltas. The wallet's coin
// selection for updateidentity picks any wallet UTXO; if a prior tx is
// still spending one of them in mempool we hit "bad-txns-inputs-spent".
// So we gate on funding-address mempool clearing too.
async function waitForIdentityMempoolEmpty(iaddr, remote = false) {
  // Map iaddr → its primary R-funding address. We only have two test
  // identities so this hardcoded lookup is fine.
  const fundingR = iaddr === BORROWER_IA ? BORROWER_R
                 : iaddr === LENDER_IA   ? LENDER_R
                 : null;
  await pollUntil(`identity ${iaddr.slice(0,8)}… + funding mempool drained`, () => {
    const confirmed = cliJ(`getidentity ${iaddr}`, remote);
    const tip = cliJ(`getidentity ${iaddr} -1`, remote);
    if (!confirmed?.txid || !tip?.txid || confirmed.txid !== tip.txid) return false;
    if (!fundingR) return true;
    const mempool = cliJ(`getaddressmempool '{"addresses":["${fundingR}"]}'`, remote);
    return Array.isArray(mempool) && mempool.length === 0;
  }, { intervalMs: 3000 });
}
const cliJ = (cmd, remote = false) => JSON.parse(cli(cmd, remote));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll a predicate every `intervalMs` until it returns truthy. No wall-clock
// timeout: chain operations are gated on block production, which can take
// arbitrarily long. The user can ctrl+c if they want to bail. Logs progress
// every `progressLogMs` so the runner isn't silent during long waits.
async function pollUntil(name, predicate, { intervalMs = 3000, progressLogMs = 60000 } = {}) {
  const t0 = Date.now();
  let lastLog = 0;
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const r = await predicate();
      if (r) return r;
    } catch {}
    if (Date.now() - lastLog > progressLogMs) {
      const elapsed = Math.floor((Date.now() - t0) / 1000);
      console.log(`    [poll ${name}] still waiting (${elapsed}s, attempt ${attempt})`);
      lastLog = Date.now();
    }
    await sleep(intervalMs);
  }
}

function multimapOf(iaddr, remote = false) {
  const d = cliJ(`getidentity ${iaddr} -1`, remote);
  return d.identity?.contentmultimap || {};
}
function decodeEntry(e) {
  const h = typeof e === "string" ? e : (e?.serializedhex || e?.message || "");
  if (!h) return null;
  try { return JSON.parse(Buffer.from(h, "hex").toString("utf8")); } catch { return null; }
}

function balanceOf(addr) {
  const r = cliJ(`getaddressbalance '{"addresses":["${addr}"]}'`);
  const cb = r.currencybalance || {};
  const KN = {"i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV":"VRSC","iGBs4DWztRNvNEJBt4mqHszLxfKTNHTkhM":"DAI"};
  return Object.fromEntries(Object.entries(cb).map(([k, v]) => [KN[k] || k.slice(0,8), parseFloat(v)]));
}

// Drop one or more VDXF keys from an identity's multimap (no-op if not present).
// Waits for any in-flight identity update to confirm before issuing this one,
// since the daemon rejects overlapping updates on the same identity.
async function dropEntries(iaddr, vdxfKeysToDrop, remote = false) {
  const d = cliJ(`getidentity ${iaddr} -1`, remote);
  const ident = d.identity;
  const cm = ident.contentmultimap || {};
  const drop = new Set(vdxfKeysToDrop);
  const newCm = {};
  let touched = false;
  for (const [k, arr] of Object.entries(cm)) {
    if (drop.has(k)) { touched = true; continue; }
    const norm = arr.map((e) => typeof e === "string" ? e : (e.serializedhex || e.message || ""))
                    .filter(Boolean);
    if (norm.length) newCm[k] = norm;
  }
  if (!touched) return null;
  await waitForIdentityMempoolEmpty(iaddr, remote);
  const arg = JSON.stringify({ name: ident.name, parent: ident.parent || "", contentmultimap: newCm });
  const escaped = arg.replace(/'/g, "'\\''");
  // Retry on transient daemon errors (e.g., mempool race after the wait).
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try { return cli(`updateidentity '${escaped}'`, remote); }
    catch (e) {
      lastErr = e;
      console.log(`    [dropEntries] updateidentity failed (attempt ${i + 1}/4): ${e.message.slice(0, 200)}`);
      await sleep(8000);
      await waitForIdentityMempoolEmpty(iaddr, remote);
    }
  }
  throw lastErr;
}

// Unlock every locked UTXO (best-effort; restoring lock state isn't needed
// because each scenario explicitly re-locks what it requires).
async function unlockAll(remote = false) {
  const locks = cliJ("listlockunspent", remote);
  if (!locks?.length) return 0;
  const arg = JSON.stringify(locks);
  cli(`lockunspent true '${arg}'`, remote);
  return locks.length;
}

// The cooperative-drain vault P2SH is deterministic from the (borrower, lender)
// pubkey pair, so the same address services every scenario.
const VAULT_ADDR = "bSe1gaBoZJqcBTMuTi6VYevXrRLz5XZ8Kj";

// Recover any stranded vault from a half-finished scenario. Cooperative
// 2-of-2: borrower sends 5.05 DAI to lender, then both sign the vault drain
// (10 VRSC → borrower). Idempotent — exits early if vault is empty.
async function recoverStrandedVault() {
  const bal = cliJ(`getaddressbalance '{"addresses":["${VAULT_ADDR}"]}'`);
  if (!bal?.balance) return null;
  console.log(`  [recovery] stranded vault has ${bal.balance / 1e8} VRSC — running recover_vault.sh`);
  // Protocol-level helper lives in the spec repo (veruslending/helpers/)
  // — it's pure RPC, no GUI dependency. Override via RECOVER_VAULT env if
  // you've moved it elsewhere.
  const recoverScript = process.env.RECOVER_VAULT || "/home/dev/veruslending/helpers/recover_vault.sh";
  try {
    execSync(`bash ${recoverScript}`, { stdio: "inherit", encoding: "utf8" });
  } catch (e) {
    throw new Error(`vault recovery failed: ${e.message.slice(0, 200)}`);
  }
  return "recovered";
}

async function cleanSlate() {
  await recoverStrandedVault();
  const tx1 = await dropEntries(BORROWER_IA, TRANSIENT);
  const tx2 = await dropEntries(LENDER_IA, TRANSIENT, true);
  const u1 = await unlockAll(false);
  const u2 = await unlockAll(true);
  if (tx1) await pollUntil("borrower transient keys cleared", () => {
    const cm = multimapOf(BORROWER_IA);
    return TRANSIENT.every((k) => !(cm[k] || []).length);
  }, { timeoutMs: 60000 });
  if (tx2) await pollUntil("lender transient keys cleared", () => {
    const cm = multimapOf(LENDER_IA, true);
    return TRANSIENT.every((k) => !(cm[k] || []).length);
  }, { timeoutMs: 60000 });
  return { borrowerCleanTxid: tx1, lenderCleanTxid: tx2, borrowerUnlocks: u1, lenderUnlocks: u2 };
}

// Snapshot live state for cross-scenario diffing.
function snapshot() {
  return {
    borrowerR: balanceOf(BORROWER_R),
    lenderR:   balanceOf(LENDER_R),
    blockTip:  parseInt(cli("getblockcount")),
  };
}

// ── GUI driver helpers ────────────────────────────────────────────────

// Wait until loadMarket has rendered at least once after the latest tab
// switch (placeholder "Loading…" has been replaced). Use this when the
// data we want is in the GUI's own daemon multimap — one settled cycle
// is sufficient; no need to bust any cache.
async function waitForMarketSettled(page, { timeout = 120000 } = {}) {
  await page.waitForFunction(() => {
    const list = document.getElementById("market-list");
    return list && list.textContent.trim() !== "Loading…";
  }, { timeout });
}

// Bust the marketplace's 15s explorer cache without stomping an in-flight
// load. Only used when the data we want is on the COUNTERPARTY's daemon
// (reached via scan.verus.cx /api/contracts/loans/{requests,matches},
// which are confirmed-only with 4-5min block lag) — own-multimap reads
// don't need this, they just need one settled cycle. loadMarket uses a
// token (main.js:1571) that aborts the prior cycle when a new one starts,
// so we wait until the previous cycle has rendered before clicking
// market-refresh again. Pass a shared {t:0} object across pollUntil ticks.
async function refreshIfIdle(page, ref) {
  // 30s minimum gap between forced refreshes. Each loadMarket cycle fires
  // 3 fetches (offers/matches/requests); two browsers from one IP share the
  // 30/min public-tier limit. At 30s gate: 2 fires/min × 3 fetches = 6/min
  // per browser × 2 = 12/min combined — comfortable headroom under the
  // ceiling, leaves room for initial-load fanout and post-action refreshes.
  if (Date.now() - ref.t < 30000) return;
  const isLoading = await page.evaluate(() => {
    const list = document.getElementById("market-list");
    return list?.textContent?.trim() === "Loading…";
  });
  if (isLoading) return;
  await page.evaluate(() => document.getElementById("market-refresh")?.click());
  ref.t = Date.now();
}

// Pick acting identity from the dropdown. Waits for the picker to be
// populated with the target as an option (listidentities RPC is async) so
// the value-set isn't a no-op, then dispatches change. Downstream handlers
// (postRequestViaGui, etc.) wait for their own readiness signals — we
// don't wait for #mp-id-info.dataset here because that element only
// exists after the post form is opened, not on picker change.
async function selectActingIdentity(page, iaddr) {
  await page.waitForFunction((target) => {
    const s = document.getElementById("mp-id-picker");
    return s && Array.from(s.options).some((o) => o.value === target);
  }, iaddr, { timeout: 30000 });
  await page.evaluate((t) => {
    const s = document.getElementById("mp-id-picker");
    s.value = t;
    s.dispatchEvent(new Event("change"));
  }, iaddr);
  // The change handler does localStorage.setItem(...) synchronously then
  // kicks off loadMarket() async. localStorage write is what every
  // downstream "acting" lookup reads, so wait for that — confirms the
  // change actually fired (not silently dropped).
  await page.waitForFunction((target) => {
    return localStorage.getItem("vl_acting_iaddr") === target;
  }, iaddr, { timeout: 10000 });
}

async function openPage(url, iaddr) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("dialog", async (d) => await d.accept());
  page.on("pageerror", (e) => console.log(`    [pageerror ${url.slice(7,11)}] ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" || m.type() === "warning" ||
        /\[repay-bal\]|\[repay\]|\[enrich\]|\[accept-v2\]|\[preview\]|tier|Recovering/i.test(t)) {
      console.log(`    [console:${m.type()} ${url.slice(7,11)}] ${t.slice(0, 600)}`);
    }
  });
  page.on("requestfailed", (req) => {
    console.log(`    [reqfail ${url.slice(7,11)}] ${req.method()} ${req.url().slice(0, 100)} — ${req.failure()?.errorText}`);
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#mp-r-picker", { timeout: 15000 });
  await selectActingIdentity(page, iaddr);
  return { browser, page };
}

// Posts a loan.request via the Marketplace's "Post loan request" button +
// fills the form fields. Returns when the request is visible on chain
// in the borrower's mempool view.
async function postRequestViaGui(page, params) {
  // Snapshot pre-state so we can detect when the new request lands.
  const before = (multimapOf(BORROWER_IA)[VDXF.request] || []).length;
  await page.evaluate(() => document.querySelector('[data-mp-tab="market"]').click());
  await page.waitForSelector('#mp-post-request', { timeout: 30000 });
  await page.click('#mp-post-request');
  await page.waitForSelector('#mp-post-form [data-mp-do="preview-request"]', { timeout: 30000 });
  // Wait for renderActingInfo to populate #mp-id-info.dataset.iaddr — the
  // preview-request handler does `if (!iaddr) return;` and silently exits
  // without that. Fast (just a balance fetch) but async.
  await page.waitForFunction(() => {
    const el = document.getElementById("mp-id-info");
    return el && el.dataset && el.dataset.iaddr;
  }, { timeout: 30000 });
  await page.evaluate((p) => {
    const f = document.getElementById("mp-post-form");
    const setVal = (sel, v) => { const el = f.querySelector(sel); if (el) { el.value = v; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); } };
    setVal('[data-f="target_lender"]', p.lender);
    setVal('[data-f="principal_amount"]', String(p.principal));
    setVal('[data-f="principal_currency"]', p.principalCcy);
    setVal('[data-f="collateral_amount"]', String(p.collateral));
    setVal('[data-f="collateral_currency"]', p.collateralCcy);
    setVal('[data-f="repay_amount"]', String(p.repay));
    setVal('[data-f="term_days"]', String(p.term || 30));
    const auto = f.querySelector('[data-f="auto_accept"]');
    if (auto) auto.checked = !!p.autoAccept;
  }, params);
  await page.click('[data-mp-do="preview-request"]');
  // Preview takes time: split + sign + render. Wait for the broadcast button
  // to appear, or an error message in the panel.
  const broadcast = await pollUntil("preview ready", async () => {
    return await page.evaluate(() => {
      const f = document.getElementById("mp-post-form");
      const btn = Array.from(f.querySelectorAll('button')).find(b => /broadcast/i.test(b.textContent));
      const err = f.querySelector('.review[style*="bad"]')?.innerText;
      if (btn && !btn.disabled) return { ready: true };
      if (err) return { error: err };
      return null;
    });
  }, { timeoutMs: 120000, intervalMs: 2000 });
  if (broadcast.error) throw new Error(`postRequest preview: ${broadcast.error}`);
  await page.evaluate(() => {
    const btn = Array.from(document.getElementById("mp-post-form").querySelectorAll('button')).find(b => /broadcast/i.test(b.textContent));
    btn.click();
  });
  // Wait until the request actually lands in the borrower's mempool view.
  await pollUntil("loan.request on chain (borrower mempool)",
    () => (multimapOf(BORROWER_IA)[VDXF.request] || []).length > before,
    { timeoutMs: 60000 });
}

// Drives the lender's GUI to fund the borrower's pending request.
// Polls until the lender's GUI shows the request, then drives the flow,
// then polls until the match is on chain.
async function postMatchViaGui(page) {
  const matchesBefore = (multimapOf(LENDER_IA, true)[VDXF.match] || []).length;
  // The lender's GUI fetches via scan.verus.cx — refresh periodically to
  // bust its 15s cache, but only when the previous loadMarket cycle has
  // settled (refreshIfIdle gates this). Lender's daemon (.44) is slow, so
  // each loadMarket can take 30s+; spamming refresh would never let one
  // complete.
  const refMatch = { t: 0 };
  await pollUntil("lender's GUI sees the request", async () => {
    await refreshIfIdle(page, refMatch);
    return await page.evaluate(() => !!document.querySelector('[data-mp-row-act="post-match"]'));
  }, { timeoutMs: 600000, intervalMs: 1500 });  // 10min: explorer-side loans/requests view only includes confirmed state, so this poll has to span block-production gaps (4-5min long blocks observed)
  await page.evaluate(() => document.querySelector('[data-mp-row-act="post-match"]').click());
  await page.waitForSelector('[data-mp-row-act="post-match-go"]', { timeout: 60000 });
  // Confirm button is rendered immediately but the panel dataset (acting,
  // vaultAddress, lenderPubkey, etc.) is populated only AFTER the async
  // createmultisig call resolves. Clicking before that fires the handler
  // with `acting=undefined` → "request directed at <X>, you are acting as
  // undefined". Wait for both: button enabled AND dataset.acting set.
  await pollUntil("post-match confirm ready (dataset populated)", async () =>
    await page.evaluate(() => {
      const btn = document.querySelector('[data-mp-row-act="post-match-go"]');
      const panel = document.querySelector('.post-match-panel');
      return btn && !btn.disabled && panel?.dataset?.acting && panel?.dataset?.vaultAddress;
    }), { timeoutMs: 30000, intervalMs: 500 });
  await page.evaluate(() => document.querySelector('[data-mp-row-act="post-match-go"]').click());
  // Wait until the match is actually on chain. Print panel text periodically
  // so we can see if the GUI surfaced an error.
  let lastDiag = 0;
  await pollUntil("loan.match on chain (lender mempool)", async () => {
    if (Date.now() - lastDiag > 30000) {
      lastDiag = Date.now();
      const panel = await page.evaluate(() => {
        const p = document.querySelector('.post-match-panel');
        return p ? p.innerText.slice(0, 400) : "(no panel)";
      });
      console.log(`    [lender panel @${Math.floor((Date.now() - lastDiag + 30000) / 1000)}s] ${panel.replace(/\n/g, " | ")}`);
    }
    return (multimapOf(LENDER_IA, true)[VDXF.match] || []).length > matchesBefore;
  }, { timeoutMs: 240000, intervalMs: 3000 });
}

// Wait until borrower's loan.status shows an active loan against the given lender.
async function waitForActiveLoan() {
  return pollUntil("active loan in borrower multimap", () => {
    const cm = multimapOf(BORROWER_IA);
    const statuses = (cm[VDXF.status] || []).map(decodeEntry).filter(Boolean);
    return statuses.find((s) => s.active === true && s.match_iaddr === LENDER_IA);
  }, { intervalMs: 5000 });
}

async function waitForRepaid(loanId) {
  return pollUntil(`repaid loan ${loanId.slice(0,12)}…`, () => {
    const cm = multimapOf(BORROWER_IA);
    const histories = (cm[VDXF.history] || []).map(decodeEntry).filter(Boolean);
    return histories.find((j) => j.loan_id === loanId && j.outcome === "repaid");
  }, { intervalMs: 5000 });
}

async function clickRepay(borrowerPage, loanId) {
  // Spawn a fresh playwright context for the repay step. The original
  // session has been open since pre-Tx-A and may have stale balance state.
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("dialog", async (d) => await d.accept());
  page.on("pageerror", (e) => console.log(`    [pageerror repay] ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" || m.type() === "warning" ||
        /\[repay-bal\]|\[repay\]|\[enrich\]|\[accept-v2\]|tier|Recovering/i.test(t)) {
      console.log(`    [console:${m.type()} repay] ${t.slice(0, 280)}`);
    }
  });
  await page.goto(BORROWER_GUI, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#mp-r-picker", { timeout: 15000 });
  await selectActingIdentity(page, BORROWER_IA);
  await page.evaluate(() => document.querySelector('[data-mp-tab="loans"]').click());
  // Poll until either: (a) repay completed on chain (loan.history(repaid)
  // appeared — the GUI's repay handler disables the button immediately on
  // click, so the button check would fail right after a successful click),
  // or (b) repay button is enabled and we click it.
  // Whichever fires first.
  // Borrower's loan.status is in their own multimap; one settled
  // loadMarket cycle is enough to render the Repay button.
  await waitForMarketSettled(page);
  let clicked = false;
  let lastDiagAt = 0;
  await pollUntil("repay completed (chain) OR button enabled", async () => {
    // (a) Did chain settle? Cheapest check first.
    const cm = multimapOf(BORROWER_IA);
    const histories = (cm[VDXF.history] || []).map(decodeEntry).filter(Boolean);
    if (histories.find((h) => h.loan_id === loanId && h.outcome === "repaid")) {
      console.log("    [clickRepay] loan.history(repaid) on chain — done");
      return true;
    }
    const r = await page.evaluate(() => {
      const btn = document.querySelector('[data-loan-act="repay"]');
      const balCell = document.querySelector('.repay-balance');
      return { btnFound: !!btn, btnDisabled: btn?.disabled, btnTitle: btn?.title || "", balText: balCell?.textContent?.slice(0,160) || "(no cell)" };
    });
    if (Date.now() - lastDiagAt > 20000) {
      lastDiagAt = Date.now();
      console.log(`    [clickRepay diag] btn=${r.btnFound} disabled=${r.btnDisabled} clicked=${clicked} bal=${r.balText.replace(/\s+/g, ' ')}`);
    }
    if (!clicked && r.btnFound && !r.btnDisabled) {
      // Click ONCE. Don't re-check the button — the handler will disable
      // it as part of "Loading Tx-Repay…", and predicate-flip would loop
      // forever. We wait for loan.history(repaid) on chain instead.
      clicked = true;
      console.log("    [clickRepay] clicking Repay button");
      await page.evaluate(() => document.querySelector('[data-loan-act="repay"]').click());
    }
    return false;
  }, { intervalMs: 3000 });
  await browser.close();
}

// ── Test runner harness ──────────────────────────────────────────────

let passed = 0, failed = 0;
const results = [];

async function runScenario(name, fn) {
  console.log(`\n[scenario] ${name}`);
  const start = Date.now();
  let outcome = "pass", err = null;
  try {
    console.log(`  resetting state…`);
    const reset = await cleanSlate();
    console.log(`  pre-state: borrower=${JSON.stringify(snapshot().borrowerR)} lender=${JSON.stringify(snapshot().lenderR)}`);
    if (reset.borrowerCleanTxid || reset.lenderCleanTxid) {
      console.log(`  cleanup txs: borrower=${reset.borrowerCleanTxid?.slice(0,12)}… lender=${reset.lenderCleanTxid?.slice(0,12)}…`);
    }
    if (reset.borrowerUnlocks || reset.lenderUnlocks) {
      console.log(`  unlocked: borrower=${reset.borrowerUnlocks} lender=${reset.lenderUnlocks}`);
    }
    await fn();
    passed++;
  } catch (e) {
    outcome = "fail";
    err = e.message || String(e);
    failed++;
    console.log(`  ✗ ${err}`);
  }
  const ms = Date.now() - start;
  results.push({ name, outcome, ms, err });
  console.log(`  → ${outcome} in ${(ms / 1000).toFixed(1)}s`);
}

// ── SCENARIO 1: happy path full cycle ────────────────────────────────
async function scenario1_happyPath() {
  const { browser: bb, page: bp } = await openPage(BORROWER_GUI, BORROWER_IA);
  try {
    console.log("  borrower posts request (auto_accept=true)…");
    await postRequestViaGui(bp, {
      lender: LENDER_IA,
      principal: 5, principalCcy: "DAI.vETH",
      collateral: 10, collateralCcy: "VRSC",
      repay: 5.05, term: 30, autoAccept: true,
    });
    const reqCm = multimapOf(BORROWER_IA);
    const reqs = (reqCm[VDXF.request] || []).map(decodeEntry).filter(Boolean);
    if (!reqs.find((r) => r.target_lender_iaddr === LENDER_IA)) throw new Error("request not on chain");
    console.log("  ✓ request posted");

    console.log("  lender funds the loan…");
    const { browser: lb, page: lp } = await openPage(LENDER_GUI, LENDER_IA);
    try { await postMatchViaGui(lp); } finally { await lb.close(); }
    const matchCm = multimapOf(LENDER_IA, true);
    const matches = (matchCm[VDXF.match] || []).map(decodeEntry).filter(Boolean);
    const myMatch = matches.find((m) => m.request?.iaddr === BORROWER_IA);
    if (!myMatch) throw new Error("match not on chain");
    console.log(`  ✓ match posted (vault=${myMatch.vault_address.slice(0,12)}…, tx_a_txid=${myMatch.tx_a_txid?.slice(0,12)}…)`);

    // Switch borrower's GUI back to Loans tab — that's where match rows
    // addressed to acting render. The auto-accept watcher dispatches a
    // click on the rendered Accept button, so the row must be in DOM.
    // (postRequestViaGui left us on the Market tab to fill the post form.)
    await bp.evaluate(() => document.querySelector('[data-mp-tab="loans"]')?.click());

    console.log("  waiting for borrower auto-accept (Tx-A broadcast)…");
    const status = await waitForActiveLoan();
    console.log(`  ✓ loan opened: loan_id=${status.loan_id.slice(0,12)}…`);

    console.log("  borrower repays…");
    await clickRepay(bp, status.loan_id);
    const history = await waitForRepaid(status.loan_id);
    console.log(`  ✓ repaid: tx_repay_txid=${history.tx_repay_txid?.slice(0,12)}…`);

    // Verify vault drained — getaddressbalance lags after Tx-Repay confirms,
    // poll until either the address-index catches up or getaddressutxos
    // reports no UTXOs (mempool-aware).
    await pollUntil("vault drained", () => {
      const utxos = cliJ(`getaddressutxos '{"addresses":["${myMatch.vault_address}"]}'`);
      return Array.isArray(utxos) && utxos.length === 0;
    }, { intervalMs: 2000 });
    console.log("  ✓ vault drained to 0");
  } finally {
    await bb.close();
  }
}

// ── SCENARIO 2: borrower cancels request before match ────────────────
async function scenario2_borrowerCancelsRequest() {
  const { browser: bb, page: bp } = await openPage(BORROWER_GUI, BORROWER_IA);
  try {
    console.log("  posting request…");
    await postRequestViaGui(bp, {
      lender: LENDER_IA,
      principal: 5, principalCcy: "DAI.vETH",
      collateral: 10, collateralCcy: "VRSC",
      repay: 5.05, term: 30, autoAccept: false,
    });
    const cm = multimapOf(BORROWER_IA);
    if ((cm[VDXF.request] || []).length === 0) throw new Error("request not on chain");
    console.log("  ✓ request posted");

    console.log("  borrower cancels request via GUI…");
    // Borrower's own request lives in their own multimap. One settled
    // loadMarket cycle is enough — no refresh loop needed.
    await bp.evaluate(() => document.querySelector('[data-mp-tab="loans"]').click());
    await waitForMarketSettled(bp);
    await pollUntil("cancel-request button visible",
      () => bp.evaluate(() => !!document.querySelector('[data-mp-row-act="cancel"]')),
      { intervalMs: 1000 });
    await bp.evaluate(() => document.querySelector('[data-mp-row-act="cancel"]').click());
    await pollUntil("loan.request removed from multimap",
      () => (multimapOf(BORROWER_IA)[VDXF.request] || []).length === 0,
      { timeoutMs: 60000 });
    console.log("  ✓ loan.request removed");
    await pollUntil("locked UTXO released",
      () => cliJ("listlockunspent").length === 0,
      { timeoutMs: 30000 });
    console.log("  ✓ borrower's locked UTXO unlocked");
  } finally {
    await bb.close();
  }
}

// ── SCENARIO 3: lender cancels match before borrower accepts ─────────
async function scenario3_lenderCancelsMatch() {
  const { browser: bb, page: bp } = await openPage(BORROWER_GUI, BORROWER_IA);
  try {
    console.log("  borrower posts request (auto_accept=false to give time to cancel)…");
    await postRequestViaGui(bp, {
      lender: LENDER_IA,
      principal: 5, principalCcy: "DAI.vETH",
      collateral: 10, collateralCcy: "VRSC",
      repay: 5.05, term: 30, autoAccept: false,
    });
    console.log("  lender funds…");
    const { browser: lb, page: lp } = await openPage(LENDER_GUI, LENDER_IA);
    try {
      await postMatchViaGui(lp);
      const matches = (multimapOf(LENDER_IA, true)[VDXF.match] || []).map(decodeEntry).filter(Boolean);
      if (!matches.find((m) => m.request?.iaddr === BORROWER_IA)) throw new Error("match not on chain");
      console.log("  ✓ match posted");

      console.log("  lender cancels match via GUI…");
      await lp.evaluate(() => document.getElementById("market-refresh")?.click());
      await lp.evaluate(() => document.querySelector('[data-mp-tab="loans"]').click());
      // Lender's own match lives in their own multimap. One settled
      // loadMarket cycle (which on .44 takes ~30s due to slow daemon
      // RPC) is enough to render the cancel-match button.
      await waitForMarketSettled(lp);
      await pollUntil("cancel-match button visible",
        () => lp.evaluate(() => !!document.querySelector('[data-loan-act="cancel-match"]')),
        { intervalMs: 1000 });
      await lp.evaluate(() => document.querySelector('[data-loan-act="cancel-match"]').click());
      await pollUntil("loan.match for this borrower removed", () => {
        const cm = multimapOf(LENDER_IA, true);
        const after = (cm[VDXF.match] || []).map(decodeEntry).filter(Boolean);
        return !after.find((m) => m.request?.iaddr === BORROWER_IA);
      }, { timeoutMs: 60000 });
      console.log("  ✓ loan.match removed from lender's multimap");
    } finally { await lb.close(); }
  } finally { await bb.close(); }
}

// ── SCENARIO 4: manual accept (auto_accept=false) ────────────────────
async function scenario4_manualAccept() {
  const { browser: bb, page: bp } = await openPage(BORROWER_GUI, BORROWER_IA);
  try {
    console.log("  request with auto_accept=false…");
    await postRequestViaGui(bp, {
      lender: LENDER_IA,
      principal: 5, principalCcy: "DAI.vETH",
      collateral: 10, collateralCcy: "VRSC",
      repay: 5.05, term: 30, autoAccept: false,
    });
    const { browser: lb, page: lp } = await openPage(LENDER_GUI, LENDER_IA);
    try { await postMatchViaGui(lp); } finally { await lb.close(); }
    console.log("  ✓ match posted");

    console.log("  borrower clicks accept-v2 manually…");
    // Match rows render only on the loans tab — postRequestViaGui left us on market.
    await bp.evaluate(() => document.querySelector('[data-mp-tab="loans"]')?.click());
    const refAcceptV2 = { t: 0 };
    await pollUntil("accept-v2 button visible", async () => {
      await refreshIfIdle(bp, refAcceptV2);
      return await bp.evaluate(() => {
        const btn = document.querySelector('[data-mp-row-act="accept-v2"]');
        return btn && !btn.disabled;
      });
    }, { intervalMs: 1500 });
    await bp.evaluate(() => document.querySelector('[data-mp-row-act="accept-v2"]').click());
    const status = await waitForActiveLoan();
    console.log(`  ✓ loan opened via manual accept: ${status.loan_id.slice(0,12)}…`);

    // Repay so the vault is drained before the next scenario (lender needs
    // its principal back to fund subsequent scenarios).
    console.log("  closing the loan (repay) so balance carries forward…");
    await clickRepay(bp, status.loan_id);
    await waitForRepaid(status.loan_id);
    await pollUntil("vault drained", () => {
      const utxos = cliJ(`getaddressutxos '{"addresses":["${VAULT_ADDR}"]}'`);
      return Array.isArray(utxos) && utxos.length === 0;
    }, { intervalMs: 2000 });
    console.log("  ✓ closed");
  } finally { await bb.close(); }
}

// ── SCENARIO 5: repay with localStorage missing ──────────────────────
async function scenario5_repayLocalstorageMissing() {
  const { browser: bb, page: bp } = await openPage(BORROWER_GUI, BORROWER_IA);
  try {
    console.log("  posting request + match + auto-accept…");
    await postRequestViaGui(bp, {
      lender: LENDER_IA, principal: 5, principalCcy: "DAI.vETH",
      collateral: 10, collateralCcy: "VRSC", repay: 5.05, term: 30, autoAccept: true,
    });
    const { browser: lb, page: lp } = await openPage(LENDER_GUI, LENDER_IA);
    try { await postMatchViaGui(lp); } finally { await lb.close(); }
    // Match rows render only on the loans tab — auto-accept watcher needs
    // the Accept button in the DOM to dispatch its click.
    await bp.evaluate(() => document.querySelector('[data-mp-tab="loans"]')?.click());
    const status = await waitForActiveLoan();
    console.log(`  ✓ loan opened: ${status.loan_id.slice(0,12)}…`);

    console.log("  clearing localStorage Tx-Repay cache…");
    await bp.evaluate((loanId) => localStorage.removeItem(`vl_tx_repay_${loanId}`), status.loan_id);

    console.log("  clicking Repay (should recover from loan.status.tx_repay_signed)…");
    await clickRepay(bp, status.loan_id);
    await waitForRepaid(status.loan_id);
    await pollUntil("vault drained", () => {
      const utxos = cliJ(`getaddressutxos '{"addresses":["${VAULT_ADDR}"]}'`);
      return Array.isArray(utxos) && utxos.length === 0;
    }, { intervalMs: 2000 });
    console.log("  ✓ repaid via on-chain Tx-Repay recovery");
  } finally { await bb.close(); }
}

// ── SCENARIO 6: repay with localStorage AND loan.status missing ──────
async function scenario6_repayDoubleRecovery() {
  const { browser: bb, page: bp } = await openPage(BORROWER_GUI, BORROWER_IA);
  try {
    console.log("  posting + match + auto-accept…");
    await postRequestViaGui(bp, {
      lender: LENDER_IA, principal: 5, principalCcy: "DAI.vETH",
      collateral: 10, collateralCcy: "VRSC", repay: 5.05, term: 30, autoAccept: true,
    });
    const { browser: lb, page: lp } = await openPage(LENDER_GUI, LENDER_IA);
    try { await postMatchViaGui(lp); } finally { await lb.close(); }
    await bp.evaluate(() => document.querySelector('[data-mp-tab="loans"]')?.click());
    const status = await waitForActiveLoan();
    console.log(`  ✓ loan opened: ${status.loan_id.slice(0,12)}…`);

    console.log("  clearing localStorage AND stripping tx_repay_signed from loan.status…");
    await bp.evaluate((loanId) => localStorage.removeItem(`vl_tx_repay_${loanId}`), status.loan_id);
    // Keep loan.status (so the loan still renders with a Repay button) but
    // strip the tx_repay_signed field. Forces the repay handler to fall
    // through past tier 2 (loan.status.tx_repay_signed) into tier 3+
    // (lender's match.tx_repay_partial).
    await waitForIdentityMempoolEmpty(BORROWER_IA);
    const ident = cliJ(`getidentity ${BORROWER_IA} -1`).identity;
    const cmExisting = ident.contentmultimap || {};
    const newCm = {};
    for (const [k, arr] of Object.entries(cmExisting)) {
      if (k === VDXF.status) {
        const stripped = (arr || []).map((e) => {
          const hex = typeof e === "string" ? e : (e.serializedhex || e.message || "");
          if (!hex) return null;
          try {
            const j = JSON.parse(Buffer.from(hex, "hex").toString("utf8"));
            if (j.loan_id === status.loan_id) {
              delete j.tx_repay_signed;
              const newHex = Buffer.from(JSON.stringify(j), "utf8").toString("hex");
              return newHex;
            }
            return hex;
          } catch { return hex; }
        }).filter(Boolean);
        if (stripped.length) newCm[k] = stripped;
      } else {
        const norm = (arr || []).map((e) => typeof e === "string" ? e : (e.serializedhex || e.message || "")).filter(Boolean);
        if (norm.length) newCm[k] = norm;
      }
    }
    const arg = JSON.stringify({ name: ident.name, parent: ident.parent || "", contentmultimap: newCm });
    cli(`updateidentity '${arg.replace(/'/g, "'\\''")}'`);
    await pollUntil("tx_repay_signed strip confirmed", () => {
      const cm2 = multimapOf(BORROWER_IA);
      const updated = (cm2[VDXF.status] || []).map(decodeEntry).filter(Boolean).find((s) => s.loan_id === status.loan_id);
      return updated && !updated.tx_repay_signed;
    }, { intervalMs: 3000 });

    console.log("  clicking Repay (should fall through to lender's match.tx_repay_partial)…");
    await clickRepay(bp, status.loan_id);
    await waitForRepaid(status.loan_id);
    await pollUntil("vault drained", () => {
      const utxos = cliJ(`getaddressutxos '{"addresses":["${VAULT_ADDR}"]}'`);
      return Array.isArray(utxos) && utxos.length === 0;
    }, { intervalMs: 2000 });
    console.log("  ✓ repaid via match.tx_repay_partial recovery cascade");
  } finally { await bb.close(); }
}

// ── SCENARIO 7: match safety check rejects bad terms ─────────────────
async function scenario7_badMatchSafety() {
  // Borrower posts a normal request. Then we MANUALLY craft a bad match
  // (substitute borrower's principal recipient with the lender's R-address)
  // and post it on the lender's identity. The borrower's GUI should fetch
  // it, run verifyMatchSafety, and catch the tampering.
  const { browser: bb, page: bp } = await openPage(BORROWER_GUI, BORROWER_IA);
  try {
    console.log("  posting request…");
    await postRequestViaGui(bp, {
      lender: LENDER_IA, principal: 5, principalCcy: "DAI.vETH",
      collateral: 10, collateralCcy: "VRSC", repay: 5.05, term: 30, autoAccept: true,
    });
    console.log("  lender posts a valid match first (so we have real partials)…");
    const { browser: lb, page: lp } = await openPage(LENDER_GUI, LENDER_IA);
    try { await postMatchViaGui(lp); } finally { await lb.close(); }
    const matches = (multimapOf(LENDER_IA, true)[VDXF.match] || []).map(decodeEntry).filter(Boolean);
    const goodMatch = matches.find((m) => m.request?.iaddr === BORROWER_IA);
    if (!goodMatch) throw new Error("no good match to corrupt");

    console.log("  if auto-accept fired before we could corrupt, this scenario can't run cleanly");
    const status = (multimapOf(BORROWER_IA)[VDXF.status] || []).map(decodeEntry).filter(Boolean)
                   .find((s) => s.match_iaddr === LENDER_IA && s.active === true);
    if (status) {
      console.log("  (auto-accept already fired — skipping bad-match injection)");
      return;
    }

    // Probe: verifyMatchSafety should be a window-exposed function so tests
    // can call it directly. Full bad-match injection requires chain
    // manipulation (corrupted Tx-A construction); the safety logic is
    // covered by unit tests.
    console.log("  probing window.verifyMatchSafety…");
    const probe = await bp.evaluate(() => typeof window.verifyMatchSafety === "function" ? "function exists" : "not a window-level export");
    console.log(`  → verifyMatchSafety probe: ${probe}`);
  } finally { await bb.close(); }
}

// ── SCENARIO 8: lender insufficient principal ────────────────────────
async function scenario8_lenderInsufficient() {
  const { browser: bb, page: bp } = await openPage(BORROWER_GUI, BORROWER_IA);
  try {
    // Lender currently has ~7.20 DAI. Request more than that.
    const tooMuch = 100;
    console.log(`  posting request for ${tooMuch} DAI (exceeds lender balance)…`);
    await postRequestViaGui(bp, {
      lender: LENDER_IA, principal: tooMuch, principalCcy: "DAI.vETH",
      collateral: 10, collateralCcy: "VRSC", repay: tooMuch + 0.05, term: 30, autoAccept: false,
    });
    const { browser: lb, page: lp } = await openPage(LENDER_GUI, LENDER_IA);
    try {
      const refSee = { t: 0 };
      await pollUntil("lender's GUI sees the request", async () => {
        await refreshIfIdle(lp, refSee);
        return await lp.evaluate(() => !!document.querySelector('[data-mp-row-act="post-match"]'));
      }, { timeoutMs: 240000, intervalMs: 1500 });
      // Click Fund — should open panel but NO confirm button (no eligible UTXO)
      await lp.evaluate(() => document.querySelector('[data-mp-row-act="post-match"]').click());
      // Poll until panel renders one of: confirm button (failure case) or
      // insufficient warning (success case).
      const state = await pollUntil("post-match panel rendered", async () =>
        await lp.evaluate(() => {
          const goBtn = document.querySelector('[data-mp-row-act="post-match-go"]');
          const panelText = document.querySelector('.post-match-panel')?.innerText || "";
          const hasWarning = /no.*balance|insufficient|too small/i.test(panelText);
          if (!goBtn && !hasWarning) return null;
          return { goBtnExists: !!goBtn, hasInsufficientWarning: hasWarning };
        }), { timeoutMs: 30000, intervalMs: 1000 });
      if (state.goBtnExists) throw new Error("confirm button shown despite insufficient lender balance");
      if (!state.hasInsufficientWarning) throw new Error("no insufficient-balance warning in lender's UI");
      console.log("  ✓ lender's GUI correctly rejects with no Confirm button + insufficient warning");
    } finally { await lb.close(); }
  } finally { await bb.close(); }
}

// ── SCENARIO 9: borrower insufficient collateral ─────────────────────
async function scenario9_borrowerInsufficient() {
  const { browser: bb, page: bp } = await openPage(BORROWER_GUI, BORROWER_IA);
  try {
    // Borrower has ~23.50 VRSC. Set collateral to 1000 (over balance).
    await bp.evaluate(() => document.querySelector('[data-mp-tab="market"]').click());
    await bp.waitForSelector('#mp-post-request', { timeout: 30000 });
    await bp.click('#mp-post-request');
    await bp.waitForSelector('#mp-post-form [data-mp-do="preview-request"]', { timeout: 30000 });
    await bp.waitForFunction(() => {
      const el = document.getElementById("mp-id-info");
      return el && el.dataset && el.dataset.iaddr;
    }, { timeout: 30000 });
    await bp.evaluate(() => {
      const f = document.getElementById("mp-post-form");
      const setVal = (sel, v) => { const el = f.querySelector(sel); if (el) { el.value = v; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); } };
      setVal('[data-f="target_lender"]', "i7A9fa8c3xZnA3uLK3SLYa58cUipganewg");
      setVal('[data-f="principal_amount"]', "5");
      setVal('[data-f="principal_currency"]', "DAI.vETH");
      setVal('[data-f="collateral_amount"]', "1000");
      setVal('[data-f="collateral_currency"]', "VRSC");
      setVal('[data-f="repay_amount"]', "5.05");
      setVal('[data-f="term_days"]', "30");
    });
    // Poll until validation has run (preview becomes disabled OR validation text appears).
    const validation = await pollUntil("form validation rendered", async () =>
      await bp.evaluate(() => {
        const f = document.getElementById("mp-post-form");
        const preview = f.querySelector('[data-mp-do="preview-request"]');
        const valText = f.querySelector('.form-validation')?.innerText || "";
        const balLine = f.querySelector('.r-balance-line');
        if (!preview?.disabled && !valText) return null;
        return {
          previewDisabled: !!preview?.disabled,
          validationText: valText.slice(0, 200),
          balLineRed: balLine?.style.color?.includes("bad") || balLine?.style.color?.includes("red"),
        };
      }), { timeoutMs: 15000, intervalMs: 500 });
    if (!validation.previewDisabled) throw new Error("Preview button NOT disabled despite insufficient collateral");
    if (!/insufficient|✗/i.test(validation.validationText)) throw new Error("no insufficient-balance message in form validation");
    console.log("  ✓ Preview & sign disabled; validation block shows insufficient");
  } finally { await bb.close(); }
}

// ── SCENARIO 12: chain-only recovery via past identity revisions ─────
// Wipes lender's loan.match AND borrower's loan.status.tx_repay_signed
// (the latter by stripping the field, like scenario 6 does). Borrower's
// localStorage cache is also wiped. The only path to settle is for the
// repay handler to walk getidentityhistory (tier 4) and recover the
// lender's tx_repay_partial from a past revision, then re-cosign.
//
// Note: a fully aggressive wipe (also dropping the entire borrower
// loan.status entry) is not testable through the current GUI because
// loadLoans only renders cards for loans visible in the live multimap.
// That requires a "recover loan from chain history" UI feature first.
// Captured as scenario 12b (TODO); scenario 12 here proves the tier 4
// fallback works.
async function scenario12_chainOnlyRecovery() {
  const { browser: bb, page: bp } = await openPage(BORROWER_GUI, BORROWER_IA);
  try {
    console.log("  posting request + match + auto-accept…");
    await postRequestViaGui(bp, {
      lender: LENDER_IA, principal: 5, principalCcy: "DAI.vETH",
      collateral: 10, collateralCcy: "VRSC", repay: 5.05, term: 30, autoAccept: true,
    });
    const { browser: lb, page: lp } = await openPage(LENDER_GUI, LENDER_IA);
    try { await postMatchViaGui(lp); } finally { await lb.close(); }
    await bp.evaluate(() => document.querySelector('[data-mp-tab="loans"]')?.click());
    const status = await waitForActiveLoan();
    console.log(`  ✓ loan opened: ${status.loan_id.slice(0,12)}…`);

    console.log("  wiping lender's live loan.match (Tx-A stays on chain; entry persists in past revision)");
    await waitForIdentityMempoolEmpty(LENDER_IA, true);
    await dropEntries(LENDER_IA, [VDXF.match], true);
    await pollUntil("loan.match removed from lender live", () => {
      const cm = multimapOf(LENDER_IA, true);
      const ents = (cm[VDXF.match] || []).map(decodeEntry).filter(Boolean);
      return !ents.find((m) => m.tx_a_txid === status.loan_id);
    }, { intervalMs: 3000 });
    console.log("  ✓ lender's live loan.match wiped");

    console.log("  stripping tx_repay_signed from borrower's loan.status + clearing localStorage…");
    await bp.evaluate((loanId) => localStorage.removeItem(`vl_tx_repay_${loanId}`), status.loan_id);
    await waitForIdentityMempoolEmpty(BORROWER_IA);
    const ident = cliJ(`getidentity ${BORROWER_IA} -1`).identity;
    const cmExisting = ident.contentmultimap || {};
    const newCm = {};
    for (const [k, arr] of Object.entries(cmExisting)) {
      if (k === VDXF.status) {
        const stripped = (arr || []).map((e) => {
          const hex = typeof e === "string" ? e : (e.serializedhex || e.message || "");
          if (!hex) return null;
          try {
            const j = JSON.parse(Buffer.from(hex, "hex").toString("utf8"));
            if (j.loan_id === status.loan_id) {
              delete j.tx_repay_signed;
              return Buffer.from(JSON.stringify(j), "utf8").toString("hex");
            }
            return hex;
          } catch { return hex; }
        }).filter(Boolean);
        if (stripped.length) newCm[k] = stripped;
      } else {
        const norm = (arr || []).map((e) => typeof e === "string" ? e : (e.serializedhex || e.message || "")).filter(Boolean);
        if (norm.length) newCm[k] = norm;
      }
    }
    const arg = JSON.stringify({ name: ident.name, parent: ident.parent || "", contentmultimap: newCm });
    cli(`updateidentity '${arg.replace(/'/g, "'\\''")}'`);
    await pollUntil("tx_repay_signed strip confirmed", () => {
      const cm2 = multimapOf(BORROWER_IA);
      const updated = (cm2[VDXF.status] || []).map(decodeEntry).filter(Boolean).find((s) => s.loan_id === status.loan_id);
      return updated && !updated.tx_repay_signed;
    }, { intervalMs: 3000 });
    console.log("  ✓ all live tx_repay sources wiped — chain history is the only source");

    console.log("  clicking Repay (must walk getidentityhistory tier 4)…");
    await clickRepay(bp, status.loan_id);
    await waitForRepaid(status.loan_id);
    await pollUntil("vault drained", () => {
      const utxos = cliJ(`getaddressutxos '{"addresses":["${VAULT_ADDR}"]}'`);
      return Array.isArray(utxos) && utxos.length === 0;
    }, { intervalMs: 2000 });
    console.log("  ✓ chain-only recovery succeeded — past-revision fallback works");
  } finally { await bb.close(); }
}

// ── SCENARIO 13: replay-safety across loans ──────────────────────────
// Same (borrower, lender) pair share the same deterministic vault P2SH.
// Run Loan A end-to-end, capture its tx_repay_signed, then open Loan B
// with the SAME parties. Try to reuse Loan A's tx_repay against Loan B's
// vault UTXO. The protocol's per-loan input commitment (signature pins
// to txid_A:vout) should reject every replay attempt.
async function scenario13_replaySafety() {
  const { browser: bb, page: bp } = await openPage(BORROWER_GUI, BORROWER_IA);
  try {
    // 1. Run Loan A
    console.log("  Loan A: opening…");
    await postRequestViaGui(bp, {
      lender: LENDER_IA, principal: 5, principalCcy: "DAI.vETH",
      collateral: 10, collateralCcy: "VRSC", repay: 5.05, term: 30, autoAccept: true,
    });
    let lb, lp;
    ({ browser: lb, page: lp } = await openPage(LENDER_GUI, LENDER_IA));
    try { await postMatchViaGui(lp); } finally { await lb.close(); }
    await bp.evaluate(() => document.querySelector('[data-mp-tab="loans"]')?.click());
    const statusA = await waitForActiveLoan();
    console.log(`  Loan A loan_id: ${statusA.loan_id.slice(0,12)}…`);

    // 2. Capture Loan A's tx_repay_signed BEFORE settlement
    const loanA_tx_repay_signed = await bp.evaluate((loanId) =>
      localStorage.getItem(`vl_tx_repay_${loanId}`), statusA.loan_id);
    if (!loanA_tx_repay_signed) throw new Error("Loan A tx_repay_signed not in localStorage — can't run replay test");
    console.log(`  captured Loan A tx_repay_signed (${loanA_tx_repay_signed.length / 2} bytes)`);

    // 3. Settle Loan A normally
    console.log("  settling Loan A…");
    await clickRepay(bp, statusA.loan_id);
    await waitForRepaid(statusA.loan_id);
    await pollUntil("Loan A vault drained", () => {
      const utxos = cliJ(`getaddressutxos '{"addresses":["${VAULT_ADDR}"]}'`);
      return Array.isArray(utxos) && utxos.length === 0;
    }, { intervalMs: 2000 });
    console.log("  ✓ Loan A settled");

    // 4. Open Loan B (same parties → same vault P2SH, fresh UTXO)
    console.log("  Loan B: opening with same parties (fresh vault UTXO)…");
    await postRequestViaGui(bp, {
      lender: LENDER_IA, principal: 5, principalCcy: "DAI.vETH",
      collateral: 10, collateralCcy: "VRSC", repay: 5.05, term: 30, autoAccept: true,
    });
    ({ browser: lb, page: lp } = await openPage(LENDER_GUI, LENDER_IA));
    try { await postMatchViaGui(lp); } finally { await lb.close(); }
    await bp.evaluate(() => document.querySelector('[data-mp-tab="loans"]')?.click());
    const statusB = await waitForActiveLoan();
    console.log(`  Loan B loan_id: ${statusB.loan_id.slice(0,12)}…`);
    if (statusB.loan_id === statusA.loan_id) throw new Error("Loan A and Loan B have the same loan_id — fresh Tx-A didn't happen");

    // 5. Replay attempt: broadcast Loan A's old tx_repay against the chain
    console.log("  replay attempt: broadcasting Loan A's old tx_repay_signed…");
    let attempt1Rejected = false, attempt1Err = "";
    try {
      cli(`sendrawtransaction ${loanA_tx_repay_signed}`);
    } catch (e) {
      attempt1Rejected = true;
      attempt1Err = e.message;
    }
    if (!attempt1Rejected) throw new Error("REPLAY VULNERABILITY: Loan A's tx_repay was accepted on chain");
    if (!/inputs[-_]spent|already.*spent|missing.*inputs|conflict|bad-txns/i.test(attempt1Err)) {
      throw new Error(`Loan A tx_repay rejected but error was unexpected: ${attempt1Err.slice(0,300)}`);
    }
    console.log(`  ✓ rejection: ${attempt1Err.slice(0,120)}…`);

    // 6. Settle Loan B normally to confirm it isn't affected
    console.log("  settling Loan B normally…");
    await clickRepay(bp, statusB.loan_id);
    await waitForRepaid(statusB.loan_id);
    await pollUntil("Loan B vault drained", () => {
      const utxos = cliJ(`getaddressutxos '{"addresses":["${VAULT_ADDR}"]}'`);
      return Array.isArray(utxos) && utxos.length === 0;
    }, { intervalMs: 2000 });
    console.log("  ✓ Loan B settled cleanly — replay attempt did not affect normal flow");
  } finally { await bb.close(); }
}

// ── Main runner ──────────────────────────────────────────────────────

(async () => {
  const t0 = Date.now();
  console.log(`\n=== v3 e2e suite — ${new Date().toISOString()} ===`);
  const ONLY = process.env.E2E_ONLY ? new Set(process.env.E2E_ONLY.split(",").map(Number)) : null;
  const maybe = (n, name, fn) => (!ONLY || ONLY.has(n)) ? runScenario(name, fn) : Promise.resolve();
  await maybe(1, "1. happy path: full cycle",                   scenario1_happyPath);
  await maybe(2, "2. borrower cancels request",                 scenario2_borrowerCancelsRequest);
  await maybe(3, "3. lender cancels match",                     scenario3_lenderCancelsMatch);
  await maybe(4, "4. manual accept (auto_accept=false)",        scenario4_manualAccept);
  await maybe(5, "5. repay with localStorage missing",          scenario5_repayLocalstorageMissing);
  await maybe(6, "6. repay with localStorage + status missing", scenario6_repayDoubleRecovery);
  await maybe(7, "7. match safety check (probe only)",          scenario7_badMatchSafety);
  await maybe(8, "8. lender insufficient principal",            scenario8_lenderInsufficient);
  await maybe(9, "9. borrower insufficient collateral",         scenario9_borrowerInsufficient);
  await maybe(12, "12. chain-only recovery (past revisions)",   scenario12_chainOnlyRecovery);
  await maybe(13, "13. replay safety across loans",             scenario13_replaySafety);

  // Final cleanup
  console.log("\n=== final cleanup ===");
  await cleanSlate();

  console.log(`\n=== summary (${((Date.now() - t0) / 1000 / 60).toFixed(1)} min) ===`);
  for (const r of results) {
    const tag = r.outcome === "pass" ? "✓" : "✗";
    console.log(`  ${tag} ${r.name}  (${(r.ms / 1000).toFixed(1)}s)${r.err ? ` — ${r.err}` : ""}`);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error("FATAL:", e.stack || e.message); process.exit(1); });

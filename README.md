# make-gui

Local web app for browsing and acting on [Make Protocol](https://github.com/Fried333/make-protocol) contract markets — loan offers, requests, matches, status — directly against your own `verusd` daemon. Reference client for the data layer specified in [SCHEMA.md](https://github.com/Fried333/make-protocol/blob/main/SCHEMA.md). Anyone can fork or replace it — the chain is the source of truth.

## Table of contents

- [What you get](#what-you-get)
- [What you provide](#what-you-provide)
- [Quick start](#quick-start)
- [Architecture](#architecture)
- [VDXF keys recognised](#vdxf-keys-recognised)
- [End-to-end validation](#end-to-end-validation)
- [What's NOT yet wired](#whats-not-yet-wired)
- [Operating in production](#operating-in-production)
- [Related](#related)
- [License](#license)
- [Disclaimer](#disclaimer)

## What you get

- Marketplace tab — open requests, open offers, matches pulled from [scan.verus.cx](https://scan.verus.cx) for stranger discovery
- Active loans tab — daemon-only view of loans involving your IDs, with one-click Repay
- Activity tab — chronological feed of contract events scoped to the acting identity
- **Borrower-first origination flow** — borrower posts a v2 `loan.request` pre-signed against a fresh single-currency UTXO; lender posts a `loan.match` carrying all three pre-signed partials (Tx-A, Tx-Repay, Tx-B); borrower clicks Accept to broadcast Tx-A and open the loan
- **Oracle-driven collateral suggestion** — pick principal currency + amount + collateral currency, the form fetches a live price via `estimateconversion` (multi-route fallback: direct → Bridge.vETH → Bridge.vARRR → Pure) and auto-populates the suggested collateral at the lender's target ratio. Override-able; suggestion stays live as inputs change.
- **Lender auto-fund (per-offer)** — offer can carry `auto_fund: true` and the GUI runs a 30s watcher that auto-posts a `loan.match` when a request matches (lend currency, VRSC cap, term cap, oracle-priced collateral ratio with 1.5× hard floor). Wallet stays unlocked, GUI signs locally — keys never leave the browser. Counterparties see a `🤖 Auto-fund` badge on the offer card.
- **Borrower auto-accept (per-request)** — request can carry `auto_accept: true`. When a `loan.match` lands, the GUI runs a 7-check verification (amounts to 8-dp exact-integer-satoshi, output addresses, vault P2SH from both pubkeys, maturity ≤ today + term × 1440, currency i-addresses match). If all pass, Tx-A broadcasts automatically; if any fail, the match surfaces in Inbox for manual review.
- **Auto-split via `sendcurrency`** — no UTXO management; the GUI splits fresh single-currency UTXOs in mempool for clean signing. Chained parent-child broadcasts settle without confirmation waits.

## What you provide

- Python 3.8+ (stdlib only — no `pip install`)
- A running `verusd` (Verus daemon) on the same machine
- The daemon's `~/.komodo/VRSC/VRSC.conf` accessible (for RPC credentials)
- A browser

That's it. No accounts, no extensions, no third-party services beyond optional explorer reads.

## Quick start

```bash
git clone https://github.com/Fried333/make-gui.git
cd make-gui
python3 server.py
# defaults to http://127.0.0.1:7777/
# default conf path: ~/.komodo/VRSC/VRSC.conf
```

Override:

```bash
python3 server.py --port 8080 --conf /path/to/VRSC.conf --bind 0.0.0.0
```

Then open the URL in any browser.

## Architecture

- `server.py` — stdlib HTTP server. Serves `static/`, proxies `/rpc` to `verusd` so the browser speaks to the daemon under one origin (avoids CORS).
- `static/index.html` — three-tab dashboard (Marketplace / Active loans / Activity)
- `static/js/main.js` — vanilla JS. Talks to local daemon via `/rpc` and to `scan.verus.cx/api` for stranger discovery
- `static/js/rpc.js` — thin RPC client
- `static/css/style.css` — minimal styling

State model:

| Layer | Role |
|---|---|
| Browser `localStorage` | Ephemeral UI state (selected R-address, ID) — never load-bearing |
| Local daemon | Source of truth for your own state + any counterparty you've transacted with (mempool-aware via `getidentity <iaddr> -1`) |
| Explorer API | **Stranger discovery only** — used by Marketplace to find offers from parties you haven't met. Loans tab is daemon-only — works even if the explorer is down. |
| Chain | Ultimate source of truth. Local + explorer are derivative. |

See [`DATA_SOURCES.md`](./DATA_SOURCES.md) for the per-feature breakdown of which calls go to your daemon vs the explorer, and the privacy / latency tradeoffs.

## VDXF keys recognised

All keys are namespaced under `make.VRSC@` (`iLWvRsiWVCEuFYhCSt2Qba7LxWksrgVerX`), the registered owner of the Make Protocol contracts standard.

| Key | VDXF id |
|---|---|
| `make.vrsc::contract.loan.offer` | `iMey7Y2idT6dt7jJvRiPXgtYcfAaKCQbHz` |
| `make.vrsc::contract.loan.request` | `iF7Ax6QpdwvTTqDJpNzDXVj1GpUSQX6vH5` |
| `make.vrsc::contract.loan.match` | `iKVShS5o56BLn8BpysrmfvUJbWCrgyio8U` |
| `make.vrsc::contract.loan.status` | `iRzM96sNYj95mUiJebzBnFwirjfws2q6o4` |
| `make.vrsc::contract.loan.history` | `i5qBwi3KWXfyo1UKuUBC3yyq67JagVennW` |
| `make.vrsc::contract.loan.decline` | `iEgciB3u2GwTxzShQR4eFhtj4k8Zv6frNb` |
| `make.vrsc::contract.option.offer` | `i5L8vkz9xsnM8yEDiXzPbP4Kix3SnJSsv5` |

VDXF ids are deterministic — re-derive any of them with `verus getvdxfid "make.vrsc::contract.loan.offer"`.

## End-to-end validation

Full lifecycle (request → match → accept → repay), plus 8 edge cases (cancels, manual accept, lost localStorage, insufficient funds, chain-only recovery, replay safety), plus the **lender auto-fund** pipeline (scenario 14: offer + matching request → match auto-posted → loan settled, no manual lender click), validated via Playwright driving two browser instances against two local daemons on Verus mainnet. See `test_e2e_v3_all.mjs`.

## What's NOT yet wired

- **Lender's claim-collateral path** — after maturity, the GUI knows Tx-B from the borrower's `loan.status.tx_b_complete` field, but the one-click claim flow on the lender side isn't wired yet. Funds still reachable via cooperative manual sign as a workaround.
- **Z-memo messaging** — Communications tab is a placeholder. Real send/receive against identity `privateaddress` is Phase C+.
- **Tx-C rescue path** — the optional last-resort borrower-side recovery (far-future nLockTime) is in the spec but not in the GUI yet.

## Operating in production

This is a **local single-user tool**, not a hosted service. Don't expose port 7777 to the public internet — it speaks directly to your daemon's wallet RPC and any caller who can reach it can drive your identities.

### Common errors

| Symptom | Likely cause |
|---|---|
| "verusd unreachable" on first load | wrong `--conf` path, or daemon not running |
| "no IDs found" on the picker | the daemon's wallet doesn't control any identities (`verus listidentities`) |
| Marketplace tab spinning | explorer (`scan.verus.cx`) is down — Active loans + Activity still work, marketplace recovers when explorer is back |
| Repay button gives "insufficient funds" | acting identity has no clean single-currency UTXO; the GUI auto-splits via `sendcurrency` but needs a parent UTXO to split from |

### Backup considerations

- Wallet keys (your identity primaries) live in the daemon's `wallet.dat` — back that up
- `loan.match` payload templates are persisted in the lender's VerusID `contentmultimap` (chain-resident), but the lender SHOULD also keep a local copy of the raw partial bytes — a wallet seed alone is enough to recover identities but not to re-sign a partial that was already broadcast as part of a match
- The GUI itself is stateless beyond browser `localStorage` (UI preferences only)

## Related

- Protocol spec: [github.com/Fried333/make-protocol](https://github.com/Fried333/make-protocol)
- Public block explorer: [scan.verus.cx](https://scan.verus.cx)
- Verus: [verus.io](https://verus.io)

## License

MIT — see [LICENSE](./LICENSE) if present, or the standard MIT terms.

## Disclaimer

This software is provided **"AS IS"**, without warranty of any kind, express or implied. In no event shall the authors or copyright holders be liable for any claim, damages, or other liability arising from the use of this software.

Make Protocol contracts involve real funds. Before using this client for production loans, audit the request→match→accept flow against your own threat model, verify the on-chain transactions before broadcast, and treat the auto-fund / auto-accept features as convenience automations that you have full responsibility for — they sign and broadcast with no second human in the loop.

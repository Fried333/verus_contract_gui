# Tests

End-to-end + unit tests for the v3 contract protocol.

## Files

- **`e2e_v3_scenarios.mjs`** — 9 mainnet end-to-end scenarios driving the GUI via Playwright. Real funds, real fees, real confirmations. Each scenario resets transient state, runs the flow, and asserts on-chain + UI outcome.
- **`recover_vault.sh`** — Cooperative 2-of-2 vault drain. Idempotent — exits 0 if vault is empty. Used to recover from a half-finished scenario (borrower→lender repay then drain collateral back to borrower).
- **`vault_v4_validation.mjs`** — Tweaked-key (option C) math + encoding round-trip checks. No funds moved; pure local verification.

## Running the e2e suite

The harness expects two GUIs running:

- borrower GUI on `http://127.0.0.1:7777` connected to local daemon (controls `i7b7Tq8JYXX9iqS7FBevC6LaG3ioh8z3RM`)
- lender GUI on `http://127.0.0.1:7778` reverse-tunneled to remote daemon (controls `i7A9fa8c3xZnA3uLK3SLYa58cUipganewg`)

Then:

```bash
node e2e_v3_scenarios.mjs                 # all 9 scenarios
E2E_ONLY=1 node e2e_v3_scenarios.mjs      # only scenario 1 (happy path)
E2E_ONLY=1,4,8 node e2e_v3_scenarios.mjs  # subset
```

## Scenarios

| # | Name | What it validates |
|---|------|-------------------|
| 1 | happy path — full cycle | request → match → auto-accept → repay → vault drained |
| 2 | borrower cancels request | request → cancel button → multimap purged + UTXO unlocked |
| 3 | lender cancels match | request → match → cancel match → multimap purged |
| 4 | manual accept | auto_accept=false → borrower clicks Accept → loan opens → repay |
| 5 | repay with localStorage missing | repay handler must recover Tx-Repay from `loan.status.tx_repay_signed` |
| 6 | repay with localStorage + status.tx_repay_signed missing | falls through to lender's `match.tx_repay_partial` |
| 7 | match safety probe | confirms `verifyMatchSafety` is window-exposed |
| 8 | lender insufficient principal | GUI shows insufficient warning, no Confirm button |
| 9 | borrower insufficient collateral | Preview & sign disabled, validation message shown |

## Reset semantics

Each scenario starts with a `cleanSlate`:

1. `recoverStrandedVault` — runs `recover_vault.sh` if the deterministic vault address has UTXOs left over from a half-run scenario.
2. Drops transient multimap keys (loan.request, loan.match, loan.status, loan.offer, **and loan.history** — the per-key blob exceeds Verus's script-element limit if history accumulates across runs).
3. Unlocks every locked UTXO on both wallets.
4. Polls until the borrower's identity update confirms (and the funding R-address mempool is empty) before issuing any new identity update — the daemon's wallet picks UTXOs that may still be in flight, causing `bad-txns-inputs-spent`.

## What blocks a scenario

- Block production cadence (~1 min). The polls have **no wall-clock timeout**: chain operations are gated on block confirmations.
- Explorer indexer lag (`scan.verus.cx`) — the lender's GUI fetches the borrower's request via the explorer's `/contracts/loans/requests` endpoint, which only includes confirmed state. The borrower's posted request must confirm before the lender can fund it.

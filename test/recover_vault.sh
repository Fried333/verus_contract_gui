#!/bin/bash
# Recover a stranded vault from a failed scenario 1 run. Idempotent: if
# vault is empty, exits 0 immediately.
set -e
VERUS=/home/dev/Downloads/verus-cli-v1.2.16/verus
CONF=/home/dev/.komodo/VRSC/VRSC.conf
SSH="ssh -p 2400 -i $HOME/.ssh/id_ed25519 -o IdentitiesOnly=yes root@86.107.168.44"
VAULT=bSe1gaBoZJqcBTMuTi6VYevXrRLz5XZ8Kj
BORROWER_R=RSiyiZ92PeBDEJskMLzmUCSjJEW45iWnsF
LENDER_R=RKGN34UhN62C8KaQeHTkMr7L3Mqn9oW2ve

V_BAL=$($VERUS -conf=$CONF getaddressbalance "{\"addresses\":[\"$VAULT\"]}" | python3 -c "import sys,json;print(json.load(sys.stdin)['balance'])")
if [ "$V_BAL" = "0" ]; then echo "vault empty, no recovery needed"; exit 0; fi

echo "stranded vault has $V_BAL sats — recovering"

# Step 1: 5.05 DAI borrower → lender
echo "  [1/2] borrower → lender 5.05 DAI"
OPID=$($VERUS -conf=$CONF sendcurrency $BORROWER_R '[{"address":"'$LENDER_R'","currency":"DAI.vETH","amount":5.05}]')
until r=$($VERUS -conf=$CONF z_getoperationresult "[\"$OPID\"]"); echo "$r" | python3 -c "import sys,json;d=json.load(sys.stdin);sys.exit(0 if d and d[0].get('status') in ('success','failed') else 1)" 2>/dev/null; do sleep 2; done
echo "$r" | python3 -c "import sys,json;d=json.load(sys.stdin);print('    txid:',d[0].get('result',{}).get('txid'))"

# Step 2: cooperative 2-of-2 vault drain
echo "  [2/2] vault drain"
B_WIF=$($VERUS -conf=$CONF dumpprivkey $BORROWER_R)
L_WIF=$($SSH '/root/verus-cli-v1.2.16/verus -conf=/root/.komodo/VRSC/VRSC.conf dumpprivkey '$LENDER_R)
VTXID=$($VERUS -conf=$CONF getaddressutxos "{\"addresses\":[\"$VAULT\"]}" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d[0]['txid'])")
VVOUT=$($VERUS -conf=$CONF getaddressutxos "{\"addresses\":[\"$VAULT\"]}" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d[0]['outputIndex'])")
RAWTX=$($VERUS -conf=$CONF createrawtransaction "[{\"txid\":\"$VTXID\",\"vout\":$VVOUT}]" "{\"$BORROWER_R\":9.9999}")
PREVTXS="[{\"txid\":\"$VTXID\",\"vout\":$VVOUT,\"scriptPubKey\":\"a9149893267be2fc287683d0485033c8b642dd34641d87\",\"redeemScript\":\"52210356455f1dc2fdcf8d6ab039dff0d38d1b0d53dcc9a315d7a7e0533c96c19237702103d71d1d78a81aceda25f11c1f9b84e42577b01c5f33f7bc8ea3ff6381ae5ab1d752ae\",\"amount\":10}]"
S1=$($VERUS -conf=$CONF signrawtransaction "$RAWTX" "$PREVTXS" "[\"$L_WIF\"]" | python3 -c 'import sys,json;print(json.load(sys.stdin)["hex"])')
S2=$($VERUS -conf=$CONF signrawtransaction "$S1" "$PREVTXS" "[\"$B_WIF\"]" | python3 -c 'import sys,json;print(json.load(sys.stdin)["hex"])')
TX2=$($VERUS -conf=$CONF sendrawtransaction "$S2")
echo "    txid: $TX2"

echo "  awaiting confirm…"
until $VERUS -conf=$CONF gettransaction $TX2 2>/dev/null | python3 -c 'import sys,json;sys.exit(0 if json.load(sys.stdin).get("confirmations",0)>=1 else 1)' 2>/dev/null; do sleep 15; done
echo "  ✓ recovery confirmed"

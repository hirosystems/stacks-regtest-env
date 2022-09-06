#!/usr/bin/env bash

# Basic auto-mining script for a bitcoind-regtest node.
# Dependencies: bash and curl >=v7.76.

set -e

# : "${MINE_INTERVAL:?Need to set MINE_INTERVAL}"

rpc(){
    params=$(local IFS=","; shift; echo "$*";)
    body='{"jsonrpc":"1.0","id":"c","method":"'$1'","params":['$params']}'
    echo "Sending RPC payload: $body" >&2
    curl -sS --fail-with-body -u "$RPC_AUTH" -H 'content-type: text/plain;' --data-binary "$body" "$RPC_HOST"
}

echo "Creating default wallet for $BTC_ADDR ..."
rpc importaddress \"$BTC_ADDR\" '""' false

echo "Mining initial $INIT_BLOCKS blocks to $BTC_ADDR ..."
rpc generatetoaddress $INIT_BLOCKS \"$BTC_ADDR\"

while true; do
    echo "Checking for Stacks mining tx..."
    tx=$(rpc listtransactions \"*\" 1 0 true)
    case "$tx" in
    *send*)
        echo "Detected Stacks mining tx, starting Bitcoin block auto-mining on $MINE_INTERVAL interval..."
        break
    ;;
    esac
    sleep 1s
done

# TODO: try polling /v2/info to determine if another block is ready to mine
while true; do
    echo "Mining block to $BTC_ADDR"
    rpc generatetoaddress 1 \"$BTC_ADDR\"
    sleep $MINE_INTERVAL
done

#!/usr/bin/env bash

# Basic auto-mining script for a bitcoind-regtest node.
# Dependencies: bitcoin-cli, bash

set -e

if [[ -z $BTC_MINER_ENABLED || $BTC_MINER_ENABLED == "true" ]]; then
    echo "BTC mining is enabled"
else
    echo "BTC mining is not enabled"
    exit 0
fi

while true; do
    echo "Checking for Stacks mining tx..."
    tx=$(bitcoin-cli -rpcwait -rpcconnect="$BTC_RPC_HOST:$BTC_RPC_PORT" -rpcuser="$BTC_RPC_USER" -rpcpassword="$BTC_RPC_PW" listtransactions '*' 1 0 true)
    case "$tx" in
    *send*)
        echo "Detected Stacks mining tx, starting Bitcoin block auto-mining on $MINE_INTERVAL interval..."
        break
        ;;
    *)
        echo "No Stacks mining tx detected in:"
        echo "$tx"
        ;;
    esac
    sleep 1s
done

# TODO: try polling /v2/info to determine if another block is ready to mine
while true; do
    echo "Mining block to $BTC_ADDR"
    bitcoin-cli -rpcwait -rpcconnect="$BTC_RPC_HOST:$BTC_RPC_PORT" -rpcuser="$BTC_RPC_USER" -rpcpassword="$BTC_RPC_PW" generatetoaddress 1 "$BTC_ADDR"
    sleep $MINE_INTERVAL
done

#!/usr/bin/env bash

export STACKS_CORE_RPC_HOST=$1
export STACKS_CORE_RPC_PORT=80
export STACKS_30_HEIGHT=131
export STACKS_25_HEIGHT=121
export STACKING_KEYS="530d9f61984c888536871c6573073bdfc0058896dc1adfe9a6a10dfacadc209101,7287ba251d44a4d3fd9276c88ce34c5c52a038955511cccaf77e61068649c17801,7036b29cb5e235e5fd9b09ae3e8eec4404e44906814d5d01cbca968a60ed4bfb01"
# export STACKS_LOG_JSON=1
export SERVICE_NAME=monitor

npx tsx monitor.ts

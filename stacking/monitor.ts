import {
  accounts,
  network,
  infoApi,
  nodeUrl,
  waitForSetup,
  EPOCH_30_START,
  didCrossPreparePhase,
  blocksApi,
  parseEnvInt,
  txApi,
} from './common';
import { Transaction, ContractCallTransaction } from '@stacks/stacks-blockchain-api-types';

let lastBurnHeight = 0;
let lastStxHeight = 0;
let lastRewardCycle = 0;
let lastStxBlockTime = new Date().getTime();
let lastStxBlockDiff = 0;

console.log('Monitoring...');

const EXIT_FROM_MONITOR = process.env.EXIT_FROM_MONITOR === '1';
const monitorInterval = parseEnvInt('MONITOR_INTERVAL') ?? 2;

console.log('Exit from monitor:', EXIT_FROM_MONITOR);

async function getTransactions(): Promise<ContractCallTransaction[]> {
  let res = await txApi.getTransactionsByBlock({
    heightOrHash: 'latest',
  });
  let txs = res.results as Transaction[];
  return txs.filter(tx => {
    return tx.tx_type === 'contract_call';
  }) as ContractCallTransaction[];
}

async function getInfo() {
  let { client } = accounts[0];
  const [poxInfo, blockInfo, txs] = await Promise.all([
    client.getPoxInfo(),
    blocksApi.getBlock({
      heightOrHash: 'latest',
    }),
    getTransactions(),
  ]);
  const { reward_cycle_id } = poxInfo;
  return {
    poxInfo,
    blockInfo,
    nextCycleId: reward_cycle_id + 1,
    txs,
  };
}

type StackerSet = {
  stacker_set: {
    signers: {
      signer_key: string;
    }[];
  };
};

async function getSignerSet(cycle: number) {
  const url = `${nodeUrl}/v2/stacker_set/${cycle}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as StackerSet;
    return data;
  } catch (error) {
    return null;
  }
}

async function loop() {
  try {
    const { poxInfo, blockInfo, ...info } = await getInfo();
    let { reward_cycle_id, current_burnchain_block_height } = poxInfo;
    let { height } = blockInfo;
    let showBurnMsg = false;
    let showPrepareMsg = false;
    let showCycleMsg = false;
    let showStxBlockMsg = false;

    if (current_burnchain_block_height && current_burnchain_block_height !== lastBurnHeight) {
      if (didCrossPreparePhase(lastBurnHeight, current_burnchain_block_height)) {
        showPrepareMsg = true;
      }
      showBurnMsg = true;
      lastBurnHeight = current_burnchain_block_height;
    }

    if (reward_cycle_id !== lastRewardCycle) {
      showCycleMsg = true;
      lastRewardCycle = reward_cycle_id;
    }

    if (height !== lastStxHeight) {
      showStxBlockMsg = true;
      lastStxHeight = height;
      const now = new Date().getTime();
      lastStxBlockDiff = now - lastStxBlockTime;
      lastStxBlockTime = now;
    }

    if (showBurnMsg) {
      console.log(
        `Burn block: ${current_burnchain_block_height}\tSTX block: ${height}\t${blockInfo.tx_count} TX`
      );
      if (current_burnchain_block_height === EPOCH_30_START) {
        console.log('Starting Nakamoto!');
      }
    }
    if (showPrepareMsg) {
      console.log(`Prepare phase started. Next cycle is ${reward_cycle_id + 1}`);
      const nextSigners = await getSignerSet(reward_cycle_id + 1);
      if (nextSigners) {
        console.log(
          `Next cycle (${info.nextCycleId}) has ${nextSigners.stacker_set.signers.length} signers`
        );
      }
    }

    if (!showBurnMsg && showStxBlockMsg) {
      console.log(
        `Nakamoto block: ${height}\t${blockInfo.tx_count} TX\t(${(lastStxBlockDiff / 1000).toFixed(
          2
        )} seconds)`
      );
    }
    if (showStxBlockMsg && info.txs.length > 0) {
      info.txs.forEach(({ contract_call, sender_address, tx_status }) => {
        console.log(`${sender_address}:\t${contract_call.function_name}\t${tx_status}`);
      });
    }

    if (showCycleMsg) {
      const currentSigners = await getSignerSet(reward_cycle_id);
      const signerCount = currentSigners?.stacker_set.signers.length ?? 0;
      console.log(`New cycle started (${reward_cycle_id}) with ${signerCount} signers`);
    }

    if (reward_cycle_id >= EPOCH_30_START && !poxInfo.reward_slots) {
      console.error('FATAL: no signers while going in to Epoch 3.0');
      exit();
    }
  } catch (error) {
    let message = 'Caught error in monitor run loop';
    if (error instanceof Error) {
      message += `: ${error.message}`;
    } else {
      console.error(error);
    }
    console.error(message);
    // if (!message.toLowerCase().includes('fetch failed')) {
    //   throw error;
    // }
  }
}

function exit() {
  if (EXIT_FROM_MONITOR) {
    console.log('Exiting...');
    process.exit(1);
  }
}

async function runLoop() {
  await loop();
  setTimeout(runLoop, monitorInterval * 1000);
}

async function run() {
  await waitForSetup();
  await runLoop();
}
process.on('SIGTERM', () => {
  process.exit(0);
});
process.on('SIGINT', () => {
  process.exit(0);
});
run();

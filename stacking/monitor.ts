import {
  accounts,
  network,
  infoApi,
  nodeUrl,
  waitForSetup,
  EPOCH_30_START,
  didCrossPreparePhase,
} from './common';

let lastBurnHeight = 0;
let lastStxHeight = 0;
let lastRewardCycle = 0;

console.log('Monitoring...');

const EXIT_FROM_MONITOR = process.env.EXIT_FROM_MONITOR === '1';

console.log('Exit from monitor:', EXIT_FROM_MONITOR);

async function getInfo() {
  let { client } = accounts[0];
  const [poxInfo, coreInfo] = await Promise.all([client.getPoxInfo(), infoApi.getCoreApiInfo()]);
  const { reward_cycle_id } = poxInfo;
  const [currentSigners, nextSigners] = await Promise.all([
    getSignerSet(reward_cycle_id),
    getSignerSet(reward_cycle_id + 1),
  ]);
  return {
    poxInfo,
    coreInfo,
    currentSigners,
    nextSigners,
    nextCycleId: reward_cycle_id + 1,
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
    const { poxInfo, coreInfo, ...info } = await getInfo();
    let { reward_cycle_id, current_burnchain_block_height } = poxInfo;
    let { stacks_tip_height } = coreInfo;
    let showBurnMsg = false;
    let showPrepareMsg = false;
    let showCycleMsg = false;
    let showStxBlockMsg = false;
    let lastStxBlockTime = new Date().getTime();
    let lastStxBlockDiff = 0;

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

    if (stacks_tip_height !== lastStxHeight) {
      showStxBlockMsg = true;
      lastStxHeight = stacks_tip_height;
      const now = new Date().getTime();
      lastStxBlockDiff = now - lastStxBlockTime;
      lastStxBlockTime = now;
    }

    if (showBurnMsg) {
      console.log(`Burn block: ${current_burnchain_block_height}\tSTX block: ${stacks_tip_height}`);
      if (current_burnchain_block_height === EPOCH_30_START) {
        console.log('Starting Nakamoto!');
      }
    }
    if (showPrepareMsg) {
      console.log(`Prepare phase started. Next cycle is ${reward_cycle_id + 1}`);
      if (info.nextSigners) {
        console.log(
          `Next cycle (${info.nextCycleId}) has ${info.nextSigners.stacker_set.signers.length} signers`
        );
      }
    }

    if (!showBurnMsg && showStxBlockMsg) {
      console.log(
        `Nakamoto block: ${stacks_tip_height}\t (${(lastStxBlockDiff / 1000).toFixed(2)} seconds)`
      );
    }

    if (showCycleMsg) {
      const signerCount = info.currentSigners?.stacker_set.signers.length ?? 0;
      console.log(`New cycle started (${reward_cycle_id}) with ${signerCount} signers`);
    }

    // if (current_burnchain_block_height && current_burnchain_block_height !== lastBurnHeight) {
    //   console.log('Burn block:', current_burnchain_block_height);
    //   if (current_burnchain_block_height === EPOCH_30_START) {
    //     console.log('Starting Nakamoto!');
    //   }
    //   lastBurnHeight = current_burnchain_block_height;
    //   if (info.currentSigners) {
    //     console.log(
    //       `Current cycle (${reward_cycle_id}) has ${info.currentSigners.stacker_set.signers.length} signers`
    //     );
    //   }
    //   if (info.nextSigners) {
    //     console.log(
    //       `Next cycle (${info.nextCycleId}) has ${info.nextSigners.stacker_set.signers.length} signers`
    //     );
    //   }
    // }
    // if (stacks_tip_height !== lastStxHeight) {
    //   console.log('Stacks block:', stacks_tip_height);
    //   lastStxHeight = stacks_tip_height;
    // }
    if (reward_cycle_id >= EPOCH_30_START && !info.currentSigners?.stacker_set.signers.length) {
      console.error('FATAL: no signers while going in to Epoch 3.0');
      exit();
    }
  } catch (error) {
    let message = 'Caught error in monitor run loop';
    if (error instanceof Error) {
      message += `: ${error.message}`;
    }
    console.error(message);
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
  setTimeout(runLoop, 1000);
}

async function run() {
  await waitForSetup();
  await runLoop();
}

run();

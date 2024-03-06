import { StackingClient } from '@stacks/stacking';
import { StacksTestnet } from '@stacks/network';
import { getAddressFromPrivateKey, TransactionVersion, createStacksPrivateKey } from '@stacks/transactions';
import { getPublicKeyFromPrivate, publicKeyToBtcAddress } from '@stacks/encryption';

const stackingInterval = process.env.STACKING_INTERVAL ?? 2;
const postTxWait = process.env.POST_TX_WAIT ?? 10;
const stackingCycles = process.env.STACKING_CYCLES ?? 1;
const url = `http://${process.env.STACKS_CORE_RPC_HOST}:${process.env.STACKS_CORE_RPC_PORT}`;
const network = new StacksTestnet({ url });

const accounts = process.env.STACKING_KEYS.split(',').map(privKey => {
  const pubKey = getPublicKeyFromPrivate(privKey);
  const stxAddress = getAddressFromPrivateKey(privKey, TransactionVersion.Testnet);
  const signerPrivKey = createStacksPrivateKey(privKey);
  const signerPubKey = getPublicKeyFromPrivate(signerPrivKey.data);
  return {
    privKey, pubKey, stxAddress,
    btcAddr: publicKeyToBtcAddress(pubKey),
    signerPrivKey: signerPrivKey,
    signerPubKey: signerPubKey,
    client: new StackingClient(stxAddress, network),
  };
});

async function waitForSetup() {
  try {
    await accounts[0].client.getPoxInfo();
  } catch (error) {
    if (/(ECONNREFUSED|ENOTFOUND)/.test(error.cause?.message)) {
      console.log(`Stacks node not ready, waiting...`)
      await new Promise(resolve => setTimeout(resolve, 1000));
      return waitForSetup();
    }
    throw error;
  }
}

async function run() {
  await waitForSetup();
  const poxInfo = await accounts[0].client.getPoxInfo();
  if (!poxInfo.contract_id.endsWith('.pox-4')) {
    console.log(`Pox contract is not .pox-4, skipping stacking (contract=${poxInfo.contract_id})`);
    return;
  }
  const nextCycleStartHeight = poxInfo.next_cycle.prepare_phase_start_block_height;
  
  const accountInfos = await Promise.all(accounts.map(async a => {
    const info = await a.client.getAccountStatus();
    const unlockHeight = Number(info.unlock_height);
    const lockedAmount = BigInt(info.locked);
    return { ...a, info, unlockHeight, lockedAmount };
  }));

  let txSubmitted = false;

  let forceExtend = false;
  // Bump min threshold by 50% to avoid getting stuck if threshold increases
  const minStx = Math.floor(poxInfo.next_cycle.min_threshold_ustx * 1.5);
  const nextCycleStx = poxInfo.next_cycle.stacked_ustx;
  if (nextCycleStx < minStx) {
    forceExtend = true;
  }

  await Promise.all(accountInfos.map(async account => {
    if (account.lockedAmount === 0n) {
      console.log(`Account ${account.stxAddress} is unlocked, stack-stx required`);
      await stackStx(poxInfo, account);
      txSubmitted = true;
      return;
    }
    if (forceExtend || account.unlockHeight <= (nextCycleStartHeight - 5)) {
      console.log(`Account ${account.stxAddress} unlocks before next cycle ${account.unlockHeight} vs ${nextCycleStartHeight}, stack-extend required`);
      await stackExtend(poxInfo, account);
      txSubmitted = true;
      return;
    }
    console.log(`Account ${account.stxAddress} is locked for next cycle, skipping stacking`);
  }));

  if (txSubmitted) {
    await new Promise(resolve => setTimeout(resolve, postTxWait * 1000));
  }
}

/**
 * @param {import('@stacks/stacking').PoxInfo} poxInfo
 * @param {typeof accounts[0]} account
 */
async function stackStx(poxInfo, account) {
  // Bump min threshold by 50% to avoid getting stuck if threshold increases
  let minStx = Math.floor(poxInfo.next_cycle.min_threshold_ustx * 1.5);

  const sigArgs = {
    topic: 'stack-stx',
    rewardCycle: poxInfo.reward_cycle_id,
    poxAddress: account.btcAddr,
    period: stackingCycles,
    signerPrivateKey: account.signerPrivKey,
  };
  const signerSignature = account.client.signPoxSignature(sigArgs);
  const stackingArgs = {
    poxAddress: account.btcAddr,
    privateKey: account.privKey,
    amountMicroStx: minStx,
    burnBlockHeight: poxInfo.current_burnchain_block_height,
    cycles: stackingCycles,
    fee: 1000,
    signerKey: account.signerPubKey,
    signerSignature,
  };
  console.log('Stack-stx with args:', { addr: account.stxAddress, ...stackingArgs, ...sigArgs });
  const stackResult = await account.client.stack(stackingArgs);
  console.log('Stack-stx tx result', stackResult);
}

/**
 * @param {import('@stacks/stacking').PoxInfo} poxInfo
 * @param {typeof accounts[0]} account
 */
async function stackExtend(poxInfo, account) {
  const sigArgs = {
    topic: 'stack-extend',
    rewardCycle: poxInfo.reward_cycle_id,
    poxAddress: account.btcAddr,
    period: stackingCycles,
    signerPrivateKey: account.signerPrivKey,
  };
  const signerSignature = account.client.signPoxSignature(sigArgs);
  const stackingArgs = {
    poxAddress: account.btcAddr,
    privateKey: account.privKey,
    extendCycles: stackingCycles,
    fee: 1000,
    signerKey: account.signerPubKey,
    signerSignature,
  };
  console.log('Stack-extend with args:', { addr: account.stxAddress, ...stackingArgs, ...sigArgs });
  const stackResult = await account.client.stackExtend(stackingArgs);
  console.log('Stack-extend tx result', stackResult);
}

async function loop() {
  try {
    await run();
  } catch (e) {
    console.error('Error running stacking:', e);
  }
  setTimeout(loop, stackingInterval * 1000);
}
loop();

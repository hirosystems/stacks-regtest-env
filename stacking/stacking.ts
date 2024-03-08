import { StackingClient, PoxInfo, Pox4SignatureTopic } from '@stacks/stacking';
import { StacksTestnet } from '@stacks/network';
import {
  getAddressFromPrivateKey,
  TransactionVersion,
  createStacksPrivateKey,
} from '@stacks/transactions';
import { getPublicKeyFromPrivate, publicKeyToBtcAddress } from '@stacks/encryption';
import crypto from 'crypto';
import { Account, accounts, network, maxAmount, parseEnvInt, waitForSetup } from './common';

const randInt = () => crypto.randomInt(0, 0xffffffffffff);
const stackingInterval = parseEnvInt('STACKING_INTERVAL') ?? 2;
const postTxWait = parseEnvInt('POST_TX_WAIT') ?? 10;
const stackingCycles = parseEnvInt('STACKING_CYCLES') ?? 1;

async function run() {
  await waitForSetup();
  const poxInfo = await accounts[0].client.getPoxInfo();
  if (!poxInfo.contract_id.endsWith('.pox-4')) {
    console.log(`Pox contract is not .pox-4, skipping stacking (contract=${poxInfo.contract_id})`);
    return;
  }
  const nextCycleStartHeight = poxInfo.next_cycle.prepare_phase_start_block_height;

  const accountInfos = await Promise.all(
    accounts.map(async a => {
      const info = await a.client.getAccountStatus();
      const unlockHeight = Number(info.unlock_height);
      const lockedAmount = BigInt(info.locked);
      return { ...a, info, unlockHeight, lockedAmount };
    })
  );

  let txSubmitted = false;

  let forceExtend = false;
  // Bump min threshold by 50% to avoid getting stuck if threshold increases
  const minStx = Math.floor(poxInfo.next_cycle.min_threshold_ustx * 1.5);
  const nextCycleStx = poxInfo.next_cycle.stacked_ustx;
  if (nextCycleStx < minStx) {
    forceExtend = true;
  }

  await Promise.all(
    accountInfos.map(async account => {
      if (account.lockedAmount === 0n) {
        console.log(`Account ${account.stxAddress} is unlocked, stack-stx required`);
        await stackStx(poxInfo, account);
        txSubmitted = true;
        return;
      }
      if (forceExtend || account.unlockHeight <= nextCycleStartHeight - 5) {
        console.log(
          `Account ${account.stxAddress} unlocks before next cycle ${account.unlockHeight} vs ${nextCycleStartHeight}, stack-extend required`
        );
        await stackExtend(poxInfo, account);
        txSubmitted = true;
        return;
      }
      console.log(`Account ${account.stxAddress} is locked for next cycle, skipping stacking`);
    })
  );

  if (txSubmitted) {
    await new Promise(resolve => setTimeout(resolve, postTxWait * 1000));
  }
}

/**
 * @param {import('@stacks/stacking').PoxInfo} poxInfo
 * @param {typeof accounts[0]} account
 */
async function stackStx(poxInfo: PoxInfo, account) {
  // Bump min threshold by 50% to avoid getting stuck if threshold increases
  const minStx = Math.floor(poxInfo.next_cycle.min_threshold_ustx * 1.5);
  const amountToStx = Math.round(minStx * account.targetSlots);
  const authId = randInt();
  const sigArgs = {
    topic: Pox4SignatureTopic.StackStx,
    rewardCycle: poxInfo.reward_cycle_id,
    poxAddress: account.btcAddr,
    period: stackingCycles,
    signerPrivateKey: account.signerPrivKey,
    authId,
    maxAmount,
  } as const;
  const signerSignature = account.client.signPoxSignature(sigArgs);
  const stackingArgs = {
    poxAddress: account.btcAddr,
    privateKey: account.privKey,
    amountMicroStx: amountToStx,
    burnBlockHeight: poxInfo.current_burnchain_block_height,
    cycles: stackingCycles,
    fee: 1000,
    signerKey: account.signerPubKey,
    signerSignature,
    authId,
    maxAmount,
  };
  console.log('Stack-stx with args:', {
    addr: account.stxAddress,
    ...stackingArgs,
    ...sigArgs,
  });
  const stackResult = await account.client.stack(stackingArgs);
  console.log('Stack-stx tx result', stackResult);
}

async function stackExtend(poxInfo: PoxInfo, account: Account) {
  const authId = randInt();
  const sigArgs = {
    topic: Pox4SignatureTopic.StackExtend,
    rewardCycle: poxInfo.reward_cycle_id,
    poxAddress: account.btcAddr,
    period: stackingCycles,
    signerPrivateKey: account.signerPrivKey,
    authId,
    maxAmount,
  } as const;
  const signerSignature = account.client.signPoxSignature(sigArgs);
  const stackingArgs = {
    poxAddress: account.btcAddr,
    privateKey: account.privKey,
    extendCycles: stackingCycles,
    fee: 1000,
    signerKey: account.signerPubKey,
    signerSignature,
    authId,
    maxAmount,
  };
  console.log('Stack-extend with args:', {
    addr: account.stxAddress,
    ...stackingArgs,
    ...sigArgs,
  });
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

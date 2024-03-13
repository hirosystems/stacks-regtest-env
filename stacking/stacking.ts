import { StackingClient, PoxInfo, Pox4SignatureTopic } from '@stacks/stacking';
import { StacksTestnet } from '@stacks/network';
import {
  getAddressFromPrivateKey,
  TransactionVersion,
  createStacksPrivateKey,
} from '@stacks/transactions';
import { getPublicKeyFromPrivate, publicKeyToBtcAddress } from '@stacks/encryption';
import crypto from 'crypto';
import {
  Account,
  accounts,
  network,
  maxAmount,
  parseEnvInt,
  waitForSetup,
  logger,
  burnBlockToRewardCycle,
} from './common';

const randInt = () => crypto.randomInt(0, 0xffffffffffff);
const stackingInterval = parseEnvInt('STACKING_INTERVAL') ?? 2;
const postTxWait = parseEnvInt('POST_TX_WAIT') ?? 10;
const stackingCycles = parseEnvInt('STACKING_CYCLES') ?? 1;

let startTxFee = 1000;
const getNextTxFee = () => startTxFee++;

async function run() {
  await waitForSetup();
  const poxInfo = await accounts[0].client.getPoxInfo();
  if (!poxInfo.contract_id.endsWith('.pox-4')) {
    // console.log(`Pox contract is not .pox-4, skipping stacking (contract=${poxInfo.contract_id})`);
    logger.info(
      {
        poxContract: poxInfo.contract_id,
      },
      `Pox contract is not .pox-4, skipping stacking (contract=${poxInfo.contract_id})`
    );
    return;
  }

  const runLog = logger.child({
    burnHeight: poxInfo.current_burnchain_block_height,
  });

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
    runLog.info(`Next cycle has less than min threshold, force extending`);
    forceExtend = true;
  }

  await Promise.all(
    accountInfos.map(async account => {
      if (account.lockedAmount === 0n) {
        runLog.info(
          {
            burnHeight: poxInfo.current_burnchain_block_height,
            unlockHeight: account.unlockHeight,
            account: account.index,
          },
          `Account ${account.index} is unlocked, stack-stx required`
        );
        await stackStx(poxInfo, account);
        txSubmitted = true;
        return;
      }
      const unlockHeightCycle = burnBlockToRewardCycle(account.unlockHeight);
      const nowCycle = burnBlockToRewardCycle(poxInfo.current_burnchain_block_height ?? 0);
      if (forceExtend || unlockHeightCycle === nowCycle + 1) {
        runLog.info(
          {
            burnHeight: poxInfo.current_burnchain_block_height,
            unlockHeight: account.unlockHeight,
            account: account.index,
            nowCycle,
            unlockCycle: unlockHeightCycle,
          },
          `Account ${account.index} unlocks before next cycle ${account.unlockHeight} vs ${poxInfo.current_burnchain_block_height}, stack-extend required`
        );
        await stackExtend(poxInfo, account);
        txSubmitted = true;
        return;
      }
      runLog.info(
        {
          burnHeight: poxInfo.current_burnchain_block_height,
          unlockHeight: account.unlockHeight,
          account: account.index,
          nowCycle,
          unlockCycle: unlockHeightCycle,
        },
        `Account ${account.index} is locked for next cycle, skipping stacking`
      );
    })
  );

  if (txSubmitted) {
    await new Promise(resolve => setTimeout(resolve, postTxWait * 1000));
  }
}

async function stackStx(poxInfo: PoxInfo, account: Account) {
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
    fee: getNextTxFee(),
    signerKey: account.signerPubKey,
    signerSignature,
    authId,
    maxAmount,
  };
  account.logger.debug(
    {
      ...stackingArgs,
      ...sigArgs,
    },
    `Stack-stx with args:`
  );
  const stackResult = await account.client.stack(stackingArgs);
  account.logger.info(
    {
      ...stackResult,
    },
    `Stack-stx tx result`
  );
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
    fee: getNextTxFee(),
    signerKey: account.signerPubKey,
    signerSignature,
    authId,
    maxAmount,
  };
  account.logger.debug(
    {
      stxAddress: account.stxAddress,
      account: account.index,
      ...stackingArgs,
      ...sigArgs,
    },
    `Stack-extend with args:`
  );
  const stackResult = await account.client.stackExtend(stackingArgs);
  account.logger.info(
    {
      stxAddress: account.stxAddress,
      account: account.index,
      ...stackResult,
    },
    `Stack-extend tx result`
  );
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

const { StackingClient } = require('@stacks/stacking');
const { StacksTestnet } = require('@stacks/network');
const { getAddressFromPrivateKey, TransactionVersion, makeRandomPrivKey } = require('@stacks/transactions');
const { getPublicKeyFromPrivate, publicKeyToBtcAddress } = require('@stacks/encryption');
const crypto = require('crypto');

const stackingInterval = process.env.STACKING_INTERVAL ?? 2;
const postTxWait = process.env.POST_TX_WAIT ?? 10;
const stackingCycles = process.env.STACKING_CYCLES ?? 1;
const url = `http://${process.env.STACKS_CORE_RPC_HOST}:${process.env.STACKS_CORE_RPC_PORT}`;
const network = new StacksTestnet({ url });

const accounts = process.env.STACKING_KEYS.split(',').map(privKey => {
  const pubKey = getPublicKeyFromPrivate(privKey);
  const stxAddress = getAddressFromPrivateKey(privKey, TransactionVersion.Testnet);
  const signerPrivKey = makeRandomPrivKey();
  const signerPubKey = getPublicKeyFromPrivate(signerPrivKey.data);
  return {
    privKey, pubKey, stxAddress,
    btcAddr: publicKeyToBtcAddress(pubKey),
    signerPrivKey: privKey,
    signerPubKey: pubKey,
    client: new StackingClient(stxAddress, network),
  };
});

async function run() {
  const poxInfo = await accounts[0].client.getPoxInfo();
  if (!poxInfo.contract_id.endsWith('.pox-4')) {
    console.log(`Pox contract is not .pox-4, skipping stacking (contract=${poxInfo.contract_id})`);
    return;
  }
  const nextCycleStx = poxInfo.next_cycle.stacked_ustx;
  let minStx = poxInfo.next_cycle.min_threshold_ustx;
  // Bump min threshold by 50% to avoid getting stuck if threshold increases
  minStx = Math.floor(minStx * 1.5);
  if (nextCycleStx >= minStx) {
    console.log(`Next cycle has enough stacked, skipping stacking (stacked=${nextCycleStx}, min=${minStx})`);
    return;
  }
  let account;
  for (const a of accounts) {
    const lockedHeight = await a.client.getAccountBalanceLocked();
    if (lockedHeight === 0n) {
      account = a;
      break;
    }
  }
  if (!account) {
    console.log(`No unlocked account available for stacking`);
    return;
  }

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
  console.log('Stacking with args:', { addr: account.stxAddress, ...stackingArgs, ...sigArgs });
  const stackResult = await account.client.stack(stackingArgs);
  console.log('Stacking tx result', stackResult);
  await new Promise(resolve => setTimeout(resolve, postTxWait * 1000));
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

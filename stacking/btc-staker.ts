import {
  makeContractCall,
  broadcastTransaction,
  AnchorMode,
  makeContractDeploy,
} from '@stacks/transactions';
import { hex } from '@scure/base';
import { PoxInfo, V2PoxInfoResponse } from '@stacks/stacking';
import {
  accounts,
  parseEnvInt,
  waitForSetup,
  logger,
  burnBlockToRewardCycle,
  network,
  POX_REWARD_LENGTH,
  type Account,
  EPOCH_40_START,
  WALLET_NAME,
  waitForTxConfirmed,
  EPOCH_30_START,
  fetchAccount,
} from './common.js';
import {
  getUnlockBytes,
  serializeLockupScript,
  calculateUnlockBurnHeight,
  getLockingAddress,
  createOrLoadWallet,
  bitcoinRPC,
  getRawTransaction,
  listUnspent,
  sendToAddress,
} from './btc-helpers.js';
import { signSignerKeyGrant, pox5, pox5Signer, clarigenClient } from './pox-5-helpers.js';
import { readFile } from 'node:fs/promises';
import { buildSbtcDepositAddress, REGTEST, SbtcApiClientDevenv } from 'sbtc';
import { p2tr, TEST_NETWORK } from '@scure/btc-signer';

const stakingInterval = parseEnvInt('STACKING_INTERVAL', true);
const stakingCyclesPox5 = parseEnvInt('STACKING_CYCLES_POX_5', true);
const lockAmountSats = BigInt(parseEnvInt('BTC_LOCK_AMOUNT_SATS', false) ?? 10_000_000);
const sbtcDeployerAddress = process.env.SBTC_DEPLOYER_ADDRESS!;

let txFee = parseEnvInt('STACKING_FEE', false) ?? 1_000_000;
const getNextTxFee = () => txFee++;

type BitcoinTxVerbose = {
  vout: Array<{
    n: number;
    scriptPubKey: {
      address?: string;
    };
  }>;
};

// -- Initialization --

async function initBtcWallet() {
  await createOrLoadWallet(WALLET_NAME);
  logger.info({ wallet: WALLET_NAME }, 'Bitcoin staking wallet ready');

  // Wait for miner to fund the wallet
  while (true) {
    const utxos = await listUnspent(WALLET_NAME, 1);
    const total = utxos.reduce((sum, u) => sum + u.amount, 0);
    if (total > 0) {
      logger.info({ balance: total }, 'Staking wallet funded');
      return;
    }
    logger.info('Waiting for staking wallet to be funded...');
    await new Promise(r => setTimeout(r, 5000));
  }
}

// -- L2: Stacks contract calls --

async function submitStake(account: Account, poxInfo: PoxInfo) {
  const stakeFnCall = pox5.stake({
    startBurnHt: poxInfo.current_burnchain_block_height!,
    amountUstx: 100_000_000000n,
    numCycles: stakingCyclesPox5,
    signerManager: account.signerManager,
    signerCalldata: null,
  });

  const tx = await makeContractCall({
    ...stakeFnCall,
    senderKey: account.privKey,
    network,
    fee: getNextTxFee(),
    nonce: (await fetchAccount(account.stxAddress)).nonce,
  });
  const result = await broadcastTransaction({
    transaction: tx,
    network,
  });
  if ('reason' in result) {
    account.logger.error(
      {
        ...result,
      },
      `Error staking: ${result.reason}`
    );
    throw new Error(`Error staking: ${result.reason}`);
  }
  account.logger.info({ ...result }, 'stake tx broadcast');
  return result;
}

async function submitStakeExtend(account: Account) {
  const txOptions = {
    ...pox5.stakeUpdate({
      amountIncrease: 0n,
      cyclesToExtend: stakingCyclesPox5,
      signerManager: account.signerManager,
      oldSignerManager: account.signerManager,
      signerCalldata: null,
    }),
    senderKey: account.privKey,
    network,
    fee: getNextTxFee(),
    anchorMode: AnchorMode.Any,
  };

  const tx = await makeContractCall(txOptions);
  const result = await broadcastTransaction({
    transaction: tx,
    network,
  });
  if ('reason' in result) {
    account.logger.error({ ...result }, `Error extending stake: ${result.reason}`);
    throw new Error(`Error extending stake: ${result.reason}`);
  }
  account.logger.info({ txid: result.txid }, 'L2 stake-extend tx broadcast');
  return result;
}

// -- L1: Bitcoin locking transaction --

async function submitBtcLock(account: Account, unlockBurnHeight: bigint, unlockBytes: Uint8Array) {
  const lockScript = serializeLockupScript({
    stacker: account.stxAddress,
    unlockBurnHeight,
    unlockBytes,
  });

  const address = getLockingAddress(lockScript);
  const amountBtc = Number(lockAmountSats) / 1e8;

  const txid = await sendToAddress(WALLET_NAME, address, amountBtc);
  account.logger.info(
    { txid, address, amountBtc, unlockBurnHeight: unlockBurnHeight.toString() },
    'L1 BTC lock tx broadcast'
  );
  return txid;
}

// -- Main loop --

const grantedSignerKeys = new Set<string>();
const depositedSBTC = new Set<string>();
const fundedSignerKeys = new Set<string>();

async function maybeCalculateRewards(account: Account) {
  const pox5Info = await clarigenClient.ro(pox5.getPoxInfo());
  if (!pox5Info.value) return;

  const cycleLength = pox5Info.value.rewardCycleLength;
  const firstBurnHeight = pox5Info.value.firstBurnchainBlockHeight;
  const currentBurnHeight = BigInt(
    (await account.client.getPoxInfo()).current_burnchain_block_height!
  );
  const distributionLength = cycleLength / 2n;
  const currentDistributionCycle = (currentBurnHeight - firstBurnHeight) / distributionLength;
  if (currentDistributionCycle === 0n) return;

  const calculationHeight = firstBurnHeight + currentDistributionCycle * distributionLength - 1n;
  const lastCalculationHeight = await clarigenClient.ro(pox5.getLastRewardComputeHeight());
  if (calculationHeight <= lastCalculationHeight) return;

  const calculationRewardCycle = (calculationHeight - firstBurnHeight) / cycleLength;
  const firstBondCycle = await clarigenClient.ro(pox5.getFirstPox5RewardCycle());
  const latestBondIndex =
    calculationRewardCycle <= firstBondCycle ? 0n : (calculationRewardCycle - firstBondCycle) / 2n;
  const bondPeriods = (
    await Promise.all(
      Array.from({ length: 6 }, async (_, offset) => {
        const bondIndex = latestBondIndex - BigInt(offset);
        if (bondIndex < 0n) return null;
        const bond = await clarigenClient.ro(pox5.getProtocolBond(bondIndex));
        if (!bond) return null;
        const bondStartHeight = firstBurnHeight + (firstBondCycle + bondIndex * 2n) * cycleLength;
        const bondEndHeight =
          firstBurnHeight + (firstBondCycle + (bondIndex + 6n) * 2n) * cycleLength;
        if (calculationHeight <= bondStartHeight || calculationHeight > bondEndHeight) return null;
        return { bondIndex, stxValueRatio: bond.stxValueRatio };
      })
    )
  )
    .filter((bond): bond is { bondIndex: bigint; stxValueRatio: bigint } => bond !== null)
    .sort((a, b) => {
      if (a.stxValueRatio === b.stxValueRatio) return a.bondIndex < b.bondIndex ? -1 : 1;
      return a.stxValueRatio > b.stxValueRatio ? -1 : 1;
    })
    .map(bond => bond.bondIndex);

  const tx = await makeContractCall({
    ...pox5.calculateRewards({ bondPeriods }),
    senderKey: account.privKey,
    network,
    fee: getNextTxFee(),
    nonce: (await fetchAccount(account.stxAddress)).nonce,
  });
  const result = await broadcastTransaction({
    transaction: tx,
    network,
  });
  if ('reason' in result) {
    account.logger.error(
      { ...result, calculationHeight: calculationHeight.toString() },
      `Error calculating rewards: ${result.reason}`
    );
    throw new Error(`Error calculating rewards: ${result.reason}`);
  }
  account.logger.info(
    {
      txid: result.txid,
      calculationHeight: calculationHeight.toString(),
      bondPeriods: bondPeriods.map(String),
    },
    'calculate-rewards tx broadcast'
  );
  await waitForTxConfirmed(result.txid);
}

async function run() {
  let poxInfo: V2PoxInfoResponse;
  try {
    poxInfo = await accounts[0]!.client.getPoxInfo();
    // oxlint-disable-next-line no-unused-vars
  } catch (error) {
    return;
  }
  if (poxInfo.current_burnchain_block_height! < EPOCH_40_START) {
    // logger.info({ burnHeight: poxInfo.current_burnchain_block_height }, 'Not on epoch 3.5 yet, skipping');
    return;
  }

  const currentCycle = poxInfo.reward_cycle_id;

  await maybeCalculateRewards(accounts[0]!);

  const accountInfos = await Promise.all(
    accounts.map(async a => {
      const info = await fetchAccount(a.stxAddress);
      return { ...a, ...info };
    })
  );

  const nowCycle = burnBlockToRewardCycle(poxInfo.current_burnchain_block_height ?? 0);

  const txIdsToWait: string[] = [];

  for (const account of accountInfos) {
    const unlockBytes = getUnlockBytes(account.pubKey);
    const unlockBurnHeight = calculateUnlockBurnHeight(
      currentCycle,
      stakingCyclesPox5,
      POX_REWARD_LENGTH
    );

    if (!grantedSignerKeys.has(account.signerManager)) {
      const authId = 2n;
      const signature = signSignerKeyGrant({
        signerManager: account.signerManager,
        authId,
        signerSk: hex.decode(account.signerPrivKey),
      });

      const signerManager = await readFile('./contracts/pox-5-signer.clar', 'utf8');
      const deployTx = await makeContractDeploy({
        senderKey: account.privKey,
        network,
        contractName: 'signer-manager',
        codeBody: signerManager
          .replaceAll(' .pox-5', ` '${pox5.identifier}`)
          .replaceAll('SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4', sbtcDeployerAddress)
          .replaceAll(
            'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4',
            'ST3NBRSFKX28FQ2ZJ1MAKX58HKHSDGNV5N7R21XCP'
          ),
      });
      const deployResult = await broadcastTransaction({
        transaction: deployTx,
        network,
      });
      const exists = 'reason' in deployResult && deployResult.reason === 'ContractAlreadyExists';
      if (!exists) {
        if ('reason' in deployResult) {
          throw new Error(`Error deploying signer manager: ${deployResult.reason}`);
        }
        account.logger.info({ ...deployResult }, 'Deployed signer manager');
        await waitForTxConfirmed(deployResult.txid);
      }

      const signerKey = await clarigenClient.ro(pox5.getSignerInfo(account.signerManager));

      if (!signerKey) {
        const registerSelf = await makeContractCall({
          ...pox5Signer(account.signerManager).registerSelf({
            signerManager: account.signerManager,
            signerKey: hex.decode(account.signerPubKey),
            authId,
            signerSig: signature,
          }),
          nonce: (await fetchAccount(account.stxAddress)).nonce,
          senderKey: account.privKey,
          network,
        });
        const registerSelfResult = await broadcastTransaction({
          transaction: registerSelf,
          network,
        });
        if ('reason' in registerSelfResult) {
          throw new Error(`Error registering signer manager: ${registerSelfResult.reason}`);
        }
        account.logger.info({ ...registerSelfResult }, 'Registered self');
        await waitForTxConfirmed(registerSelfResult.txid);
      }
      grantedSignerKeys.add(account.signerManager);
    }

    await fundSbtcSignerUtxo();

    if (!depositedSBTC.has(account.stxAddress)) {
      await depositSBTC(account);
      depositedSBTC.add(account.stxAddress);
    }

    if (account.lockedAmount === 0n) {
      account.logger.info('Account unlocked, staking...', {
        account: account.index,
        rewardCycle: poxInfo.reward_cycle_id,
        unlockBurnHeight: unlockBurnHeight.toString(),
      });

      const stakeResult = await submitStake(account, poxInfo);
      txIdsToWait.push(stakeResult.txid);

      await submitBtcLock(account, unlockBurnHeight, unlockBytes);
      continue;
    }

    const unlockCycle = burnBlockToRewardCycle(account.unlockHeight);

    if (unlockCycle === nowCycle + 1) {
      account.logger.info(
        { unlockHeight: account.unlockHeight, nowCycle, unlockCycle },
        'Extending stake...'
      );

      const stakeExtendResult = await submitStakeExtend(account);
      txIdsToWait.push(stakeExtendResult.txid);

      await submitBtcLock(account, unlockBurnHeight, unlockBytes);
      continue;
    }

    // account.logger.info({ nowCycle, unlockCycle }, 'Staked through next cycle, skipping');
  }
  await Promise.all(txIdsToWait.map(waitForTxConfirmed));
}

function getSbtcClient() {
  return new SbtcApiClientDevenv({
    sbtcContract: sbtcDeployerAddress,
    btcApiUrl: 'http://bitcoind:18443',
    stxApiUrl: 'http://stacks-api:3999',
    sbtcApiUrl: 'http://emily-server:3031',
  });
}

async function fundSbtcSignerUtxo() {
  const client = getSbtcClient();
  let signerKey = '';
  try {
    signerKey = await client.fetchSignersPublicKey();
    // oxlint-disable-next-line no-unused-vars
  } catch (_error) {
    return;
  }
  if (fundedSignerKeys.has(signerKey)) return;

  const regtest = { ...TEST_NETWORK, bech32: 'bcrt' };
  const signerKeyHex = signerKey.startsWith('0x') ? signerKey.slice(2) : signerKey;
  const xOnlyPublicKey = (() => {
    if (signerKeyHex.length === 64) return signerKeyHex;
    if (signerKeyHex.length === 66) return signerKeyHex.slice(2);
    if (signerKeyHex.length === 128) return signerKeyHex.slice(0, 64);
    if (signerKeyHex.length === 130 && signerKeyHex.startsWith('04'))
      return signerKeyHex.slice(2, 66);
    return Buffer.from(signerKey).toString('hex');
  })();
  if (xOnlyPublicKey.length !== 64) {
    throw new Error(
      `Expected 32-byte x-only sBTC signer key, got ${xOnlyPublicKey.length} hex chars`
    );
  }
  const signerPayment = p2tr(xOnlyPublicKey, undefined, regtest);
  if (!signerPayment.address) {
    throw new Error(`Could not derive sBTC signer address for aggregate key ${signerKey}`);
  }

  const txid = await sendToAddress(WALLET_NAME, signerPayment.address, 0.1);
  logger.info(
    { txid, address: signerPayment.address, aggregateKey: signerKey },
    'Funded sBTC signer UTXO'
  );
  fundedSignerKeys.add(signerKey);
}

async function depositSBTC(account: Account) {
  console.log('Depositing sBTC for account:', account.stxAddress);
  const client = getSbtcClient();

  const deposit = buildSbtcDepositAddress({
    stacksAddress: account.stxAddress, // the address to send/mint the sBTC to
    signersPublicKey: await client.fetchSignersPublicKey(), // the aggregated public key of the signers
    reclaimLockTime: 950, // default locktime for reclaiming failed deposits
    reclaimPublicKey: account.pubKey.slice(0, 64), // public key for reclaiming failed deposits
    network: REGTEST,
    maxSignerFee: 50_000, // max fee the signers can charge for processing the subsequent sweep tx
  });
  console.log('Deposit Address:', { address: deposit.address, account: account.stxAddress });

  const txid = await sendToAddress(WALLET_NAME, deposit.address, 0.1);
  console.log('Sent BTC to deposit address:', {
    txid: txid,
    address: deposit.address,
    account: account.stxAddress,
  });
  await new Promise(resolve => setTimeout(resolve, 1000));
  const transaction = await getRawTransaction(txid);
  if (!/^[0-9a-f]+$/i.test(transaction)) {
    throw new Error(`Expected raw transaction hex for ${txid}, got: ${transaction.slice(0, 80)}`);
  }
  const transactionInfo = await bitcoinRPC<BitcoinTxVerbose>('getrawtransaction', [txid, true]);
  const vout = transactionInfo.vout.find(
    output => output.scriptPubKey.address === deposit.address
  )?.n;
  if (vout === undefined) {
    throw new Error(`Could not find deposit output for ${deposit.address} in ${txid}`);
  }
  console.log('Transaction:', { transaction, vout });
  const notifyResult = await client.notifySbtc({ ...deposit, transaction, vout });
  console.log('Notified sbtc:', { notifyResult, txid });
}

async function loop() {
  await waitForSetup();
  await initBtcWallet();

  while (true) {
    try {
      await run();
    } catch (e) {
      logger.error(e, 'Error in btc-staker loop');
    }
    await new Promise(r => setTimeout(r, stakingInterval * 1000));
  }
}

loop();

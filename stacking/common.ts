import { StackingClient } from '@stacks/stacking';
import { StacksTestnet } from '@stacks/network';
import {
  getAddressFromPrivateKey,
  TransactionVersion,
  createStacksPrivateKey,
} from '@stacks/transactions';
import { getPublicKeyFromPrivate, publicKeyToBtcAddress } from '@stacks/encryption';
import { StacksNodeApi } from '@stacks/api';
import crypto from 'crypto';
import { InfoApi, Configuration, BlocksApi } from '@stacks/blockchain-api-client';

export const nodeUrl = `http://${process.env.STACKS_CORE_RPC_HOST}:${process.env.STACKS_CORE_RPC_PORT}`;
export const network = new StacksTestnet({ url: nodeUrl });
const apiConfig = new Configuration({
  basePath: nodeUrl,
});
export const infoApi = new InfoApi(apiConfig);
export const blocksApi = new BlocksApi(apiConfig);

export const EPOCH_30_START = parseEnvInt('STACKS_30_HEIGHT', true);
export const EPOCH_25_START = parseEnvInt('STACKS_25_HEIGHT', true);

export const accounts = process.env.STACKING_KEYS!.split(',').map((privKey, index) => {
  const pubKey = getPublicKeyFromPrivate(privKey);
  const stxAddress = getAddressFromPrivateKey(privKey, TransactionVersion.Testnet);
  const signerPrivKey = createStacksPrivateKey(privKey);
  const signerPubKey = getPublicKeyFromPrivate(signerPrivKey.data);
  return {
    privKey,
    pubKey,
    stxAddress,
    btcAddr: publicKeyToBtcAddress(pubKey),
    signerPrivKey: signerPrivKey,
    signerPubKey: signerPubKey,
    targetSlots: (index + 1) * 2,
    client: new StackingClient(stxAddress, network),
  };
});

export type Account = typeof accounts[0];

export const MAX_U128 = 2n ** 128n - 1n;
export const maxAmount = MAX_U128;

export async function waitForSetup() {
  try {
    await accounts[0].client.getPoxInfo();
  } catch (error) {
    if (/(ECONNREFUSED|ENOTFOUND)/.test(error.cause?.message)) {
      console.log(`Stacks node not ready, waiting...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      return waitForSetup();
    }
    throw error;
  }
}

export function parseEnvInt(envKey: string, required: true): number;
export function parseEnvInt(envKey: string): number | undefined;
export function parseEnvInt(envKey: string, required: undefined): number | undefined;
export function parseEnvInt(envKey: string, required?: boolean) {
  let value = process.env[envKey];
  if (typeof value === 'undefined') {
    if (required) {
      throw new Error(`Missing required env var: ${envKey}`);
    }
    return undefined;
  }
  return parseInt(value, 10);
}

/** hard-coded numbers from Stacks.toml file */
export function burnBlockToRewardCycle(burnBlock: number) {
  const cycleLength = 20n;
  return Number(BigInt(burnBlock) / cycleLength) + 1;
}

export const EPOCH_30_START_CYCLE = burnBlockToRewardCycle(EPOCH_30_START);

export function isPreparePhase(burnBlock: number) {
  return 20 - (burnBlock % 20) < 5;
}

export function didCrossPreparePhase(lastBurnHeight: number, newBurnHeight: number) {
  return isPreparePhase(newBurnHeight) && !isPreparePhase(lastBurnHeight);
}

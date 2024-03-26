import { StacksTestnet } from '@stacks/network';
import { StackingClient } from '@stacks/stacking';
import {
  TransactionVersion,
  getAddressFromPrivateKey,
  getNonce,
  makeSTXTokenTransfer,
  broadcastTransaction,
} from '@stacks/transactions';

const broadcastInterval = parseInt(process.env.NAKAMOTO_BLOCK_INTERVAL ?? '2');
const url = `http://${process.env.STACKS_CORE_RPC_HOST}:${process.env.STACKS_CORE_RPC_PORT}`;
const network = new StacksTestnet({ url });
const EPOCH_30_START = parseInt(process.env.STACKS_30_HEIGHT ?? '0');

const accounts = process.env.ACCOUNT_KEYS!.split(',').map(privKey => ({
  privKey,
  stxAddress: getAddressFromPrivateKey(privKey, TransactionVersion.Testnet),
}));

const client = new StackingClient(accounts[0].stxAddress, network);

async function run() {
  const accountNonces = await Promise.all(
    accounts.map(async account => {
      const nonce = await getNonce(account.stxAddress, network);
      return { ...account, nonce };
    })
  );

  // Send from account with lowest nonce
  accountNonces.sort((a, b) => Number(a.nonce) - Number(b.nonce));
  const sender = accountNonces[0];
  const recipient = accountNonces[1];

  console.log(
    `Sending stx-transfer from ${sender.stxAddress} (nonce=${sender.nonce}) to ${recipient.stxAddress}`
  );

  const tx = await makeSTXTokenTransfer({
    recipient: recipient.stxAddress,
    amount: 1000,
    senderKey: sender.privKey,
    network,
    nonce: sender.nonce,
    fee: 300,
    anchorMode: 'any',
  });

  const broadcastResult = await broadcastTransaction(tx, network);
  if (broadcastResult.error) {
    console.error('Error broadcasting stx-transfer', broadcastResult);
  } else {
    console.log(`Broadcast stx-transfer tx=${broadcastResult.txid}`);
  }
}

async function waitForNakamoto() {
  while (true) {
    try {
      const poxInfo = await client.getPoxInfo();
      if (poxInfo.current_burnchain_block_height! <= EPOCH_30_START) {
        console.log(`Nakamoto not activated yet, waiting... (current=${poxInfo.current_burnchain_block_height}), (epoch3=${EPOCH_30_START})`);
      } else {
        console.log(`Nakamoto activation height reached, ready to submit txs for Nakamoto block production`);
        break;
      }
    } catch (error) {
      if (/(ECONNREFUSED|ENOTFOUND|SyntaxError)/.test(error.cause?.message)) {
        console.log(`Stacks node not ready, waiting...`);
      } else {
        console.error('Error getting pox info:', error);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}

async function loop() {
  await waitForNakamoto();
  while (true) {
    try {
      await run();
    } catch (e) {
      console.error('Error submitting stx-transfer tx:', e);
    }
    await new Promise(resolve => setTimeout(resolve, broadcastInterval * 1000));
  }
}
loop();

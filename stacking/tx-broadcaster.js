const { StacksTestnet } = require('@stacks/network');
const { TransactionVersion, getAddressFromPrivateKey, getNonce, makeSTXTokenTransfer, broadcastTransaction } = require('@stacks/transactions');

const broadcastInterval = process.env.BROADCAST_INTERVAL ?? 2;
const postTxWait = process.env.POST_TX_WAIT ?? 2;
const url = `http://${process.env.STACKS_CORE_RPC_HOST}:${process.env.STACKS_CORE_RPC_PORT}`;
const network = new StacksTestnet({ url });

const accounts = process.env.ACCOUNT_KEYS.split(',').map(privKey => ({
  privKey,
  stxAddress: getAddressFromPrivateKey(privKey, TransactionVersion.Testnet),
}));

async function run() {
  const accountNonces = await Promise.all(accounts.map(async (account) => {
    const nonce = await getNonce(account.stxAddress, network);
    return { ...account, nonce };
  }));

  // Send from account with lowest nonce
  accountNonces.sort((a, b) => Number(a.nonce) - Number(b.nonce));
  const sender = accountNonces[0];
  const recipient = accountNonces[1];

  console.log(`Sending stx-transfer from ${sender.stxAddress} (nonce=${sender.nonce}) to ${recipient.stxAddress}`);

  const tx = await makeSTXTokenTransfer({
    recipient: recipient.stxAddress,
    amount: 1000,
    senderKey: sender.privKey,
    network,
    nonce: sender.nonce,
    fee: 300,
  });

  const broadcastResult = await broadcastTransaction(tx, network);
  if (broadcastResult.error) {
    console.error('Error broadcasting stx-transfer', broadcastResult);
  } else {
    console.log(`Broadcast stx-transfer tx=${broadcastResult.txid}`);
  }

  await new Promise(resolve => setTimeout(resolve, postTxWait * 1000));
}

async function loop() {
  try {
    await run();
  } catch (e) {
    console.error('Error submitting stx-transfer tx:', e);
  }
  setTimeout(loop, broadcastInterval * 1000);
}
loop();

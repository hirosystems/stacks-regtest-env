# Stacks Regtest Environment

Easily run a Stacks node in Kypton mode with a Bitcoind regtest instance and Stacks API

## Run with Docker Compose

Clone this repo and change to its directory:
```shell
git clone https://github.com/zone117x/stacks-regtest-env.git
cd stacks-regtest-env
```

Run the command to create the initial chainstate snapshots:
```shell
docker compose up --build snapshot-init
```
This mines the initial [101 blocks on bitcoind](https://developer.bitcoin.org/examples/testing.html#regtest-mode) (required to have any spendable tBTC in regtest), and syncs the stacks-node against the initial Bitcoin blocks so that it's ready to produce a Stacks block immediately on next startup. Once completed new files will be created in the `init-data` directory.

This only needs ran once. However, after pulling updates from this repo, re-run the command in case the pulled changes are incompatible with the previous snapshot.


Now the environment can be started with:
```shell
docker compose up --build
```

The block mining interval defaults to 500ms. This can be configured with the `MINE_INTERVAL` environment variable, for example:
```shell
MINE_INTERVAL=2.5s docker compose up --build
```

#### The following services are created

###### Bitcoind node in regtest mode
  * JSON-RPC interface available at http://localhost:18443
  * RPC auth username and password are both `krypton`
  * tBTC is available from the miner account:
    * Address: `miEJtNKa3ASpA19v5ZhvbKTEieYjLpzCYT`
    * Private key: `9e446f6b0c6a96cf2190e54bcd5a8569c3e386f091605499464389b8d4e0bfc201`
    * Private key (WIF format): `cStMQXkK5yTFGP3KbNXYQ3sJf2qwQiKrZwR9QJnksp32eKzef1za`
###### Mining script that automatically triggers bitcoind to mine new Bitcoin blocks
  * Block mining interval defaults to 500ms, configure using the `MINE_INTERVAL` environment variable
###### Stacks-node in kypton mode (i.e. a regtest-like local testnet)
  * RPC available at http://localhost:20443/v2/info
  * STX are preseeded to several accounts listed in [`stacks-krypton-miner.toml`](stacks-krypton-miner.toml), first account:
    * Address: `STB44HYPYAT2BB2QE513NSP81HTMYWBJP02HPGK6`
    * Key: `cb3df38053d132895220b9ce471f6b676db5b9bf0b4adefb55f2118ece2478df01`
###### Stacks API instance
  * API available at http://localhost:3999/extended/v1/block
  * Playground/debug webpages listed at http://localhost:3999/extended/v1/debug/broadcast
###### PostgreSQL database required by the Stacks API
  * PG port is available at 5490
  * Both username and password are `postgres`
  * Database name: `stacks_blockchain_api`


_Note:_ preserving chainstate between environment restarts is not yet supported. Before re-starting the environment, clear data from previous sessions by running:

```shell
docker compose down --volumes --remove-orphans --timeout=1 --rmi=all
```

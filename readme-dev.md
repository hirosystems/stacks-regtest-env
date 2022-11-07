### Locally build and test e2e dockerfile

First build:
```shell
docker build -t e2e-test -f Dockerfile.e2e .
```

Then run:
```shell
docker run --rm -p "20443:20443" -e MINE_INTERVAL=0.01s -v "$(pwd)"/event-log.json:/event-log.json e2e-test
```

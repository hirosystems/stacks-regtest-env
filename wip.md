* First build the image:
```shell
docker build -t e2e-test -f Dockerfile.e2e .
```

* Then run the image:
```shell
docker run --rm -p "20443:20443" -e MINE_INTERVAL=5s e2e-test
```

* If everything works, visit http://localhost:20443/v2/pox

#!/usr/bin/env bash

docker compose down --volumes --remove-orphans --timeout=1 --rmi=all
docker compose --profile snapshot-init up --build
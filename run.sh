#!/usr/bin/env bash

docker compose down --volumes --remove-orphans --timeout=1 --rmi=local
# docker compose up --build
docker compose up --build
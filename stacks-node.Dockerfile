FROM rust:bullseye as builder

ARG GIT_COMMIT
RUN test -n "$GIT_COMMIT" || (echo "GIT_COMMIT not set" && false)

RUN echo "Building stacks-node from commit: https://github.com/stacks-network/stacks-blockchain/commit/$GIT_COMMIT"

WORKDIR /stacks
RUN git init && \
    git remote add origin https://github.com/stacks-network/stacks-blockchain.git && \
    git -c protocol.version=2 fetch --depth=1 origin "$GIT_COMMIT" && \
    git reset --hard FETCH_HEAD

RUN cargo build --package stacks-node --bin stacks-node --release

FROM debian:bullseye
COPY --from=builder /stacks/target/release/stacks-node /usr/local/bin/stacks-node
CMD ["stacks-node"]

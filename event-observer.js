#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const decodeTransaction = require('stacks-encoding-native-js').decodeTransaction;

const server = http.createServer((request, response) => {
  const { headers, method, url } = request;
  let body = [];
  request.on('error', (err) => {
    console.error(err);
    response.writeHead(500).end();
  }).on('data', (chunk) => {
    body.push(chunk);
  }).on('end', () => {
    body = JSON.parse(Buffer.concat(body).toString());
    if (body.transactions) {
      for (const transaction of body.transactions) {
        transaction.decoded_tx = decodeTransaction(transaction.raw_tx)
      }
    }
    console.log(url, body);
    fs.appendFileSync('/event-log.json', `["${url}",${JSON.stringify(body)}]\n`);
    response.writeHead(200).end();
  });
});
server.listen(3998, '0.0.0.0', () => {
  console.log(`Event-observer started on: ${server.address().address}:${server.address().port}`);
});

process.on('exit', (code) => {
  console.log(`Event-observer to exit with code: ${code}`);
});

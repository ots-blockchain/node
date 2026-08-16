# OTS Blockchain

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Docker Pulls](https://img.shields.io/docker/pulls/grovvik/ots-node)](https://hub.docker.com/r/grovvik/ots-node)

OTS Blockchain is a decentralized, custom-built blockchain platform featuring an integrated peer-to-peer (P2P) network, secure wallet management, advanced cryptography, and a JavaScript-based smart contract execution environment.

## How It Works

The OTS Blockchain is designed around several core technical pillars:

* **P2P Networking**: Operates via WebSockets to facilitate decentralized communication. Nodes seamlessly connect to peers, synchronize blockchain state, and broadcast transactions in real-time.
* **Cryptography & Wallets**: Leverages robust cryptographic algorithms for generating private/public keys, securing transactions with digital signatures, and managing wallets. Accounts are identified via Base58 encoded addresses.
* **Smart Contract Runtime**: Features an innovative JavaScript runtime. Instead of executing raw JS directly, the environment securely compiles JavaScript smart contract code into a custom Abstract Syntax Tree (AST) format prior to execution. This enables decompilation and guarantees deterministic, safe contract execution.

## Environment Variables (.env)

Both the Main (Validator) Node and API Node rely on environment variables for configuration. You can pass environment variables via a `.env` file (`--env-file .env`) or inline using `-e` parameters in Docker.

### 1. Main (Validator) Node (`main/index.js`)

| Variable | Required | Description | Example |
| :--- | :--- | :--- | :--- |
| `PORT` | Yes | WebSocket P2P server port for peer connections | `5001` |
| `PEERS` | Yes | Comma-separated WebSocket URLs of peer nodes | `ws://127.0.0.1:5002,ws://127.0.0.1:5003` |
| `KEY` | Yes | Private key of the validator node | `YOUR_PRIVATE_KEY` |

### 2. API Node (`api/index.js`)

| Variable | Required | Description | Default / Example |
| :--- | :--- | :--- | :--- |
| `PORT` | No | HTTP REST API server port | `3000` |
| `SEED_NODE_URL` | No | WebSocket URL of the seed/validator node to connect to | `ws://127.0.0.1:5001` |

---

## Running with Docker

### 1. Pulling Pre-built Image from Docker Hub

To pull and run the validator node image from Docker Hub:

```bash
# Pull the latest image
docker pull grovvik/ots-node:main

# Run the validator node with environment variables
docker run -d \
  -p 5001:5001 \
  -e PORT=5001 \
  -e PEERS="ws://peer-node-ip:5001" \
  -e KEY="YOUR_VALIDATOR_PRIVATE_KEY" \
  --name ots-validator \
  grovvik/ots-node:main
```

Using a `.env` file:

```bash
docker run -d -p 5001:5001 --env-file .env --name ots-validator grovvik/ots-node:main
```

### 2. Building the Image Locally

To clone the repository and build the Docker image locally:

```bash
# Clone the repository
git clone https://github.com/ots-blockchain/node.git
cd ots/node

# Build the local Docker image
docker build -t ots-node .
```

Run your local image:

```bash
docker run -d -p 5001:5001 --env-file .env --name ots-validator ots-node
```

### 3. Running the API Node (Explorer / REST API)

The Docker image contains both the main node and the API node. You can spin up an API node by overriding the container command:

```bash
docker run -d \
  -p 3000:3000 \
  -e PORT=3000 \
  -e SEED_NODE_URL="ws://127.0.0.1:5001" \
  --name ots-api-node \
  grovvik/ots-node:main node api/index.js
```

Or run it directly using Node.js:

```bash
cd node/api
npm install
PORT=3000 SEED_NODE_URL="ws://127.0.0.1:5001" node index.js
```

## License

This project is open-source and distributed under the MIT License. For more information, please see the `LICENSE` file.

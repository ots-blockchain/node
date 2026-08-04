const WebSocket = require('ws');
const CryptoUtils = require('../core/crypto');
const Blockchain = require('../core/blockchain');
const { Transaction, Block } = require('../models/models');
const Network = require('./network');
const { consts } = require('../core/config');
const Logger = require('../core/logger.js');
const logger = new Logger('P2PNetwork');

const notBroadcast = [
    'SYNC_REQ', 'SYNC_RES', 'MEMPOOL_REQ', 'MEMPOOL_RES', 'NONCE_REQ',
    'NONCE', 'ACC_REQ', 'ACC', 'ELEC_REQ', 'ELEC', 'STRG_REQ', 'STRG',
    'TX_RES', 'GETBLK_REQ', 'GETBLK', 'INFO_REQ', 'INFO'
];

class P2PNetwork {
    /**
     * @param {Blockchain} blockchain 
     */
    constructor(blockchain) {
        this.blockchain = blockchain;
        this.sockets = [];
        this.validators = new Set([blockchain.validatorAddress]);
        this.seenMessages = new Set();
        this.seenMessageQueue = [];
        this.lastBlockTime = Date.now();
        this.syncParams = {
            lastSyncTime: 0
        };
    }

    startServer(port) {
        const server = new WebSocket.Server({ port });
        server.on('connection', (socket) => this.initConnection(socket));
        logger.info(`P2P Node listening on port ${port}`);
        this.startConsensus();
    }

    connectToPeer(url) {
        const connect = () => {
            const socket = new WebSocket(url);

            socket.on('open', () => {
                logger.info(`Connected to peer: ${url}`);
                this.initConnection(socket, url);
            });

            socket.on('error', () => {});

            socket.on('close', () => {
                this.closeConnection(socket, url, connect);
            });
        }

        connect()
    }

    initConnection(socket, url = null) {
        socket.binaryType = 'nodebuffer'; 
        this.sockets.push(socket);
        
        socket.on('message', async (data) => await this.handleMessage(socket, data));
        socket.on('close', () => this.closeConnection(socket, url, null, false ));

        Network.send(this.blockchain.validatorKey, socket, { type: 'VD' });

        Network.send(this.blockchain.validatorKey, socket, { 
            type: 'SYNC_REQ', 
            index: this.blockchain.chain.length 
        });

        Network.send(this.blockchain.validatorKey, socket, { type: 'MEMPOOL_REQ' });
    }

    /**
     * @param {WebSocket} socket
     * @param {string} url
     * @param {Function} connect
     * @param {boolean} reconnect
     */
    async closeConnection(socket, url, connect, reconnect = true) {
        this.sockets = this.sockets.filter(s => s !== socket);
        if (reconnect) {
            logger.warn(`Peer ${url} disconnected. Retrying in ${consts.RECONNECT_INTERVAL / 1000}s...`);
            setTimeout(connect, consts.RECONNECT_INTERVAL);
        }
    }

    /**
     * @param {object} message 
     * @param {WebSocket[] | undefined} without
     */
    async broadcast(message, without = []) {
        const data = {
            type: message.type,
            from: this.blockchain.validatorAddress,
            message_id: CryptoUtils.hash(Date.now() + Math.random().toString()),
            payload: message
        };
        const sign = CryptoUtils.sign(CryptoUtils.hash(CryptoUtils.serializeWithBigInt(data)), this.blockchain.validatorKey);
        const binaryPacket = await Network.serialize({ sign, data });

        this.sockets.forEach(socket => {
            if (socket.readyState === WebSocket.OPEN && !without.includes(socket)) {
                socket.send(binaryPacket);
            }
        });
    }

    async checkValidatorStatus(address) {
        try {
            const account = await this.blockchain.state.getAccount(address);
            const isValidator = !!account && account.stake >= consts.MINIMAL_STAKE;
            return isValidator;
        } catch {
            return false;
        }
    }

    markAsSeen(id) {
        this.seenMessages.add(id);
        this.seenMessageQueue.push(id);
        if (this.seenMessages.size > consts.MAX_SEEN_MESSAGES) {
            const oldest = this.seenMessageQueue.shift();
            this.seenMessages.delete(oldest);
        }
    }

    startConsensus() {
        if (this.consensusInterval) clearInterval(this.consensusInterval);
        
        this.currentRound = 0;
        this.roundStartTime = Date.now();
        this.lastConsensusHeight = this.blockchain.chain.length;
        this.roundActionDone = false;
        
        this.consensusInterval = setInterval(async () => {
            if (this.lastConsensusHeight !== this.blockchain.chain.length) {
                this.currentRound = 0;
                this.lastConsensusHeight = this.blockchain.chain.length;
                this.roundStartTime = Date.now();
                this.roundActionDone = false;
            }

            const timeInRound = Date.now() - this.roundStartTime;
            if (timeInRound > consts.BLOCK_TIMEOUT_MS) {
                this.currentRound++;
                this.roundStartTime = Date.now();
                this.roundActionDone = false;
                logger.warn(`Consensus timeout! Moving to round ${this.currentRound}`);
                if (this.currentRound > 2) {
                     await this.broadcast({ type: 'SYNC_REQ', index: this.blockchain.chain.length });
                }
            }
            
            if (this.roundActionDone) return;

            const nextIndex = this.blockchain.chain.length;
            const elected = await this.blockchain.getElectedValidator(nextIndex, this.currentRound);
            
            if (elected === this.blockchain.validatorAddress) {
                const timeSinceLastBlock = Date.now() - (this.lastBlockTime || 0);
                if (timeSinceLastBlock < consts.TICK_INTERVAL) return;

                this.roundActionDone = true;
                const newBlock = await this.blockchain.executeBlock();
                if (newBlock) {
                    newBlock.header.round = this.currentRound;
                    logger.info(`Proposing block ${newBlock.header.index} for round ${this.currentRound}`);
                    await this.broadcast({ 
                        type: 'PROPOSE', 
                        block: newBlock.serialize()
                    });
                    
                    const preVote = await this.blockchain.handleProposal(newBlock);
                    if (preVote) {
                        const preCommit = await this.blockchain.handlePreVote(newBlock, preVote);
                        await this.broadcast({ type: 'PRE_VOTE', block: newBlock.serialize(), vote: preVote });
                        if (preCommit) {
                            const committed = await this.blockchain.handlePreCommit(newBlock, preCommit);
                            await this.broadcast({ type: 'PRE_COMMIT', block: newBlock.serialize(), vote: preCommit });
                            if (committed) {
                                await this.broadcast({ type: 'COMMIT_BLK', block: newBlock.serialize() });
                            }
                        }
                    }
                }
            }
        }, 500); 
    }

    /**
     * @param {WebSocket} socket
     * @param {Buffer} binaryData
     */
    async handleMessage(socket, binaryData) {
        if (!Buffer.isBuffer(binaryData)) return;

        const message = Network.verifyPacket(await Network.deserialize(binaryData));
        if (!message) return;

        const { data } = message;

        if (this.seenMessages.has(data.message_id)) return;
        this.markAsSeen(data.message_id);

        const isValidator = await this.checkValidatorStatus(data.from);
        if (isValidator) {
            switch (data.type) {
                case 'PROPOSE': {
                    const incomingBlock = Block.deserialize(data.payload.block);
                    const round = incomingBlock.header.round || 0;
                    
                    if (incomingBlock.header.index === this.blockchain.chain.length) {
                        if (round > this.currentRound) {
                            this.currentRound = round;
                            this.roundStartTime = Date.now();
                            this.roundActionDone = false;
                        }
                    }

                    const elected = await this.blockchain.getElectedValidator(incomingBlock.header.index, round);
                    if (!elected || elected != data.from) break;
                    
                    const preVote = await this.blockchain.handleProposal(incomingBlock);
                    if (preVote) {
                        logger.info(`Pre-voted for proposed block ${incomingBlock.header.index} (Round ${round})`);
                        // Process our own pre-vote locally to contribute to 2/3
                        const preCommit = await this.blockchain.handlePreVote(incomingBlock, preVote);
                        
                        // Broadcast our pre-vote
                        await this.broadcast({ type: 'PRE_VOTE', block: data.payload.block, vote: preVote });

                        if (preCommit) {
                            const committed = await this.blockchain.handlePreCommit(incomingBlock, preCommit);
                            await this.broadcast({ type: 'PRE_COMMIT', block: incomingBlock.serialize(), vote: preCommit });
                            if (committed) {
                                this.lastBlockTime = Date.now();
                                await this.broadcast({ type: 'COMMIT_BLK', block: incomingBlock.serialize() });
                            }
                        }
                    }
                    break;
                }
                case 'PRE_VOTE': {
                    const incomingBlock = Block.deserialize(data.payload.block);

                    const round = incomingBlock.header.round || 0;
                    if (incomingBlock.header.index === this.blockchain.chain.length) {
                        if (round > this.currentRound) {
                            this.currentRound = round;
                            this.roundStartTime = Date.now();
                            this.roundActionDone = false;
                        }
                    }

                    const preCommit = await this.blockchain.handlePreVote(incomingBlock, data.payload.vote);
                    if (preCommit) {
                        logger.info(`Block ${incomingBlock.header.index} locked (Polka reached)! Pre-committing.`);
                        
                        const committed = await this.blockchain.handlePreCommit(incomingBlock, preCommit);
                        await this.broadcast({ type: 'PRE_COMMIT', block: incomingBlock.serialize(), vote: preCommit });
                        
                        if (committed) {
                            this.lastBlockTime = Date.now();
                            await this.broadcast({ type: 'COMMIT_BLK', block: incomingBlock.serialize() });
                        }
                    }
                    break;
                }
                case 'PRE_COMMIT': {
                    const incomingBlock = Block.deserialize(data.payload.block);

                    const round = incomingBlock.header.round || 0;
                    if (incomingBlock.header.index === this.blockchain.chain.length) {
                        if (round > this.currentRound) {
                            this.currentRound = round;
                            this.roundStartTime = Date.now();
                            this.roundActionDone = false;
                        }
                    }

                    const committed = await this.blockchain.handlePreCommit(incomingBlock, data.payload.vote);
                    if (committed) {
                        logger.info(`Block ${incomingBlock.header.index} finalized (2/3 PRE_COMMITs)!`);
                        this.lastBlockTime = Date.now();
                        await this.broadcast({ type: 'COMMIT_BLK', block: incomingBlock.serialize() });
                    }
                    break;
                }
                case 'BLK':
                case 'COMMIT_BLK': {
                    const incomingBlock = Block.deserialize(data.payload.block);
                    const success = await this.blockchain.pushBlockToQueue(incomingBlock);
                    if (success) {
                        logger.info(`Accepted COMMITTED block ${incomingBlock.header.index} via ${data.type}`);
                        this.lastBlockTime = Date.now();
                    }
                    break;
                }
            }
        }

        switch (data.type) {
            case 'TX': {
                if (this.blockchain.mempool.length === 0) this.lastBlockTime = Date.now();
                const tx = Transaction.deserialize(data.payload.tx);
                this.blockchain.addTransaction(tx);
                this.blockchain.txCallbacks[tx.getHash()] = (async (res) => {
                    await Network.send(this.blockchain.validatorKey, socket, { 
                        type: 'TX_RES', 
                        data: CryptoUtils.serializeWithBigInt(res)
                    });
                });
                break;
            }
            case 'MEMPOOL_RES': {
                if (!data.payload.data || typeof data.payload.data != 'object') break;
                const txs = data.payload.data.map(txData => Transaction.deserialize(txData));
                let added = 0;
                for (const tx of txs) {
                    try {
                        if (await this.blockchain.addTransaction(tx)) added++;
                    } catch {}
                }
                if (added > 0) console.log(`Synced ${added} txs`);
                break;
            }
            case 'MEMPOOL_REQ': {
                if (this.blockchain.mempool.length > 0) {
                    const serializedTxs = this.blockchain.mempool.map(tx => tx.serialize());
                    logger.debug(`Sending mempool: ${serializedTxs.length} txs`);
                    await Network.send(this.blockchain.validatorKey, socket, {
                        type: 'MEMPOOL_RES',
                        data: serializedTxs
                    });
                }
                break;
            }
            case 'SYNC_RES': {
                const blocksData = CryptoUtils.deserializeWithBigInt(data.payload.blocks);
                const lastIndex = this.blockchain.chain.length - 1;
                let i = 0;
                if (!blocksData || blocksData.length == 0) break;
                for (const b of blocksData) {
                    const blockObj = Block.deserialize(b);
                    if (blockObj.header.index <= lastIndex) continue;
                    const success = await this.blockchain.pushBlockToQueue(blockObj, true);
                    if (success) {
                        i++;
                        this.blockchain.mempool = this.blockchain.mempool.filter(tx => 
                            !blockObj.body.some(btx => btx.getHash() === tx.getHash())
                        );
                    }
                }
                if (i > 0) {
                    logger.debug(`Synced ${i} blocks`);
                    this.lastBlockTime = Date.now();
                }
                break;
            }
            case 'SYNC_REQ': {
                const now = Date.now();
                if (now - this.syncParams.lastSyncTime < consts.BLOCK_TIMEOUT_MS) {
                    break;
                }
            
                const blocks = this.blockchain.getBlocksFrom(data.payload.index);
                if (blocks.length > 0) {
                    logger.debug(`Send ${blocks.length} blocks`);
                    await Network.send(this.blockchain.validatorKey, socket, { 
                        type: 'SYNC_RES', 
                        blocks: CryptoUtils.serializeWithBigInt(blocks.map(b => b.serialize())) 
                    });
                    this.syncParams.lastSyncTime = now;
                }
                break;
            }

            // API
            case 'NONCE_REQ': {
                if (!data.payload.address) break;
                try {
                    const nonce = await this.blockchain.calculateNonce(data.payload.address)
                    await Network.send(this.blockchain.validatorKey, socket, { 
                        type: 'NONCE', 
                        data: nonce
                    });
                } catch {
                    await Network.send(this.blockchain.validatorKey, socket, { 
                        type: 'NONCE', 
                        data: null
                    });
                }
                break;
            }

            case 'ACC_REQ': {
                if (!data.payload.address) break;
                try {
                    const account = { ...await this.blockchain.state.getAccount(data.payload.address) };
                    account.storage = undefined;
                    await Network.send(this.blockchain.validatorKey, socket, { 
                        type: 'ACC', 
                        data: account
                    });
                } catch {
                    await Network.send(this.blockchain.validatorKey, socket, { 
                        type: 'ACC', 
                        data: null
                    });
                }
            }

            case 'ELEC_REQ': {
                try {
                    const elected = await this.blockchain.getElectedValidator(data.payload.index || this.blockchain.chain.length);
                    await Network.send(this.blockchain.validatorKey, socket, { 
                        type: 'ELEC', 
                        data: elected
                    });
                } catch {
                    await Network.send(this.blockchain.validatorKey, socket, { 
                        type: 'ELEC', 
                        data: null
                    });
                }
            }

            case 'STRG_REQ': {
                if (!data.payload.address || !data.payload.key) break;
                try {
                    const dataParam = await this.blockchain.state.getContractStorage(data.payload.address, data.payload.key);
                    await Network.send(this.blockchain.validatorKey, socket, { 
                        type: 'STRG', 
                        data: dataParam
                    });
                } catch {
                    await Network.send(this.blockchain.validatorKey, socket, { 
                        type: 'STRG', 
                        data: null
                    });
                }
                break;
            }

            case 'GETBLK_REQ': {
                if (typeof data.payload.height != 'number' || data.payload.height < 0) break;
                try {
                    const dataParam = await this.blockchain.chain[data.payload.height];
                    await Network.send(this.blockchain.validatorKey, socket, { 
                        type: 'GETBLK', 
                        data: dataParam ? dataParam.serialize() : null
                    });
                } catch {
                    await Network.send(this.blockchain.validatorKey, socket, { 
                        type: 'GETBLK', 
                        data: null
                    });
                }
                break;
            }

            case 'INFO_REQ': {
                try {
                    const index = this.blockchain.chain.length - 1;
                    const prevBlock = this.blockchain.chain[index];
                    const elected = await this.blockchain.getElectedValidator(data.payload.index || this.blockchain.chain.length);
                    const dataParam = {
                        height: index,
                        mempool: this.blockchain.mempool.length,
                        prevBlockHash: prevBlock ? prevBlock.getHash() : '0',
                        elected: elected
                    };
                    await Network.send(this.blockchain.validatorKey, socket, { 
                        type: 'INFO', 
                        data: dataParam
                    });
                } catch {
                    await Network.send(this.blockchain.validatorKey, socket, { 
                        type: 'INFO', 
                        data: null
                    });
                }
                break;
            }
        }

        if (!notBroadcast.includes(data.type)) {
            this.sockets.forEach(bsocket => {
                if (socket != bsocket) bsocket.send(binaryData);
            });
        }
    }
}

module.exports = P2PNetwork;

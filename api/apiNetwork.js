const WebSocket = require('ws');
const CryptoUtils = require('../main/core/crypto');
const { Transaction, Block } = require('../main/models/models');
const Network = require('../main/network/network');
const { consts } = require('../main/core/config');
const Logger = require('../main/core/logger.js');
const logger = new Logger('P2PNetwork');

class P2PNetwork {
    constructor(blockchain) {
        this.blockchain = blockchain;
        this.socket = null;
        this.seenMessages = new Set();
        this.seenMessageQueue = [];
        this.syncParams = {
            lastSyncTime: 0
        };
    }

    connectToPeer(url) {
        const connect = () => {
            if (this.socket) {
                this.socket.removeAllListeners();
                if (this.socket.readyState === WebSocket.OPEN) {
                    this.socket.close();
                }
            }

            const socket = new WebSocket(url);

            socket.on('open', () => {
                logger.info(`Connected to peer: ${url}`);
                this.socket = socket;
                this.initConnection();
                this.requestSync();
            });

            socket.on('error', (err) => {
                logger.error(`Socket error: ${err.message}`);
            });

            socket.on('close', () => {
                this.socket = null;
                this.closeConnection(connect);
            });
        }

        connect();
    }

    initConnection() {
        if (!this.socket) return;
        this.socket.binaryType = 'nodebuffer';
        this.socket.on('message', async (data) => await this.handleMessage(data));

        this.startSyncLoop();
    }

    async closeConnection(connect, reconnect = true) {
        if (this.syncInterval) clearInterval(this.syncInterval);
        if (reconnect) {
            logger.warn(`Peer disconnected. Retrying in ${consts.RECONNECT_INTERVAL / 1000}s...`);
            setTimeout(connect, consts.RECONNECT_INTERVAL);
        }
    }

    async send(data) {
        if (!data || typeof data !== 'object') throw new Error(`Expected object`);
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            return;
        }
        await Network.send(this.blockchain.validatorKey, this.socket, data);
    }

    markAsSeen(id) {
        this.seenMessages.add(id);
        this.seenMessageQueue.push(id);
        if (this.seenMessages.size > consts.MAX_SEEN_MESSAGES) {
            const oldest = this.seenMessageQueue.shift();
            this.seenMessages.delete(oldest);
        }
    }

    startSyncLoop() {
        if (this.syncInterval) clearInterval(this.syncInterval);
        this.syncInterval = setInterval(() => {
            this.requestSync();
        }, 15000);
    }

    async requestSync() {
        await this.send({
            type: 'SYNC_REQ',
            index: this.blockchain.chain.length
        });
    }

    async handleMessage(binaryData) {
        if (!Buffer.isBuffer(binaryData)) return;

        const message = Network.verifyPacket(await Network.deserialize(binaryData));
        if (!message) return;

        const { data } = message;

        if (this.seenMessages.has(data.message_id)) return;
        this.markAsSeen(data.message_id);

        switch (data.type) {
            case 'BLK': {
                const blockObj = Block.deserialize(data.payload.block);
                const success = await this.blockchain.pushBlockToQueue(blockObj, true);
                if (success) {
                    logger.info(`New block received via P2P: ${blockObj.header.index}`);
                }
                break;
            }

            case 'TX': {
                const tx = Transaction.deserialize(data.payload.tx);
                try {
                    this.blockchain.addTransaction(tx);
                } catch (e) {
                    logger.debug(`Invalid TX received: ${e.message}`);
                }
                break;
            }

            case 'SYNC_RES': {
                const blocksData = CryptoUtils.deserializeWithBigInt(data.payload.blocks);
                const lastIndex = this.blockchain.chain.length - 1;
                let added = 0;

                if (!blocksData || blocksData.length == 0) break;

                for (const b of blocksData) {
                    const blockObj = Block.deserialize(b);
                    if (blockObj.header.index <= lastIndex) continue;
                    const success = await this.blockchain.pushBlockToQueue(blockObj, true);
                    if (success) {
                        added++;
                    } else {
                        break;
                    }
                }

                if (added > 0) {
                    logger.info(`Synced ${added} blocks from network. Current height: ${this.blockchain.chain.length - 1}`);
                }
                break;
            }
        }
    }
}

module.exports = P2PNetwork;
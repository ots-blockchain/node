const WebSocket = require('ws');
const CryptoUtils = require('../core/crypto');
const { Transaction, Block } = require('../models/models');
const Network = require('./network');
const { consts } = require('../core/config');
const Logger = require('../core/logger.js');
const logger = new Logger('P2PNetwork');

class P2PNetwork {
    /**
     * @param {string} privateKey 
     */
    constructor(privateKey) {
        this.privateKey = privateKey;
        this.seenMessages = new Set();
        this.seenMessageQueue = [];
        this.callbacks = {};
        this.socket = null;
    }

    /**
     * @param {string} url 
     */
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
                this.initConnection();
            });

            socket.on('error', (err) => {
                logger.error(`Socket error: ${err.message}`);
            });

            socket.on('close', () => {
                this.closeConnection(connect);
            });

            this.socket = socket;
        }

        connect();
    }

    initConnection() {
        if (!this.socket) return;
        this.socket.binaryType = 'nodebuffer';
        this.socket.on('message', async (data) => await this.handleMessage(data));
    }

    /**
     * @param {Function} connect
     * @param {boolean} reconnect
     */
    async closeConnection(connect, reconnect = true) {
        if (reconnect) {
            logger.warn(`Peer disconnected. Retrying in ${consts.RECONNECT_INTERVAL / 1000}s...`);
            setTimeout(connect, consts.RECONNECT_INTERVAL);
        }
    }

    /**
     * @param {Transaction} tx 
     */
    async sendTransaction(tx) {
        if (!tx.isValid()) throw new Error("Invalid Tx Signature");
        const type = 'TX_RES';
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`${type} request timeout after ${consts.BLOCK_TIMEOUT_MS + consts.TICK_INTERVAL}ms`));
            }, consts.BLOCK_TIMEOUT_MS + consts.TICK_INTERVAL);

            this.callbacks[type] = this.callbacks[type] || [];

            this.callbacks[type].push((data) => {
                clearTimeout(timer);
                const txres = CryptoUtils.deserializeWithBigInt(data?.payload?.data);
                if (txres?.hash == tx.getHash()) {
                    resolve(txres);
                }
            });

            this.send({ type: 'TX', tx: tx.serialize() })
                .catch(err => {
                    clearTimeout(timer);
                    reject(err);
                });
        });
    }

    /**
     * @param {string} type 
     * @param {object} params 
     * @param {number} timeout 
     */
    async _requestWithTimeout(type, params, timeout) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`${type} request timeout after ${timeout}ms`));
            }, timeout);

            this.callbacks[type] = this.callbacks[type] || [];

            this.callbacks[type].push((data) => {
                clearTimeout(timer);
                resolve(data?.payload?.data);
            });

            this.send({ type: `${type}_REQ`, ...params })
                .catch(err => {
                    clearTimeout(timer);
                    reject(err);
                });
        });
    }

    /**
     * @param {string} address
     * @returns {number | null}
     */
    async getNonce(address) {
        let lastError;
        for (let i = 0; i < consts.MAX_RETRIES; i++) {
            try {
                return Number(await this._requestWithTimeout('NONCE', { address: String(address) }, consts.REQUEST_TIMEOUT));
            } catch (err) {
                lastError = err;
                logger.warn(`getNonce attempt ${i + 1}/${consts.MAX_RETRIES} failed: ${err.message}`);
                if (i < consts.MAX_RETRIES - 1) {
                    await new Promise(r => setTimeout(r, 500));
                }
            }
        }
        throw lastError;
    }

    /**
     * @param {number} height
     * @returns {Block | null}
     */
    async getBlock(height) {
        let lastError;
        for (let i = 0; i < consts.MAX_RETRIES; i++) {
            try {
                const blockData = await this._requestWithTimeout('GETBLK', { height: Number(height) }, consts.REQUEST_TIMEOUT);
                return Block.deserialize(blockData);
            } catch (err) {
                lastError = err;
                logger.warn(`getBlock attempt ${i + 1}/${consts.MAX_RETRIES} failed: ${err.message}`);
                if (i < consts.MAX_RETRIES - 1) {
                    await new Promise(r => setTimeout(r, 500));
                }
            }
        }
        throw lastError;
    }

    /**
     * @returns {object | null}
     */
    async getInfo() {
        let lastError;
        for (let i = 0; i < consts.MAX_RETRIES; i++) {
            try {
                const info = await this._requestWithTimeout('INFO', null, consts.REQUEST_TIMEOUT);
                
                return info;
            } catch (err) {
                lastError = err;
                logger.warn(`getInfo attempt ${i + 1}/${consts.MAX_RETRIES} failed: ${err.message}`);
                if (i < consts.MAX_RETRIES - 1) {
                    await new Promise(r => setTimeout(r, 500));
                }
            }
        }
        throw lastError;
    }

    /**
     * @param {string} address
     * @returns {object | null}
     */
    async getAccount(address) {
        let lastError;
        for (let i = 0; i < consts.MAX_RETRIES; i++) {
            try {
                return await this._requestWithTimeout('ACC', { address: String(address) }, consts.REQUEST_TIMEOUT);
            } catch (err) {
                lastError = err;
                logger.warn(`getAccount attempt ${i + 1}/${consts.MAX_RETRIES} failed: ${err.message}`);
                if (i < consts.MAX_RETRIES - 1) {
                    await new Promise(r => setTimeout(r, 500));
                }
            }
        }
        throw lastError;
    }

    /**
     * @param {string} address
     * @param {string} key
     * @returns {object | null}
     */
    async getStorage(address, key) {
        let lastError;
        for (let i = 0; i < consts.MAX_RETRIES; i++) {
            try {
                return await this._requestWithTimeout('STRG', { address: String(address), key: String(key) }, consts.REQUEST_TIMEOUT);
            } catch (err) {
                lastError = err;
                logger.warn(`getAccount attempt ${i + 1}/${consts.MAX_RETRIES} failed: ${err.message}`);
                if (i < consts.MAX_RETRIES - 1) {
                    await new Promise(r => setTimeout(r, 500));
                }
            }
        }
        throw lastError;
    }

    markAsSeen(id) {
        this.seenMessages.add(id);
        this.seenMessageQueue.push(id);
        if (this.seenMessages.size > consts.MAX_SEEN_MESSAGES) {
            const oldest = this.seenMessageQueue.shift();
            this.seenMessages.delete(oldest);
        }
    }

    /**
     * @param {Buffer} binaryData 
     */
    async handleMessage(binaryData) {
        if (!Buffer.isBuffer(binaryData)) return;

        const message = Network.verifyPacket(await Network.deserialize(binaryData));
        if (!message) return;

        const { data } = message;

        if (this.seenMessages.has(data.message_id)) return;
        this.markAsSeen(data.message_id);
        if (data.type && typeof this.callbacks[data.type] === 'object') {
            const queue = this.callbacks[data.type];
            if (queue && queue.length > 0) {
                const callback = queue.shift();
                if (callback) callback(data);
            }
        }
    }

    /**
     * @param {object} data
     * @param {string} data.type
     */
    async send(data) {
        if (!data || typeof data !== 'object') throw new Error(`Expected object, received null`);
        if (!data.type || typeof data.type !== 'string') throw new Error(`Expected string, received ${typeof data.type}`);
        
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            throw new Error('Socket is not connected');
        }

        await Network.send(this.privateKey, this.socket, data);
    }
}

module.exports = P2PNetwork;

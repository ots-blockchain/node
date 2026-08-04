const CryptoUtils = require('../core/crypto');
const zlib = require('zlib');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

class Network {
    static async serialize(packet) {
        if (!packet.data.type) throw new Error(`Please provide 'type' parameter in packet`);
        const typeBuf = Buffer.from(packet.data.type, 'utf8');
        const payloadBuf = Buffer.from(CryptoUtils.serializeWithBigInt(packet.data.payload || {}), 'utf8');
        const fromBuf = Buffer.from(packet.data.from, 'hex');
        const msgIdBuf = Buffer.from(packet.data.message_id, 'hex');
        const signBuf = Buffer.from(packet.sign, 'hex');

        // [Sign:64][From:33][MsgId:32][TypeLen:1][Type:X][Payload:Y]
        const buffer = Buffer.concat([
            signBuf,
            fromBuf,
            msgIdBuf,
            Buffer.from([typeBuf.length]), 
            typeBuf,
            payloadBuf
        ]);

        return await gzip(buffer);
    }

    static async deserialize(cbuffer) {
        try {
            const buffer = await gunzip(cbuffer);
            let offset = 0;
            const sign = buffer.subarray(offset, offset += 64).toString('hex');
            const from = buffer.subarray(offset, offset += 33).toString('hex');
            const message_id = buffer.subarray(offset, offset += 32).toString('hex');
            const typeLen = buffer[offset++];
            const type = buffer.subarray(offset, offset += typeLen).toString('utf8');
            const payload = CryptoUtils.deserializeWithBigInt(buffer.subarray(offset).toString('utf8'));

            return { sign, data: { type, from, message_id, payload } };
        } catch (e) {
            return null;
        }
    }

    /**
     * @param {string} data json
     * @returns {object | null}
     */
    static verifyPacket(data) {
        try {
            const message = data;
            return CryptoUtils.verify(message.sign, CryptoUtils.hash(CryptoUtils.serializeWithBigInt(message.data)), message.data.from) ? message : null;
        } catch(e) {
            return null;
        }
    }

    /**
     * @param {WebSocket} socket 
     * @param {object} dataObj 
     */
    static async send(privateKey, socket, dataObj) {
        if (!privateKey || !socket || !dataObj) return;
        const { type, ...payload } = dataObj;
        
        const data = {
            type,
            from: CryptoUtils.getPublicKey(privateKey),
            message_id: CryptoUtils.hash(Date.now() + Math.random().toString()),
            payload: payload
        };

        const sign = CryptoUtils.sign(CryptoUtils.hash(CryptoUtils.serializeWithBigInt(data)), privateKey);
        const binaryPacket = await this.serialize({ sign, data });

        if (socket.readyState === WebSocket.OPEN) {
            socket.send(binaryPacket);
        }
    }
}

module.exports = Network;

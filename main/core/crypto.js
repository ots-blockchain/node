const secp = require('@noble/secp256k1');
const { sha256 } = require('@noble/hashes/sha2.js');
const { hmac } = require('@noble/hashes/hmac.js');
const { bytesToHex, hexToBytes } = require('@noble/hashes/utils.js');

secp.hashes.sha256 = (msg) => sha256(msg);
secp.hashes.hmacSha256 = (msg, data) => hmac(sha256, msg, data);

class CryptoUtils {
    static hash(data) {
        const str = typeof data === 'string' ? data : this.serializeWithBigInt(data);
        return bytesToHex(sha256(new TextEncoder().encode(str)));
    }

    /**
     * @param {string | Uint8Array} privateKey 
     * @returns {string} hex
     */
    static getPublicKey(privateKey) {
        return bytesToHex(secp.getPublicKey(typeof privateKey === 'string' ? hexToBytes(privateKey) : privateKey));
    }

    /**
     * @param {string | Uint8Array} hash 
     * @param {string | Uint8Array} privateKey 
     * @returns {string} hex
     */
    static sign(hash, privateKey) {
        const sig = secp.sign(typeof hash === 'string' ? hexToBytes(hash) : hash, typeof privateKey === 'string' ? hexToBytes(privateKey) : privateKey);
        return bytesToHex(sig);
    }

    /**
     * @param {string | Uint8Array} signature 
     * @param {string | Uint8Array} hash 
     * @param {string | Uint8Array} publicKey 
     * @returns {boolean}
     */
    static verify(signature, hash, publicKey) {
        return secp.verify(typeof signature === 'string' ? hexToBytes(signature) : signature, typeof hash === 'string' ? hexToBytes(hash) : hash, typeof publicKey === 'string' ? hexToBytes(publicKey) : publicKey);
    }

    static isValidPublicKey(hexKey) {
        try {
            secp.Point.fromHex(hexKey);
            return true;
        } catch (error) {
            try {
                return hexToBytes(hexKey).length >= 16;
            } catch {
                return false;
            }
        }
    }

    static serializeWithBigInt(value) {
        return JSON.stringify(value, (_, v) => 
            typeof v === 'bigint' ? { __bigint: true, value: v.toString() } : v
        );
    }
    
    static deserializeWithBigInt(json) {
        if (typeof json === 'string') {
            return JSON.parse(json, (_, v) => 
                v?.__bigint === true ? BigInt(v.value) : v
            );
        }
        return json;
    }

    static generateKeyPair() {
        const privateKey = secp.keygen();
        return {
            privateKey: bytesToHex(privateKey.secretKey),
            publicKey: bytesToHex(privateKey.publicKey)
        };
    }
}

module.exports = CryptoUtils;

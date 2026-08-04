const CryptoUtils = require('../core/crypto');

class Transaction {
    /**
     * @param {object} params
     * @param {('transfer' | 'deploy' | 'call' | 'stake')} params.type
     * @param {string} params.from
     * @param {string} params.to
     * @param {bigint} params.amount
     * @param {string} params.data
     * @param {number} params.nonce
     * @param {string} params.signature
     */
    constructor({ type, from, to = null, amount = 0n, data = "", nonce = 0, signature = null, timestamp = Date.now(), gasLimit = 0n, valid = undefined }) {
        this.type = type;
        this.from = from;
        this.to = to;
        this.amount = amount;
        this.data = data;
        this.nonce = nonce;
        this.signature = signature;
        this.timestamp = timestamp;
        this.gasLimit = gasLimit;
        if (valid !== undefined) {
            this.valid = valid;
        }
    }

    getHash() {
        const payload = {
            type: this.type, from: this.from, to: this.to,
            amount: this.amount, data: this.data, nonce: this.nonce,
            timestamp: this.timestamp, gasLimit: this.gasLimit
        };
        return CryptoUtils.hash(payload);
    }

    sign(privateKey) {
        this.signature = CryptoUtils.sign(this.getHash(), privateKey);
    }

    serialize() {
        return CryptoUtils.serializeWithBigInt(this);
    }

    static deserialize(data) {
        if (!data) return null;
        if (data instanceof Transaction) return data;
        const obj = (typeof data === 'string' || Buffer.isBuffer(data))
            ? CryptoUtils.deserializeWithBigInt(data)
            : data;
        return new Transaction(obj);
    }

    isValid() {
        if (!this.signature) return false;
        return CryptoUtils.verify(this.signature, this.getHash(), this.from);
    }
}

class Block {
    constructor(index, prevHash, transactions, validator, stateRoot, signatures = [], timestamp = Date.now(), round = 0) {
        this.header = {
            index,
            prevHash,
            timestamp,
            validator,
            stateRoot,
            signatures: signatures || [],
            round: round
        };
        this.body = (transactions && transactions.length > 0)
            ? transactions.map(tx => Transaction.deserialize(tx))
            : [];
    }

    serialize() {
        return CryptoUtils.serializeWithBigInt(this);
    }

    static deserialize(data) {
        if (!data) return null;
        if (data instanceof Block) return data;
        const b = (typeof data === 'string' || Buffer.isBuffer(data))
            ? CryptoUtils.deserializeWithBigInt(data)
            : data;

        return new Block(
            b.header.index,
            b.header.prevHash,
            b.body,
            b.header.validator,
            b.header.stateRoot,
            b.header.signatures || [],
            b.header.timestamp,
            b.header.round || 0
        );
    }

    getSigningHash() {
        const txHashes = this.body.map(tx => tx.getHash()).join('');
        const { signatures, ...unsignedHeader } = this.header;
        return CryptoUtils.hash(
            CryptoUtils.serializeWithBigInt(unsignedHeader) + txHashes
        );
    }

    getHash() {
        return this.getSigningHash();
    }

    sign(privateKey) {
        const validatorAddress = CryptoUtils.getPublicKey(privateKey);
        const signature = CryptoUtils.sign(this.getSigningHash(), privateKey);
        // Avoid duplicate signatures from same validator
        if (!this.header.signatures.find(s => s.validator === validatorAddress)) {
            this.header.signatures.push({ validator: validatorAddress, signature });
        }
        this.header.signatures.sort((a, b) => a.validator.localeCompare(b.validator));
    }

    isValid(prevBlock, activeValidatorsMap = null) {
        if (this.header.index !== prevBlock.header.index + 1) return false;
        if (this.header.prevHash !== prevBlock.getHash()) return false;

        if (activeValidatorsMap) {
            let totalStake = 0n;
            let votedStake = 0n;
            for (const stake of Object.values(activeValidatorsMap)) {
                totalStake += BigInt(stake);
            }

            const signingHash = this.getSigningHash();
            const validVoters = new Set();

            for (const sigObj of this.header.signatures) {
                if (!activeValidatorsMap[sigObj.validator]) continue;
                if (validVoters.has(sigObj.validator)) continue; // prevent double voting

                if (CryptoUtils.verify(sigObj.signature, signingHash, sigObj.validator)) {
                    validVoters.add(sigObj.validator);
                    votedStake += BigInt(activeValidatorsMap[sigObj.validator]);
                }
            }

            // BFT requires > 2/3 of total stake
            if (votedStake * 3n <= totalStake * 2n) return false;
        }

        return true;
    }
}

module.exports = { Transaction, Block };

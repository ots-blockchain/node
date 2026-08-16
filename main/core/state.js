const { Level } = require('level');
const CryptoUtils = require('./crypto.js');

class StateManager {
    constructor(dbPath = null) {
        this.db = dbPath ? new Level(dbPath, { valueEncoding: 'json' }) : null;
        this.stateCache = {};
        this.modifiedKeys = new Set();
    }

    async getAccount(address) {
        if (!CryptoUtils.isValidPublicKey(address)) throw new Error('Invalid address');
        if (this.stateCache[String(address)]) return this.stateCache[address];
        if (this.db) {
            try {
                const account = await this.db.get(`account:${address}`);
                if (!account) throw new Error('No account in db');
                this.stateCache[String(address)] = CryptoUtils.deserializeWithBigInt(account);
                return this.stateCache[String(address)];
            } catch (e) {
                return { balance: 0n, nonce: 0, stake: 0n, code: null, storage: {} };
            }
        }
        return { balance: 0n, nonce: 0, stake: 0n, code: null, storage: {} };
    }

    async getActiveValidators(minimalStake) {
        const validators = {};
        if (this.db) {
            for await (const [key, value] of this.db.iterator()) {
                if (key.startsWith('account:')) {
                    const address = key.split(':')[1];
                    const acc = CryptoUtils.deserializeWithBigInt(value);
                    if (BigInt(acc.stake) >= minimalStake) {
                        validators[address] = BigInt(acc.stake);
                    }
                }
            }
        }
        // Also check uncommitted stateCache for recent stake updates
        for (const [address, acc] of Object.entries(this.stateCache)) {
            if (BigInt(acc.stake) >= minimalStake) {
                validators[address] = BigInt(acc.stake);
            } else {
                delete validators[address];
            }
        }
        return validators;
    }

    async updateAccount(address, data) {
        const account = await this.getAccount(address);
        this.stateCache[String(address)] = { ...account, ...data };
        this.modifiedKeys.add(String(address));
    }

    updateAccountImmediate(address, data) {
        this.stateCache[address] = data;
    }

    async getContractStorage(address, key) {
        const account = await this.getAccount(String(address));
        return account.storage[key] || null;
    }

    async setContractStorage(contractAddress, key, value) {
        const acc = await this.getAccount(contractAddress);
        const newStorage = { ...acc.storage };
        newStorage[key] = value;
        this.updateAccount(contractAddress, { storage: newStorage });
    }

    async commit() {
        if (!this.db) return;
        const batch = this.db.batch();
        for (const address of this.modifiedKeys) {
            const rawData = this.stateCache[String(address)];
            batch.put(`account:${address}`, CryptoUtils.serializeWithBigInt(rawData));
        }
        await batch.write();
        this.modifiedKeys.clear();
    }

    rollback() {
        this.stateCache = {};
        this.modifiedKeys.clear();
    }

    /**
     * @param {string} contractAddress 
     * @param {string} userAddress 
     * @returns {Promise<bigint>}
     */
    async getTokenBalance(contractAddress, userAddress) {
        const contractAccount = await this.getAccount(contractAddress);
        const storageKey = "balance:" + userAddress;
        const balance = contractAccount.storage[storageKey];
        
        return balance !== undefined ? BigInt(balance) : 0n;
    }

    async getRootHash(prevRoot) {
        const sortedAddresses = Array.from(this.modifiedKeys).sort();
        
        if (sortedAddresses.length === 0) return prevRoot;

        const changes = sortedAddresses.map(addr => ({
            addr,
            data: this.stateCache[addr]
        }));

        const changesHash = CryptoUtils.hash(CryptoUtils.serializeWithBigInt(changes));
        return CryptoUtils.hash(prevRoot ? (prevRoot + changesHash) : changesHash);
    }

    createSandbox() {
        const sandbox = new StateManager(null);
        sandbox.db = this.db;
        sandbox.stateCache = CryptoUtils.deserializeWithBigInt(CryptoUtils.serializeWithBigInt(this.stateCache));
        sandbox.modifiedKeys = new Set(this.modifiedKeys);
        return sandbox;
    }
}

module.exports = StateManager;

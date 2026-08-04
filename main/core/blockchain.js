const { Block, Transaction } = require('../models/models');
const StateManager = require('./state');
const SmartContractVM = require('../vm/vm');
const CryptoUtils = require('./crypto');
const { consts, costs } = require('./config');
const Logger = require('./logger.js');
const logger = new Logger('Blockchain');

class Blockchain {
    constructor(validatorKey) {
        this.mempool = [];
        this.chain = [];
        if (validatorKey) {
            this.validatorKey = validatorKey;
            this.validatorAddress = CryptoUtils.getPublicKey(validatorKey);
            this.isValidator = true;
        } else {
            const tempKeys = CryptoUtils.generateKeyPair();
            this.validatorKey = tempKeys.privateKey;
            this.validatorAddress = tempKeys.publicKey;
            this.isValidator = false;
        }
        const dbSuffix = this.isValidator ? this.validatorAddress.slice(0, 8) : 'api';
        this.state = new StateManager(`./chain_db_${dbSuffix}`);
        this.vm = new SmartContractVM(this.state);
        this.txCallbacks = {};
        this.isProcessingBlock = false;
        this.blockQueue = [];
        this.orphanBlocks = new Map();
        this.pendingPreVotes = new Map(); // blockHash -> { block, votes: Set<validator>, votedStake: bigint }
        this.pendingPreCommits = new Map();

        // vote locking properties to prevent double-voting
        this.lockedHeight = -1;
        this.lockedHash = null;
        this.lockedRound = -1;
        this.lastPreVotedHeight = -1;
        this.lastPreVotedRound = -1;
    }

    async init() {
        try {
            const lastBlockData = CryptoUtils.deserializeWithBigInt(await this.state.db.get('lastBlock'));
            const totalHeight = lastBlockData.header.index;

            logger.debug("Loading chain... Target height:", totalHeight);

            this.chain = [];

            for (let i = 0; i <= totalHeight; i++) {
                const blockData = await this.state.db.get(`block:${i}`);
                const block = Block.deserialize(blockData);
                this.chain.push(block);
            }

            logger.info("Chain fully loaded. Current height:", this.chain.length - 1);
        } catch (e) {
            logger.warn("No chain found or error loading. Creating genesis...");
            await this.createGenesisBlock();
        }
    }

    async createGenesisBlock() {
        const genesisTxs = [];
        const genesisTimestamp = consts.GENESIS_TIMESTAMP;
        const nullAddress = "000000000000000000000000000000000000000000000000000000000000000000";
        const balance = consts.GENESIS_BALANCE;
        const stake = consts.GENESIS_STAKE;

        for (const address of consts.GENESIS_ADDRESSES) {
            genesisTxs.push(new Transaction({
                type: 'transfer',
                from: nullAddress,
                to: address,
                amount: balance,
                timestamp: genesisTimestamp,
                nonce: 0,
                signature: null
            }));

            genesisTxs.push(new Transaction({
                type: 'stake',
                from: nullAddress,
                to: address,
                amount: stake,
                timestamp: genesisTimestamp,
                nonce: 0,
                signature: null
            }));

            await this.state.updateAccount(address, { balance, stake, nonce: 0 });
        }

        await this.state.commit();

        const validatorAddress = consts.GENESIS_ADDRESSES[0];

        const genesisBlock = new Block(
            0,
            "0",
            genesisTxs,
            validatorAddress,
            await this.state.getRootHash("0"),
            null,
            genesisTimestamp
        );

        this.chain.push(genesisBlock);
        await this.state.db.put('block:0', genesisBlock.serialize());
        await this.state.db.put('lastBlock', genesisBlock.serialize());
        logger.debug("Genesis Created!");
    }

    /**
     * @param {Transaction} tx 
     */
    addTransaction(tx) {
        if (!tx.isValid()) throw new Error("Invalid Tx Signature");
        this.mempool.push(tx);
    }

    /**
     * @param {Transaction} tx 
     */
    async sendTransaction(tx) {
        this.addTransaction(tx);
        await this.p2p.broadcast({ type: 'TX', tx: tx.serialize() });
    }

    /**
     * @param {string} address
     * @returns {number}
     */
    async calculateNonce(address) {
        const account = await this.state.getAccount(address);
        let nextNonce = account.nonce;
        const pendingTxs = this.mempool.filter(tx => tx.from === address);
        return nextNonce + pendingTxs.length;
    }

    async getElectedValidator(blockIndex, slotOverride = null) {
        const activeValidatorsMap = await this.state.getActiveValidators(consts.MINIMAL_STAKE);
        const activeValidators = Object.keys(activeValidatorsMap).sort();

        if (activeValidators.length === 0) return null;

        let totalStake = 0n;
        for (const stake of Object.values(activeValidatorsMap)) {
            totalStake += BigInt(stake);
        }

        const prevBlock = this.chain[this.chain.length - 1];
        const seed = prevBlock ? prevBlock.getHash() : "genesis";

        const slot = slotOverride !== null ? slotOverride : Math.floor(Date.now() / consts.BLOCK_TIMEOUT_MS);
        const hash = CryptoUtils.hash(seed + blockIndex + slot);

        const hashBigInt = BigInt(`0x${hash}`);
        const target = hashBigInt % totalStake;

        let accumulated = 0n;
        for (const address of activeValidators) {
            accumulated += BigInt(activeValidatorsMap[address]);
            if (accumulated > target) {
                return address;
            }
        }

        return activeValidators[0];
    }

    getBlocksFrom(index) {
        return this.chain.slice(index, index + consts.MAX_SYNC_BATCH);
    }

    async pushBlockToQueue(incomingBlock, restoreDb = false) {
        return new Promise((resolve) => {
            this.blockQueue.push({ incomingBlock, restoreDb, resolve });
            this._processQueue();
        });
    }

    async _processQueue() {
        if (this.isProcessingBlock || this.blockQueue.length === 0) return;

        this.isProcessingBlock = true;
        const { incomingBlock, restoreDb, resolve } = this.blockQueue.shift();

        try {
            const result = await this.handleBlock(incomingBlock, restoreDb);
            resolve(result);
        } catch (e) {
            logger.error('Error processing block from queue:', e);
            resolve(false);
        } finally {
            this.isProcessingBlock = false;
            this._processQueue();
        }
    }

    /**
     * @param {Transaction} tx 
     * @param {string} validatorAddress 
     * @param {number} blockIndex 
     */
    async _processTransaction(tx, validatorAddress, blockIndex) {
        const snapshot = CryptoUtils.deserializeWithBigInt(CryptoUtils.serializeWithBigInt(this.state.stateCache));
        const modifiedSnapshot = new Set(this.state.modifiedKeys);
        const callback = this.txCallbacks[tx.getHash()];

        try {
            // genesis transactions
            if (blockIndex === 0) {
                const acc = await this.state.getAccount(tx.to);
                if (tx.type === 'transfer') {
                    await this.state.updateAccount(tx.to, { balance: BigInt(acc.balance) + BigInt(tx.amount) });
                } else if (tx.type === 'stake') {
                    await this.state.updateAccount(tx.to, { stake: BigInt(acc.stake) + BigInt(tx.amount) });
                }
                tx.valid = true;
                return;
            }

            const senderAccount = await this.state.getAccount(tx.from);
            if (tx.nonce !== senderAccount.nonce) throw new Error(`Invalid nonce`);

            const execResult = await this.vm.execute(tx, blockIndex);
            if (!execResult) throw new Error('Execute returned false');

            const [fee, txData] = Array.isArray(execResult) ? execResult : [execResult, null];

            const updatedSender = await this.state.getAccount(tx.from);
            await this.state.updateAccount(tx.from, { nonce: updatedSender.nonce + 1 });

            const validatorAcc = await this.state.getAccount(validatorAddress);
            await this.state.updateAccount(validatorAddress, {
                balance: BigInt(validatorAcc.balance) + BigInt(fee)
            });

            tx.valid = true;

            if (callback) {
                callback({ success: true, hash: tx.getHash(), fee: BigInt(fee), data: txData, tx: tx.serialize() });
                this.txCallbacks[tx.getHash()] = null;
            }
        } catch (e) {
            logger.error('Tx failed:', e.message);
            this.state.stateCache = snapshot;
            this.state.modifiedKeys = modifiedSnapshot;

            if (blockIndex === 0) {
                tx.valid = false;
                return;
            }

            const revertedSender = await this.state.getAccount(tx.from);
            let balanceDeduction = 0n;

            if (e.gasUsed !== undefined) {
                balanceDeduction = BigInt(e.gasUsed) + costs.BASE_FEE;
            } else {
                balanceDeduction = BigInt(costs.BASE_FEE);
            }

            await this.state.updateAccount(tx.from, {
                nonce: revertedSender.nonce + 1,
                balance: BigInt(revertedSender.balance) - balanceDeduction
            });

            const currentValidatorAcc = await this.state.getAccount(validatorAddress);
            await this.state.updateAccount(validatorAddress, {
                balance: BigInt(currentValidatorAcc.balance) + balanceDeduction
            });

            tx.valid = false;

            if (callback) {
                callback({ success: false, hash: tx.getHash(), fee: balanceDeduction, data: e.result?.error, tx: tx.serialize() });
                this.txCallbacks[tx.getHash()] = null;
            }
        }
    }

    /**
     * @param {Block} incomingBlock 
     * @param {boolean} restoreDb
     * @returns {boolean} 
     */
    async handleBlock(incomingBlock, restoreDb = false) {
        try {
            const nextIndex = this.chain.length;
            const prevBlock = this.chain[nextIndex - 1];

            if (incomingBlock.header.index < nextIndex) {
                return false; // already committed
            }

            if (incomingBlock.header.index > nextIndex) {
                logger.debug(`Stashing future block ${incomingBlock.header.index}. Expected ${nextIndex}`);
                if (this.orphanBlocks.size < 100) {
                    this.orphanBlocks.set(incomingBlock.header.index, incomingBlock);
                }
                return false;
            }

            if (incomingBlock.header.index > 0) {
                if (incomingBlock.header.prevHash !== (prevBlock ? prevBlock.getHash() : "0")) {
                    logger.debug('block:', incomingBlock);
                    throw new Error(`prevHash mismatch (got ${incomingBlock.header.prevHash}, but expected ${(prevBlock ? prevBlock.getHash() : "0")})`);
                }
                const validator = incomingBlock.header.validator;

                // use round for election
                const round = incomingBlock.header.round || 0;
                if (await this.getElectedValidator(incomingBlock.header.index, round) !== validator && !restoreDb) throw new Error(`Block from ${incomingBlock.header.validator}, but expected another validator for round ${round}`)

                const activeValidatorsMap = await this.state.getActiveValidators(consts.MINIMAL_STAKE);
                if (!incomingBlock.isValid(prevBlock, activeValidatorsMap)) throw new Error(`Invalid signature or insufficient BFT votes`);


                for (const tx of incomingBlock.body) {
                    if (!tx.isValid()) throw new Error("Invalid Tx Signature in block");
                    await this._processTransaction(tx, validator, incomingBlock.header.index);
                }

                const prevRoot = prevBlock ? prevBlock.header.stateRoot : "0";
                const localRoot = await this.state.getRootHash(prevRoot);

                if (localRoot !== incomingBlock.header.stateRoot) {
                    logger.debug('block:', incomingBlock);
                    logger.debug('modifiedKeys:', this.state.modifiedKeys);
                    logger.debug('stateCache:', this.state.stateCache);
                    throw new Error(`StateRoot mismatch! Expected ${localRoot}, got ${incomingBlock.header.stateRoot}`);
                }

                await this.state.commit();
                await this.saveBlock(incomingBlock);

                // clear committed txs from mempool
                this.mempool = this.mempool.filter(tx =>
                    !incomingBlock.body.some(btx => btx.getHash() === tx.getHash())
                );

                const nextOrphan = this.orphanBlocks.get(this.chain.length);
                if (nextOrphan) {
                    this.orphanBlocks.delete(this.chain.length);
                    this.pushBlockToQueue(nextOrphan, restoreDb);
                }
                return true;
            }
        } catch (e) {
            logger.error(`Block Rejected:`, e);
            return false;
        }
    }

    async executeBlock() {
        if (!this.isValidator) {
            throw new Error("Cannot execute block on a non-validator node");
        }
        this.mempool.sort((a, b) => a.nonce - b.nonce);

        const txs = this.mempool.slice(0, consts.MAX_TXS_PER_BLOCK);

        const snapshot = CryptoUtils.deserializeWithBigInt(CryptoUtils.serializeWithBigInt(this.state.stateCache));
        const modifiedSnapshot = new Set(this.state.modifiedKeys);

        const validTxs = [];
        const prevBlock = this.chain[this.chain.length - 1];
        const nextIndex = prevBlock ? prevBlock.header.index + 1 : 0;

        const currentTimestamp = Date.now();

        for (const tx of txs) {
            await this._processTransaction(tx, this.validatorAddress, nextIndex);

            validTxs.push(tx);
        }

        const prevRoot = prevBlock ? prevBlock.header.stateRoot : "0";
        const stateRoot = await this.state.getRootHash(prevRoot);

        // revert temporary state changes from block execution proposal
        this.state.stateCache = snapshot;
        this.state.modifiedKeys = modifiedSnapshot;

        return new Block(
            nextIndex,
            prevBlock ? prevBlock.getHash() : null,
            validTxs,
            this.validatorAddress,
            stateRoot,
            [],
            currentTimestamp
        );
    }

    /**
     * @param {Block} block 
     */
    async saveBlock(block) {
        this.chain.push(block);
        await this.state.db.put(`block:${block.header.index}`, block.serialize());
        await this.state.db.put('lastBlock', block.serialize());
    }

    async handleProposal(incomingBlock) {
        if (!this.isValidator) return null;
        try {
            const nextIndex = this.chain.length;
            const prevBlock = this.chain[nextIndex - 1];

            if (incomingBlock.header.index !== nextIndex) {
                return null; // not ready or already processed
            }

            if (incomingBlock.header.index > 0) {
                if (incomingBlock.header.prevHash !== (prevBlock ? prevBlock.getHash() : "0")) return null;
                const round = incomingBlock.header.round || 0;
                const validator = incomingBlock.header.validator;
                if (await this.getElectedValidator(incomingBlock.header.index, round) !== validator) return null;

                const signingHash = incomingBlock.getSigningHash();

                // prevent double pre-voting in the same round for the same height
                if (incomingBlock.header.index > this.lastPreVotedHeight) {
                    this.lastPreVotedHeight = incomingBlock.header.index;
                    this.lastPreVotedRound = -1;
                }
                if (round <= this.lastPreVotedRound) {
                    logger.warn(`Already pre-voted for height ${incomingBlock.header.index} in round ${this.lastPreVotedRound} (proposal round: ${round})`);
                    return null;
                }

                // prevent double voting
                if (this.lockedHeight === incomingBlock.header.index && this.lockedHash !== signingHash) {
                    if (this.lockedRound >= round) {
                        logger.warn(`Vote locked: already voted for a different block at height ${this.lockedHeight} (locked round: ${this.lockedRound}, new round: ${round})`);
                        return null;
                    }
                }

                // create a temporary sandbox state manager to avoid polluting main stateCache during proposal validation
                const sandboxState = new StateManager(null);
                sandboxState.stateCache = CryptoUtils.deserializeWithBigInt(CryptoUtils.serializeWithBigInt(this.state.stateCache));
                sandboxState.modifiedKeys = new Set(this.state.modifiedKeys);

                // temporarily swap VM's state pointer to sandbox
                const originalState = this.state;
                this.state = sandboxState;
                this.vm.state = sandboxState;

                try {

                    for (const tx of incomingBlock.body) {
                        if (!tx.isValid()) throw new Error("Invalid Tx Signature");
                        await this._processTransaction(tx, validator, incomingBlock.header.index);
                    }
                    const prevRoot = prevBlock ? prevBlock.header.stateRoot : "0";
                    const localRoot = await sandboxState.getRootHash(prevRoot);

                    if (localRoot !== incomingBlock.header.stateRoot) throw new Error("StateRoot mismatch");

                    // valid! Pre-vote.
                    this.lastPreVotedRound = round;

                    // create pre-vote signature
                    const preVoteHash = CryptoUtils.hash(signingHash + ':PREVOTE');
                    const voteSig = CryptoUtils.sign(preVoteHash, this.validatorKey);

                    // restore original state pointer
                    this.state = originalState;
                    this.vm.state = originalState;

                    return {
                        validator: this.validatorAddress,
                        signature: voteSig
                    };
                } catch (e) {
                    // restore original state pointer
                    this.state = originalState;
                    this.vm.state = originalState;
                    return null;
                }
            }
        } catch (e) {
            return null;
        }
    }

    async handlePreVote(incomingBlock, voteObj) {
        const signingHash = incomingBlock.getSigningHash();

        if (!this.pendingPreVotes.has(signingHash)) {
            this.pendingPreVotes.set(signingHash, {
                block: incomingBlock,
                votes: new Map(), // validator -> signature
                votedStake: 0n
            });
        }

        const proposal = this.pendingPreVotes.get(signingHash);

        const activeValidatorsMap = await this.state.getActiveValidators(consts.MINIMAL_STAKE);
        if (!activeValidatorsMap[voteObj.validator]) return false;

        if (proposal.votes.has(voteObj.validator)) return false; // already voted

        // verify pre-vote signature
        const preVoteHash = CryptoUtils.hash(signingHash + ':PREVOTE');
        if (!CryptoUtils.verify(voteObj.signature, preVoteHash, voteObj.validator)) return false;

        proposal.votes.set(voteObj.validator, voteObj.signature);
        proposal.votedStake += BigInt(activeValidatorsMap[voteObj.validator]);

        let totalStake = 0n;
        for (const stake of Object.values(activeValidatorsMap)) {
            totalStake += BigInt(stake);
        }

        if (proposal.votedStake * 3n > totalStake * 2n) {
            // reached > 2/3 PRE_VOTE consensus (Polka)!
            this.pendingPreVotes.delete(signingHash);

            // lock on this block
            this.lockedHeight = incomingBlock.header.index;
            this.lockedRound = incomingBlock.header.round || 0;
            this.lockedHash = signingHash;

            // generate Pre-Commit signature
            const preCommitSig = CryptoUtils.sign(signingHash, this.validatorKey);
            return {
                validator: this.validatorAddress,
                signature: preCommitSig
            };
        }
        return null;
    }

    async handlePreCommit(incomingBlock, voteObj) {
        const signingHash = incomingBlock.getSigningHash();

        if (!this.pendingPreCommits.has(signingHash)) {
            this.pendingPreCommits.set(signingHash, {
                block: incomingBlock,
                votes: new Map(), // validator -> signature
                votedStake: 0n
            });
        }

        const proposal = this.pendingPreCommits.get(signingHash);

        const activeValidatorsMap = await this.state.getActiveValidators(consts.MINIMAL_STAKE);
        if (!activeValidatorsMap[voteObj.validator]) return false;

        if (proposal.votes.has(voteObj.validator)) return false; // already voted

        // verify pre-commit signature
        if (!CryptoUtils.verify(voteObj.signature, signingHash, voteObj.validator)) return false;

        proposal.votes.set(voteObj.validator, voteObj.signature);
        proposal.votedStake += BigInt(activeValidatorsMap[voteObj.validator]);

        let totalStake = 0n;
        for (const stake of Object.values(activeValidatorsMap)) {
            totalStake += BigInt(stake);
        }

        if (proposal.votedStake * 3n > totalStake * 2n) {
            // reached > 2/3 PRE_COMMIT consensus!
            this.pendingPreCommits.delete(signingHash);

            // reconstruct block with signatures
            incomingBlock.header.signatures = Array.from(proposal.votes.entries()).map(([val, sig]) => ({
                validator: val,
                signature: sig
            })).sort((a, b) => a.validator.localeCompare(b.validator));

            // push to queue to officially process and commit it
            await this.pushBlockToQueue(incomingBlock);
            return true;
        }
        return false;
    }
}

module.exports = Blockchain;

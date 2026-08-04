const { start } = require('./interpreter.js');
const CryptoUtils = require('../core/crypto');
const StateManager = require('../core/state.js');
const { Transaction } = require('../models/models.js');
const { consts, costs } = require('../core/config');
const Logger = require('../core/logger.js');
const logger = new Logger('VM');

class SmartContractVM {
    /**
     * @param {StateManager} stateManager 
     */
    constructor(stateManager) {
        this.state = stateManager;
    }

    static countInstructions(node) {
        if (Array.isArray(node)) {
            const isOpcode = typeof node[0] === 'string';

            let count = isOpcode ? 1 : 0;

            for (const item of node) {
                count += SmartContractVM.countInstructions(item);
            }
            return count;
        }

        else if (typeof node === 'object' && node !== null) {
            let count = 0;
            for (const key in node) {
                count += SmartContractVM.countInstructions(node[key]);
            }
            return count;
        }

        return 0;
    }

    /**
     * @param {Transaction} transaction 
     * @param {number} blockIndex 
     * @returns {Array | Number}
     */
    async execute(transaction, blockIndex) {
        const sender = transaction.from;
        const senderAccount = await this.state.getAccount(sender);
        const amountBI = BigInt(transaction.amount);
        if (transaction.data && transaction.data.length > consts.MAX_DATA_LENGTH) throw new Error(`Data too big`);
        if (!CryptoUtils.isValidPublicKey(sender)) throw new Error(`Invalid sender`);
        if (amountBI < 0n) throw new Error(`Amount cannot be less than 0`);
        if (transaction.type === 'transfer') {
            if (BigInt(senderAccount.balance) < (amountBI + costs.BASE_FEE)) throw new Error(`No funds (${BigInt(senderAccount.balance)} < ${(amountBI + costs.BASE_FEE)})`);
            if (!CryptoUtils.isValidPublicKey(transaction.to)) throw new Error(`Invalid receiver`);

            await this.state.updateAccount(sender, { balance: BigInt(senderAccount.balance) - (amountBI + costs.BASE_FEE) });
            const receiver = await this.state.getAccount(transaction.to);
            await this.state.updateAccount(transaction.to, { balance: BigInt(receiver.balance) + amountBI });

            return costs.BASE_FEE;
            
        } else if (transaction.type === 'stake') {
            if (BigInt(senderAccount.balance) < (amountBI + costs.BASE_FEE)) throw new Error(`No funds for staking (${BigInt(senderAccount.balance)} < ${(amountBI + costs.BASE_FEE)})`);
            if (!CryptoUtils.isValidPublicKey(transaction.to)) throw new Error(`Invalid receiver`);

            await this.state.updateAccount(sender, { balance: BigInt(senderAccount.balance) - (amountBI + costs.BASE_FEE) });
            const receiver = await this.state.getAccount(transaction.to);
            await this.state.updateAccount(transaction.to, { stake: BigInt(receiver.stake) + amountBI });

            return costs.BASE_FEE;
            
        } else if (transaction.type === 'deploy') {
            const contractAddress = CryptoUtils.hash(sender + transaction.nonce);
            const compiled = JSON.parse(transaction.data);
            const codeAmountBI = BigInt(SmartContractVM.countInstructions(compiled)) * consts.OPCODE_PRICE;

            if (BigInt(senderAccount.balance) < (amountBI + costs.BASE_FEE)) throw new Error(`No funds (${BigInt(senderAccount.balance)} < ${(amountBI + costs.BASE_FEE)})`);
            
            if (amountBI < codeAmountBI) throw new Error(`Deployment cost exceeds provided limit (${amountBI} < ${codeAmountBI})`);

            await this.state.updateAccount(sender, { balance: BigInt(senderAccount.balance) - (codeAmountBI + costs.BASE_FEE) });
            await this.state.updateAccount(contractAddress, {
                code: compiled,
                storage: {}
            });

            return codeAmountBI + costs.BASE_FEE;
            
        } else if (transaction.type === 'call') {
            const topContractAddr = transaction.to;
            let topContract = await this.state.getAccount(topContractAddr);

            if (!topContract.code) throw new Error("Contract not found");

            const gasLimit = BigInt(transaction.gasLimit || transaction.amount);
            const msgValue = BigInt(transaction.amount || 0);
            
            const gasTracker = { amount: gasLimit }; 

            const totalCost = gasLimit + msgValue + costs.BASE_FEE;

            if (BigInt(senderAccount.balance) < totalCost) {
                throw new Error("Insufficient balance to cover gas limit, fee and value");
            }

            await this.state.updateAccount(sender, {
                balance: BigInt(senderAccount.balance) - totalCost
            });

            if (msgValue > 0n) {
                topContract = await this.state.getAccount(topContractAddr);
                await this.state.updateAccount(topContractAddr, {
                    balance: BigInt(topContract.balance || 0) + msgValue
                });
            }

            const safeArg = (arg) => {
                try {
                    if (typeof arg === 'undefined') return 'undefined';
                    if (arg?.toString) return arg.toString();
                    if (typeof arg === 'object' && arg !== null && !arg.toString) {
                        return JSON.stringify(arg);
                    }
                    return String(arg);
                } catch {
                    return String(arg);
                }
            }

            const useGas = (amount) => {
                const cost = BigInt(amount);
                if (gasTracker.amount < cost) {
                    gasTracker.amount = 0n;
                    throw new Error("Out of gas");
                }
                gasTracker.amount -= cost;
            }

            const buildContext = (currentContractAddr, callerAddr, callData, callValue) => {
                return {
                    storageRead: async (key) => {
                        const contractAcc = await this.state.getAccount(currentContractAddr);
                        const val = contractAcc.storage[key];
                        if (val === undefined) return key.startsWith("balance:") ? 0n : null;
                        return val;
                    },
                    storageWrite: async (key, val) => {
                        const contractAcc = await this.state.getAccount(currentContractAddr);
                        const newStorage = { ...contractAcc.storage };
                        const dataSize = BigInt(String(key).length + String(val).length);
                        const storageCost = costs.WRITE_VAR + (dataSize * costs.MEMORY_BYTE);

                        useGas(storageCost);
                        newStorage[key] = safeArg(val);
                        await this.state.updateAccount(currentContractAddr, {
                            storage: newStorage 
                        });
                    },
                    getMsgSender: () => String(callerAddr),
                    getMsgData: () => String(callData),
                    getMsgTime: () => BigInt(transaction.timestamp),
                    getContractAddress: () => String(currentContractAddr),
                    getBlockIndex: () => Number(blockIndex),
                    
                    getMsgValue: () => BigInt(callValue), 
                    
                    contractTransfer: async (toAddress, amount) => {
                        const transferAmount = BigInt(amount);
                        let currentContractAcc = await this.state.getAccount(currentContractAddr);
                        let recipientAcc = await this.state.getAccount(toAddress);
                        if (BigInt(currentContractAcc.balance || 0) < transferAmount) {
                            throw new Error("Contract has insufficient funds to transfer");
                        }
            
                        await this.state.updateAccount(currentContractAddr, {
                            balance: BigInt(currentContractAcc.balance) - transferAmount
                        });
                        
                        await this.state.updateAccount(toAddress, {
                            balance: BigInt(recipientAcc.balance || 0) + transferAmount
                        });
                    },
                    
                    print: (...args) => logger.info(`[Contract]`,...args),

                    contractCall: async (targetAddress, targetData, targetValue = 0) => {
                        const valueBI = BigInt(targetValue);
                        let targetContract = await this.state.getAccount(targetAddress);

                        if (!targetContract.code) throw new Error("Target contract not found");

                        if (valueBI > 0n) {
                            let currentContractAcc = await this.state.getAccount(currentContractAddr);
                            if (BigInt(currentContractAcc.balance || 0) < valueBI) {
                                throw new Error("Insufficient funds for cross-contract call");
                            }
                            await this.state.updateAccount(currentContractAddr, {
                                balance: BigInt(currentContractAcc.balance) - valueBI
                            });
                            
                            targetContract = await this.state.getAccount(targetAddress);
                            await this.state.updateAccount(targetAddress, {
                                balance: BigInt(targetContract.balance || 0) + valueBI
                            });
                        }

                        const subContext = buildContext(targetAddress, currentContractAddr, targetData, valueBI);

                        const subResult = await start(targetContract.code, subContext, gasTracker);

                        if (!subResult.success) {
                            throw new Error(`Sub-call reverted: ${subResult.error}`);
                        }

                        return subResult.status; 
                    }
                };
            };
        
            const context = buildContext(topContractAddr, sender, transaction.data, msgValue);
        
            const result = await start(topContract.code, context, gasTracker);
    
            const remainingGas = gasTracker.amount;
            const gasUsed = gasLimit - remainingGas;

            if (!result.success) {
                const err = new Error(`VM Revert: ${result.error}`);
                err.gasUsed = gasUsed;
                err.result = result; 
                throw err;
            }

            const finalSenderAccount = await this.state.getAccount(sender);
            await this.state.updateAccount(sender, {
                balance: BigInt(finalSenderAccount.balance) + remainingGas
            });

            return [gasUsed + costs.BASE_FEE, result.status];
        }
        
        return false;
    }
}

module.exports = SmartContractVM;

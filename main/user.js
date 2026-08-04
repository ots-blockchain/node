const P2PNetwork = require('./network/userNetwork');
const CryptoUtils = require('./core/crypto');
const readline = require('readline');
const { Transaction } = require('./models/models');
const { compile } = require('./vm/compiler');
const fs = require('fs');

const { costs } = require('./core/config');

const PEER = 'wss://api.ots.su';

(async () => {
    const myKeys = {
        privateKey: '', // REPLACE WITH YOUR KEY
        publicKey: ''   // REPLACE WITH YOUR KEY
    };

    const p2p = new P2PNetwork(myKeys.privateKey);
    p2p.connectToPeer(PEER);
    
    const commands = {
        send: async (args) => {
            const [type, ...jsonParts] = args;
            if (!type) throw new Error('Provide message type (string)');

            const payload = jsonParts.length 
                ? CryptoUtils.deserializeWithBigInt(jsonParts.join(' ')) 
                : {};

            await p2p.send({ type, ...payload });
        },

        tx: async (args) => {
            const [from, to, amount] = args;
            if (!from) throw new Error(`Provide 'from' argument (private key)`);
            if (!to) throw new Error(`Provide 'to' argument (public key)`);
            if (!amount) throw new Error(`Provide 'amount' argument (number)`);
            const nonce = await p2p.getNonce(CryptoUtils.getPublicKey(from));
            const stx = new Transaction({
                type: 'transfer',
                from: CryptoUtils.getPublicKey(from),
                to,
                amount: BigInt(amount),
                nonce
            });
            stx.sign(from);
            console.log(await p2p.sendTransaction(stx));
        },

        mtx: async (args) => {
            const [to, amount] = args;
            if (!to) throw new Error(`Provide 'to' argument (public key)`);
            if (!amount) throw new Error(`Provide 'amount' argument (number)`);
            const nonce = await p2p.getNonce(myKeys.publicKey);
            const stx = new Transaction({
                type: 'transfer',
                from: myKeys.publicKey,
                to,
                amount: BigInt(amount),
                nonce
            });
            stx.sign(myKeys.privateKey);
            console.log(await p2p.sendTransaction(stx));
        },

        bal: async (args) => {
            const [address] = args;
            if (!address) throw new Error(`Provide 'address' argument (public key)`);
            const account = await p2p.getAccount(address);
            console.log(account.balance);
        },

        stake: async (args) => {
            const [address] = args;
            if (!address) throw new Error(`Provide 'address' argument (public key)`);
            const account = await p2p.getAccount(address);
            console.log(account.stake);
        },

        nonce: async (args) => {
            const [address] = args;
            if (!address) throw new Error(`Provide 'address' argument (public key)`);
            const nonce = await p2p.getNonce(address);
            console.log(nonce);
        },

        tbal: async (args) => {
            const [contractAddress, address] = args;
            if (!contractAddress) throw new Error(`Provide 'contractAddress' argument (public key)`);
            if (!address) throw new Error(`Provide 'address' argument (public key)`);
            const balance = await p2p.getStorage(contractAddress, "balance:" + String(address)) || 0;
            
            console.log(BigInt(balance));
        },

        deploy: async (args) => {
            const [codePath, iamount] = args;
            if (!codePath) throw new Error(`Provide 'codePath' argument (string)`);
            if (fs.existsSync(codePath)) {
                const code = compile(fs.readFileSync(codePath));
                const nonce = await p2p.getNonce(myKeys.publicKey);
                const contractAddress = CryptoUtils.hash(myKeys.publicKey + nonce);
                console.log(`Deployed on ${contractAddress}`);
                const amount = iamount || ((await p2p.getAccount(myKeys.publicKey)).balance - costs.BASE_FEE);
                const stx = new Transaction({
                    type: 'deploy',
                    from: myKeys.publicKey,
                    data: CryptoUtils.serializeWithBigInt(code),
                    amount: BigInt(amount),
                    nonce
                });
                stx.sign(myKeys.privateKey);
                console.log(await p2p.sendTransaction(stx));
            }
            else throw new Error(`File '${codePath}' doesn't exists`)
        },

        block: async (args) => {
            const [height] = args;
            if (!height) throw new Error(`Provide 'height' argument (number)`);
            console.log(await p2p.getBlock(height));
        },

        info: async () => {
            console.log(await p2p.getInfo());
        },

        mbal: async () => {
            const account = await p2p.getAccount(myKeys.publicKey);
            console.log(account.balance);
        },

        mn: async () => {
            const nonce = await p2p.getNonce(myKeys.publicKey);
            console.log(nonce);
        },

        call: async (args) => {
            const [contractAddress, json, amount = 0] = args;
            if (!contractAddress) throw new Error(`Provide 'contractAddress' argument (public key)`);
            if (!json) throw new Error(`Provide 'json' argument (string)`);
            const nonce = await p2p.getNonce(myKeys.publicKey);
            const stx = new Transaction({
                type: 'call',
                from: myKeys.publicKey,
                to: contractAddress,
                data: json,
                gasLimit: 10000000n,
                amount: BigInt(amount),
                nonce
            });
            stx.sign(myKeys.privateKey);
            console.log(await p2p.sendTransaction(stx));
        },

        help: async () => {
            console.log('Available commands:', Object.keys(commands).join(', '));
        }
    };

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: '> '
    });

    rl.prompt();

    rl.on('line', async (line) => {
        const input = line.trim();
        if (!input) { rl.prompt(); return; }

        const [cmdName, ...args] = input.split(/\s+/);
        const handler = commands[cmdName];

        try {
            if (handler) {
                await handler(args);
            } else {
                console.error(`Unknown command: ${cmdName} (type 'help')`);
            }
        } catch (err) {
            console.error('Error:', err.message);
        } finally {
            rl.prompt();
        }
    });

    rl.on('SIGINT', () => {
        console.log('\nExiting...');
        rl.close();
        process.exit(0);
    });
})();
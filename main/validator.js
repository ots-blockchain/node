const Blockchain = require('./core/blockchain');
const P2PNetwork = require('./network/validatorNetwork');
const StateManager = require('./core/state');
const CryptoUtils = require('./core/crypto');
const readline = require('readline');
const { Transaction } = require('./models/models');
const { compile } = require('./vm/compiler');
const fs = require('fs');

let PORT = 5001;
let PEERS = [];

(async () => {
    let myKeys;
    if (process.env.KEY) {
        myKeys = {
            privateKey: process.env.KEY,
            publicKey: CryptoUtils.getPublicKey(process.env.KEY)
        };
        PORT = process.env.PORT || 5001;
        PEERS = process.env.PEERS ? process.env.PEERS.split(',') : [];
    } else {
        const keys = require('../key.json');
        switch (process.argv[2] || process.argv[1]) {
            case '1': {
                PORT = process.env.PORT || 5001;
                PEERS = process.env.PEERS ? process.env.PEERS.split(',') : [];
                myKeys = keys.validator1;
                break;
            }
            case '2': {
                PORT = process.env.PORT || 5002;
                PEERS = process.env.PEERS ? process.env.PEERS.split(',') : ['ws://localhost:5001'];
                myKeys = keys.validator2;
                break;
            }
            case '3': {
                PORT = process.env.PORT || 5003;
                PEERS = process.env.PEERS ? process.env.PEERS.split(',') : ['ws://localhost:5002'];
                myKeys = keys.validator3;
                break;
            }
            case '4': {
                PORT = process.env.PORT || 5004;
                PEERS = process.env.PEERS ? process.env.PEERS.split(',') : ['ws://localhost:5003'];
                myKeys = keys.validator4;
                break;
            }
            case '5': {
                PORT = process.env.PORT || 5005;
                PEERS = process.env.PEERS ? process.env.PEERS.split(',') : ['ws://localhost:5004'];
                myKeys = keys.validator5;
                break;
            }
        }
    }
    const node = new Blockchain(myKeys.privateKey);
    await node.init();

    const p2p = new P2PNetwork(node);
    node.p2p = p2p;
    p2p.startServer(Number(PORT));

    PEERS.forEach(peer => p2p.connectToPeer(peer));

    const commands = {
        send: async (args) => {
            const [type, ...jsonParts] = args;
            if (!type) throw new Error('Provide message type (string)');

            const payload = jsonParts.length
                ? CryptoUtils.deserializeWithBigInt(jsonParts.join(' '))
                : {};

            await p2p.broadcast({ type, ...payload });
        },

        v: async () => {
            p2p.validators.forEach(v => console.log(v));
        },

        b: async () => {
            console.log(`Last block index: ${node.chain.length - 1}`);
        },

        ba: async () => {
            console.log(`Last block:`, node.chain[node.chain.length - 1]);
        },

        block: async (args) => {
            const [height] = args;
            if (!height) throw new Error(`Provide 'height' argument (number)`);
            console.log(node.chain[height]);
        },

        tx: async (args) => {
            const [from, to, amount] = args;
            if (!from) throw new Error(`Provide 'from' argument (private key)`);
            if (!to) throw new Error(`Provide 'to' argument (public key)`);
            if (!amount) throw new Error(`Provide 'amount' argument (number)`);

            const stx = new Transaction({
                type: 'transfer',
                from: CryptoUtils.getPublicKey(from),
                to,
                amount: BigInt(amount),
                nonce: await node.calculateNonce(CryptoUtils.getPublicKey(from))
            });
            stx.sign(from);
            node.sendTransaction(stx);
        },

        bal: async (args) => {
            const [address] = args;
            if (!address) throw new Error(`Provide 'address' argument (public key)`);
            const account = await node.state.getAccount(address);
            console.log(account.balance);
        },

        stake: async (args) => {
            const [address] = args;
            if (!address) throw new Error(`Provide 'address' argument (public key)`);
            const account = await node.state.getAccount(address);
            console.log(account.stake);
        },

        nonce: async (args) => {
            const [address] = args;
            if (!address) throw new Error(`Provide 'address' argument (public key)`);
            const account = await node.state.getAccount(address);
            console.log(account.nonce);
        },

        tbal: async (args) => {
            const [contractAddress, address] = args;
            if (!contractAddress) throw new Error(`Provide 'contractAddress' argument (public key)`);
            if (!address) throw new Error(`Provide 'address' argument (public key)`);
            const bal = await node.state.getTokenBalance(contractAddress, address);
            console.log(bal);
        },

        deploy: async (args) => {
            const [codePath, amount = 100000] = args;
            if (!codePath) throw new Error(`Provide 'codePath' argument (string)`);
            if (fs.existsSync(codePath)) {
                const code = compile(fs.readFileSync(codePath));
                const contractAddress = CryptoUtils.hash(myKeys.publicKey + await node.calculateNonce(myKeys.publicKey));
                const stx = new Transaction({
                    type: 'deploy',
                    from: myKeys.publicKey,
                    data: CryptoUtils.serializeWithBigInt(code),
                    amount: BigInt(amount),
                    nonce: await node.calculateNonce(myKeys.publicKey)
                });
                stx.sign(myKeys.privateKey);
                node.sendTransaction(stx);
                console.log(`Deployed on ${contractAddress}`);
            }
            else throw new Error(`File '${codePath}' doesn't exists`)
        },

        mn: async () => {
            console.log(await node.calculateNonce(myKeys.publicKey));
        },

        call: async (args) => {
            const [contractAddress, json, amount = 0] = args;
            if (!contractAddress) throw new Error(`Provide 'contractAddress' argument (public key)`);
            if (!json) throw new Error(`Provide 'json' argument (string)`);
            const stx = new Transaction({
                type: 'call',
                from: myKeys.publicKey,
                to: contractAddress,
                data: json,
                gasLimit: 100000n,
                amount: BigInt(amount),
                nonce: await node.calculateNonce(myKeys.publicKey)
            });
            stx.sign(myKeys.privateKey);
            node.sendTransaction(stx);
        },

        mp: async (args) => {
            const [all] = args;
            if (all) {
                console.log('Mempool:', node.mempool);
            } else {
                console.log('Mempool length:', node.mempool.length)
            }
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
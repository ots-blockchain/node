const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const Blockchain = require('../main/core/blockchain');
const P2PNetwork = require('./apiNetwork');
const Logger = require('../main/core/logger.js');
const fs = require('fs');

const logger = new Logger('API-Node');
const SEED_NODE_URL = process.env.SEED_NODE_URL || 'ws://127.0.0.1:5001';
const PORT = process.env.PORT || 3000;

if (!fs.existsSync('./chain_db')) fs.mkdirSync('chain_db');
const db = new Database('./chain_db/explorer.db');

db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
        hash TEXT PRIMARY KEY,
        blockIndex INTEGER,
        type TEXT,
        sender TEXT,
        receiver TEXT,
        amount TEXT,
        timestamp INTEGER,
        nonce INTEGER,
        data TEXT,
        fee TEXT,
        valid INTEGER,
        gasLimit TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tx_sender ON transactions(sender);
    CREATE INDEX IF NOT EXISTS idx_tx_receiver ON transactions(receiver);
    
    CREATE TABLE IF NOT EXISTS blocks (
        idx INTEGER PRIMARY KEY,
        hash TEXT,
        validator TEXT,
        timestamp INTEGER,
        txCount INTEGER
    );
`);

try {
    db.exec(`ALTER TABLE transactions ADD COLUMN gasLimit TEXT`);
} catch (e) {
    // column already exists
}

function prepareForJson(value) {
    if (typeof value === 'bigint') {
        return value.toString();
    }
    if (Array.isArray(value)) {
        return value.map(item => prepareForJson(item));
    }
    if (value !== null && typeof value === 'object') {
        const obj = {};
        for (const key in value) {
            obj[key] = prepareForJson(value[key]);
        }
        return obj;
    }
    return value;
}

function formatTx(tx) {
    if (!tx) return null;

    let txHash = "";
    if (tx.hash) txHash = tx.hash;
    else if (tx.signature) txHash = tx.signature;
    else if (typeof tx.getHash === 'function') txHash = tx.getHash();
    const formatted = {
        hash: txHash,
        signature: tx.signature || tx.hash || "",
        type: tx.type,
        from: tx.from || tx.sender || "000000000000000000000000000000000000000000000000000000000000000000",
        to: tx.to || tx.receiver,
        amount: tx.amount.toString(),
        data: tx.data || '',
        nonce: Number(tx.nonce || 0),
        timestamp: Number(tx.timestamp),
        blockIndex: tx.blockIndex !== undefined ? Number(tx.blockIndex) : null,
        fee: (tx.fee || 0).toString(),
        valid: (tx.blockIndex === 0 || tx.valid === 1 || tx.valid === true)
    };

    if (tx.type === 'call') {
        formatted.gasLimit = (tx.gasLimit !== undefined && tx.gasLimit !== null) ? tx.gasLimit.toString() : '0';
    }

    return formatted;
}

function indexBlock(block) {
    const insertTx = db.prepare(`
        INSERT OR REPLACE INTO transactions 
        (hash, blockIndex, type, sender, receiver, amount, timestamp, nonce, data, fee, valid, gasLimit) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertBlock = db.prepare(`
        INSERT OR REPLACE INTO blocks (idx, hash, validator, timestamp, txCount)
        VALUES (?, ?, ?, ?, ?)
    `);

    db.transaction(() => {
        insertBlock.run(
            block.header.index,
            block.getHash(),
            block.header.validator,
            block.header.timestamp,
            block.body.length
        );

        for (const tx of block.body) {
            insertTx.run(
                tx.signature || tx.getHash(),
                block.header.index,
                tx.type || 'unknown',
                tx.from,
                tx.to,
                tx.amount.toString(),
                tx.timestamp,
                tx.nonce,
                tx.data || '',
                (tx.fee || 0n).toString(),
                (tx.valid || block.header.index === 0) ? 1 : 0,
                tx.gasLimit !== undefined && tx.gasLimit !== null ? tx.gasLimit.toString() : null
            );
        }
    })();
}

const blockchain = new Blockchain();

async function startNode() {
    await blockchain.init();
    logger.info(`Blockchain loaded. Height: ${blockchain.chain.length - 1}`);

    const originalSaveBlock = blockchain.saveBlock.bind(blockchain);
    blockchain.saveBlock = async (block) => {
        await originalSaveBlock(block);
        indexBlock(block);
        logger.debug(`Block ${block.header.index} indexed in SQLite`);
    };

    const existingBlocks = db.prepare('SELECT COUNT(*) as count FROM blocks').get().count;
    if (existingBlocks === 0 && blockchain.chain.length > 0) {
        logger.info("Building SQL index from LevelDB...");
        for (const block of blockchain.chain) {
            indexBlock(block);
        }
    }

    const p2p = new P2PNetwork(blockchain);
    p2p.connectToPeer(SEED_NODE_URL);

    const app = express();
    app.use(cors());
    app.use(express.json());

    app.get('/api/address/:address', async (req, res) => {
        try {
            const address = req.params.address;
            const account = await blockchain.state.getAccount(address);

            const historyRows = db.prepare(`
                SELECT * FROM transactions 
                WHERE sender = ? OR receiver = ? 
                ORDER BY timestamp DESC LIMIT 50
            `).all(address, address);

            res.json({
                address,
                balance: account.balance.toString(),
                stake: account.stake.toString(),
                nonce: account.nonce,
                code: prepareForJson(account.code),
                history: historyRows.map(formatTx)
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/storage/:address', async (req, res) => {
        try {
            const address = req.params.address;
            const account = await blockchain.state.getAccount(address);

            res.json({
                address,
                storage: prepareForJson(account.storage),
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/recent-blocks', (req, res) => {
        try {
            const blocks = db.prepare('SELECT * FROM blocks ORDER BY idx DESC LIMIT ' + Math.min(100, Math.max(1, parseInt(req.query.limit || 15)))).all();
            res.json(blocks.map(b => ({
                index: b.idx,
                hash: b.hash,
                validator: b.validator,
                timestamp: b.timestamp,
                txCount: b.txCount
            })));
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/tx/:hash', (req, res) => {
        try {
            const row = db.prepare('SELECT * FROM transactions WHERE hash = ?').get(req.params.hash);
            if (!row) return res.status(404).json({ error: "Transaction not found" });
            res.json(formatTx(row));
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/block/:index', (req, res) => {
        try {
            const index = parseInt(req.params.index);
            const block = blockchain.chain[index];

            if (!block) return res.status(404).json({ error: "Block not found" });

            const txRows = db.prepare('SELECT * FROM transactions WHERE blockIndex = ?').all(index);

            res.json({
                header: {
                    index: block.header.index,
                    prevHash: block.header.prevHash,
                    validator: block.header.validator,
                    stateRoot: block.header.stateRoot,
                    timestamp: block.header.timestamp,
                    signatures: block.header.signatures || [],
                    hash: block.getHash()
                },
                body: txRows.map(row => formatTx(row))
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.listen(PORT, () => {
        logger.info(`API Explorer Node running on http://localhost:${PORT}`);
    });
}

startNode();
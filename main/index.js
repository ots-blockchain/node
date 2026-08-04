const Blockchain = require('./core/blockchain');
const P2PNetwork = require('./network/validatorNetwork');
const CryptoUtils = require('./core/crypto');

let PORT = process.env.PORT;
let PEERS = process.env.PEERS.split(',');
let myKeys = { privateKey: process.env.KEY, publicKey: CryptoUtils.getPublicKey(process.env.KEY) };

(async () => {
    const node = new Blockchain(myKeys.privateKey);
    await node.init();

    const p2p = new P2PNetwork(node);
    node.p2p = p2p;
    p2p.startServer(Number(PORT));

    PEERS.forEach(peer => p2p.connectToPeer(peer));
})();
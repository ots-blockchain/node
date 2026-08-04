const OWNER = '03c5cd6c709e4b57974070d9375befaff038438d5a4ac687685420d6b9655ac4dc';
const TOKEN_A_ADDRESS = '712edcbbfc3a0251c973e1d033c5cb049ec25dcc68f7853a7905d81d38690fb3';

function balanceOf(address) {
    const bal = storageRead("balance:" + address);
    if (bal) {
        return toBigInt(parseInt(bal));
    } else {
        return toBigInt(0);
    }
}

function transfer(to, amount) {
    const from = getMsgSender();
    const currentBalance = balanceOf(from);
    const amountBigint = toBigInt(parseInt(amount));

    if (currentBalance < amountBigint) {
        print("Insufficient funds");
        const sentValue = toBigInt(getMsgValue());
        if (sentValue > 0n) {
            contractTransfer(getMsgSender(), sentValue);
        }
        return 5;
    }

    storageWrite("balance:" + from, currentBalance - amountBigint);
    storageWrite("balance:" + to, balanceOf(to) + amountBigint);

    return balanceOf(to);
}

function mint(to, amount) {
    if (getMsgSender() != OWNER) return;
    const price = toBigInt(amount) * 1000;
    const sentValue = toBigInt(getMsgValue());
    if (sentValue < price) {
        print("Insufficient value sent");
        contractTransfer(getMsgSender(), sentValue);
        return 6;
    }
    
    let currentSupply = storageRead("totalSupply");
    const amountBigint = toBigInt(parseInt(amount));
    if (!currentSupply) currentSupply = 0;
    storageWrite("totalSupply", toBigInt(currentSupply) + amountBigint);
    storageWrite("balance:" + to, balanceOf(to) + amountBigint);
    const change = sentValue - toBigInt(price);

    if (change > 0) {
        contractTransfer(getMsgSender(), change);
    }

    return balanceOf(to);
}

function swap(amount) {
    const from = getMsgSender();
    const currentBalance = balanceOf(from);
    const amountBigint = toBigInt(parseInt(amount));

    if (currentBalance < amountBigint) {
        print("Insufficient funds for swap");
        const sentValue = toBigInt(getMsgValue());
        if (sentValue > 0n) {
            contractTransfer(from, sentValue);
        }
        return 5;
    }

    storageWrite("balance:" + from, currentBalance - amountBigint);
    
    let currentSupply = storageRead("totalSupply");
    if (currentSupply) {
        storageWrite("totalSupply", toBigInt(parseInt(currentSupply)) - amountBigint);
    }

    const callData = stringifyJSON({
        method: 'transfer',
        to: from,
        amount: amount
    });

    print("Calling Token A for swap...");
    
    const result = contractCall(TOKEN_A_ADDRESS, callData, 0);

    if (result == 5) {
        print("Swap failed: This contract does not have enough Token A to payout");
        
        storageWrite("balance:" + from, currentBalance);
        let currentSupplyRollback = storageRead("totalSupply");
        storageWrite("totalSupply", toBigInt(parseInt(currentSupplyRollback)) + amountBigint);
        
        return 8;
    }

    print("Swap successful!");
    return result;
}

function action(data) {
    if (!data) return 1;
    if (!data.method) return 2;
    if (data.method == 'transfer') {
        if (!data.to || !data.amount) return 3;
        return transfer(data.to, data.amount);
    }
    if (data.method == 'mint') {
        if (!data.to || !data.amount) return 4;
        return mint(data.to, data.amount);
    }
    if (data.method == 'swap') {
        if (!data.amount) return 7;
        return swap(data.amount);
    }
}

action(parseJSON(getMsgData()));
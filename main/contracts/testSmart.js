const OWNER = '02746dfc34ffb4a8f893705c035ab26a69adb89be57b75785bcbd527c0f25506ae';

function getOwner() {
    const newOwner = storageRead("owner");
    if (!newOwner) return OWNER;
    return newOwner;
}

function setOwner(newOwner) {
    if (getMsgSender() != getOwner()) return 8;
    storageWrite("owner", newOwner);
    return newOwner;
}

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
    const price = toBigInt(amount) * 1000000;
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
    if (data.method == 'get_owner') {
        return getOwner();
    }
    if (data.method == 'set_owner') {
        if (!data.owner) return 7;
        return setOwner(data.owner);
    }
}

action(parseJSON(getMsgData()));
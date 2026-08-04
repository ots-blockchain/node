const OWNER = '03dced9c1cd641b29065f7ca733eaed95a366f75a917a30c092056637f052511a7';

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
        return false;
    }

    storageWrite("balance:" + from, currentBalance - amountBigint);
    storageWrite("balance:" + to, balanceOf(to) + amountBigint);

    return balanceOf(to);
}

function mint(to, amount) {
    if (getMsgSender() != OWNER) return
    let currentSupply = storageRead("totalSupply");
    const amountBigint = toBigInt(parseInt(amount));
    if (!currentSupply) currentSupply = 0;
    storageWrite("totalSupply", toBigInt(currentSupply) + amountBigint);
    storageWrite("balance:" + to, balanceOf(to) + amountBigint);

    return balanceOf(to);
}

function action(data) {
    if (!data) return;
    if (!data.method) return;
    if (data.method == 'transfer') {
        if (!data.to || !data.amount) return;
        return transfer(data.to, data.amount);
    }
    if (data.method == 'mint') {
        if (!data.to || !data.amount) return;
        return mint(data.to, data.amount);
    }
}

action(getMsgData());
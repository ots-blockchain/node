function rotr(x, n) {
    return bitOr(bitShr(x, n), bitShl(x, 32 - n));
}

function ch(x, y, z) {
    return bitXor(bitAnd(x, y), bitAnd(bitNot(x), z));
}

function maj(x, y, z) {
    return bitXor(bitXor(bitAnd(x, y), bitAnd(x, z)), bitAnd(y, z));
}

function add32(a, b) {
    return bitOr(a + b, 0);
}

function toHexString(hashObj) {
    let fullString = "";
    
    let wordIdx = 0;
    while (wordIdx < 8) {
        let word = hashObj[wordIdx];
        
        let shift = 28;
        while (shift >= 0) {
            let nibble = bitAnd(bitShr(word, shift), 15);
            
            let char = getHexChar(nibble);
            fullString = fullString + char;
            
            shift = shift - 4;
        }
        wordIdx = wordIdx + 1;
    }
    return fullString;
}

function getHexChar(val) {
    const hexChars = "0123456789abcdef";
    return hexChars[val];
}

function sha256(msgArray) {
    let L_bytes = 0;
    while (readObjectKey(msgArray, L_bytes) != null) {
        L_bytes = L_bytes + 1;
    }
    let L_bits = L_bytes * 8;

    writeObjectKey(msgArray, L_bytes, 128);
    let currLen = L_bytes + 1;

    while (currLen - floor(currLen / 64) * 64 != 56) {
        writeObjectKey(msgArray, currLen, 0);
        currLen = currLen + 1;
    }

    writeObjectKey(msgArray, currLen, 0); currLen = currLen + 1;
    writeObjectKey(msgArray, currLen, 0); currLen = currLen + 1;
    writeObjectKey(msgArray, currLen, 0); currLen = currLen + 1;
    writeObjectKey(msgArray, currLen, 0); currLen = currLen + 1;

    writeObjectKey(msgArray, currLen, bitShr(L_bits, 24)); currLen = currLen + 1;
    writeObjectKey(msgArray, currLen, bitAnd(bitShr(L_bits, 16), 255)); currLen = currLen + 1;
    writeObjectKey(msgArray, currLen, bitAnd(bitShr(L_bits, 8), 255)); currLen = currLen + 1;
    writeObjectKey(msgArray, currLen, bitAnd(L_bits, 255)); currLen = currLen + 1;

    let H0 = 1779033703; let H1 = 3144134277; let H2 = 1013904242; let H3 = 2773480762;
    let H4 = 1359893119; let H5 = 2600822924; let H6 = 528734635;  let H7 = 1541459225;

    let K = parseJSON("[1116352408, 1899447441, 3049323471, 3921009573, 961987163, 1508970993, 2453635748, 2870763221, 3624381080, 310598401, 607225278, 1426881987, 1925078388, 2162078206, 2614888103, 3248222580, 3835390401, 4022224774, 264347078, 604807628, 770255983, 1249150122, 1555081692, 1996064986, 2554220882, 2821834349, 2952996808, 3210313671, 3336571891, 3584528711, 113926993, 338241895, 666307205, 773529912, 1294757372, 1396182291, 1695183700, 1986661051, 2177026350, 2456956037, 2730485921, 2820302411, 3259730800, 3345764771, 3516065817, 3600352804, 4094571909, 275423344, 430227734, 506948616, 659060556, 883997877, 958139571, 1322822218, 1537002063, 1747873779, 1955562222, 2024104815, 2227730452, 2361852424, 2428436474, 2756734187, 3204031479, 3329325298]");

    let numBlocks = currLen / 64;
    let blockIdx = 0;

    while (blockIdx < numBlocks) {
        let offset = blockIdx * 64;
        let W = parseJSON("[]"); 

        let i = 0;
        while (i < 16) {
            let b0 = readObjectKey(msgArray, offset + i * 4);
            let b1 = readObjectKey(msgArray, offset + i * 4 + 1);
            let b2 = readObjectKey(msgArray, offset + i * 4 + 2);
            let b3 = readObjectKey(msgArray, offset + i * 4 + 3);
            
            if (b0 == null) { b0 = 0; }
            if (b1 == null) { b1 = 0; }
            if (b2 == null) { b2 = 0; }
            if (b3 == null) { b3 = 0; }

            let word = bitOr(bitShl(b0, 24), bitOr(bitShl(b1, 16), bitOr(bitShl(b2, 8), b3)));
            writeObjectKey(W, i, word);
            i = i + 1;
        }

        while (i < 64) {
            let w15 = readObjectKey(W, i - 15);
            let w2 = readObjectKey(W, i - 2);
            
            let s0 = bitXor(bitXor(rotr(w15, 7), rotr(w15, 18)), bitShr(w15, 3));
            let s1 = bitXor(bitXor(rotr(w2, 17), rotr(w2, 19)), bitShr(w2, 10));
            
            let sum = add32(add32(readObjectKey(W, i - 16), s0), add32(readObjectKey(W, i - 7), s1));
            writeObjectKey(W, i, sum);
            i = i + 1;
        }

        let a = H0; let b = H1; let c = H2; let d = H3;
        let e = H4; let f = H5; let g = H6; let h = H7;
        let j = 0;
        while (j < 64) {
            let S1 = bitXor(bitXor(rotr(e, 6), rotr(e, 11)), rotr(e, 25));
            let ch_res = ch(e, f, g);
            let temp1 = add32(add32(add32(h, S1), add32(ch_res, readObjectKey(K, j))), readObjectKey(W, j));
            
            let S0 = bitXor(bitXor(rotr(a, 2), rotr(a, 13)), rotr(a, 22));
            let maj_res = maj(a, b, c);
            let temp2 = add32(S0, maj_res);

            h = g; g = f; f = e;
            e = add32(d, temp1);
            d = c; c = b; b = a;
            a = add32(temp1, temp2);

            j = j + 1;
        }

        H0 = add32(H0, a); H1 = add32(H1, b); H2 = add32(H2, c); H3 = add32(H3, d);
        H4 = add32(H4, e); H5 = add32(H5, f); H6 = add32(H6, g); H7 = add32(H7, h);

        blockIdx = blockIdx + 1;
    }

    let finalHash = parseJSON("{}");
    writeObjectKey(finalHash, 0, H0); writeObjectKey(finalHash, 1, H1);
    writeObjectKey(finalHash, 2, H2); writeObjectKey(finalHash, 3, H3);
    writeObjectKey(finalHash, 4, H4); writeObjectKey(finalHash, 5, H5);
    writeObjectKey(finalHash, 6, H6); writeObjectKey(finalHash, 7, H7);
    return finalHash;
}

function substr(str, start, end) {
	let res = '';
  	for (let i = start; i < end; i++) {
    	res = res + str[i];
    }
  	return res;
}

function mine(data) {
    let nonce = 0;
    let targetPrefix = "00";
    let found = false;
    let finalHex = "";

    print("Starting mining...");

    while (found == false) {
        writeObjectKey(data, 0, bitAnd(nonce, 255));
        writeObjectKey(data, 1, bitAnd(bitShr(nonce, 8), 255));

        let hash1 = sha256(data);
        
        let hex = toHexString(hash1);

        if (isTargetReached(hex, targetPrefix)) {
            found = true;
            finalHex = hex;
        } else {
            nonce = nonce + 1;
            
            if (bitAnd(nonce, 15) == 0) {
                print("Trying nonce: " + nonce + " Hash: " + hex);
            }
        }
        
        if (nonce > 500) {
            print("Mining stopped: maximum attempts reached.");
            return "failed";
        }
    }

    print("Nonce: " + nonce);
    print("Result: " + finalHex);
    return finalHex;
}

function isTargetReached(h, prefix) {
    let ok = true;
    if (substr(h, 0, prefix.length) != prefix) { ok = false; }
    return ok;
}

let initialData = parseJSON("[0, 0, 0, 0]");
mine(initialData);
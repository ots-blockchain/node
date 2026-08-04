import Decimal from 'decimal.js';
import { consts, costs } from '../core/config.js';
import Logger from '../core/logger.js';
const logger = new Logger('Interpreter');

const BLACKLIST = ['__proto__', 'constructor', 'prototype'];

const toDec = (val) => {
    if (val instanceof Decimal) return val;
    if (typeof val === 'bigint') return new Decimal(val.toString());
    if (typeof val === 'object' && val['__bigint'] === true) return new Decimal(val.value);
    return new Decimal(val);
};

class Scope {
    constructor(parent = null) {
        this.parent = parent;
        this.vars = new Map();
    }
    get(name) {
        if (this.vars.has(name)) return this.vars.get(name);
        if (this.parent) return this.parent.get(name);
        return undefined;
    }
    set(name, value) {
        this.vars.set(name, value);
    }
    has(name) {
        if (this.vars.has(name)) return true;
        if (this.parent) return this.parent.has(name);
        return false;
    }
    delete(name) {
        return this.vars.delete(name);
    }
}

export class VM {
    constructor(gasTracker, extraFuncs = {}) {
        this.gasTracker = gasTracker; 
        this.globalScope = new Scope();
        this.currentScope = this.globalScope;
        this.callDepth = 0;
        this.extraFuncs = extraFuncs;
        this.initBuiltins();
    }

    useGas(amount) {
        const cost = BigInt(amount);
        if (this.gasTracker.amount < cost) {
            this.gasTracker.amount = 0n;
            throw new Error('Out of Gas!');
        }
        this.gasTracker.amount -= cost;
    }

    chargeMemory(size) {
        this.useGas(BigInt(size) * costs.MEMORY_BYTE);
    }

    initBuiltins() {
        const funcs = {
            writeVar: (name, value) => {
                this.useGas(costs.WRITE_VAR);
                if (!name || name.length > consts.VARNAME_LENGTH_LIMIT) throw new Error('Incorrect variable name');
                if (funcs[name] || this.extraFuncs[name]) throw new Error('Cannot write a read-only variable');
                this.currentScope.set(name, value);
            },
            deleteVar: (name) => {
                this.useGas(costs.DEFAULT);
                if (!name || name.length > consts.VARNAME_LENGTH_LIMIT) throw new Error('Incorrect variable name');
                if (funcs[name] || this.extraFuncs[name]) throw new Error('Cannot delete a read-only variable');
                return this.currentScope.delete(name);
            },
            readVar: (name) => {
                this.useGas(costs.DEFAULT);
                if (!name || name.length > consts.VARNAME_LENGTH_LIMIT) throw new Error('Incorrect variable name');
                return this.currentScope.get(name);
            },
            readGas: () => {
                this.useGas(costs.DEFAULT);
                return BigInt(this.gas);
            },

            execFunc: async (funcBody) => {
                let result;
                for (let i = 0; i < funcBody.length; i++) {
                    this.useGas(costs.INSTRUCTION);
                    const inst = funcBody[i];
                    
                    result = Array.isArray(inst) 
                        ? await this.resolveArg(inst) 
                        : inst;
            
                    if (result && typeof result === 'object' && result.type) {
                        return result; 
                    }
                }
                return result;
            },

            break: () => ({ type: 'break' }),
            continue: () => ({ type: 'continue' }),

            while: async (condition, funcBody) => {
                while (true) {
                    this.useGas(costs.DEFAULT);
                    if (!(await this.resolveArg(condition))) break;
                    const result = await funcs.execFunc(funcBody);
                    if (result) {
                        if (result.type === 'return') return result;
                        if (result.type === 'break') break;
                        if (result.type === 'continue') continue;
                    }
                }
            },

            return: async (value) => ({ type: 'return', value: await this.resolveArg(value) }),

            writeFunc: (name, paramNames, body) => {
                if (!Array.isArray(paramNames)) {
                    body = paramNames;
                    paramNames = [];
                }
                const funcBody = Array.isArray(body.raw) ? body.raw : body;

                this.currentScope.set(name, funcs.createFunc(paramNames, funcBody));
            },

            makeFunc: (paramNames, body) => {
                if (!Array.isArray(paramNames)) {
                    body = paramNames;
                    paramNames = [];
                }

                const funcBody = Array.isArray(body.raw) ? body.raw : body;

                return funcs.createFunc(paramNames, funcBody);
            },

            add: (a, b) => {
                this.useGas(costs.DEFAULT);
                if (typeof a === 'string' || typeof b === 'string') {
                    const res = String(a) + String(b);
                    if (res.length > consts.MAX_STRING_LENGTH) throw new Error("String length limit exceeded");
                    this.chargeMemory(res.length);
                    return res;
                }
                return toDec(a).add(toDec(b));
            },
            sub: (a, b) => {
                this.useGas(costs.DEFAULT);
                return toDec(a).sub(toDec(b));
            },
            mul: (a, b) => {
                this.useGas(costs.DEFAULT);
                return toDec(a).mul(toDec(b));
            },
            div: (a, b) => {
                this.useGas(costs.DEFAULT);
                return toDec(a).div(toDec(b));
            },
            mod: (a, b) => {
                this.useGas(costs.DEFAULT);
                return toDec(a).mod(toDec(b));
            },
        
            pow: (a, b) => {
                this.useGas(costs.COMPLEX_MATH);
                return toDec(a).pow(toDec(b));
            },
            sqrt: (a) => {
                this.useGas(costs.COMPLEX_MATH);
                return toDec(a).sqrt();
            },
            cbrt: (a) => {
                this.useGas(costs.COMPLEX_MATH);
                return toDec(a).cbrt();
            },

            sin: (a) => {
                this.useGas(costs.COMPLEX_MATH);
                return toDec(a).sin();
            },
            cos: (a) => {
                this.useGas(costs.COMPLEX_MATH);
                return toDec(a).cos();
            },
            tan: (a) => {
                this.useGas(costs.COMPLEX_MATH);
                return toDec(a).tan();
            },
            asin: (a) => {
                this.useGas(costs.COMPLEX_MATH);
                return toDec(a).asin();
            },
            acos: (a) => {
                this.useGas(costs.COMPLEX_MATH);
                return toDec(a).acos();
            },
            atan: (a) => {
                this.useGas(costs.COMPLEX_MATH);
                return toDec(a).atan();
            },

            log: (a, b) => {
                this.useGas(costs.COMPLEX_MATH);
                return toDec(a).log(toDec(b));
            },
            ln: (a) => {
                this.useGas(costs.COMPLEX_MATH);
                return toDec(a).ln();
            },

            abs: (a) => {
                this.useGas(costs.DEFAULT);
                return toDec(a).abs();
            },
            ceil: (a) => {
                this.useGas(costs.DEFAULT);
                return toDec(a).ceil();
            },
            floor: (a) => {
                this.useGas(costs.DEFAULT);
                return toDec(a).floor();
            },
            round: (a) => {
                this.useGas(costs.DEFAULT);
                return toDec(a).round();
            },
            
            isEqual: (a, b) => {
                this.useGas(costs.DEFAULT);
                if (a == null && b == null) return true;
                if (a == null || b == null) return false;
                try {
                    return toDec(a).eq(toDec(b));
                } catch (e) {
                    return a === b; 
                }
            },
            
            isNotEqual: (a, b) => {
                return !funcs.isEqual(a, b);
            },
            
            isGreater: (a, b) => {
                this.useGas(costs.DEFAULT);
                if (a == null || b == null) return false;
                return toDec(a).gt(toDec(b));
            },

            isLower: (a, b) => {
                this.useGas(costs.DEFAULT);
                if (a == null || b == null) return false;
                return toDec(a).lt(toDec(b));
            },
            
            isEqualGreater: (a, b) => {
                this.useGas(costs.DEFAULT);
                if (a == null || b == null) return false;
                return toDec(a).gte(toDec(b));
            },

            isEqualLower: (a, b) => {
                this.useGas(costs.DEFAULT);
                if (a == null || b == null) return false;
                return toDec(a).lte(toDec(b));
            },

            not: (a) => {
                this.useGas(costs.DEFAULT);
                return !a;
            },
            and: (a, b) => {
                this.useGas(costs.DEFAULT);
                return a && b;
            },
            or: (a, b) => {
                this.useGas(costs.DEFAULT);
                return a || b;
            },
            bitAnd: (a, b) => {
                this.useGas(costs.DEFAULT);
                return (Number(a) & Number(b)) >>> 0;
            },
            bitOr: (a, b) => {
                this.useGas(costs.DEFAULT);
                return (Number(a) | Number(b)) >>> 0;
            },
            bitXor: (a, b) => {
                this.useGas(costs.DEFAULT);
                return (Number(a) ^ Number(b)) >>> 0;
            },
            bitNot: (a) => {
                this.useGas(costs.DEFAULT);
                return (~Number(a)) >>> 0;
            },
            bitShl: (a, b) => {
                this.useGas(costs.DEFAULT);
                return (Number(a) << Number(b)) >>> 0;
            },
            bitShr: (a, b) => {
                this.useGas(costs.DEFAULT);
                return Number(a) >>> Number(b);
            },

            parseInt: parseInt,
            parseFloat: parseFloat,
            toBigInt: (a) => BigInt(a || 0),
            toString: (a) => String(a),

            if: async (cond, t, f) => {
                const conditionMet = await this.resolveArg(cond);
                const target = conditionMet ? t : f;
                if (target) return await funcs.execFunc(target);
            },

            typeof: (a) => {
                return typeof a;
            },

            objectKeys: (o) => Object.keys(o),
            objectValues: (o) => Object.values(o),
            parseJSON: (js) => {
                try {
                    this.useGas(costs.CREATE_OBJECT);
                    const parsed = JSON.parse(js);
                    return parsed;
                } catch(e) {
                    return null;
                }
            },

            stringifyJSON: (obj) => {
                try {
                    this.useGas(costs.CREATE_OBJECT);
                    const js = JSON.stringify(obj);
                    return js;
                } catch(e) {
                    return null;
                }
            },

            readObjectKey: (obj, key) => {
                if (BLACKLIST.includes(key) || !obj) return undefined;
                return obj[key];
            },

            writeObjectKey: (obj, key, val) => {
                if (BLACKLIST.includes(key) || !obj) return undefined;
                obj[key] = val;
            },

            createObject: async (elements) => {
                this.useGas(costs.CREATE_OBJECT);
                const newObj = Object.create(null); 
                
                for (const el of elements) {
                    if (el.type === 'spread') {
                        const sourceObj = await this.resolveArg(el.argument);
                        if (sourceObj && typeof sourceObj === 'object') {
                            const keys = Object.keys(sourceObj);
                            this.chargeMemory(keys.length * 2);
                            
                            keys.forEach(key => {
                                if (!BLACKLIST.includes(key)) newObj[key] = sourceObj[key];
                            });
                        }
                    } else if (el.type === 'property') {
                        if (!BLACKLIST.includes(el.key)) {
                            this.chargeMemory(2);
                            newObj[el.key] = await this.resolveArg(el.value);
                        }
                    }
                }
                return newObj;
            },
        };

        for (const [key, val] of Object.entries(funcs)) {
            this.globalScope.set(key, val);
        }
        for (const [key, val] of Object.entries(this.extraFuncs)) {
            this.globalScope.set(key, val);
        }

        funcs.createFunc = (paramNames, funcBody) => {
            return async (...args) => {
                this.callDepth++;
                if (this.callDepth > consts.MAX_CALL_DEPTH) throw new Error("Call stack overflow");
                const previousScope = this.currentScope;
                this.currentScope = new Scope(previousScope); 
    
                try {
                    for (let i = 0; i < paramNames.length; i++) {
                        this.currentScope.set(paramNames[i], args[i]);
                    }
                    const returnVal = await funcs.execFunc(funcBody);
                    if (returnVal && returnVal.type === 'return') return returnVal.value;
                    return returnVal;
                } finally {
                    this.currentScope = previousScope;
                    this.callDepth--;
                }
            };
        };
    }

    async resolveArg(arg) {
        if (typeof arg !== 'object' || arg === null) return arg;
    
        if (Array.isArray(arg)) {
            this.useGas(costs.FUNC_CALL);
            if (arg.length === 0) return undefined;
    
            const funcName = arg[0];
            const func = this.currentScope.get(funcName);
    
            if (typeof func !== 'function') {
                throw new Error(`Unknown function: ${funcName}`);
            }
    
            const resolvedArgs = [];
            for (let i = 1; i < arg.length; i++) {
                resolvedArgs.push(await this.resolveArg(arg[i]));
            }
    
            return await func(...resolvedArgs);
        }
    
        if (arg.raw !== undefined) return arg.raw;
        return arg;
    }

    async run(code) {
        try {
            let status = null;
            for (const inst of code) {
                status = await this.resolveArg(inst);
            }
            return { success: true, remainingGas: this.gasTracker.amount, status };
        } catch (e) {
            logger.error('Execution error:', e);
            return { success: false, error: e.message || e, remainingGas: this.gasTracker.amount };
        }
    }
}

export async function start(code, extraFuncsArg = {}, gasTracker) {
    const vm = new VM(gasTracker, extraFuncsArg);
    return await vm.run(code);
}

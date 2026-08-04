import * as acorn from 'acorn';
import Logger from '../core/logger.js';
const logger = new Logger('Compiler');

const BINARY_OPS = {
    '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod',
    '==': 'isEqual', '===': 'isEqualType', '!=': 'isNotEqual', '!==': 'isNotEqualType',
    '>': 'isGreater', '<': 'isLower', '>=': 'isEqualGreater', '<=': 'isEqualLower',
    '&&': 'and', '||': 'or', '!': 'not'
};

export function compile(jsCode) {
    const ast = acorn.parse(jsCode, { ecmaVersion: 2020 });

    function transform(node) {
        if (!node) return null;

        switch (node.type) {
            case 'Program':
                const progBody = [];
                node.body.forEach(n => {
                    const res = transform(n);
                    if (Array.isArray(res) && Array.isArray(res[0])) {
                        progBody.push(...res); 
                    } else {
                        progBody.push(res);
                    }
                });
                return progBody;

            case 'FunctionDeclaration':
                return [
                    "writeFunc",
                    node.id.name,
                    { "raw": node.params.map(p => p.name) },
                    transform(node.body)
                ];

            case 'ArrowFunctionExpression':
                return [
                    "makeFunc",
                    { "raw": node.params.map(p => p.name) },
                    transform(node.body)
                ];

            case 'BlockStatement':
                const blockBody = [];
                node.body.forEach(n => {
                    const res = transform(n);
                    if (Array.isArray(res) && Array.isArray(res[0])) {
                        blockBody.push(...res);
                    } else {
                        blockBody.push(res);
                    }
                });
                return { "raw": blockBody };

            case 'ExpressionStatement':
                return transform(node.expression);

            case 'CallExpression':
                return [node.callee.name, ...node.arguments.map(transform)];

            case 'ReturnStatement':
                return ["return", transform(node.argument)];

            case 'VariableDeclaration':
                const decl = node.declarations[0];
                const initVal = transform(decl.init); 
                return ["writeVar", decl.id.name, initVal];

            case 'IfStatement':
                const ifRes = [
                    "if",
                    transform(node.test),
                    node.consequent.type === 'BlockStatement'
                        ? transform(node.consequent)
                        : { "raw": [transform(node.consequent)] }
                ];
                if (node.alternate) {
                    ifRes.push(
                        node.alternate.type === 'BlockStatement'
                            ? transform(node.alternate)
                            : { "raw": [transform(node.alternate)] }
                    );
                }
                return ifRes;

            case 'ForStatement':
                const init = transform(node.init);
                const test = transform(node.test);
                const body = transform(node.body);

                const whileBody = [...body.raw];
                if (node.update.type === 'UpdateExpression') {
                    const vName = node.update.argument.name;
                    const op = node.update.operator === '++' ? 'add' : 'sub';
                    whileBody.push(["writeVar", vName, [op, ["readVar", vName], 1]]);
                }

                return [
                    init,
                    ["while", { "raw": test }, { "raw": whileBody }]
                ];

            case 'BinaryExpression':
                return [BINARY_OPS[node.operator] || node.operator, transform(node.left), transform(node.right)];

            case 'LogicalExpression':
                return [BINARY_OPS[node.operator] || node.operator, transform(node.left), transform(node.right)];
            
            case 'UnaryExpression':
                return [BINARY_OPS[node.operator] || node.operator, transform(node.argument)];
            
            case 'EmptyStatement':
                return [ null ];

            case 'Identifier':
                return ["readVar", node.name];

            case 'Literal':
                return node.value;

            case 'MemberExpression':
                return ["readObjectKey", transform(node.object), node.computed ? transform(node.property) : node.property.name];

            case 'AssignmentExpression':
                if (node.left.type === 'MemberExpression') {
                    return ["writeObjectKey", transform(node.left.object), node.left.computed ? transform(node.left.property) : node.left.property.name, transform(node.right)];
                }
                return ["writeVar", node.left.name, transform(node.right)];
            case 'WhileStatement':
                return [
                    "while",
                    { "raw": transform(node.test) },
                    node.body.type === 'BlockStatement'
                        ? transform(node.body)
                        : { "raw": [transform(node.body)] }
                ];

            case 'ArrayExpression':
                return {
                    "raw": node.elements.map(transform)
                };

            case 'ObjectExpression':
                const elements = node.properties.map(prop => {
                    if (prop.type === 'SpreadElement') {
                        return {
                            type: 'spread',
                            argument: transform(prop.argument)
                        };
                    } else {
                        const key = prop.key.type === 'Identifier' ? prop.key.name : prop.key.value;
                        return {
                            type: 'property',
                            key: key,
                            value: transform(prop.value)
                        };
                    }
                });
            
                return ["createObject", {"raw": elements}];

            case 'BreakStatement':
                return ["break"];

            case 'UpdateExpression':
                const varName = node.argument.name;
                const op = node.operator === '++' ? 'add' : 'sub';
                
                return [
                    "writeVar", 
                    varName, 
                    [op, ["readVar", varName], 1]
                ];

            default:
                logger.debug("Unknown node type:", node.type)
                return null;
        }
    }
    return transform(ast);
}

export function decompile(input) {
    let ast;
    if (typeof input === 'string') {
        try { ast = JSON.parse(input); } 
        catch (e) { throw new Error("Invalid JSON input"); }
    } else {
        ast = input;
    }

    const INDENT = '  ';

    function getIndent(level) {
        return INDENT.repeat(level);
    }

    function decompileNode(node, indent = 0) {
        if (node === null) return 'null';
        if (typeof node === 'string') return `"${node.replace(/"/g, '\\"')}"`;
        if (typeof node === 'number' || typeof node === 'boolean') return String(node);
        
        if (typeof node === 'object' && !Array.isArray(node)) {
            if (node.__bigint) return `${node.value}n`;
            
            if (node.raw !== undefined) {
                if (Array.isArray(node.raw)) {
                    return '[' + node.raw.map(n => decompileNode(n, indent)).join(', ') + ']';
                } else {
                    return decompileNode(node.raw, indent);
                }
            }
            if (node.type === 'property') {
                return `${node.key}: ${decompileNode(node.value, indent)}`;
            }
            if (node.type === 'spread') {
                return `...${decompileNode(node.argument, indent)}`;
            }
        }

        if (Array.isArray(node)) {
            if (node.length === 0) return '';
            
            if (Array.isArray(node[0])) {
                return node.map(n => getIndent(indent) + decompileStatement(n, indent)).join('\n');
            }

            const op = node[0];
            const args = node.slice(1);

            switch (op) {
                case 'writeFunc': {
                    const [name, paramsObj, bodyObj] = args;
                    const params = (paramsObj && paramsObj.raw) ? paramsObj.raw.join(', ') : '';
                    return `function ${name}(${params}) {\n${decompileBlock(bodyObj, indent + 1)}\n${getIndent(indent)}}`;
                }
                case 'makeFunc': {
                    const [mParamsObj, mBodyObj] = args;
                    const mParams = (mParamsObj && mParamsObj.raw) ? mParamsObj.raw.join(', ') : '';
                    return `(${mParams}) => {\n${decompileBlock(mBodyObj, indent + 1)}\n${getIndent(indent)}}`;
                }
                case 'writeVar':
                    return `let ${args[0]} = ${decompileNode(args[1], indent)}`;

                case 'readVar':
                    return args[0];

                case 'return':
                    if (args[0] === null || args[0] === undefined) return 'return';
                    return `return ${decompileNode(args[0], indent)}`;

                case 'if': {
                    const condition = decompileNode(args[0], indent);
                    let ifStr = `if (${condition}) {\n${decompileBlock(args[1], indent + 1)}\n${getIndent(indent)}}`;
                    if (args[2]) {
                        ifStr += ` else {\n${decompileBlock(args[2], indent + 1)}\n${getIndent(indent)}}`;
                    }
                    return ifStr;
                }
                case 'while': {
                    const wTest = decompileNode(args[0], indent);
                    return `while (${wTest}) {\n${decompileBlock(args[1], indent + 1)}\n${getIndent(indent)}}`;
                }
                case 'break':
                    return 'break';

                case 'readObjectKey': {
                    const obj = decompileNode(args[0], indent);
                    const keyStr = args[1];
                    if (typeof keyStr === 'string' && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(keyStr)) {
                        return `${obj}.${keyStr}`;
                    }
                    return `${obj}[${decompileNode(args[1], indent)}]`;
                }
                case 'writeObjectKey': {
                    const wObj = decompileNode(args[0], indent);
                    const wKeyStr = args[1];
                    const wVal = decompileNode(args[2], indent);
                    
                    if (typeof wKeyStr === 'string' && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(wKeyStr)) {
                        return `${wObj}.${wKeyStr} = ${wVal}`;
                    }
                    return `${wObj}[${decompileNode(args[1], indent)}] = ${wVal}`;
                }
                case 'createObject':
                    return `{ ${(args[0].raw || []).map(p => decompileNode(p, indent)).join(', ')} }`;

                case 'add': return `(${decompileNode(args[0], indent)} + ${decompileNode(args[1], indent)})`;
                case 'sub': return `(${decompileNode(args[0], indent)} - ${decompileNode(args[1], indent)})`;
                case 'mul': return `(${decompileNode(args[0], indent)} * ${decompileNode(args[1], indent)})`;
                case 'div': return `(${decompileNode(args[0], indent)} / ${decompileNode(args[1], indent)})`;
                case 'mod': return `(${decompileNode(args[0], indent)} % ${decompileNode(args[1], indent)})`;
                case 'isEqual': return `(${decompileNode(args[0], indent)} == ${decompileNode(args[1], indent)})`;
                case 'isEqualType': return `(${decompileNode(args[0], indent)} === ${decompileNode(args[1], indent)})`;
                case 'isNotEqual': return `(${decompileNode(args[0], indent)} != ${decompileNode(args[1], indent)})`;
                case 'isNotEqualType': return `(${decompileNode(args[0], indent)} !== ${decompileNode(args[1], indent)})`;
                case 'isGreater': return `(${decompileNode(args[0], indent)} > ${decompileNode(args[1], indent)})`;
                case 'isLower': return `(${decompileNode(args[0], indent)} < ${decompileNode(args[1], indent)})`;
                case 'isEqualGreater': return `(${decompileNode(args[0], indent)} >= ${decompileNode(args[1], indent)})`;
                case 'isEqualLower': return `(${decompileNode(args[0], indent)} <= ${decompileNode(args[1], indent)})`;
                case 'and': return `(${decompileNode(args[0], indent)} && ${decompileNode(args[1], indent)})`;
                case 'or': return `(${decompileNode(args[0], indent)} || ${decompileNode(args[1], indent)})`;
                
                case 'not': return `!${decompileNode(args[0], indent)}`;

                default:
                    return `${op}(${args.map(a => decompileNode(a, indent)).join(', ')})`;
            }
        }
        return '';
    }

    function decompileBlock(blockNode, indent) {
        let stmts = [];
        if (blockNode && blockNode.raw) {
            stmts = blockNode.raw;
        } else if (Array.isArray(blockNode)) {
            stmts = blockNode;
        } else {
            stmts = [blockNode];
        }
        
        return stmts.map(stmt => getIndent(indent) + decompileStatement(stmt, indent)).join('\n');
    }

    function decompileStatement(node, indent) {
        if (!node) return '';
        const stmt = decompileNode(node, indent);
        
        if (Array.isArray(node) && !Array.isArray(node[0])) {
            const op = node[0];
            if (['writeFunc', 'if', 'while'].includes(op)) {
                return stmt;
            }
        }
        return stmt + ';';
    }

    if (Array.isArray(ast) && Array.isArray(ast[0])) {
         return ast.map(n => decompileStatement(n, 0)).join('\n\n');
    } else {
         return decompileStatement(ast, 0);
    }
}

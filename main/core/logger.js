let chalk = null;
try {
    if (typeof require !== 'undefined') {
        const { Chalk } = require('chalk');
        if (Chalk) chalk = new Chalk();
    }
} catch (e) {
    chalk = null;
}

function formatDate(date, millis = true) {
    const now = date instanceof Date ? date : (date ? new Date(date) : new Date());

    const options = {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    };

    const mskString = now.toLocaleString('ru-RU', options).replace(',', '');

    if (!millis) return mskString;

    const milliseconds = String(now.getMilliseconds()).padStart(3, '0');
    return `${mskString}.${milliseconds}`;
}

const levelNames = chalk ? [
    null,
    chalk.bgGreen(chalk.whiteBright(" INFO  ")),
    chalk.bgYellow(chalk.whiteBright(" WARN  ")),
    chalk.bgRed(chalk.whiteBright(" ERROR ")),
    chalk.bgGray(chalk.whiteBright(" DEBUG "))
] : [
    null,
    "[INFO]",
    "[WARN]",
    "[ERROR]",
    "[DEBUG]"
];

export class Logger {
    constructor(name) {
        this.name = name;
    }

    log(level, ...msg) {
        const time = chalk ? chalk.gray(formatDate()) : formatDate();
        const tag = levelNames[level] || `[LEVEL_${level}]`;
        const prefix = `[${time}] ${tag} ${this.name ? this.name + ':' : ''}`;
        if (level === 3) {
            console.error(prefix, ...msg);
        } else if (level === 2) {
            console.warn(prefix, ...msg);
        } else if (level === 4) {
            console.debug(prefix, ...msg);
        } else {
            console.log(prefix, ...msg);
        }
    }

    info(...msg) {
        this.log(1, ...msg);
    }

    warn(...msg) {
        this.log(2, ...msg);
    }

    error(...msg) {
        this.log(3, ...msg);
    }

    debug(...msg) {
        this.log(4, ...msg);
    }
}

try {
    if (typeof module !== 'undefined' && module.exports && typeof exports !== 'undefined' && module.exports === exports) {
        module.exports = Logger;
    }
} catch (e) {}

export default Logger;

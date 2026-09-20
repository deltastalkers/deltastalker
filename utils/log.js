import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
export default class Logger {
    constructor({ maxLogs, logFile, categories, onUpdate = () => { }, writeToConsole = true }) {
        this.maxLogs = maxLogs;
        this.logFile = logFile;
        this.categories = Object.freeze(categories.map(s => s.toUpperCase()));
        this.onUpdate = onUpdate;
        this.writeToConsole = writeToConsole;
        this.logs = [];
    };

    log(data, { error, cat = 0 } = {}) {
        const timestamp = new Date().toISOString();
        const category = this.categories[cat] || `${cat}`;
        const logInfo = { timestamp, data, category, error };
        this.logs.push(logInfo);
        this.onUpdate(logInfo);
        if (this.logs.length > this.maxLogs) this.logs.shift();

        const rawString = `[${category.toUpperCase()} @ ${timestamp}] ${data}${error ? ":" : ""}`;
        if (this.writeToConsole) error ? console.error(rawString, error) : console.log(rawString);
        if (this.logFile) {
            mkdirSync(dirname(this.logFile), { recursive: true });
            appendFileSync(this.logFile, `${rawString}${error ? ` ${error.message}, ${error.stack || 'no stack trace available'}` : ""}\n`);
        };
    };
};
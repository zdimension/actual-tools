import { EOL } from "node:os";
import def from "ajv/dist/vocabularies/applicator/additionalItems.js";

type ArgumentStoreOptions = { splitter?: string} | {nargs?: '*' | '?' | '+' | number};

interface BaseArgumentOptions {
    help?: string;
    required?: boolean;
}

type ArgumentOptions = BaseArgumentOptions & (({
    action?: 'store';
} & ArgumentStoreOptions) | {
    action: 'store_true';
});

type PositionalArgumentOptions = BaseArgumentOptions & ArgumentStoreOptions;

interface ArgumentBase {
    usage(): string;
}

class Argument implements ArgumentBase { 
    short: string | null;
    long: string | null;
    options: ArgumentOptions;

    constructor(short: string, long: string | null, options: ArgumentOptions) {
        if (!short && !long) {
            throw new Error('Argument must have at least a short or long name');
        }
        this.short = short;
        this.long = long;
        this.options = options;
    }

    valName(): string {
        return (this.long?.replace(/^--/, '') || this.short?.replace(/^-/, '')).toUpperCase().replace(/-+/, '_');
    }

    valNameJs(): string {
        return this.valName().toLowerCase().replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    }

    usage(): string {
        let disp = this.short || this.long;
        if (this.options.action !== 'store_true') {
            disp += ` ` + this.valName();
        }
        if (this.options.required) {
            return `[${disp}]`;
        } else {
            return disp;
        }
    }

};

class PositionalArgument extends Argument {
    constructor(name: string, options: PositionalArgumentOptions) {
        super(null, name, options || {});
    }

    usage(): string {
        const disp = this.long!;
        if ('nargs' in this.options) {
            if (this.options.nargs === '*' || this.options.nargs === '+') {
                return `${disp}...`;
            } else if (this.options.nargs === '?') {
                return `[${disp}]`;
            } else if (typeof this.options.nargs === 'number') {
                return Array(this.options.nargs).fill(disp).join(' ');
            }
        } else {
            return disp;
        }
    }
}

class ArgumentGroup implements ArgumentBase {
    children: (Argument | ArgumentGroup)[] = [];

    usage(par: boolean = true): string {
        const res = this.children.map(c => c.usage(false)).join(' ');
        if (par) {
            return `(${res})`;
        } else {
            return res;
        }
    }

    add_argument(short: string | null, long: string | null, options?: ArgumentOptions): void;
    add_argument(short_or_long: string, options?: ArgumentOptions): void;

    add_argument(short: string | null, long: string | null | ArgumentOptions, options?: ArgumentOptions): void {
        if (typeof long === 'object' && options === undefined) {
            options = long;
            if (short.startsWith('--')) {
                long = short;
                short = null;
            } else {
                long = null;
            }
        }
        if ((short && !short.startsWith('-')) || (long && !(long as string).startsWith('--'))) {
            throw new Error('Invalid argument names: short should start with "-" and long should start with "--"');
        }
        this.children.push(new Argument(short, long as string | null, {
            action: 'store',
            required: false,
            ...options
        }));
    }

    add_argument_group(): ArgumentGroup {
        const group = new ArgumentGroup();
        this.children.push(group);
        return group;
    }

    add_mutually_exclusive_group(): MutuallyExclusiveGroup {
        const group = new MutuallyExclusiveGroup();
        this.children.push(group);
        return group;
    }

    find(arg: string): number[] | null {
        for (let i = 0; i < this.children.length; i++) {
            const child = this.children[i];
            if ('short' in child && (child.short === arg || child.long === arg)) {
                return [i];
            }
            if (child instanceof ArgumentGroup) {
                const subpath = child.find(arg);
                if (subpath) return [i, ...subpath];
            }
        }
        return null;
    }
}

class MutuallyExclusiveGroup extends ArgumentGroup {
    usage(): string {
        return `[${this.children.map(c => c.usage()).join(' | ')}]`;
    }
}

export class ArgumentParser extends ArgumentGroup {
    prog: string;
    helpIfEmpty: boolean;
    positionals: PositionalArgument[] = [];

    constructor(opts: { prog?: string, helpIfEmpty?: boolean } = {}) {
        super();
        this.prog = opts.prog || 'program';
        this.helpIfEmpty = opts.helpIfEmpty ?? true;
    }

    usage(par?: boolean): string {
        const baseUsage = super.usage(par);
        const positionalUsage = this.positionals.map(p => p.usage()).join(' ');
        return [baseUsage, positionalUsage].filter(s => s.length > 0).join(' ').trim();
    }

    add_argument(short: string | null, long: string | null | ArgumentOptions | PositionalArgumentOptions, options?: ArgumentOptions): void {
        if (!short.startsWith('-')) {
            if (typeof long === 'string') {
                throw new Error('Positional arguments should not have a long name');
            }
            this.positionals.push(new PositionalArgument(short, long as PositionalArgumentOptions));
            return;
        }

        super.add_argument(short, long as string | null, options);
    }

    private print_usage(): void {
        const output = [
            `usage: ${this.prog} ${this.usage(false)}`, 
            '', 
        ];

        if (this.positionals.length > 0) {
            output.push('positional arguments:');
            for (const pos of this.positionals) {
                output.push(`  ${pos.usage()}  ${pos.options.help || ''}`);
            }
            output.push('');
        }

        output.push('options:');

        type ConnectorSet = readonly [string, string, string, string];
        const normalChars: ConnectorSet = ['┌', '├', '│', '└'];
        const exclusiveChars: ConnectorSet = ['╓', '╟', '║', '╙'];
        const [START, MID_LINK, MID, END] = [0, 1, 2, 3];

        function formatArgument(arg: Argument): string {
            let forms = [arg.short, arg.long].filter(Boolean).map(s => arg.options.action !== 'store_true' ? `${s} ${arg.valName()}` : s);
            let usage = forms.join(', ');
            return `${usage}  %%${arg.options.help || ''}`;
        }

        function prefixBlock(lines: string[], idx: number, total: number, chars: ConnectorSet): string[] {
            if (lines.length === 0) {
                return [];
            }

            if (lines.length === 1) {
                const char = idx === 0 ? chars[START] : idx === total - 1 ? chars[END] : chars[MID_LINK];
                return [`${char} ${lines[0]}`];
            }

            return lines.map((line, lineIdx) => {
                const char = lineIdx === 0
                    ? (idx === 0 ? chars[START] : chars[MID_LINK])
                    : lineIdx === lines.length - 1
                        ? (idx === total - 1 ? chars[END] : chars[MID])
                        : chars[MID];
                return `${char} ${line}`;
            });
        }

        function renderGroup(group: ArgumentGroup, chars: ConnectorSet, isExclusive: boolean = false): string[] {
            const header = isExclusive ? ['one of:'] : [];
            const childrenLines = group.children.flatMap((child, idx) => {
                const block = child instanceof Argument
                    ? [formatArgument(child)]
                    : child instanceof MutuallyExclusiveGroup
                        ? renderGroup(child, exclusiveChars, true)
                        : renderGroup(child, normalChars, false);

                return prefixBlock(block, idx, group.children.length, chars);
            });

            return [...header, ...childrenLines];
        }

        let rendered = renderGroup(this, [' ', ' ', ' ', ' '], false).map(line => {
            const trimmed = line.trimEnd();
            const helpStart = trimmed.indexOf('%%');
            if (helpStart !== -1) {
                return [trimmed.slice(0, helpStart), trimmed.slice(helpStart + 2)];
            }
            return [trimmed, ''];
        });
        let maxLength = rendered.reduce((max, [line, _]) => Math.max(max, line.length), 0);

        output.push(...rendered.map(([line, help]) => {
            const usagePart = line.padEnd(maxLength);
            return `${usagePart}  ${help}`;
        }));

        process.stdout.write(output.join(EOL));

        console.log();
    }

    parse_args(args: string[]): any {
        const result: any = {};

        const cleanedArgs = args.map(arg => arg.trim());

        if (cleanedArgs.includes('-h') || cleanedArgs.includes('--help') || (cleanedArgs.length === 0 && this.helpIfEmpty)) {
            this.print_usage();
            process.exit(0);
        }

        const positionals: { name: string, minmax?: [number, number] }[] = [];

        for (const pos of this.positionals) {
            const name = pos.valNameJs();
            if ('nargs' in pos.options) {
                let min = 0;
                let max = 0;
                if (pos.options.nargs === '?') { min = 0; max = 1; }
                else if (pos.options.nargs === '*') { min = 0; max = Infinity; }
                else if (pos.options.nargs === '+') { min = 1; max = Infinity; }
                else if (typeof pos.options.nargs === 'number') { min = max = pos.options.nargs; }
                result[name] = [];
                positionals.push({ name, minmax: [min, max] });
            } else {                
                result[name] = null;
                positionals.push({ name });
            }
        }

        const chosenMap = new Map<MutuallyExclusiveGroup, { idx: number, source: Argument }>();
        // maps each argument or group to its parent group, used for backtracking when parsing
        const parentMap = new Map<ArgumentBase, { node: ArgumentGroup, idx: number }>();
        const nameMap = new Map<string, Argument>();

        function populate(group: ArgumentGroup) {
            for (const [idx, child] of group.children.entries()) {
                parentMap.set(child, { node: group, idx });
                if (child instanceof ArgumentGroup) {
                    populate(child);
                } else if (child instanceof Argument) {
                    if (child.short) nameMap.set(child.short, child);
                    if (child.long) nameMap.set(child.long, child);
                }
            }
        }

        populate(this);

        const unrecognized: string[] = [];
        const unexpectedPositionals: string[] = [];

        let i = 0;
        while (i < cleanedArgs.length) {
            const arg = cleanedArgs[i++];
            if (!arg.startsWith('-')) {
                // find which arg to fill
                let filled = false;
                for (const { name, minmax } of positionals) {
                    const arr = result[name];
                    if (minmax) {
                        const [min, max] = minmax;
                        if (arr.length < max) {
                            arr.push(arg);
                            filled = true;
                            break;
                        }
                    } else if (arr === null) {
                        result[name] = arg;
                        filled = true;
                        break;
                    }
                }

                if (!filled) {
                    unexpectedPositionals.push(arg);
                }

                continue;
            }
            const argDef = nameMap.get(arg);
            if (!argDef) {
                unrecognized.push(arg);
                continue;
            }

            // mark exclusive parents
            let parentInfo = parentMap.get(argDef);
            while (parentInfo) {
                const { node, idx } = parentInfo;
                if (node instanceof MutuallyExclusiveGroup) {
                    const existing = chosenMap.get(node);
                    if (existing && existing.idx !== idx) {
                        const prevPath = existing.source.usage();
                        const newPath = argDef.usage();
                        console.error(`error: argument ${arg} cannot be used with ${existing.source.short || existing.source.long} (${prevPath} vs ${newPath})`);
                        process.exit(1);
                    }
                    chosenMap.set(node, { idx, source: argDef });
                }
                parentInfo = parentMap.get(node);
            }

            const valName = argDef.valNameJs();
            if (argDef.options.action === 'store_true') {
                result[valName] = true;
            } else if (argDef.options.action === 'store') {
                const nargs = 'nargs' in argDef.options ? argDef.options.nargs : null;
                if (nargs === null) {
                    const value = cleanedArgs[i++];
                    if (value === undefined || value.startsWith('-')) {
                        console.error(`error: argument ${arg} expected a value`);
                        process.exit(1);
                    }
                    if ('splitter' in argDef.options) {
                        result[valName] = value.split(argDef.options.splitter).map(v => v.trim()).filter(v => v.length > 0);
                    } else {
                        result[valName] = value;
                    }
                } else if (nargs === '?') {
                    const value = cleanedArgs[i];
                    if (value === undefined || value.startsWith('-')) {
                        result[valName] = null;
                    } else {                        
                        result[valName] = value;
                        i++;
                    }
                } else if (nargs === '*' || nargs === '+') {
                    const values: string[] = [];
                    while (i < cleanedArgs.length && !cleanedArgs[i].startsWith('-')) {
                        values.push(cleanedArgs[i++]);
                    }
                    if (nargs === '+' && values.length === 0) {
                        console.error(`error: argument ${arg} expected at least one value`);
                        process.exit(1);
                    }
                    result[valName] = values;
                } else if (typeof nargs === 'number') {
                    const values: string[] = [];
                    for (let count = 0; count < nargs; count++) {
                        const value = cleanedArgs[i++];
                        if (value === undefined || value.startsWith('-')) {
                            console.error(`error: argument ${arg} expected ${nargs} values`);
                            process.exit(1);
                        }                        
                        values.push(value);
                    }
                    result[valName] = values;
                }
            }
        }

        if (unrecognized.length > 0) {
            console.error(`error: unrecognized arguments: ${unrecognized.join(', ')}`);
            this.print_usage();
            process.exit(1);
        }

        if (unexpectedPositionals.length > 0) {
            console.error(`error: unexpected positional arguments: ${unexpectedPositionals.join(', ')}`);
            this.print_usage();
            process.exit(1);
        }

        return result;
    }
}

if (import.meta.main) {
    const parser = new ArgumentParser();
    const summary = parser.add_mutually_exclusive_group();
    summary.add_argument('-s', '--summary', { action: 'store_true', help: 'Show summary of connectors and exit (no syncing)' });
    const sync = summary.add_argument_group();
    sync.add_argument('-d', '--dry-run', { action: 'store_true', help: 'Run without making any changes to Actual (for testing)' });
    const filter = sync.add_mutually_exclusive_group();
    filter.add_argument('-c', '--connectors', { help: 'Comma-separated list of connectors to run (format: "connector" or "connector/account")' });
    filter.add_argument('-m', '--all-manual', { action: 'store_true', help: 'Run all connectors marked as manual (requiresManualRun: true)' });
    parser.add_argument('things2', { nargs: 2, help: 'Positional arguments' });
    parser.add_argument('things', { nargs: '?', help: 'Positional arguments' });
    /*parser.add_argument('-1', '--one');
    const summary = parser.add_mutually_exclusive_group();
    summary.add_argument('-a', '--alpha');
    const sync = summary.add_argument_group();
    const filter = sync.add_mutually_exclusive_group();
    filter.add_argument('-c', '--charlie', { help: 'This is charlie' });
    filter.add_argument('-d', '--delta');
    filter.add_argument('-e', '--echo', { action: 'store_true' });
    filter.add_argument('-f', '--foxtrot');
    filter.add_argument('-g', '--golf');
    const filter2 = sync.add_argument_group();
    filter2.add_argument(null, '--hotel', { help: 'This is hotel' });
    filter2.add_argument('-i', '--india');
    const filter3 = sync.add_mutually_exclusive_group();
    filter3.add_argument('-j', '--juliet');
    filter3.add_argument('-k', '--kilo');
    summary.add_argument('-m', '--mike');
    const excl2 = parser.add_mutually_exclusive_group();
    excl2.add_argument('-x', '--xray', { action: 'store_true' });
    excl2.add_argument('-y', '--yankee');*/

    console.log(parser.parse_args(["-m", "arbitrary", "positional", "args", "aaa"]));
}





"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const Module = require('module');
const chokidar_1 = __importDefault(require("chokidar"));
const path = __importStar(require("path"));
const graph_1 = require("./graph");
const utils_1 = require("./utils");
class RegistryEntry {
    constructor(mod, filename, accepted = false, stash = null, patchees = new Map(), store = () => { }) {
        this.mod = mod;
        this.filename = filename;
        this.accepted = accepted;
        this.stash = stash;
        this.patchees = patchees;
        this.store = store;
    }
}
const _Module = {
    load: Module.prototype.load,
    require: Module.prototype.require
};
Module.prototype.require = function (filename) {
    const caller = this;
    const xports = _Module.require.call(caller, filename);
    const modulePath = Module._resolveFilename(filename, caller);
    if (!utils_1.isEligible(_cfg, modulePath)) {
        return xports;
    }
    const dependency = require.cache[modulePath];
    if (!dependency) {
        return xports;
    }
    if (caller !== process.mainModule) {
        _graph.addDependency(caller.filename, dependency.filename);
    }
    _watcher.add(dependency.filename);
    return xports;
};
Module.prototype.load = function (filename) {
    const eligible = utils_1.isEligible(_cfg, filename);
    if (eligible) {
        injectFile(this, filename);
    }
    _Module.load.call(this, filename);
    if (eligible && _cfg.patchExports) {
        patchExports(this);
    }
};
const _cfg = {
    silent: false,
    patchExports: false,
    exclude: [/[\/\\]node_modules[\/\\]/]
};
const _graph = new graph_1.Graph();
const _registry = new Map();
const _watcher = chokidar_1.default.watch([], { disableGlobbing: true });
_watcher.on('change', (file) => {
    const entry = _registry.get(file);
    if (!entry) {
        return;
    }
    utils_1.log(_cfg, 'Changed:', path.relative(process.cwd(), entry.filename));
    let acceptees = reload(entry);
    for (const acceptee of acceptees) {
        utils_1.log(_cfg, 'Reloading:', path.relative(process.cwd(), acceptee));
        _Module.require.call(entry.mod, acceptee);
    }
});
function reload(entry, acceptees = new Set(), reloaded = new Set()) {
    reloaded.add(entry);
    entry.store();
    delete require.cache[entry.filename];
    const removed = _graph.removeDependencies(entry.filename);
    for (const dependency of removed) {
        _watcher.unwatch(dependency);
    }
    const dependants = _graph.getDependantsOf(entry.filename);
    if (entry.accepted || dependants.length === 0) {
        acceptees.add(entry.filename);
    }
    else {
        for (const dependant of dependants) {
            const dependantEntry = _registry.get(dependant);
            if (dependantEntry && !reloaded.has(dependantEntry)) {
                reload(dependantEntry, acceptees, reloaded);
            }
        }
    }
    return acceptees;
}
function registerFile(mod, filename) {
    let entry = _registry.get(filename);
    if (!entry) {
        entry = new RegistryEntry(mod, filename);
        _registry.set(filename, entry);
    }
    return entry;
}
function injectFile(mod, filename) {
    if (mod.hot) {
        return;
    }
    const entry = registerFile(mod, filename);
    mod.hot = {
        accept: () => {
            entry.accepted = true;
        },
        store: (stasher) => {
            entry.store = () => {
                entry.stash = {};
                stasher(entry.stash);
            };
        },
        restore: (stasher) => {
            if (entry.stash) {
                stasher(entry.stash);
                entry.stash = null;
            }
        },
        patch: (...constructors) => {
            const { patchees } = entry;
            for (const current of constructors) {
                let history = patchees.get(current.name);
                if (history == null) {
                    history = [];
                    patchees.set(current.name, history);
                }
                for (const old of history) {
                    utils_1.assign(current, old, type => type !== 'function');
                    utils_1.assign(old, current, type => type === 'function');
                    utils_1.assign(old.prototype, current.prototype, type => type === 'function');
                    Object.setPrototypeOf(old.prototype, Object.getPrototypeOf(current.prototype));
                }
                history.push(current);
            }
        }
    };
}
function patchExports(mod) {
    if (utils_1.isPlainObject(mod.exports)) {
        for (const key of Object.getOwnPropertyNames(mod.exports)) {
            const xport = mod.exports[key];
            if (utils_1.isConstructorLike(xport)) {
                mod.hot.patch(xport);
            }
        }
    }
    else if (utils_1.isConstructorLike(mod.exports)) {
        mod.hot.patch(mod.exports);
    }
}
function configure(opts) {
    Object.assign(_cfg, opts);
}
exports.configure = configure;

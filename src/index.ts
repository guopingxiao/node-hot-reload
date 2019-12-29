// tslint:disable-next-line:variable-name
const Module = require('module');
import chokidar from 'chokidar';
import * as path from 'path';
import { Graph } from './graph';
import {
	isPlainObject,
	isConstructorLike,
	assign,
	log,
	isEligible
} from './utils';

type Constructor = new (...args: any[]) => any;
type StashCallback = (stash: any) => void;

interface Options {
	silent?: boolean;
	patchExports?: boolean;
	exclude?: RegExp[];
}

interface Hot {
	accept(): void;
	store(callback: StashCallback): void;
	restore(callback: StashCallback): void;
	patch(...constructors: Constructor[]): void;
}

declare global {
	interface NodeModule {
		hot?: Hot;
	}
}

/**
 * RegistryEntry
 */
class RegistryEntry {
	constructor(
		public mod: NodeModule,
		public filename: string,
		public accepted = false,
		public stash: Object | null = null,
		public patchees = new Map<string, Constructor[]>(),
		public store = () => { }
	) { }
}

/**
 * 定义_Module 的load函数和require函数
 */
const _Module = {
	load: Module.prototype.load as Function,
	require: Module.prototype.require as Function
};

// 增加require方法
Module.prototype.require = function (filename: string): any {
	const caller = this as NodeModule;
	const xports = _Module.require.call(caller, filename);

	const modulePath = Module._resolveFilename(filename, caller) as string;
	if (!isEligible(_cfg, modulePath)) {
		return xports;
	}

	const dependency = require.cache[modulePath] as NodeModule;
	if (!dependency) {
		return xports;
	}

	if (caller !== process.mainModule) {
		_graph.addDependency(caller.filename, dependency.filename);
	}

	_watcher.add(dependency.filename);

	return xports;
};

// 增加load方法
Module.prototype.load = function (filename: string) {
	const eligible = isEligible(_cfg, filename);
	if (eligible) {
		injectFile(this, filename);
	}

	_Module.load.call(this, filename);

	if (eligible && _cfg.patchExports) {
		patchExports(this);
	}
};

const _cfg: Required<Options> = {
	silent: false,
	patchExports: false,
	exclude: [/[\/\\]node_modules[\/\\]/]
}

const _graph = new Graph();
const _registry = new Map<string, RegistryEntry>();
const _watcher = chokidar.watch([], { disableGlobbing: true });

// watcher change file
_watcher.on('change', (file: string) => {
	const entry = _registry.get(file);
	if (!entry) { return; }

	log(_cfg, 'Changed:', path.relative(process.cwd(), entry.filename));

	let acceptees = reload(entry)
	for (const acceptee of acceptees) {
		log(_cfg, 'Reloading:', path.relative(process.cwd(), acceptee));
		_Module.require.call(entry.mod, acceptee);
	}
})

/**
 * reload file
 * @param entry
 * @param acceptees
 * @param reloaded
 */
function reload(
  entry: RegistryEntry,
	acceptees = new Set<string>(),
	reloaded = new Set<RegistryEntry>()
) {
	reloaded.add(entry)
	entry.store();

	// 删除cache的缓存
	delete require.cache[entry.filename];

	// 移除之前依赖的watch
	const removed = _graph.removeDependencies(entry.filename);
	for (const dependency of removed) {
		_watcher.unwatch(dependency);
	}

	//获得依赖，以及依赖的依赖，递归reload， add 到 acceptees
	const dependants = _graph.getDependantsOf(entry.filename);
	if (entry.accepted || dependants.length === 0) {
		acceptees.add(entry.filename);
	} else {
		for (const dependant of dependants) {
			const dependantEntry = _registry.get(dependant);
			if (dependantEntry && !reloaded.has(dependantEntry)) { // 有重复的不reload了
				reload(dependantEntry, acceptees, reloaded);
			}
		}
	}

	return acceptees
}

/**
 * register模块到 _registry
 * @param mod
 * @param filename
 */
function registerFile(mod: NodeModule,filename: string) {
	let entry = _registry.get(filename);
	if (!entry) {
		entry = new RegistryEntry(mod, filename);
		_registry.set(filename, entry);
	}

	return entry;
}

/**
 * 注入模块一些属性
 * @param mod
 * @param filename
 */
function injectFile(mod: NodeModule, filename: string) {
	if (mod.hot) { return; }

	const entry = registerFile(mod, filename)

	mod.hot = {
		accept: () => {
			entry.accepted = true;
		},
		store: (stasher: StashCallback) => {
			entry.store = () => {
				entry.stash = {};
				stasher(entry.stash);
			};
		},
		restore: (stasher: StashCallback) => {
			if (entry.stash) {
				stasher(entry.stash);
				entry.stash = null;
			}
		},
		patch: (...constructors: Constructor[]) => {
			const { patchees } = entry;

			for (const current of constructors) {
				let history = patchees.get(current.name);
				if (history == null) {
					history = [];
					patchees.set(current.name, history);
				}

				for (const old of history) {
					// Patch static state into current
					assign(current, old,
						type => type !== 'function'
					);

					// Patch static methods into old
					assign(old, current,
						type => type === 'function'
					);

					// Patch regular methods into old
					assign(old.prototype, current.prototype,
						type => type === 'function'
					);

					// Patch prototype into old
					Object.setPrototypeOf(
						old.prototype,
						Object.getPrototypeOf(current.prototype)
					);
				}

				history.push(current);
			}
		}
	};
}

function patchExports(mod: NodeModule) {
	if (isPlainObject(mod.exports)) {
		for (const key of Object.getOwnPropertyNames(mod.exports)) {
			const xport = mod.exports[key];
			if (isConstructorLike(xport)) {
				mod.hot!.patch(xport);
			}
		}
	} else if (isConstructorLike(mod.exports)) {
		mod.hot!.patch(mod.exports);
	}
}


function configure(opts: Options) {
	Object.assign(_cfg, opts);
}

export { configure };

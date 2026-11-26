// fileproxy: hub-backed store implementing the same interface as createStore in
// ./store.js (read/write/update/all/describe). Used when config.fileProxy === 'hub'.
//
// Design constraints (docs/DESIGN-v2.md §3.2):
// - The hub is the concurrency chokepoint: every instance writes through it under
//   CAS revision control, so this module does NOT need the local file lock.
// - update(mutator) does read → run mutator locally → CAS PUT, retrying on
//   revision-conflict with backoff. After 3 attempts it surfaces the conflict.
// - Never silently fall back: if the hub is unreachable the error propagates
//   (hub-unavailable); the manager decides whether to fail fast.
import { randomUUID } from 'node:crypto';
import { ConnectorError } from './errors.js';

const CAS_ATTEMPTS = 3;
const RETRY_DELAY_MS = [0, 150, 450];

function sleep(ms) {
    if (ms <= 0) return Promise.resolve();
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Normalize a document the same way lib/store.js does on read, so a mutator sees
// the same shapes regardless of whether the store is local or proxied.
function salvage(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { version: 2, todos: [], trash: [] };
    }
    const version = typeof value.version === 'number' ? value.version : 2;
    const todos = Array.isArray(value.todos)
        ? value.todos.filter(item => item !== null && typeof item === 'object' && !Array.isArray(item) && typeof item.id === 'string' && item.id !== '')
        : [];
    const trash = Array.isArray(value.trash) ? value.trash.filter(item => item !== null && typeof item === 'object' && !Array.isArray(item)) : [];
    return { version, todos, trash };
}

export function createFileProxy({ hubClient, logger, name = 'todo-store' }) {
    if (!hubClient || typeof hubClient.readFile !== 'function' || typeof hubClient.putFile !== 'function') {
        throw new ConnectorError('invalid-request', 'createFileProxy 需要一个实现了 readFile/putFile 的 hub 客户端');
    }

    let revision = null;      // last known revision, refreshed on every read
    let chain = Promise.resolve();
    let busy = false;
    let knownRevision = null; // revision observed before our own writes (external-change detection)
    let externalChanges = 0;

    async function fetchDocument() {
        const result = await hubClient.readFile(name);
        const doc = salvage(result.doc ?? result);
        const nextRevision = typeof result.revision === 'number' ? result.revision : 0;
        if (knownRevision !== null && nextRevision !== knownRevision) {
            externalChanges += 1;
        }
        knownRevision = nextRevision;
        revision = nextRevision;
        return doc;
    }

    async function writeDocument(doc, expectedRevision) {
        const result = await hubClient.putFile(name, doc, expectedRevision);
        const nextRevision = typeof result.revision === 'number' ? result.revision : expectedRevision + 1;
        if (knownRevision !== null && nextRevision !== knownRevision + 1) {
            externalChanges += 1;
        }
        knownRevision = nextRevision;
        revision = nextRevision;
        return nextRevision;
    }

    async function updateOnce(mutator) {
        const doc = await fetchDocument();
        const outcome = await mutator(doc);
        if (!outcome || !Array.isArray(outcome.next)) {
            // No change requested: same contract as the local store (no write).
            return { result: outcome?.result ?? null };
        }
        const nextDoc = {
            version: outcome.version ?? doc.version ?? 2,
            todos: outcome.next,
            trash: outcome.trash ?? doc.trash ?? [],
        };
        const nextRevision = await writeDocument(nextDoc, revision);
        return { result: outcome.result ?? null, revision: nextRevision };
    }

    function update(mutator) {
        if (typeof mutator !== 'function') {
            return Promise.reject(new ConnectorError('invalid-request', 'update 需要一个函数'));
        }
        if (busy) {
            return Promise.reject(new ConnectorError('internal', 'store.update 不能在 mutator 里嵌套调用'));
        }
        const run = chain.then(async () => {
            busy = true;
            try {
                let lastError = null;
                for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
                    await sleep(RETRY_DELAY_MS[attempt] ?? 0);
                    try {
                        return await updateOnce(mutator);
                    } catch (error) {
                        const reason = error instanceof ConnectorError ? error.reason : '';
                        if (reason === 'revision-conflict') {
                            lastError = error;
                            continue;
                        }
                        throw error;
                    }
                }
                throw lastError ?? new ConnectorError('revision-conflict', 'revision 冲突，重试次数用尽');
            } finally {
                busy = false;
            }
        });
        chain = run.then(() => undefined, () => undefined);
        return run;
    }

    return {
        kind: 'hub-proxy',
        name,
        hubClient,
        async read() {
            const run = chain.then(fetchDocument);
            chain = run.then(() => undefined, () => undefined);
            return run;
        },
        async write(doc) {
            return update(() => ({ next: doc.todos ?? [], trash: doc.trash ?? [], version: doc.version ?? 2 }));
        },
        update,
        async all() {
            const doc = await fetchDocument();
            return doc.todos;
        },
        async describe() {
            const doc = await fetchDocument();
            return {
                kind: 'hub-proxy',
                name,
                todos: doc.todos.length,
                schemaVersion: doc.version,
                revision,
                externalChanges,
            };
        },
    };
}

// Fresh correlation id per update, useful in hub run logs.
export function newCorrelationId() {
    return randomUUID().replace(/-/g, '').slice(0, 12);
}

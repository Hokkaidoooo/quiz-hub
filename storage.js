/* 学习记录共享存储：严格读取、变更合并及跨标签页串行提交。 */
(function () {
  'use strict';
  const LOCK_NAME = 'quizhub:storage:v1';
  const stores = new Map();
  const options = Object.assign({ warnBeforeUnload: true }, window.QUIZ_STORAGE_OPTIONS);

  class StorageError extends Error {
    constructor(message, key, cause) {
      super(message, { cause });
      this.name = 'QuizStorageError';
      this.key = key;
    }
  }
  class ConflictError extends StorageError {
    constructor(key, field) {
      super('另一页面已修改相同记录，本页内容已保留。请在备份与恢复中选择保留的版本。', key);
      this.name = 'QuizStorageConflictError';
      this.field = field;
    }
  }
  const clone = value => value === undefined ? undefined : structuredClone(value);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  function equal(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
  }
  function validate(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new TypeError('记录包含不允许的属性');
      validate(child);
    }
  }
  function parse(raw, key) {
    try {
      const value = JSON.parse(raw);
      validate(value);
      return value;
    } catch (error) {
      throw new StorageError('本地记录无法读取，已保留原始内容。请先导出备份，再恢复有效记录。', key, error);
    }
  }
  function read(key, empty, normalize, storage = localStorage) {
    let raw;
    try { raw = storage.getItem(key); }
    catch (error) { throw new StorageError('浏览器不允许读取本地记录。', key, error); }
    const value = raw === null ? empty() : parse(raw, key);
    if (!object(value)) throw new StorageError('本地记录格式不正确，已保留原始内容。', key);
    try {
      const normalized = normalize(clone(value));
      if (!object(normalized)) throw new TypeError('记录必须为对象');
      validate(normalized);
      return normalized;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError('本地记录格式不正确，已停止写入。', key, error);
    }
  }

  function merge(base, local, remote, config, field = '') {
    if (equal(local, base)) return clone(remote);
    if (equal(remote, base) || equal(local, remote)) return clone(local);
    if (config.overwritePaths.some(path => field === path || field.startsWith(path + '.'))) return clone(local);
    if (config.setPaths.includes(field)) {
      if (![base, local, remote].every(value => value === undefined || Array.isArray(value))) throw new ConflictError(config.key, field);
      const before = base || [];
      const after = local || [];
      const removed = before.filter(value => !after.includes(value));
      const added = after.filter(value => !before.includes(value));
      return [...new Set([...(remote || []).filter(value => !removed.includes(value)), ...added])];
    }
    if (config.atomicPaths.some(pattern => {
      const expected = pattern.split('.');
      const actual = field.split('.');
      return actual.length === expected.length && expected.every((part, index) => part === '*' || part === actual[index]);
    })) {
      if (config.keepLocal) return clone(local);
      throw new ConflictError(config.key, field);
    }
    if ((object(base) || base === undefined) && object(local) && object(remote)) {
      const result = {};
      const keys = new Set([...Object.keys(base || {}), ...Object.keys(local), ...Object.keys(remote)]);
      for (const key of keys) {
        const next = merge(base?.[key], local[key], remote[key], config, field ? field + '.' + key : key);
        if (next !== undefined) result[key] = next;
      }
      return result;
    }
    if (config.keepLocal) return clone(local);
    throw new ConflictError(config.key, field);
  }

  function locked(action) {
    if (!navigator.locks?.request) {
      return Promise.reject(new StorageError('当前浏览器不支持安全保存。请使用新版浏览器或 HTTPS 页面，并先导出本页记录。', ''));
    }
    return navigator.locks.request(LOCK_NAME, { mode: 'exclusive' }, action);
  }
  function notify(key, source) {
    const item = stores.get(key);
    if (item && item !== source) item.refresh();
    window.dispatchEvent(new CustomEvent('quizstoragechange', { detail: { key } }));
  }
  function open(key, settings = {}) {
    if (stores.has(key)) return stores.get(key);
    if (typeof key !== 'string' || !key) throw new TypeError('存储键不能为空');
    const config = Object.assign({ key, empty: () => ({}), normalize: value => value, overwritePaths: [], setPaths: [], atomicPaths: [] }, settings);
    let base = read(key, config.empty, config.normalize);
    let value = clone(base);
    let lastError = null;
    let inflight = null;
    let disposed = false;
    const listeners = new Set();
    function emit(type, error) {
      for (const listener of listeners) {
        try { listener({ type, value: clone(value), error }); }
        catch (renderError) {
          // 数据提交与界面更新独立：渲染失败不能把已保存事务报告为写入失败。
          console.error('记录已更新，但界面刷新失败。', renderError);
          window.dispatchEvent(new CustomEvent('quizstorageviewerror', { detail: { key, error: renderError } }));
        }
      }
      window.dispatchEvent(new CustomEvent('quizstoragechange', { detail: { key, type, error: error?.message } }));
    }
    const store = {
      key,
      get value() { return clone(value); },
      get pending() { return !equal(base, value); },
      get error() { return lastError; },
      update(mutator) {
        if (disposed) return Promise.reject(new StorageError('记录已关闭，请重新进入题库。', key));
        const next = clone(value);
        mutator(next);
        validate(next);
        value = config.normalize(next);
        emit('local');
        return store.flush();
      },
      flush(keepLocal = false) {
        if (inflight) return inflight;
        if (!store.pending) return Promise.resolve(store.value);
        inflight = (async () => {
          do {
            await locked(() => {
              const latest = read(key, config.empty, config.normalize);
              const merged = config.normalize(merge(base, value, latest, { ...config, keepLocal }));
              try { localStorage.setItem(key, JSON.stringify(merged)); }
              catch (error) { throw new StorageError('浏览器无法保存记录，本页内容已保留。请导出备份后重试。', key, error); }
              base = clone(merged);
              value = clone(merged);
              lastError = null;
              emit('saved');
              notify(key, store);
            });
          } while (store.pending);
          return store.value;
        })().catch(error => {
          lastError = error;
          emit('error', error);
          throw error;
        }).finally(() => { inflight = null; });
        return inflight;
      },
      refresh() {
        try {
          const latest = read(key, config.empty, config.normalize);
          const combined = merge(base, value, latest, config);
          base = clone(latest);
          value = config.normalize(combined);
          lastError = null;
          emit('external');
          return store.value;
        } catch (error) {
          lastError = error;
          emit('error', error);
          return null;
        }
      },
      async resolve(choice) {
        if (choice === 'keep-local') return store.flush(true);
        if (choice !== 'use-saved') throw new TypeError('请选择保留版本');
        if (inflight) await inflight.catch(() => {});
        base = read(key, config.empty, config.normalize);
        value = clone(base);
        lastError = null;
        emit('external');
        return store.value;
      },
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      dispose() {
        if (store.pending) return false;
        disposed = true;
        listeners.clear();
        stores.delete(key);
        return true;
      },
    };
    stores.set(key, store);
    return store;
  }

  async function transaction(entries, settings = {}) {
    if (!Array.isArray(entries) || !entries.length) return;
    const seen = new Set();
    await locked(() => {
      const changes = entries.map(entry => {
        const storage = entry.store || localStorage;
        if (storage !== localStorage && storage !== sessionStorage) throw new TypeError('不支持的存储位置');
        const identity = `${storage === localStorage ? 'local' : 'session'}:${entry.key}`;
        if (seen.has(identity)) throw new TypeError('同一事务包含重复存储键');
        seen.add(identity);
        if (Object.hasOwn(entry, 'raw') === Object.hasOwn(entry, 'value')) throw new TypeError('每项必须明确提供raw或value');
        const previous = storage.getItem(entry.key);
        if (Object.hasOwn(entry, 'expectedRaw') && previous !== entry.expectedRaw) throw new ConflictError(entry.key, '');
        if (Object.hasOwn(entry, 'value')) {
          validate(entry.value);
          if (previous !== null && !settings.allowCorrupt) parse(previous, entry.key);
        }
        const next = Object.hasOwn(entry, 'raw') ? entry.raw : JSON.stringify(entry.value);
        if (next !== null && typeof next !== 'string') throw new TypeError('写入内容必须是JSON值或原始文本');
        return { key: entry.key, storage, previous, next };
      });
      const written = [];
      try {
        for (const change of changes) {
          if (change.next === null) change.storage.removeItem(change.key);
          else change.storage.setItem(change.key, change.next);
          written.push(change);
        }
      } catch (error) {
        const failures = [];
        for (const change of written.reverse()) {
          try {
            if (change.previous === null) change.storage.removeItem(change.key);
            else change.storage.setItem(change.key, change.previous);
          } catch (rollbackError) { failures.push(rollbackError); }
        }
        if (failures.length) throw new AggregateError([error, ...failures], '写入失败，部分记录未能回滚。请保留备份并查看当前记录。');
        throw new StorageError('记录未能保存，已恢复修改前的内容。', '', error);
      }
      for (const change of changes) if (change.storage === localStorage) notify(change.key);
    });
  }

  window.addEventListener('storage', event => {
    if (event.storageArea !== localStorage) return;
    if (event.key === null) for (const store of stores.values()) store.refresh();
    else stores.get(event.key)?.refresh();
  });
  window.addEventListener('beforeunload', event => {
    if (!options.warnBeforeUnload || ![...stores.values()].some(store => store.pending)) return;
    event.preventDefault();
    event.returnValue = '';
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    for (const store of stores.values()) {
      if (store.pending && !(store.error instanceof ConflictError)) store.flush().catch(error => console.error(error.message));
    }
  });
  window.QuizStorage = Object.freeze({
    open, transaction, parse, equal, StorageError, ConflictError,
    snapshot: () => [...stores.values()].map(store => ({ key: store.key, value: store.value, pending: store.pending, error: store.error?.message || '', conflict: store.error instanceof ConflictError })),
    get: key => stores.get(key),
    options,
  });
})();

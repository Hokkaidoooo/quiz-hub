/* 六套题库的学习记录备份与恢复，不包含接口密钥或服务商配置。 */
(function () {
  'use strict';
  const VERSION = 1;
  const MAX_BYTES = 50 * 1024 * 1024;
  const scriptUrl = document.currentScript.src;
  const hubBanks = (window.QUIZ_BANKS || []).filter(bank => bank.data);
  const names = new Map(hubBanks.map(bank => [bank.storageKey || `quizhub_${bank.id}_v1`, bank.name]));
  const kinds = new Map([...names.keys()].map(key => [key, 'hub']));
  for (const [suffix, kind] of [['statuses', 'statuses'], ['notes', 'notes'], ['preferences', 'preferences']]) {
    const key = `mvt300:v1:${suffix}`;
    names.set(key, `中值定理 · ${{ statuses: '掌握状态', notes: '笔记', preferences: '阅读位置' }[suffix]}`);
    kinds.set(key, kind);
  }
  for (const key of ['quizhub:ai:v1:threads', 'mvt300:ai:v1:threads']) {
    names.set(key, key.startsWith('quizhub') ? 'AI 讲解记录' : '中值定理 AI 记录');
    kinds.set(key, 'threads');
  }
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const clone = value => structuredClone(value);
  let dialog;
  let importData;
  let currentPlan;
  let lastFocus;

  function validateRecord(key, value) {
    return window.QuizRecordSchema.validate(value, kinds.get(key));
  }
  function allowed(key, includeChats) { return kinds.has(key) && (includeChats || kinds.get(key) !== 'threads'); }
  function exportData({ includeChats = false } = {}) {
    const entries = [];
    for (const key of kinds.keys()) {
      if (!allowed(key, includeChats)) continue;
      const raw = localStorage.getItem(key);
      if (raw !== null) entries.push({ key, raw });
    }
    const pending = window.QuizStorage.snapshot().filter(item => item.pending && allowed(item.key, includeChats)).map(({ key, value }) => ({ key, value }));
    return { app: 'quiz-hub', version: VERSION, exportedAt: new Date().toISOString(), entries, pending };
  }
  function decodeBackup(payload, usePending = false) {
    if (!object(payload)) throw new Error('备份不是有效对象。');
    if (payload.app === '中值场 300 题' && payload.version === 1) {
      const entries = ['statuses', 'notes', 'preferences'].filter(field => payload[field] !== undefined).map(field => ({ key: `mvt300:v1:${field}`, raw: JSON.stringify(payload[field]) }));
      payload = { app: 'quiz-hub', version: VERSION, entries };
    }
    if (payload.app !== 'quiz-hub' || payload.version !== VERSION || !Array.isArray(payload.entries)) throw new Error('备份格式或版本不匹配。');
    const result = new Map();
    const pending = new Map();
    for (const item of payload.pending || []) {
      if (!object(item) || !kinds.has(item.key) || pending.has(item.key)) throw new Error('本页待保存记录格式不正确。');
      pending.set(item.key, validateRecord(item.key, item.value));
    }
    for (const entry of payload.entries) {
      if (!object(entry) || !kinds.has(entry.key) || typeof entry.raw !== 'string' || result.has(entry.key)) throw new Error('备份包含未知或重复记录，导入已停止。');
      const value = usePending && pending.has(entry.key) ? pending.get(entry.key) : window.QuizStorage.parse(entry.raw, entry.key);
      const validated = validateRecord(entry.key, value);
      result.set(entry.key, ['statuses', 'notes'].includes(kinds.get(entry.key)) ? window.QuizRecordSchema.canonicalMvtRecords(validated) : validated);
    }
    if (usePending) for (const [key, value] of pending) result.set(key, ['statuses', 'notes'].includes(kinds.get(key)) ? window.QuizRecordSchema.canonicalMvtRecords(value) : value);
    if (!result.size) throw new Error('备份中没有可恢复的学习记录。');
    return result;
  }
  function mergeMap(current, incoming, preferIncoming, conflicts) {
    const result = clone(current || {});
    for (const [key, value] of Object.entries(incoming || {})) {
      if (!Object.hasOwn(result, key)) result[key] = clone(value);
      else if (!window.QuizStorage.equal(result[key], value)) {
        conflicts.count += 1;
        if (preferIncoming) result[key] = clone(value);
      }
    }
    return result;
  }
  function mergeRecord(key, current, incoming, mode, conflicts) {
    if (mode === 'replace') return clone(incoming);
    const preferIncoming = mode === 'incoming';
    if (kinds.get(key) !== 'hub') return mergeMap(current, incoming, preferIncoming, conflicts);
    const result = { ...clone(current) };
    for (const field of ['done', 'notes', 'drafts']) result[field] = mergeMap(current[field], incoming[field], preferIncoming, conflicts);
    result.wrong = [...new Set([...(current.wrong || []), ...(incoming.wrong || [])])];
    if (!current.last || preferIncoming) result.last = clone(incoming.last ?? current.last ?? null);
    if (current.retiredRecords || incoming.retiredRecords) {
      result.retiredRecords = mergeRecord(key, current.retiredRecords || {}, incoming.retiredRecords || {}, mode, conflicts);
    }
    for (const field of Object.keys(incoming)) if (!Object.hasOwn(result, field)) result[field] = clone(incoming[field]);
    return result;
  }
  function planImport(payload, { mode = 'current', usePending = false, replaceCorrupt = false } = {}) {
    if (!['current', 'incoming', 'replace'].includes(mode)) throw new Error('请选择有效的冲突处理方式。');
    const values = decodeBackup(payload, usePending);
    const changes = [];
    const rows = [];
    const conflicts = { count: 0 };
    for (const [key, incoming] of values) {
      if (window.QuizStorage.get(key)?.pending) throw new Error(`${names.get(key)}仍有本页待保存内容，请先导出并处理待保存记录。`);
      const expectedRaw = localStorage.getItem(key);
      let current = {};
      let corrupted = false;
      if (expectedRaw !== null) {
        try { current = validateRecord(key, window.QuizStorage.parse(expectedRaw, key)); }
        catch (error) {
          if (!replaceCorrupt) throw new Error(`${names.get(key)}的现有记录损坏。先导出当前备份，再勾选“允许用有效备份替换损坏记录”。`);
          corrupted = true;
        }
      }
      const value = mergeRecord(key, current, incoming, mode, conflicts);
      changes.push({ key, value, expectedRaw });
      rows.push({ key, name: names.get(key), records: kinds.get(key) === 'hub' ? Object.keys(incoming.done || {}).length : Object.keys(incoming).length, notes: kinds.get(key) === 'hub' ? Object.keys(incoming.notes || {}).length : null, corrupted });
    }
    return { changes, rows, conflicts: conflicts.count, mode, replaceCorrupt };
  }
  async function applyImport(plan) {
    if (!plan || !Array.isArray(plan.changes)) throw new Error('请先预览备份。');
    for (const change of plan.changes) {
      if (!kinds.has(change.key)) throw new Error('不允许恢复此存储键。');
      validateRecord(change.key, change.value);
      if (window.QuizStorage.get(change.key)?.pending) throw new Error('预览后产生了新草稿，请先保存再导入。');
    }
    await window.QuizStorage.transaction(plan.changes, { allowCorrupt: plan.replaceCorrupt });
    window.dispatchEvent(new CustomEvent('quizbackuprestored', { detail: { keys: plan.changes.map(change => change.key) } }));
  }
  function download(payload) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `刷题中心备份-${new Date().toISOString().replaceAll(':', '-').slice(0, 19)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function status(message, error = false) {
    const node = dialog.querySelector('#backup-status');
    node.textContent = message;
    node.dataset.error = String(error);
  }
  function handle(action) {
    return async () => {
      try { await action(); }
      catch (error) { status(error.message, true); }
    };
  }
  function pendingRows() {
    const container = dialog.querySelector('#backup-pending');
    container.replaceChildren();
    const pending = window.QuizStorage.snapshot().filter(item => item.pending);
    if (!pending.length) return;
    const intro = document.createElement('p');
    intro.textContent = '以下内容尚未保存。请先导出备份，再重试或选择要保留的版本。';
    container.append(intro);
    for (const item of pending) {
      const row = document.createElement('div');
      row.className = 'backup-pending-row';
      const title = document.createElement('strong');
      title.textContent = names.get(item.key) || '当前记录';
      const message = document.createElement('p');
      message.textContent = item.error || '正在等待保存';
      row.append(title, message);
      const actions = item.conflict ? [['保留本页修改', 'keep-local'], ['使用已保存版本', 'use-saved']] : [['重试保存', 'retry']];
      for (const [text, choice] of actions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = text;
        button.addEventListener('click', handle(async () => {
          if (choice !== 'retry' && !confirm(`${text}：相同记录的另一版本将不再作为当前版本。请确认已导出备份。`)) return;
          const store = window.QuizStorage.get(item.key);
          if (choice === 'retry') await store.flush();
          else await store.resolve(choice);
          pendingRows();
          status('记录已更新。');
        }));
        row.append(button);
      }
      container.append(row);
    }
  }
  function preview() {
    currentPlan = null;
    dialog.querySelector('#backup-apply').disabled = true;
    if (!importData) return;
    currentPlan = planImport(importData, {
      mode: dialog.querySelector('#backup-mode').value,
      usePending: dialog.querySelector('#backup-use-pending').checked,
      replaceCorrupt: dialog.querySelector('#backup-corrupt').checked,
    });
    const summary = dialog.querySelector('#backup-preview');
    summary.replaceChildren();
    for (const row of currentPlan.rows) {
      const line = document.createElement('li');
      line.textContent = `${row.name}：${row.records} 条记录${row.notes === null ? '' : `、${row.notes} 条笔记`}${row.corrupted ? '（替换损坏记录）' : ''}`;
      summary.append(line);
    }
    status(`检测到 ${currentPlan.conflicts} 处不同版本。请确认合并方式后导入。`);
    dialog.querySelector('#backup-apply').disabled = false;
  }
  function build() {
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = new URL('backup.css', scriptUrl).href;
    document.head.append(stylesheet);
    dialog = document.createElement('dialog');
    dialog.id = 'quiz-backup-dialog';
    dialog.setAttribute('aria-labelledby', 'backup-title');
    dialog.innerHTML = `<div class="backup-heading"><h2 id="backup-title">备份与恢复</h2><button type="button" id="backup-close" aria-label="关闭备份与恢复">关闭</button></div>
      <p>六套题库的进度、笔记和作答草稿保存在当前浏览器。导出备份后，可在另一台设备或线上页面恢复。</p>
      <section><h3>导出当前记录</h3><label class="backup-check"><input type="checkbox" id="backup-chats">同时导出 AI 对话</label><p class="backup-hint">备份不含 API Key 或服务商配置；尚未保存的本页内容也会保留在备份中。</p><button type="button" id="backup-export">导出备份</button></section>
      <section id="backup-pending" aria-label="待保存记录"></section>
      <section><h3>从备份恢复</h3><label for="backup-file">选择备份文件</label><input type="file" id="backup-file" accept=".json,application/json">
      <label for="backup-mode">相同题目有不同记录时</label><select id="backup-mode"><option value="current">合并，保留当前版本</option><option value="incoming">合并，采用备份版本</option><option value="replace">替换备份中包含的题库记录</option></select>
      <label class="backup-check"><input type="checkbox" id="backup-use-pending">采用备份中“尚未保存”的本页版本</label>
      <label class="backup-check"><input type="checkbox" id="backup-corrupt">允许用有效备份替换损坏记录（请先导出当前备份）</label>
      <ul id="backup-preview"></ul><button type="button" id="backup-apply" disabled>确认导入</button></section>
      <p id="backup-status" role="status" aria-live="polite"></p>`;
    document.body.append(dialog);
    dialog.querySelector('#backup-close').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => lastFocus?.focus());
    dialog.querySelector('#backup-export').addEventListener('click', handle(() => {
      download(exportData({ includeChats: dialog.querySelector('#backup-chats').checked }));
      status('备份文件已生成。请妥善保存，其中可能包含私人笔记。');
    }));
    dialog.querySelector('#backup-file').addEventListener('change', handle(async () => {
      importData = null;
      currentPlan = null;
      dialog.querySelector('#backup-apply').disabled = true;
      dialog.querySelector('#backup-preview').replaceChildren();
      const file = dialog.querySelector('#backup-file').files[0];
      if (!file) return;
      if (file.size > MAX_BYTES) throw new Error('备份超过 50MB，请检查是否选择了正确文件。');
      importData = window.QuizStorage.parse(await file.text(), 'backup-file');
      preview();
    }));
    for (const id of ['backup-mode', 'backup-use-pending', 'backup-corrupt']) dialog.querySelector('#' + id).addEventListener('change', handle(preview));
    dialog.querySelector('#backup-apply').addEventListener('click', handle(async () => {
      const button = dialog.querySelector('#backup-apply');
      button.disabled = true;
      try {
        await applyImport(currentPlan);
        currentPlan = null;
        status('备份已导入，学习记录已更新。');
        pendingRows();
      } catch (error) {
        currentPlan = null;
        throw error;
      }
    }));
  }
  function open() {
    if (!dialog) build();
    lastFocus = document.activeElement;
    pendingRows();
    if (!dialog.open) dialog.showModal();
  }
  window.QuizBackup = Object.freeze({ open, exportData, planImport, applyImport });
})();

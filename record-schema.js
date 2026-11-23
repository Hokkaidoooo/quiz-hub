/* 学习记录契约：页面读取与备份导入共用校验，保留未知字段和题号。 */
(function () {
  'use strict';

  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const own = (value, field) => Object.hasOwn(value, field);
  const modes = new Set(['wrong', 'subject', 'chapter', 'notes']);
  const reviews = new Set(['pending', 'mastered', 'revisit']);
  const statuses = new Set(['mastered', 'review']);

  function invalid(field) {
    throw new TypeError(`学习记录的 ${field} 格式无效，已保留原记录，写入或导入已停止。`);
  }

  function requireObject(value, field) {
    if (!object(value)) invalid(field);
  }

  function optional(value, field, valid, prefix) {
    if (own(value, field) && !valid(value[field])) invalid(`${prefix}.${field}`);
  }

  function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
  function text(value) { return typeof value === 'string'; }
  function questionId(value) { return text(value) || (Number.isInteger(value) && value >= 0); }
  function isMvtQuestionKey(value) {
    const match = /^q(\d{1,3})$/.exec(value);
    return match !== null && Number(match[1]) >= 1 && Number(match[1]) <= 300;
  }

  function validatePosition(value, field) {
    if (value === null) return;
    requireObject(value, field);
    if (!modes.has(value.mode)) invalid(`${field}.mode`);
    optional(value, 'subject', text, field);
    optional(value, 'chapterKey', text, field);
    optional(value, 'questionId', questionId, field);
    optional(value, 'index', item => Number.isInteger(item) && item >= 0, field);
  }

  function validateResult(value, field) {
    requireObject(value, field);
    const choice = Array.isArray(value.choice) ? value.choice.join('') : value.choice;
    if (!text(choice) || !/^(?:[A-E]+|REVIEWED)$/i.test(choice)) invalid(`${field}.choice`);
    if (Array.isArray(value.choice) && value.choice.some(part => !text(part) || !/^[A-E]$/i.test(part))) invalid(`${field}.choice`);
    optional(value, 'response', text, field);
    optional(value, 'review', item => reviews.has(item), field);
    optional(value, 'correct', item => item === null || typeof item === 'boolean', field);
    optional(value, 'ts', finite, field);
  }

  function validateHub(value, field = 'hub') {
    requireObject(value, field);
    for (const name of ['done', 'notes', 'drafts']) {
      if (own(value, name)) requireObject(value[name], `${field}.${name}`);
    }
    if (own(value, 'wrong') && (!Array.isArray(value.wrong) || value.wrong.some(id => !questionId(id)))) invalid(`${field}.wrong`);
    if (own(value, 'last')) validatePosition(value.last, `${field}.last`);
    for (const [id, result] of Object.entries(value.done || {})) validateResult(result, `${field}.done.${id}`);
    for (const [id, note] of Object.entries(value.notes || {})) {
      const target = `${field}.notes.${id}`;
      requireObject(note, target);
      if (!text(note.text)) invalid(`${target}.text`);
      optional(note, 'updatedAt', finite, target);
    }
    for (const [id, draft] of Object.entries(value.drafts || {})) if (!text(draft)) invalid(`${field}.drafts.${id}`);
    if (own(value, 'retiredRecords')) validateHub(value.retiredRecords, `${field}.retiredRecords`);
  }

  function validatePreferences(value) {
    requireObject(value, 'preferences');
    optional(value, 'currentId', item => Number.isInteger(item) && item >= 1 && item <= 300, 'preferences');
    optional(value, 'filter', item => ['all', 'todo', 'mastered', 'review'].includes(item), 'preferences');
    optional(value, 'theme', item => ['light', 'dark'].includes(item), 'preferences');
    optional(value, 'chapter', text, 'preferences');
    optional(value, 'methodId', text, 'preferences');
    optional(value, 'notesOpen', item => typeof item === 'boolean', 'preferences');
  }

  function validateThreads(value) {
    requireObject(value, 'threads');
    for (const [id, thread] of Object.entries(value)) {
      const field = `threads.${id}`;
      requireObject(thread, field);
      if (!Array.isArray(thread.messages)) invalid(`${field}.messages`);
      optional(thread, 'updatedAt', finite, field);
      for (const [index, message] of thread.messages.entries()) {
        const target = `${field}.messages.${index}`;
        requireObject(message, target);
        if (!['user', 'assistant'].includes(message.role)) invalid(`${target}.role`);
        if (!text(message.content)) invalid(`${target}.content`);
      }
    }
  }

  function validate(value, kind) {
    if (kind === 'hub') validateHub(value);
    else if (kind === 'preferences') validatePreferences(value);
    else if (kind === 'threads') validateThreads(value);
    else if (kind === 'statuses' || kind === 'notes') {
      requireObject(value, kind);
      for (const [id, row] of Object.entries(value)) {
        if (!isMvtQuestionKey(id)) continue;
        if (kind === 'statuses' ? !statuses.has(row) : !text(row)) invalid(`${kind}.${id}`);
      }
    } else throw new TypeError(`未知学习记录类型：${kind}`);
    return value;
  }

  function mvtQuestionKey(id) {
    const number = Number(id);
    if (!Number.isInteger(number) || number < 1 || number > 300) throw new TypeError('中值定理题号必须为1—300。');
    return `q${String(number).padStart(3, '0')}`;
  }

  function canonicalMvtRecords(value) {
    const result = structuredClone(value);
    for (const [key, row] of Object.entries(value)) {
      const match = /^q(\d{1,3})$/.exec(key);
      const number = match ? Number(match[1]) : 0;
      if (number < 1 || number > 300) continue;
      const canonical = mvtQuestionKey(number);
      if (!Object.hasOwn(result, canonical)) result[canonical] = structuredClone(row);
    }
    return result;
  }

  window.QuizRecordSchema = Object.freeze({ validate, mvtQuestionKey, canonicalMvtRecords });
})();

/* ============================================================
 * TopData · 图标弹窗
 * 展示工作流列表：运行 / 重命名 / 进入编辑器（全页标签页）。
 * 另提供"可视化选择元素"入口：在当前网页注入可拖动选择浮层。
 * 运行逻辑统一交给编辑器页执行（弹窗关闭即销毁，不适合长任务）。
 * ============================================================ */

'use strict';

const $ = (sel) => document.querySelector(sel);
let state = null;

init();

async function init() {
  state = await WCAStore.load();
  render();
  $('#newBtn').addEventListener('click', onNew);
  $('#pickBtn').addEventListener('click', onPick);
  $('#openHome').addEventListener('click', (e) => {
    e.preventDefault();
    openEditor(null);
  });
}

function showMsg(text) {
  const el = $('#popMsg');
  el.textContent = text;
  el.classList.remove('hidden');
}

/* 在当前活动网页注入选择浮层，随后关闭弹窗让用户看到页面 */
async function onPick() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !/^https?:/i.test(tab.url || '')) {
    showMsg('当前标签页不是普通网页，无法选择元素。请切换到 http/https 页面后重试。');
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: wcaInspector,
      args: [{ mode: 'inspect' }],
    });
  } catch (e) {
    showMsg('无法在当前页面注入选择面板：' + e.message);
    return;
  }
  window.close();
}

/* 打开编辑器标签页；id 为空打开主页，autorun 时自动运行 */
function openEditor(id, autorun) {
  let url = 'editor/editor.html';
  if (id) url += '?id=' + encodeURIComponent(id) + (autorun ? '&autorun=1' : '');
  chrome.tabs.create({ url: chrome.runtime.getURL(url) });
  window.close();
}

async function onNew() {
  const wf = WCAStore.makeWorkflow();
  state.workflows.push(wf);
  await WCAStore.save(state);
  openEditor(wf.id);
}

const ICON_PLAY = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>';
const ICON_MORE = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';

function render() {
  const list = $('#wfList');
  list.innerHTML = '';
  const wfs = [...state.workflows].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  $('#wfEmpty').classList.toggle('hidden', wfs.length > 0);

  wfs.forEach((wf) => {
    const row = document.createElement('div');
    row.className = 'wf-row';
    row.innerHTML = `
      <div class="wf-main" title="点击进入编辑器">
        <div class="wf-name">${escapeHtml(wf.name || '未命名工作流')}</div>
        <div class="wf-meta">${relativeTime(wf.updatedAt)}</div>
      </div>
      <button class="wf-icon" data-op="run" title="运行工作流">${ICON_PLAY}</button>
      <button class="wf-icon" data-op="more" title="更多操作">${ICON_MORE}</button>
      <div class="wf-menu hidden">
        <button data-op="rename">重命名</button>
        <button data-op="del" class="danger">删除</button>
      </div>`;

    row.querySelector('.wf-main').addEventListener('click', () => openEditor(wf.id));
    row.querySelector('[data-op="run"]').addEventListener('click', (e) => {
      e.stopPropagation();
      openEditor(wf.id, true);
    });
    row.querySelector('[data-op="more"]').addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = row.querySelector('.wf-menu');
      const willShow = menu.classList.contains('hidden');
      list.querySelectorAll('.wf-menu').forEach((m) => m.classList.add('hidden'));
      menu.classList.toggle('hidden', !willShow);
    });
    row.querySelector('[data-op="rename"]').addEventListener('click', () => {
      row.querySelector('.wf-menu').classList.add('hidden');
      startRename(row, wf);
    });
    row.querySelector('[data-op="del"]').addEventListener('click', (e) => onDelete(e.currentTarget, wf));
    list.appendChild(row);
  });
}

/* 删除：两次点击确认（popup 中 confirm 可能直接关闭弹窗） */
async function onDelete(btn, wf) {
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.textContent = '确认删除？';
    setTimeout(() => {
      if (!btn.isConnected) return;
      delete btn.dataset.armed;
      btn.textContent = '删除';
    }, 3000);
    return;
  }
  state.workflows = state.workflows.filter((w) => w.id !== wf.id);
  await WCAStore.save(state);
  render();
}

/* 相对时间 */
function relativeTime(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const min = 60 * 1000, hour = 60 * min, day = 24 * hour, month = 30 * day, year = 365 * day;
  if (diff < min) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < month) return `${Math.floor(diff / day)} 天前`;
  if (diff < year) return `${Math.floor(diff / month)} 个月前`;
  return `${Math.floor(diff / year)} 年前`;
}

/* 内联重命名（popup 中 window.prompt 不可用）：Enter/失焦保存，Esc 取消 */
function startRename(row, wf) {
  const nameEl = row.querySelector('.wf-name');
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = wf.name || '';
  input.maxLength = 50;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  input.addEventListener('click', (e) => e.stopPropagation());   // 避免冒泡触发进入编辑器

  let done = false;
  const commit = async (shouldSave) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (shouldSave && v && v !== wf.name) {
      wf.name = v;
      wf.updatedAt = Date.now();
      await WCAStore.save(state);
    }
    render();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit(true);
    else if (e.key === 'Escape') commit(false);
  });
  input.addEventListener('blur', () => commit(true));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

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

function render() {
  const list = $('#wfList');
  list.innerHTML = '';
  const wfs = [...state.workflows].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  $('#wfEmpty').classList.toggle('hidden', wfs.length > 0);

  wfs.forEach((wf) => {
    const item = document.createElement('div');
    item.className = 'wf-item';
    item.innerHTML = `
      <div class="wf-name" title="点击进入编辑器">${escapeHtml(wf.name || '未命名工作流')}</div>
      <div class="wf-ops">
        <button class="btn btn-primary" data-op="run">运行</button>
        <button class="btn" data-op="rename">重命名</button>
        <button class="btn" data-op="edit">编辑</button>
      </div>`;
    item.querySelector('.wf-name').addEventListener('click', () => openEditor(wf.id));
    item.querySelector('[data-op="run"]').addEventListener('click', () => openEditor(wf.id, true));
    item.querySelector('[data-op="edit"]').addEventListener('click', () => openEditor(wf.id));
    item.querySelector('[data-op="rename"]').addEventListener('click', () => startRename(item, wf));
    list.appendChild(item);
  });
}

/* 内联重命名（popup 中 window.prompt 不可用）：Enter/失焦保存，Esc 取消 */
function startRename(item, wf) {
  const nameEl = item.querySelector('.wf-name');
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = wf.name || '';
  input.maxLength = 50;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

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

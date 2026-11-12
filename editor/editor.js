/* ============================================================
 * 网页采集助手 · 编辑器 + 执行引擎（全页标签页形态）
 * 执行引擎运行在扩展页面内（而非 Service Worker），
 * 规避 MV3 Service Worker 长任务被回收的限制。
 *
 * 页面路由：
 *   editor.html                  → 工作流列表主页
 *   editor.html?id=xxx           → 编辑指定工作流
 *   editor.html?id=xxx&autorun=1 → 打开后立即运行（来自弹窗"运行"）
 * ============================================================ */

'use strict';

/* ---------- 常量 ---------- */

const NODE_TYPES = {
  openTab:      { label: '打开标签页', badge: '页', fixed: true },
  extract:      { label: '提取内容',   badge: '取' },
  list:         { label: '批量提取',   badge: '列' },
  image:        { label: '下载图片',   badge: '图' },
  loop:         { label: '循环开始',   badge: '循', block: true },
  loopEnd:      { label: '循环结束',   badge: '循', fixed: true, blockEnd: true },
  condition:    { label: '条件分支',   badge: '条', block: true },
  conditionEnd: { label: '条件结束',   badge: '条', fixed: true, blockEnd: true },
  assemble:     { label: '文章组装',   badge: '文', unique: true },
};

const DEFAULT_REGEX = () => ({ regexOn: false, regexPattern: '', regexFlags: 'g', regexRepl: '' });

const DEFAULTS = {
  openTab:  () => ({ url: '', openMode: 'new', extraWaitSec: 0, autoClose: false }),
  extract:  () => ({
    varName: '', selectorType: 'css', selector: '', extractType: 'text', attrName: '',
    multiMode: 'first', joinSep: '\n', waitSec: 5, onMissing: 'stop', ...DEFAULT_REGEX(),
  }),
  list:     () => ({
    varName: '', selectorType: 'css', selector: '', extractType: 'text', attrName: '', fields: [],
    pagingOn: false, nextSelector: '', nextSelectorType: 'css', maxPages: 5, pageWaitSec: 2,
    ...DEFAULT_REGEX(),
  }),
  image:    () => ({
    varName: '', sourceMode: 'selector', srcVar: '', selectorType: 'css', selector: '',
    attrName: 'src', refMode: 'local', onFail: 'stop', ...DEFAULT_REGEX(),
  }),
  loop:         () => ({ overVar: '', itemVar: 'item' }),
  loopEnd:      () => ({}),
  condition:    () => ({ sourceVar: '', operator: 'notEmpty', compareValue: '' }),
  conditionEnd: () => ({}),
  assemble: () => ({
    title: '',
    template: '# 文章标题\n\n在此编写正文，使用 {{变量名}} 引用前面节点提取的内容。\n集合变量可用 {{#each 列表名}}…{{/each}}。\n',
  }),
};

const VAR_NAME_RE = /^[一-龥A-Za-z0-9_]{1,50}$/;
const TEMPLATE_REF_RE = /\{\{\s*([^}]+?)\s*\}\}/g;
const EACH_BLOCK_RE = /\{\{#each\s+([^}]+?)\s*\}\}([\s\S]*?)\{\{\/each\}\}/g;
const CONDITION_OPS = [
  ['notEmpty', '不为空'],
  ['isEmpty', '为空'],
  ['equals', '等于'],
  ['notEquals', '不等于'],
  ['contains', '包含'],
  ['notContains', '不包含'],
  ['gt', '大于（数字）'],
  ['lt', '小于（数字）'],
];

/* 左侧节点库分组：[类型, 名称, 说明] */
const PALETTE_GROUPS = [
  { label: '数据采集', items: [
    ['extract', '提取内容', '文本 / 属性值'],
    ['list', '批量提取', '集合 / 字段映射'],
    ['image', '下载图片', '图片保存与引用'],
  ] },
  { label: '流程控制', items: [
    ['loop', '循环', '遍历集合变量'],
    ['condition', '条件分支', '按条件执行'],
  ] },
  { label: '结果输出', items: [
    ['assemble', '文章组装', '生成 Markdown'],
  ] },
];

const PALETTE_TYPES = new Set(PALETTE_GROUPS.reduce((acc, g) => acc.concat(g.items.map((it) => it[0])), []));

/* 画布尺寸：卡片等宽居中，嵌套按层缩进 */
const CANVAS_WIDTH = 760;
const CANVAS_CARD_WIDTH = 340;
const CANVAS_CARD_X = (CANVAS_WIDTH - CANVAS_CARD_WIDTH) / 2;
const CANVAS_NODE_GAP = 46;
const CANVAS_DEPTH_OFFSET = 44;
const CANVAS_START_Y = 78;

/* ---------- 状态 ---------- */

let state = null;              // 全量状态 { workflows, settings }，结构见 common/store.js
let workflow = null;           // 当前编辑的工作流（state.workflows 中的引用）
let settings = null;           // 全局设置（state.settings 的引用）
let selectedId = null;
let running = false;
let nodeStatus = {};           // nodeId -> idle|running|success|empty|failed|skipped
let invalidIds = new Set();    // 校验失败的节点
let lastMarkdown = null;
let lastTitle = '';
let lastMarkdowns = [];        // 多篇结果（循环内组装会产出多篇）
let resultIndex = 0;
let canvasScale = 1;
let canvasPan = { x: 0, y: 0 };
let canvasLayout = [];         // [{ id, x, y, w, h }]，渲染后供连线/拖放定位使用
let canvasWorldHeight = 600;
let canvasDropIndex = null;

/* ---------- 工具 ---------- */

const $ = (sel) => document.querySelector(sel);

const uid = WCAStore.uid;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function escapeAttr(s) { return escapeHtml(s); }

function displayName(node) {
  const t = NODE_TYPES[node.type];
  if (node.type === 'extract' || node.type === 'image' || node.type === 'list') {
    return node.config.varName ? `${t.label}：${node.config.varName}` : t.label;
  }
  if (node.type === 'assemble') {
    return node.config.title ? `${t.label}：${node.config.title}` : t.label;
  }
  if (node.type === 'loop') {
    return node.config.overVar ? `${t.label}：${node.config.overVar}` : t.label;
  }
  if (node.type === 'condition') {
    return node.config.sourceVar ? `${t.label}：${node.config.sourceVar}` : t.label;
  }
  return t.label;
}

const ICON_PLAY = '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>';
const ICON_MORE = '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';

function sanitizeFilename(name) {
  const cleaned = String(name).replace(/[\\/:*?"<>|]/g, '-').trim();
  return cleaned || '未命名文章';
}

function sanitizeFolder(input) {
  let p = String(input || '').trim().replace(/\\/g, '/');
  p = p.replace(/^\/+|\/+$/g, '');
  if (!p || p.includes('..')) return 'web-collector/images';
  p = p.replace(/[:*?"<>|]/g, '-');
  return p;
}

let saveTimer = null;
function saveState() {
  if (workflow) workflow.updatedAt = Date.now();
  const label = $('#saveState');
  if (label) { label.textContent = '正在保存…'; label.classList.add('saving'); }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await WCAStore.save(state);
    if (label) { label.textContent = '已保存到本地'; label.classList.remove('saving'); }
  }, 300);
}

/* 立即落盘 */
async function saveNow() {
  clearTimeout(saveTimer);
  if (workflow) workflow.updatedAt = Date.now();
  await WCAStore.save(state);
  const label = $('#saveState');
  if (label) { label.textContent = '已保存到本地'; label.classList.remove('saving'); }
}

/* 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / N 个月前 / N 年前 */
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

/* 正则后处理：pattern 非法时抛错 */
function applyRegex(value, cfg) {
  if (!cfg || !cfg.regexOn || !cfg.regexPattern) return value;
  let re;
  try {
    re = new RegExp(cfg.regexPattern, cfg.regexFlags || 'g');
  } catch (e) {
    throw new Error(`正则表达式非法：${e.message}`);
  }
  return String(value).replace(re, cfg.regexRepl == null ? '' : cfg.regexRepl);
}

/* 渲染模板：支持 {{变量}}、{{item.字段}} 与 {{#each 列表}}…{{/each}}（块内 {{item}} / {{index}}） */
function renderTemplate(tpl, vars, scope) {
  let out = String(tpl).replace(EACH_BLOCK_RE, (m, name, inner) => {
    const arr = vars[name.trim()];
    if (!Array.isArray(arr)) return '';
    return arr.map((it, i) => renderTemplate(inner, vars, { item: it, index: i + 1 })).join('\n');
  });
  out = out.replace(TEMPLATE_REF_RE, (m, raw) => {
    const key = raw.trim();
    if (scope) {
      const field = /^(?:item|this)\.(.+)$/.exec(key);
      if (field) {
        const src = scope.item;
        if (!src || typeof src !== 'object') return '';
        const v = src[field[1]];
        return v == null ? '' : String(v);
      }
      if (key === 'item' || key === 'this') return stringifyValue(scope.item);
      if (key === 'index') return String(scope.index);
    }
    if (!Object.prototype.hasOwnProperty.call(vars, key)) return '';
    return stringifyValue(vars[key]);
  });
  return out;
}

/* 变量值转文本：集合按换行展开，对象转 JSON */
function stringifyValue(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(stringifyValue).join('\n');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/* ---------- 初始化与页面路由 ---------- */

init();

async function init() {
  state = await WCAStore.load();
  settings = state.settings;
  bindImportInput();

  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  const wf = id ? state.workflows.find((w) => w.id === id) : null;

  if (!wf) { enterHome(); return; }

  workflow = wf;
  // 兼容旧版本保存的节点：补齐新增配置项的默认值
  workflow.nodes.forEach((n) => {
    n.config = Object.assign(DEFAULTS[n.type] ? DEFAULTS[n.type]() : {}, n.config || {});
  });
  ensureOpenTabFirst();
  selectedId = workflow.nodes[0].id;
  resetStatuses();
  document.body.classList.add('editor-mode');
  document.title = `${workflow.name || '未命名工作流'} · TopData`;
  bindEditorUI();
  renderAll();
  requestAnimationFrame(resetCanvas);
  log('info', '就绪。从左侧拖入节点搭建流程，点击右上角"运行"。');

  // 来自弹窗"运行"：打开后立即执行，并去掉 autorun 参数避免刷新重跑
  if (params.get('autorun') === '1') {
    history.replaceState(null, '', 'editor.html?id=' + encodeURIComponent(id));
    runWorkflow();
  }
}

/* ---------- 主页：工作流列表 ---------- */

function enterHome() {
  document.body.classList.add('home-mode');
  document.title = 'TopData · 工作流';
  bindHomeUI();
  renderHome();
}

function bindHomeUI() {
  $('#homeNewBtn').addEventListener('click', async () => {
    const wf = WCAStore.makeWorkflow();
    state.workflows.push(wf);
    await WCAStore.save(state);
    location.href = 'editor.html?id=' + encodeURIComponent(wf.id);
  });
  $('#homeImportBtn').addEventListener('click', () => importWorkflowFile());

  // 点击空白处收起列表项的下拉菜单
  document.addEventListener('click', (e) => {
    if (e.target.closest('.wf-menu') || e.target.closest('[data-op="more"]')) return;
    document.querySelectorAll('.wf-menu').forEach((m) => m.classList.add('hidden'));
  });
}

function renderHome() {
  const list = $('#homeList');
  list.innerHTML = '';
  const wfs = [...state.workflows].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  $('#homeEmpty').classList.toggle('hidden', wfs.length > 0);

  wfs.forEach((wf) => {
    const row = document.createElement('div');
    row.className = 'wf-row';
    row.innerHTML = `
      <div class="wf-main">
        <div class="wf-name">${escapeHtml(wf.name || '未命名工作流')}</div>
        <div class="wf-meta">${relativeTime(wf.updatedAt)} · ${wf.nodes.length} 个节点</div>
      </div>
      <button class="wf-icon" data-op="run" title="运行工作流">${ICON_PLAY}</button>
      <button class="wf-icon" data-op="more" title="更多操作">${ICON_MORE}</button>
      <div class="wf-menu hidden">
        <button data-op="rename">重命名</button>
        <button data-op="del" class="danger">删除</button>
      </div>`;

    row.querySelector('.wf-main').addEventListener('click', () => openWorkflow(wf.id));
    row.querySelector('[data-op="run"]').addEventListener('click', (e) => {
      e.stopPropagation();
      openWorkflow(wf.id, true);
    });
    row.querySelector('[data-op="more"]').addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = row.querySelector('.wf-menu');
      const willShow = menu.classList.contains('hidden');
      document.querySelectorAll('.wf-menu').forEach((m) => m.classList.add('hidden'));
      menu.classList.toggle('hidden', !willShow);
    });
    row.querySelector('[data-op="rename"]').addEventListener('click', () => {
      row.querySelector('.wf-menu').classList.add('hidden');
      startRename(row, wf);
    });
    row.querySelector('[data-op="del"]').addEventListener('click', () => {
      row.querySelector('.wf-menu').classList.add('hidden');
      deleteWorkflow(wf);
    });
    list.appendChild(row);
  });
}

function openWorkflow(id, autorun) {
  location.href = 'editor.html?id=' + encodeURIComponent(id) + (autorun ? '&autorun=1' : '');
}

/* 内联重命名：Enter/失焦保存，Esc 取消 */
function startRename(card, wf) {
  const nameEl = card.querySelector('.wf-name');
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
    renderHome();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit(true);
    else if (e.key === 'Escape') commit(false);
  });
  input.addEventListener('blur', () => commit(true));
}

async function deleteWorkflow(wf) {
  if (!confirm(`确定删除工作流「${wf.name || '未命名工作流'}」吗？该操作不可恢复。`)) return;
  state.workflows = state.workflows.filter((w) => w.id !== wf.id);
  await WCAStore.save(state);
  renderHome();
}

/* ---------- 文件：保存 / 导入 / 导出 ---------- */

function bindImportInput() {
  const input = $('#importFile');
  if (!input) return;
  input.addEventListener('change', onImportFileChosen);
}

function importWorkflowFile() {
  const input = $('#importFile');
  input.value = '';
  input.click();
}

async function onImportFileChosen(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;

  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (err) {
    alert('导入失败：文件不是合法的 JSON。');
    return;
  }
  const raw = Array.isArray(data) ? data : (Array.isArray(data.workflows) ? data.workflows : (data.nodes ? [data] : []));
  const added = raw.map(normalizeImported).filter(Boolean);
  if (!added.length) {
    alert('导入失败：文件中没有找到有效的工作流。');
    return;
  }
  added.forEach((wf) => state.workflows.push(wf));
  await WCAStore.save(state);

  if (workflow) {
    log('success', `已导入 ${added.length} 个工作流：${added.map((w) => w.name).join('、')}。可返回列表页查看。`);
  } else {
    renderHome();
  }
}

/* 规整导入数据：节点 id 重新生成，配置与默认值合并 */
function normalizeImported(item) {
  if (!item || !Array.isArray(item.nodes)) return null;
  const nodes = item.nodes
    .filter((n) => n && NODE_TYPES[n.type])
    .map((n) => ({
      id: uid(),
      type: n.type,
      config: Object.assign(DEFAULTS[n.type](), n.config || {}),
    }));
  if (!nodes.length) return null;
  const openIdx = nodes.findIndex((n) => n.type === 'openTab');
  if (openIdx === -1) {
    nodes.unshift({ id: uid(), type: 'openTab', config: DEFAULTS.openTab() });
  } else if (openIdx > 0) {
    nodes.unshift(nodes.splice(openIdx, 1)[0]);
  }
  return {
    id: uid('w_'),
    name: item.name || '导入的工作流',
    nodes,
    updatedAt: Date.now(),
  };
}

async function handleFileOp(op) {
  if (op === 'save') {
    await saveNow();
    log('success', `已保存工作流「${workflow.name || '未命名工作流'}」。`);
    switchTab('log');
  } else if (op === 'exportOne') {
    exportWorkflows([workflow], `${sanitizeFilename(workflow.name || 'workflow')}.json`);
  } else if (op === 'exportAll') {
    if (!state.workflows.length) { log('warn', '暂无工作流可导出。'); switchTab('log'); return; }
    exportWorkflows(state.workflows, 'topdata-workflows.json');
  } else if (op === 'import') {
    importWorkflowFile();
  }
}

/* 导出为 JSON：单套（workflow）或多套（bundle） */
function exportWorkflows(list, filename) {
  const payload = {
    app: 'TopData',
    kind: list.length === 1 ? 'workflow' : 'bundle',
    version: 1,
    exportedAt: new Date().toISOString(),
    workflows: list.map((w) => ({
      name: w.name || '未命名工作流',
      updatedAt: w.updatedAt || Date.now(),
      nodes: w.nodes.map((n) => ({ type: n.type, config: n.config })),
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  log('success', `已导出 ${list.length} 个工作流：${filename}`);
}

function makeNode(type) {
  return { id: uid(), type, config: DEFAULTS[type]() };
}

function ensureOpenTabFirst() {
  const idx = workflow.nodes.findIndex((n) => n.type === 'openTab');
  if (idx === -1) {
    workflow.nodes.unshift(makeNode('openTab'));
  } else if (idx > 0) {
    const [n] = workflow.nodes.splice(idx, 1);
    workflow.nodes.unshift(n);
  }
}

function resetStatuses() {
  nodeStatus = {};
  workflow.nodes.forEach((n) => { nodeStatus[n.id] = 'idle'; });
  invalidIds = new Set();
}

function getNode(id) { return workflow.nodes.find((n) => n.id === id); }

/* ---------- 编辑器 UI 绑定 ---------- */

function bindEditorUI() {
  // 返回工作流列表（运行中禁止离开，beforeunload 另有拦截）
  $('#backBtn').addEventListener('click', () => {
    if (running) return;
    location.href = 'editor.html';
  });

  $('#workflowName').addEventListener('input', (e) => {
    workflow.name = e.target.value;
    document.title = `${workflow.name || '未命名工作流'} · TopData`;
    saveState();
  });

  $('#runBtn').addEventListener('click', runWorkflow);
  bindCanvasUI();
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#settingsCancel').addEventListener('click', () => $('#settingsModal').classList.add('hidden'));
  $('#settingsSave').addEventListener('click', saveSettings);

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  $('#copyMdBtn').addEventListener('click', copyMarkdown);
  $('#downloadMdBtn').addEventListener('click', downloadMarkdown);
  $('#downloadAllBtn').addEventListener('click', downloadAllMarkdowns);
  $('#resultSelect').addEventListener('change', (e) => showResultAt(parseInt(e.target.value, 10) || 0));

  // 文件菜单：保存 / 导入 / 导出
  $('#fileBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#fileMenu').classList.toggle('hidden');
  });
  $('#fileMenu').querySelectorAll('[data-op]').forEach((btn) => {
    btn.addEventListener('click', () => {
      $('#fileMenu').classList.add('hidden');
      handleFileOp(btn.dataset.op);
    });
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.file-menu-wrap')) $('#fileMenu').classList.add('hidden');
  });

  // 接收目标页面选择浮层回传的选择器
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'WCA_INSPECTOR_RESULT') return;
    if (!pickRequestId || msg.requestId !== pickRequestId) return;
    const node = getNode(pickNodeId);
    const fieldIdx = pickFieldIndex;
    const field = node && fieldIdx != null && Array.isArray(node.config.fields)
      ? node.config.fields[fieldIdx] : null;
    if (msg.selector && field) {
      // 字段映射点选：优先使用“相对当前列表项”的选择器
      field.selector = typeof msg.relativeSelector === 'string' ? msg.relativeSelector : msg.selector;
      field.selectorType = 'css';
      if (!field.extractType) field.extractType = 'text';
      invalidIds.delete(node.id);
      saveState();
      renderConfigForm();
      renderNodeList();
      switchTab('log');
      log('success', `字段「${field.key || '未命名字段'}」选择器已填入：${field.selector || '（留空 = 当前列表项元素本身）'}`);
    } else if (msg.selector && node) {
      node.config.selector = msg.selector;
      if (msg.selectorType) node.config.selectorType = msg.selectorType;
      if (msg.multiMatch && node.type === 'extract') node.config.multiMode = 'all';
      invalidIds.delete(node.id);
      saveState();
      renderConfigForm();
      renderNodeList();
      switchTab('log');
      const matchTip = msg.multiMatch
        ? (node.type === 'extract' ? '（已同时把“多匹配处理”设为全部）' : '（多元素匹配已开启）')
        : '';
      log('success', `已填入选择器（${msg.selectorType === 'xpath' ? 'XPath' : 'CSS'}）：${msg.selector}${matchTip}`);
    } else {
      switchTab('log');
      log('info', '已关闭选择面板，未选择元素。');
    }
    resetPickState();
  });

  // 运行中关闭页面前提示
  window.addEventListener('beforeunload', (e) => {
    if (running) { e.preventDefault(); e.returnValue = ''; }
  });
}

function renderAll() {
  $('#workflowName').value = workflow.name || '';
  renderNodeList();
  renderConfigForm();
}

/* ---------- 流程画布 ---------- */

function renderNodeList() {
  const list = $('#nodeList');
  if (!list) return;
  list.innerHTML = '';
  canvasLayout = [];
  const depths = computeDepths(workflow.nodes);
  let y = CANVAS_START_Y;

  workflow.nodes.forEach((node) => {
    const t = NODE_TYPES[node.type];
    const isEnd = !!t.blockEnd;
    const depth = depths[node.id] || 0;
    const x = CANVAS_CARD_X + depth * CANVAS_DEPTH_OFFSET;

    const card = document.createElement('div');
    card.className = 'node-card'
      + (isEnd ? ' block-end' : '')
      + (node.id === selectedId ? ' selected' : '')
      + (invalidIds.has(node.id) ? ' invalid' : '');
    card.dataset.nodeId = node.id;
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
    card.style.width = `${CANVAS_CARD_WIDTH}px`;

    const sub = isEnd ? '' : nodeSubtitle(node);
    card.innerHTML = `
      <div class="node-card-head">
        <span class="node-badge ${node.type}">${t.badge}</span>
        <span class="node-name">${escapeHtml(displayName(node))}</span>
        <span class="status-dot ${nodeStatus[node.id] || 'idle'}" title="${escapeAttr(statusTitle(node.id))}"></span>
      </div>
      ${sub ? `<div class="node-sub">${escapeHtml(sub)}</div>` : ''}
      ${!t.fixed ? `<span class="node-ops">
        <button class="node-op" data-op="up" title="上移">↑</button>
        <button class="node-op" data-op="down" title="下移">↓</button>
        <button class="node-op danger" data-op="del" title="删除">×</button>
      </span>` : ''}
    `;
    card.addEventListener('click', (e) => {
      const op = e.target.dataset && e.target.dataset.op;
      if (op) { e.stopPropagation(); handleNodeOp(node.id, op); return; }
      selectedId = node.id;
      renderNodeList();
      renderConfigForm();
    });
    list.appendChild(card);

    const h = card.offsetHeight || (isEnd ? 42 : 66);
    canvasLayout.push({ id: node.id, x, y, w: CANVAS_CARD_WIDTH, h });
    y += h + CANVAS_NODE_GAP;
  });

  canvasWorldHeight = Math.max(320, y + 20);
  const world = $('#canvasWorld');
  if (world) world.style.height = `${canvasWorldHeight}px`;
  drawCanvasEdges();
  updateCanvasMeta();
  renderPalette();
}

/* 节点之间的贝塞尔连线；首个节点从 START 连出 */
function drawCanvasEdges() {
  const svg = $('#canvasEdges');
  if (!svg) return;
  const nodes = workflow.nodes;
  const parts = [];
  if (canvasLayout.length) {
    const first = canvasLayout[0];
    const x1 = CANVAS_WIDTH / 2;
    const y1 = 44;
    const x2 = first.x + first.w / 2;
    const y2 = first.y;
    parts.push(`<path class="canvas-edge${first.id === selectedId ? ' selected' : ''}" d="M ${x1} ${y1} C ${x1} ${y1 + 18}, ${x2} ${y2 - 18}, ${x2} ${y2}"></path>`);
  }
  for (let i = 0; i < canvasLayout.length - 1; i++) {
    const a = canvasLayout[i];
    const b = canvasLayout[i + 1];
    const x1 = a.x + a.w / 2;
    const y1 = a.y + a.h;
    const x2 = b.x + b.w / 2;
    const y2 = b.y;
    const k = Math.max(12, (y2 - y1) / 2);
    const active = nodes[i].id === selectedId || nodes[i + 1].id === selectedId;
    parts.push(`<path class="canvas-edge${active ? ' selected' : ''}" d="M ${x1} ${y1} C ${x1} ${y1 + k}, ${x2} ${y2 - k}, ${x2} ${y2}"></path>`);
  }
  svg.setAttribute('width', String(CANVAS_WIDTH));
  svg.setAttribute('height', String(canvasWorldHeight));
  svg.innerHTML = parts.join('');
}

function updateCanvasMeta() {
  const count = workflow.nodes.length;
  const countEl = $('#canvasNodeCount');
  if (countEl) countEl.textContent = String(count);
  const metaEl = $('#workflowNodeMeta');
  if (metaEl) metaEl.textContent = `${count} 个节点`;
}

/* ---------- 左侧节点库 ---------- */

function renderPalette() {
  const box = $('#nodePalette');
  if (!box) return;
  const input = $('#nodeSearch');
  const q = (input ? input.value : '').trim().toLowerCase();
  const hasAssemble = workflow.nodes.some((n) => n.type === 'assemble');
  let html = '';

  PALETTE_GROUPS.forEach((group) => {
    const items = group.items.filter(([type, name, desc]) => {
      if (!q) return true;
      return name.toLowerCase().includes(q)
        || desc.toLowerCase().includes(q)
        || type.toLowerCase().includes(q);
    });
    if (!items.length) return;
    html += `<div class="palette-group"><div class="palette-group-title">${group.label}</div><div class="palette-grid">`;
    items.forEach(([type, name, desc]) => {
      const t = NODE_TYPES[type];
      if (!t) return;
      const disabled = type === 'assemble' && hasAssemble;
      html += `<button class="palette-item" data-type="${type}" draggable="${disabled ? 'false' : 'true'}"
        ${disabled ? 'disabled' : ''} title="${escapeAttr(disabled ? '已存在（最多一个）' : desc)}">
        <span class="node-badge ${type}">${t.badge}</span>
        <span class="palette-item-name">${name}</span>
      </button>`;
    });
    html += '</div></div>';
  });

  box.innerHTML = html || '<div class="palette-empty">没有匹配的节点</div>';

  box.querySelectorAll('.palette-item').forEach((btn) => {
    btn.addEventListener('dragstart', (e) => {
      if (btn.disabled) { e.preventDefault(); return; }
      e.dataTransfer.setData('text/plain', btn.dataset.type);
      e.dataTransfer.effectAllowed = 'copy';
      btn.classList.add('dragging');
    });
    btn.addEventListener('dragend', () => btn.classList.remove('dragging'));
  });
}

function isPaletteNodeType(type) { return PALETTE_TYPES.has(type); }

/* ---------- 画布交互 ---------- */

function bindCanvasUI() {
  renderPalette();

  const search = $('#nodeSearch');
  if (search) search.addEventListener('input', renderPalette);

  const paletteToggle = $('#paletteToggle');
  if (paletteToggle) {
    paletteToggle.addEventListener('click', () => {
      const collapsed = document.body.classList.toggle('palette-collapsed');
      paletteToggle.setAttribute('aria-expanded', String(!collapsed));
      paletteToggle.title = collapsed ? '展开节点库' : '收起节点库';
      paletteToggle.setAttribute('aria-label', paletteToggle.title);
    });
  }

  const bottomToggle = $('#bottomToggle');
  if (bottomToggle) bottomToggle.addEventListener('click', () => {
    setBottomCollapsed(!document.body.classList.contains('bottom-collapsed'));
  });

  const zoomIn = $('#zoomIn');
  if (zoomIn) zoomIn.addEventListener('click', () => setCanvasScale(canvasScale * 1.1));
  const zoomOut = $('#zoomOut');
  if (zoomOut) zoomOut.addEventListener('click', () => setCanvasScale(canvasScale / 1.1));
  const zoomLabel = $('#zoomLabel');
  if (zoomLabel) zoomLabel.addEventListener('click', () => setCanvasScale(1));
  const fit = $('#fitCanvas');
  if (fit) fit.addEventListener('click', fitCanvas);
  const reset = $('#resetCanvas');
  if (reset) reset.addEventListener('click', resetCanvas);

  const vp = $('#canvasViewport');
  if (!vp) return;

  // 空白处拖动平移
  let panning = false;
  let panStart = { x: 0, y: 0 };
  vp.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.node-card')) return;
    panning = true;
    panStart = { x: e.clientX - canvasPan.x, y: e.clientY - canvasPan.y };
    vp.classList.add('panning');
    try { vp.setPointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
  });
  vp.addEventListener('pointermove', (e) => {
    if (!panning) return;
    canvasPan.x = e.clientX - panStart.x;
    canvasPan.y = e.clientY - panStart.y;
    applyCanvasTransform();
  });
  const endPan = (e) => {
    if (!panning) return;
    panning = false;
    vp.classList.remove('panning');
    try { vp.releasePointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
  };
  vp.addEventListener('pointerup', endPan);
  vp.addEventListener('pointercancel', endPan);

  // 滚轮平移；Ctrl / ⌘ + 滚轮以鼠标为锚点缩放
  vp.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      setCanvasScale(canvasScale * (e.deltaY > 0 ? 0.9 : 1.1), e.clientX, e.clientY);
      return;
    }
    canvasPan.x -= e.deltaX;
    canvasPan.y -= e.deltaY;
    applyCanvasTransform();
  }, { passive: false });

  // 从节点库拖入
  vp.addEventListener('dragover', (e) => {
    if (!Array.from(e.dataTransfer ? e.dataTransfer.types : []).includes('text/plain')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    vp.classList.add('drag-over');
    updateCanvasDrop(e);
  });
  vp.addEventListener('dragleave', (e) => {
    if (e.relatedTarget && vp.contains(e.relatedTarget)) return;
    vp.classList.remove('drag-over');
    hideCanvasDrop();
  });
  vp.addEventListener('drop', (e) => {
    e.preventDefault();
    vp.classList.remove('drag-over');
    const type = e.dataTransfer ? e.dataTransfer.getData('text/plain') : '';
    const point = canvasPoint(e.clientX, e.clientY);
    const idx = computeDropIndex(point.y);
    hideCanvasDrop();
    if (isPaletteNodeType(type)) addNode(type, idx);
  });
}

function setBottomCollapsed(collapsed) {
  document.body.classList.toggle('bottom-collapsed', !!collapsed);
  const btn = $('#bottomToggle');
  if (!btn) return;
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.title = collapsed ? '展开底部面板' : '收起底部面板';
  btn.setAttribute('aria-label', btn.title);
  const label = btn.querySelector('span');
  if (label) label.textContent = collapsed ? '展开' : '收起';
}

function applyCanvasTransform() {
  const world = $('#canvasWorld');
  if (world) {
    world.style.transform = `translate(${canvasPan.x}px, ${canvasPan.y}px) scale(${canvasScale})`;
  }
  const label = $('#zoomLabel');
  if (label) label.textContent = `${Math.round(canvasScale * 100)}%`;
}

function setCanvasScale(next, clientX, clientY) {
  const clamped = Math.min(2, Math.max(0.4, next));
  if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
    const rect = $('#canvasViewport').getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const wx = (px - canvasPan.x) / canvasScale;
    const wy = (py - canvasPan.y) / canvasScale;
    canvasScale = clamped;
    canvasPan.x = px - wx * canvasScale;
    canvasPan.y = py - wy * canvasScale;
  } else {
    canvasScale = clamped;
  }
  applyCanvasTransform();
}

function resetCanvas() {
  const vp = $('#canvasViewport');
  if (!vp) return;
  canvasScale = 1;
  canvasPan = {
    x: Math.max(24, (vp.clientWidth - CANVAS_WIDTH) / 2),
    y: 18,
  };
  applyCanvasTransform();
}

function fitCanvas() {
  const vp = $('#canvasViewport');
  if (!vp || !vp.clientWidth) return;
  const contentH = canvasWorldHeight + 24;
  const scale = Math.min(1, (vp.clientWidth - 48) / CANVAS_WIDTH, (vp.clientHeight - 32) / contentH);
  canvasScale = Math.max(0.4, scale);
  canvasPan = {
    x: Math.max(16, (vp.clientWidth - CANVAS_WIDTH * canvasScale) / 2),
    y: Math.max(12, (vp.clientHeight - contentH * canvasScale) / 2),
  };
  applyCanvasTransform();
}

function centerCanvasNode(id) {
  const item = canvasLayout.find((l) => l.id === id);
  const vp = $('#canvasViewport');
  if (!item || !vp || !vp.clientHeight) return;
  canvasPan.x = Math.max(24, (vp.clientWidth - CANVAS_WIDTH * canvasScale) / 2);
  canvasPan.y = vp.clientHeight / 2 - (item.y + item.h / 2) * canvasScale;
  applyCanvasTransform();
}

/* 屏幕坐标 → 画布世界坐标 */
function canvasPoint(clientX, clientY) {
  const rect = $('#canvasViewport').getBoundingClientRect();
  return {
    x: (clientX - rect.left - canvasPan.x) / canvasScale,
    y: (clientY - rect.top - canvasPan.y) / canvasScale,
  };
}

/* 世界纵坐标 → 插入下标（最小为 1，保证 openTab 始终在首位） */
function computeDropIndex(worldY) {
  let idx = workflow.nodes.length;
  for (let i = 0; i < canvasLayout.length; i++) {
    const item = canvasLayout[i];
    if (worldY < item.y + item.h / 2) { idx = i; break; }
  }
  return Math.min(workflow.nodes.length, Math.max(1, idx));
}

function updateCanvasDrop(e) {
  const point = canvasPoint(e.clientX, e.clientY);
  const idx = computeDropIndex(point.y);
  canvasDropIndex = idx;
  const indicator = $('#dropIndicator');
  if (!indicator) return;
  let y;
  if (!canvasLayout.length) {
    y = CANVAS_START_Y - CANVAS_NODE_GAP / 2;
  } else if (idx >= canvasLayout.length) {
    const last = canvasLayout[canvasLayout.length - 1];
    y = last.y + last.h + CANVAS_NODE_GAP / 2;
  } else {
    y = canvasLayout[idx].y - CANVAS_NODE_GAP / 2;
  }
  indicator.style.left = `${CANVAS_CARD_X - 12}px`;
  indicator.style.right = 'auto';
  indicator.style.width = `${CANVAS_CARD_WIDTH + 24}px`;
  indicator.style.top = `${y}px`;
  indicator.classList.remove('hidden');
}

function hideCanvasDrop() {
  canvasDropIndex = null;
  const indicator = $('#dropIndicator');
  if (indicator) indicator.classList.add('hidden');
}

/* 计算每个节点的块嵌套深度（结束标记归到外层） */
function computeDepths(nodes) {
  const map = {};
  let d = 0;
  nodes.forEach((n) => {
    if (n.type === 'loopEnd' || n.type === 'conditionEnd') {
      d = Math.max(0, d - 1);
      map[n.id] = d;
    } else {
      map[n.id] = d;
      if (n.type === 'loop' || n.type === 'condition') d += 1;
    }
  });
  return map;
}

/* 找到块开始节点对应的结束节点下标 */
function findBlockEnd(nodes, startIdx) {
  const start = nodes[startIdx];
  if (!start || (start.type !== 'loop' && start.type !== 'condition')) return -1;
  const wantEnd = start.type === 'loop' ? 'loopEnd' : 'conditionEnd';
  let depth = 0;
  for (let i = startIdx + 1; i < nodes.length; i++) {
    const t = nodes[i].type;
    if (t === start.type) depth += 1;
    else if (t === wantEnd) {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

function nodeSubtitle(node) {
  const c = node.config;
  switch (node.type) {
    case 'openTab': return c.url || '未配置 URL';
    case 'extract': {
      if (!c.selector) return '未配置选择器';
      const listTag = c.multiMode === 'list' ? ' · 列表集合' : '';
      return `${selPrefix(c)}${c.selector} → ${c.extractType === 'attr' ? '@' + (c.attrName || '?') : '文本'}${listTag}`;
    }
    case 'list': {
      const nf = (c.fields || []).length;
      return c.selector
        ? `${selPrefix(c)}${c.selector}${nf ? ` · ${nf} 个字段` : ''}${c.pagingOn ? ' · 翻页' : ''}`
        : '未配置选择器';
    }
    case 'image':   return c.sourceMode === 'var'
      ? `{{${c.srcVar || '?'}}} → ${c.refMode === 'url' ? '原始URL' : '本地下载'}`
      : (c.selector ? `${selPrefix(c)}${c.selector} → ${c.refMode === 'url' ? '原始URL' : '本地下载'}` : '未配置选择器');
    case 'loop':    return c.overVar ? `遍历 {{${c.overVar}}}，当前项 → {{${c.itemVar || 'item'}}}` : '未指定集合变量';
    case 'condition': return `${c.sourceVar || '?'} ${opLabel(c.operator)}${c.compareValue ? ' ' + c.compareValue : ''}`;
    case 'assemble':return c.title ? `《${c.title}》` : '未配置标题';
    default: return '';
  }
}

function selPrefix(c) {
  return c.selectorType === 'xpath' ? 'xpath: ' : '';
}

function opLabel(op) {
  const found = CONDITION_OPS.find((o) => o[0] === op);
  return found ? found[1] : op;
}

function statusTitle(id) {
  return { idle: '未运行', running: '运行中', success: '成功', empty: '成功（空值）', failed: '失败', skipped: '跳过' }[nodeStatus[id]] || '未运行';
}

function handleNodeOp(id, op) {
  const idx = workflow.nodes.findIndex((n) => n.id === id);
  if (idx < 0) return;
  const node = workflow.nodes[idx];
  const t = NODE_TYPES[node.type];

  if (op === 'del') {
    if (t.block) {
      // 删除块开始节点：连同区间与结束标记一起删除
      const endIdx = findBlockEnd(workflow.nodes, idx);
      const count = endIdx > -1 ? endIdx - idx + 1 : 1;
      const inner = Math.max(0, count - 2);
      if (!confirm(`删除该${t.label}及其内部 ${inner} 个节点？（此操作不可撤销）`)) return;
      workflow.nodes.splice(idx, count);
    } else {
      workflow.nodes.splice(idx, 1);
    }
    if (selectedId === id) selectedId = workflow.nodes[Math.max(0, idx - 1)].id;
  } else if (op === 'up' || op === 'down') {
    const depths = computeDepths(workflow.nodes);
    const targetIdx = op === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 1 || targetIdx >= workflow.nodes.length) return;   // 不能越过起始节点
    // 仅允许在同一层级内移动，避免破坏块结构
    if (depths[node.id] !== depths[workflow.nodes[targetIdx].id]) return;
    if (NODE_TYPES[workflow.nodes[targetIdx].type].fixed) return;
    [workflow.nodes[idx], workflow.nodes[targetIdx]] = [workflow.nodes[targetIdx], workflow.nodes[idx]];
  }
  saveState();
  renderNodeList();
  renderConfigForm();
}

/* ---------- 添加节点 ---------- */

function addNode(type, insertAt) {
  if (type === 'assemble' && workflow.nodes.some((n) => n.type === 'assemble')) {
    switchTab('log');
    log('warn', '每个工作流最多只能添加一个文章组装节点。');
    return;
  }
  const node = makeNode(type);
  // 拖入时使用指示线位置；点击节点库时插入到当前选中节点之后。
  const idx = workflow.nodes.findIndex((n) => n.id === selectedId);
  const fallback = idx >= 0 ? idx + 1 : workflow.nodes.length;
  const requested = Number.isFinite(insertAt) ? Math.trunc(insertAt) : fallback;
  const pos = Math.min(workflow.nodes.length, Math.max(1, requested));
  // 块节点同时插入结束标记，形成空块
  const items = [node];
  if (type === 'loop') items.push(makeNode('loopEnd'));
  if (type === 'condition') items.push(makeNode('conditionEnd'));
  workflow.nodes.splice(pos, 0, ...items);
  items.forEach((n) => { nodeStatus[n.id] = 'idle'; });
  selectedId = node.id;
  saveState();
  renderNodeList();
  renderConfigForm();
  centerCanvasNode(node.id);
}

/* ---------- 配置表单 ---------- */

function renderConfigForm() {
  const box = $('#configForm');
  const badge = $('#configNodeBadge');
  const selectionHint = $('#canvasSelectionHint');
  const node = getNode(selectedId);
  if (!node) {
    box.innerHTML = '<div class="empty-hint">请选择画布中的节点</div>';
    if (badge) { badge.textContent = '未选择'; badge.removeAttribute('title'); }
    if (selectionHint) { selectionHint.textContent = '点击节点编辑配置'; selectionHint.removeAttribute('title'); }
    return;
  }
  const t = NODE_TYPES[node.type];
  const name = displayName(node);
  if (badge) { badge.textContent = t.label; badge.title = name; }
  if (selectionHint) { selectionHint.textContent = `正在配置：${name}`; selectionHint.title = name; }
  const c = node.config;
  let body = '';

  if (node.type === 'openTab') {
    body = `
      ${f('页面 URL', `<input type="text" data-k="url" value="${escapeAttr(c.url)}" placeholder="https://example.com/article">`, true, '仅支持 http/https。后续所有提取/下载节点都在此页面上执行。')}
      ${f('打开方式', radio('openMode', c.openMode, [['new', '新标签页'], ['current', '当前标签页']]), true, '“当前标签页”即当前窗口正在浏览的页面（仅 http/https）。')}
      <div class="form-row">
        ${f('额外等待时间（秒）', `<input type="number" data-k="extraWaitSec" min="0" max="60" step="1" value="${c.extraWaitSec}">`, false, '页面 load 后再等待，用于异步渲染内容。')}
        ${f('运行后自动关闭标签页', `<label class="switch-field"><input type="checkbox" data-k="autoClose" ${c.autoClose ? 'checked' : ''}> 启用</label>`)}
      </div>`;
  }

  if (node.type === 'extract') {
    body = `
      ${f('变量名', `<input type="text" data-k="varName" value="${escapeAttr(c.varName)}" placeholder="如：标题、正文、author">`, true, '供文章组装节点以 {{变量名}} 引用。同一工作流内唯一。')}
      ${selectorField(c, '点击“选择元素”会在最近浏览的网页上打开选择面板，可切换 CSS / XPath。')}
      ${f('提取类型', radio('extractType', c.extractType, [['text', '元素文本'], ['attr', '属性值']]), true)}
      <div class="form-field" data-show="extractType" data-value="attr">
        <label>属性名<span class="req">*</span></label>
        <input type="text" data-k="attrName" value="${escapeAttr(c.attrName)}" placeholder="如：href、src、alt、data-id">
        <div class="field-hint">href / src 会自动转为绝对 URL。</div>
      </div>
      ${f('多匹配处理', radio('multiMode', c.multiMode, [['first', '仅第一个'], ['all', '全部（拼接）'], ['list', '列表集合（返回 list）']]), true, '“列表集合”会把全部匹配项作为数组存入变量：可用循环节点逐项处理，或在文章组装中用 {{#each 变量名}} 渲染。')}
      <div class="form-field" data-show="multiMode" data-value="all">
        <label>拼接分隔符</label>
        <input type="text" data-k="joinSep" value="${escapeAttr(c.joinSep)}" placeholder="默认换行">
      </div>
      <div class="form-row">
        ${f('等待元素出现（秒）', `<input type="number" data-k="waitSec" min="0" max="60" step="1" value="${c.waitSec}">`, false, '超时时间内持续查找元素，0 表示立即匹配。')}
        ${f('未匹配时', radio('onMissing', c.onMissing, [['stop', '停止并报错'], ['continue', '置空并继续']]), true)}
      </div>
      ${regexBlock(c)}`;
  }

  if (node.type === 'image') {
    const vars = availableVars();
    const varOpts = vars.length
      ? vars.map((v) => `<option value="${escapeAttr(v.name)}" ${c.srcVar === v.name ? 'selected' : ''}>${escapeHtml(v.name)}${v.list ? '（集合）' : ''}</option>`).join('')
      : '<option value="">（暂无变量）</option>';
    body = `
      ${f('变量名', `<input type="text" data-k="varName" value="${escapeAttr(c.varName)}" placeholder="如：封面图">`, true, '变量值为 Markdown 图片语法可用的引用路径或原始 URL。')}
      ${f('图片来源', radio('sourceMode', c.sourceMode || 'selector', [['selector', '页面元素选择器'], ['var', '变量（图片 URL）']]), true, '选择“变量”并配合循环节点，可把批量提取到的多个图片地址逐一下载。')}
      <div class="form-field" data-show="sourceMode" data-value="selector">
        ${selectorField(c, '建议直接选择页面中的 <img> 元素。')}
        ${f('属性名', `<input type="text" data-k="attrName" value="${escapeAttr(c.attrName)}" placeholder="默认 src">`, false, '取图片地址的属性，默认 src。')}
      </div>
      <div class="form-field" data-show="sourceMode" data-value="var">
        <label>图片 URL 变量<span class="req">*</span></label>
        <select data-k="srcVar">${varOpts}</select>
        <div class="field-hint">通常选择循环节点的“当前项变量”，从而实现多图批量下载。</div>
      </div>
      ${f('引用方式', radio('refMode', c.refMode, [['local', '下载到本地（相对路径）'], ['url', '不下载，引用原始 URL']]), true)}
      ${f('未匹配 / 下载失败时', radio('onFail', c.onFail, [['stop', '停止并报错'], ['continue', '置空并继续']]), true)}
      ${regexBlock(c)}`;
  }

  if (node.type === 'list') {
    const hasFields = (c.fields || []).length > 0;
    body = `
      ${f('集合变量名', `<input type="text" data-k="varName" value="${escapeAttr(c.varName)}" placeholder="如：文章列表">`, true, '产出一个集合变量（数组），供循环节点遍历、文章组装 {{#each}} 渲染。')}
      ${selectorField(c, '匹配到的全部元素会逐个取值组成集合。')}
      ${hasFields ? '' : `
      ${f('提取类型', radio('extractType', c.extractType, [['text', '元素文本'], ['attr', '属性值']]), true)}
      <div class="form-field" data-show="extractType" data-value="attr">
        <label>属性名<span class="req">*</span></label>
        <input type="text" data-k="attrName" value="${escapeAttr(c.attrName)}" placeholder="如：href、src">
        <div class="field-hint">href / src 会自动转为绝对 URL。</div>
      </div>`}
      ${fieldMappingBlock(c)}
      <div class="form-field">
        <label class="switch-field"><input type="checkbox" data-k="pagingOn" ${c.pagingOn ? 'checked' : ''}> 翻页采集（点击“下一页”继续收集）</label>
        <div class="paging-body" data-show="pagingOn">
          <div class="form-field">
            <label>下一页选择器</label>
            <div class="picker-row">
              <select class="inline-select" data-k="nextSelectorType">
                <option value="css" ${c.nextSelectorType !== 'xpath' ? 'selected' : ''}>CSS</option>
                <option value="xpath" ${c.nextSelectorType === 'xpath' ? 'selected' : ''}>XPath</option>
              </select>
              <input type="text" data-k="nextSelector" value="${escapeAttr(c.nextSelector)}" placeholder="如：.pagination .next">
            </div>
          </div>
          <div class="form-row">
            ${f('最大页数', `<input type="number" data-k="maxPages" min="1" max="100" step="1" value="${c.maxPages}">`)}
            ${f('每页等待（秒）', `<input type="number" data-k="pageWaitSec" min="1" max="30" step="1" value="${c.pageWaitSec}">`, false, '点击下一页后等待新内容加载。')}
          </div>
          <div class="field-hint">仅支持点击后页面不整体跳转的翻页；若翻页会刷新整页，请改用独立工作流。</div>
        </div>
      </div>
      ${hasFields ? '' : regexBlock(c)}`;
  }

  if (node.type === 'loop') {
    const listVars = availableVars().filter((v) => v.list);
    const opts = listVars.length
      ? listVars.map((v) => `<option value="${escapeAttr(v.name)}" ${c.overVar === v.name ? 'selected' : ''}>${escapeHtml(v.name)}</option>`).join('')
      : '<option value="">（暂无集合变量）</option>';
    body = `
      ${f('遍历集合变量', `<select data-k="overVar">${opts}</select>`, true, '取前面“批量提取”或“提取内容（列表集合）”产出的集合变量。')}
      ${f('当前项变量名', `<input type="text" data-k="itemVar" value="${escapeAttr(c.itemVar)}" placeholder="item">`, true, '循环体内用 {{变量名}} 引用当前项。')}
      <div class="field-hint">循环体 = 本节点与“循环结束”之间的全部节点，按集合项数重复执行。循环体内放“文章组装”可逐条产出多篇 Markdown。</div>`;
  }

  if (node.type === 'condition') {
    const vars = availableVars();
    const opts = vars.length
      ? vars.map((v) => `<option value="${escapeAttr(v.name)}" ${c.sourceVar === v.name ? 'selected' : ''}>${escapeHtml(v.name)}</option>`).join('')
      : '<option value="">（暂无变量）</option>';
    body = `
      ${f('来源变量', `<select data-k="sourceVar">${opts}</select>`, true, '条件判断所用的变量。')}
      ${f('判断条件', `<select data-k="operator">${CONDITION_OPS.map(([v, label]) => `<option value="${v}" ${c.operator === v ? 'selected' : ''}>${label}</option>`).join('')}</select>`, true)}
      <div class="form-field" data-show="operator" data-value="__compare__">
        <label>比较值</label>
        <input type="text" data-k="compareValue" value="${escapeAttr(c.compareValue)}" placeholder="用于比较的文本或数字">
      </div>
      <div class="field-hint">条件成立时执行“条件分支”与“条件结束”之间的节点；不成立则整段跳过。需要 else 时再加一个取反的条件分支即可。</div>`;
  }

  if (node.type === 'assemble') {
    const vars = availableVars();
    const chips = vars.length
      ? vars.map((v) => `<span class="var-chip" data-var="${escapeAttr(v.name)}">{{${escapeHtml(v.name)}}}${v.list ? '（集合）' : ''}</span>`).join('')
      : '<span class="field-hint">暂无可引用变量，请先添加“提取内容 / 批量提取 / 下载图片”节点并填写变量名。</span>';
    body = `
      ${f('文章标题', `<input type="text" data-k="title" value="${escapeAttr(c.title)}" placeholder="下载 .md 时作为文件名，支持 {{变量}}">`, true)}
      <div class="form-field">
        <label>Markdown 模板<span class="req">*</span></label>
        <textarea data-k="template" id="templateEditor" spellcheck="false">${escapeHtml(c.template)}</textarea>
        <div class="field-hint">使用 {{变量名}} 引用变量：集合变量默认按换行展开；{{#each 集合名}} … {{/each}} 逐项渲染，块内用 {{item}} / {{index}}，对象集合用 {{item.字段名}}（如 {{item.name}}）。点击变量标签插入到光标处。</div>
        <div class="var-chips">${chips}</div>
      </div>
      <div class="field-hint">位于循环体内时，每次循环都会产出一篇独立 Markdown，结果面板可逐篇切换、批量下载。</div>`;
  }

  box.innerHTML = `
    <div class="form-title"><span class="node-badge ${node.type}">${t.badge}</span>${t.label}</div>
    <div class="form-desc">${nodeDesc(node.type)}</div>
    ${body}`;

  // 绑定字段变更
  box.querySelectorAll('[data-k]').forEach((el) => {
    el.addEventListener('input', () => updateConfig(node, el));
    el.addEventListener('change', () => { renderConfigForm(); renderNodeList(); });
  });
  box.querySelectorAll('input[type="radio"]').forEach((el) => {
    el.addEventListener('change', () => { updateConfig(node, el); renderConfigForm(); renderNodeList(); });
  });
  // 变量 chip 插入
  box.querySelectorAll('.var-chip').forEach((chip) => {
    chip.addEventListener('click', () => insertAtCursor($('#templateEditor'), `{{${chip.dataset.var}}}`));
  });
  // 点选元素按钮
  box.querySelectorAll('[data-action="pick"]').forEach((btn) => {
    btn.addEventListener('click', () => startPicker(node, btn));
  });
  // 批量提取：字段映射 -> 为该字段点选元素（相对当前列表项）
  box.querySelectorAll('[data-field-pick]').forEach((btn) => {
    btn.addEventListener('click', () => startPicker(node, btn, parseInt(btn.dataset.fieldPick, 10)));
  });
  // 批量提取：字段映射的增删与输入
  box.querySelectorAll('[data-fk]').forEach((el) => {
    const onChange = () => updateFieldConfig(node, el);
    el.addEventListener('input', onChange);
    el.addEventListener('change', onChange);
  });
  box.querySelectorAll('[data-field-add]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!Array.isArray(node.config.fields)) node.config.fields = [];
      node.config.fields.push(newListField());
      saveState();
      renderConfigForm();
      renderNodeList();
    });
  });
  box.querySelectorAll('[data-field-del]').forEach((btn) => {
    btn.addEventListener('click', () => {
      node.config.fields.splice(parseInt(btn.dataset.fieldDel, 10), 1);
      saveState();
      renderConfigForm();
      renderNodeList();
    });
  });
  applyConditionalFields(node);
}

/* 更新字段映射中的某一项 */
function updateFieldConfig(node, el) {
  const idx = parseInt(el.dataset.fi, 10);
  const field = node.config.fields && node.config.fields[idx];
  if (!field) return;
  field[el.dataset.fk] = el.type === 'checkbox' ? el.checked : el.value;
  saveState();
}

/* 字段联动显隐：data-show=<配置键>，data-value 为空表示按真假判断 */
function applyConditionalFields(node) {
  $('#configForm').querySelectorAll('[data-show]').forEach((el) => {
    const key = el.dataset.show;
    const expect = el.dataset.value || '';
    const actual = node.config[key];
    let show;
    if (expect === '__compare__') show = actual !== 'notEmpty' && actual !== 'isEmpty';
    else if (expect) show = String(actual) === expect;
    else show = !!actual;
    el.hidden = !show;
    el.style.display = show ? '' : 'none';
  });
}

/* 选择器字段：类型（CSS / XPath）+ 输入框 + 选择元素 */
function selectorField(c, hint) {
  const isXpath = c.selectorType === 'xpath';
  return `<div class="form-field">
    <label>选择器<span class="req">*</span></label>
    <div class="picker-row">
      <select class="inline-select" data-k="selectorType">
        <option value="css" ${isXpath ? '' : 'selected'}>CSS</option>
        <option value="xpath" ${isXpath ? 'selected' : ''}>XPath</option>
      </select>
      <input type="text" data-k="selector" value="${escapeAttr(c.selector)}" placeholder="${isXpath ? '如：//div[@class=&quot;item&quot;]/a' : '如：h1.title  或  .article p'}">
      <button class="btn" data-action="pick" title="在网页上点选元素，自动生成选择器">选择元素</button>
    </div>
    ${hint ? `<div class="field-hint">${hint}</div>` : ''}
  </div>`;
}

/* 正则后处理区块 */
function regexBlock(c) {
  return `<div class="form-field">
    <label class="switch-field"><input type="checkbox" data-k="regexOn" ${c.regexOn ? 'checked' : ''}> 正则后处理</label>
    <div class="regex-body" data-show="regexOn">
      <input type="text" data-k="regexPattern" value="${escapeAttr(c.regexPattern)}" placeholder="正则表达式，如：^\\s*作者[:：]\\s*(.*)$">
      <div class="form-row">
        ${f('标志', `<select data-k="regexFlags">
          <option value="g" ${c.regexFlags === 'g' ? 'selected' : ''}>g（全局）</option>
          <option value="gi" ${c.regexFlags === 'gi' ? 'selected' : ''}>gi（+忽略大小写）</option>
          <option value="gm" ${c.regexFlags === 'gm' ? 'selected' : ''}>gm（+多行）</option>
          <option value="gim" ${c.regexFlags === 'gim' ? 'selected' : ''}>gim（+忽略大小写+多行）</option>
        </select>`)}
        ${f('替换为', `<input type="text" data-k="regexRepl" value="${escapeAttr(c.regexRepl)}" placeholder="$1，留空表示删除匹配内容">`)}
      </div>
      <div class="field-hint">对提取到的文本执行正则替换；三个组都可留空，表示不做处理。</div>
    </div>
  </div>`;
}

/* 批量提取：字段映射（key → 值），每个列表项输出一个对象 */
function fieldMappingBlock(c) {
  const fields = Array.isArray(c.fields) ? c.fields : [];
  const rows = fields.map((fd, i) => `
    <div class="field-row">
      <div class="field-row-hd">
        <input type="text" class="field-key" data-fk="key" data-fi="${i}" value="${escapeAttr(fd.key || '')}" placeholder="字段名，如 id / name / date">
        <button class="field-del" data-field-del="${i}" title="删除该字段">×</button>
      </div>
      <div class="picker-row">
        <select class="inline-select" data-fk="selectorType" data-fi="${i}">
          <option value="css" ${fd.selectorType !== 'xpath' ? 'selected' : ''}>CSS</option>
          <option value="xpath" ${fd.selectorType === 'xpath' ? 'selected' : ''}>XPath</option>
        </select>
        <input type="text" data-fk="selector" data-fi="${i}" value="${escapeAttr(fd.selector || '')}" placeholder="留空 = 当前项元素本身">
        <button class="btn" data-field-pick="${i}" title="在网页上点选元素，自动生成相对当前列表项的选择器">选择元素</button>
      </div>
      <div class="form-row">
        ${f('取值', `<select data-fk="extractType" data-fi="${i}">
          <option value="text" ${fd.extractType !== 'attr' ? 'selected' : ''}>元素文本</option>
          <option value="attr" ${fd.extractType === 'attr' ? 'selected' : ''}>属性值</option>
        </select>`)}
        ${f('属性名', `<input type="text" data-fk="attrName" data-fi="${i}" value="${escapeAttr(fd.attrName || '')}" placeholder="如 href、src">`)}
      </div>
    </div>`).join('');

  return `<div class="form-field">
    <label>字段映射（可选，把每个列表项变成对象）</label>
    <div class="field-list">${rows || '<div class="field-hint">未添加字段时，每个列表项只产出一个文本 / 属性值。</div>'}</div>
    <button class="btn btn-dashed" data-field-add="1">＋ 添加字段</button>
    <div class="field-help">
      <div class="field-help-t">怎样填写</div>
      <div><b>字段名</b>：对象里的属性名，模板中用 <code>{{item.字段名}}</code> 引用，如 id / name / date。</div>
      <div><b>选择器</b>：相对“当前列表项”查找，点「选择元素」可直接点选，会自动写成相对写法（如 <code>.item-name</code>）；留空表示取列表项元素本身。XPath 相对查找请以 <code>.//</code> 开头。</div>
      <div><b>取值 / 属性名</b>：取元素文本，或取属性值并填写属性名（href / src 会自动转为绝对 URL）。</div>
      <div class="field-help-ex">示例：列表项 <code>&lt;li class="item"&gt;&lt;a class="item-name" href="/p/1"&gt;标题&lt;/a&gt;&lt;span class="item-date"&gt;10-01&lt;/span&gt;&lt;/li&gt;</code><br>
      字段 name：选择器 <code>.item-name</code>，取值「元素文本」；字段 link：选择器 <code>.item-name</code>，取值「属性值」+ 属性名 <code>href</code>。<br>
      模板：<code>{{#each 文章列表}}{{item.name}} | {{item.link}}{{/each}}</code></div>
    </div>
  </div>`;
}

function newListField() {
  return { key: '', selectorType: 'css', selector: '', extractType: 'text', attrName: '' };
}

/* 当前工作流中可引用的变量 */
function availableVars() {
  const out = [];
  workflow.nodes.forEach((n) => {
    const v = n.config && n.config.varName;
    if (n.type === 'list' && v) out.push({ name: v, list: true });
    else if (n.type === 'extract' && v && n.config.multiMode === 'list') out.push({ name: v, list: true });
    else if ((n.type === 'extract' || n.type === 'image') && v) out.push({ name: v, list: false });
    else if (n.type === 'loop' && n.config.itemVar) out.push({ name: n.config.itemVar, list: false });
  });
  return out;
}

function nodeDesc(type) {
  return {
    openTab: '起始节点：指定采集目标页面，每个工作流有且仅有一个。',
    extract: '按 CSS / XPath 选择器提取元素文本或属性值，产出命名变量；多匹配选“列表集合”时产出数组。',
    list: '批量提取：把匹配到的全部元素取值组成集合变量，可翻页累积。',
    image: '下载图片到本地，产出可用于 Markdown 的引用变量；也可引用图片 URL 变量配合循环批量下载。',
    loop: '循环开始：遍历集合变量，重复执行区间内的节点。',
    loopEnd: '循环结束标记：与“循环开始”配对，节点不可单独删除或移动。',
    condition: '条件分支：判断成立时执行区间内节点，不成立则整段跳过。',
    conditionEnd: '条件结束标记：与“条件分支”配对，节点不可单独删除或移动。',
    assemble: '用前面节点的变量组装 Markdown（每个工作流最多一个）。',
  }[type] || '';
}

function f(label, input, required, hint) {
  return `<div class="form-field"><label>${label}${required ? '<span class="req">*</span>' : ''}</label>${input}${hint ? `<div class="field-hint">${hint}</div>` : ''}</div>`;
}

function radio(name, current, options) {
  return `<div class="radio-group">` + options.map(([val, text]) =>
    `<label><input type="radio" name="${name}" value="${val}" ${current === val ? 'checked' : ''}> ${text}</label>`
  ).join('') + `</div>`;
}

function updateConfig(node, el) {
  const key = el.dataset.k || el.name;
  let val;
  if (el.type === 'checkbox') val = el.checked;
  else if (el.type === 'number') val = Math.max(0, parseInt(el.value, 10) || 0);
  else val = el.value;
  node.config[key] = val;

  // 联动显示
  applyConditionalFields(node);
  invalidIds.delete(node.id);
  saveState();
  renderNodeList();
}

function insertAtCursor(textarea, text) {
  if (!textarea) return;
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
  textarea.selectionStart = textarea.selectionEnd = start + text.length;
  textarea.focus();
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

/* ---------- 全局设置 ---------- */

function openSettings() {
  $('#setPageTimeout').value = settings.pageTimeoutSec;
  $('#setImageFolder').value = settings.imageFolder;
  $('#settingsModal').classList.remove('hidden');
}

function saveSettings() {
  let timeout = parseInt($('#setPageTimeout').value, 10);
  if (isNaN(timeout)) timeout = 30;
  settings.pageTimeoutSec = Math.min(120, Math.max(10, timeout));
  settings.imageFolder = sanitizeFolder($('#setImageFolder').value);
  saveState();
  $('#settingsModal').classList.add('hidden');
  log('success', `设置已保存：加载超时 ${settings.pageTimeoutSec}s，图片目录 ${settings.imageFolder}/`);
}

/* ---------- 底部面板 ---------- */

function switchTab(name) {
  setBottomCollapsed(false);
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-page').forEach((p) => p.classList.add('hidden'));
  $(`#tab-${name}`).classList.remove('hidden');
}

function log(level, msg) {
  const list = $('#logList');
  const item = document.createElement('div');
  item.className = `log-item ${level}`;
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  item.innerHTML = `<span class="log-time">${time}</span><span class="log-msg">${escapeHtml(msg)}</span>`;
  list.appendChild(item);
  list.scrollTop = list.scrollHeight;
}

function showOutputs(outputs) {
  const tbody = $('#outputTable tbody');
  tbody.innerHTML = '';
  $('#outputEmpty').style.display = outputs.length ? 'none' : '';
  outputs.forEach(({ name, value }) => {
    const tr = document.createElement('tr');
    const shown = value.length > 500 ? value.slice(0, 500) + ` …（共 ${value.length} 字符）` : value;
    tr.innerHTML = `<td>${escapeHtml(name)}</td><td><pre>${escapeHtml(shown) || '<空>'}</pre></td>`;
    tbody.appendChild(tr);
  });
}

function showResults(markdowns) {
  lastMarkdowns = markdowns.slice();
  resultIndex = 0;
  const sel = $('#resultSelect');
  const allBtn = $('#downloadAllBtn');
  if (markdowns.length > 1) {
    sel.innerHTML = markdowns
      .map((m, i) => `<option value="${i}">${escapeHtml(m.title)}</option>`)
      .join('');
    sel.classList.remove('hidden');
    allBtn.classList.remove('hidden');
  } else {
    sel.classList.add('hidden');
    allBtn.classList.add('hidden');
  }
  showResultAt(0);
}

function showResultAt(index) {
  const item = lastMarkdowns[index];
  if (!item) return;
  resultIndex = index;
  lastMarkdown = item.markdown;
  lastTitle = item.title;
  $('#mdSource').value = item.markdown;
  $('#mdPreview').innerHTML = renderMarkdown(item.markdown);
  const sel = $('#resultSelect');
  if (sel.value !== String(index)) sel.value = String(index);
  const pageInfo = lastMarkdowns.length > 1 ? ` · 第 ${index + 1}/${lastMarkdowns.length} 篇` : '';
  $('#resultHint').textContent = `《${item.title}》 共 ${item.markdown.length} 字符${pageInfo}`;
  switchTab('result');
}

/* ---------- 复制 / 下载 Markdown ---------- */

async function copyMarkdown() {
  if (!lastMarkdown) { log('warn', '暂无可复制的 Markdown，请先成功运行含文章组装节点的流程。'); return; }
  try {
    await navigator.clipboard.writeText(lastMarkdown);
    log('success', 'Markdown 已复制到剪贴板。');
  } catch (e) {
    // 回退方案
    const ta = $('#mdSource');
    ta.select();
    const ok = document.execCommand('copy');
    log(ok ? 'success' : 'error', ok ? 'Markdown 已复制到剪贴板。' : '复制失败，请改用“下载 .md”。');
  }
}

function downloadMarkdown() {
  if (!lastMarkdown) { log('warn', '暂无可下载的 Markdown，请先成功运行含文章组装节点的流程。'); return; }
  downloadOne(lastMarkdowns[resultIndex] || { title: lastTitle, markdown: lastMarkdown });
}

async function downloadAllMarkdowns() {
  if (!lastMarkdowns.length) return;
  for (let i = 0; i < lastMarkdowns.length; i++) {
    downloadOne(lastMarkdowns[i]);
    await sleep(300);   // 避免浏览器连续下载被拦截
  }
  log('success', `已开始下载全部 ${lastMarkdowns.length} 篇 Markdown。`);
}

function downloadOne(item) {
  const blob = new Blob([item.markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sanitizeFilename(item.title)}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  log('success', `已下载 ${sanitizeFilename(item.title)}.md`);
}

/* ============================================================
 * 执行引擎
 * ============================================================ */

function validateWorkflow() {
  const errs = [];
  const defs = new Map(); // 变量名 -> { list, nodeId }

  // 第一轮：收集全部变量名（与节点顺序无关）
  workflow.nodes.forEach((n) => {
    const v = (n.config && n.config.varName || '').trim();
    if ((n.type === 'extract' || n.type === 'image' || n.type === 'list') && v) {
      defs.set(v, {
        list: n.type === 'list' || (n.type === 'extract' && n.config.multiMode === 'list'),
        nodeId: n.id,
      });
    }
    const iv = (n.type === 'loop' && (n.config.itemVar || '').trim()) || '';
    if (iv) defs.set(iv, { list: false, nodeId: n.id });
  });
  const vars = new Set(defs.keys());

  // 第二轮：逐项校验
  workflow.nodes.forEach((n) => {
    const dn = displayName(n);
    const c = n.config || {};

    if (n.type === 'openTab') {
      if (!/^https?:\/\/\S+/i.test((c.url || '').trim())) {
        errs.push({ id: n.id, msg: '起始节点：URL 为空或非法（仅支持 http/https）' });
      }
    }

    if (n.type === 'extract' || n.type === 'image' || n.type === 'list') {
      const vn = (c.varName || '').trim();
      const imageVarMode = n.type === 'image' && (c.sourceMode || 'selector') === 'var';
      if (!vn) errs.push({ id: n.id, msg: `${dn}：变量名必填` });
      else if (!VAR_NAME_RE.test(vn)) errs.push({ id: n.id, msg: `${dn}：变量名「${vn}」含非法字符（允许中文、字母、数字、下划线，≤50 字）` });
      else if (workflow.nodes.filter((m) => ['extract', 'image', 'list'].includes(m.type) && (m.config.varName || '').trim() === vn).length > 1) {
        errs.push({ id: n.id, msg: `变量名「${vn}」重复` });
      }
      if (!imageVarMode && !(c.selector || '').trim()) errs.push({ id: n.id, msg: `${dn}：选择器必填` });
      if ((n.type === 'extract' || n.type === 'list') && c.extractType === 'attr'
        && !(c.attrName || '').trim() && !(n.type === 'list' && (c.fields || []).length)) {
        errs.push({ id: n.id, msg: `${dn}：提取属性值时属性名必填` });
      }
      if (imageVarMode) {
        const sv = (c.srcVar || '').trim();
        if (!sv) errs.push({ id: n.id, msg: `${dn}：图片来源为变量时，必须选择图片 URL 变量` });
        else if (!vars.has(sv)) errs.push({ id: n.id, msg: `${dn}：变量「${sv}」未定义` });
      }
      if (n.type === 'image' && !imageVarMode && !(c.attrName || '').trim()) {
        errs.push({ id: n.id, msg: `${dn}：图片属性名必填` });
      }
      if (n.type === 'list' && c.pagingOn && !(c.nextSelector || '').trim()) {
        errs.push({ id: n.id, msg: `${dn}：开启翻页后必须填写下一页选择器` });
      }
      if (n.type === 'list' && Array.isArray(c.fields) && c.fields.length) {
        const keys = new Set();
        c.fields.forEach((fd, i) => {
          const k = (fd.key || '').trim();
          if (!k) errs.push({ id: n.id, msg: `${dn}：第 ${i + 1} 个字段的字段名必填` });
          else if (!VAR_NAME_RE.test(k)) errs.push({ id: n.id, msg: `${dn}：字段名「${k}」含非法字符` });
          else if (keys.has(k)) errs.push({ id: n.id, msg: `${dn}：字段名「${k}」重复` });
          else keys.add(k);
          if ((fd.extractType || 'text') === 'attr' && !(fd.attrName || '').trim()) {
            errs.push({ id: n.id, msg: `${dn}：字段「${k || i + 1}」取属性值时属性名必填` });
          }
        });
      }
      if (c.regexOn && !(n.type === 'list' && (c.fields || []).length)) {
        if (!(c.regexPattern || '').trim()) errs.push({ id: n.id, msg: `${dn}：已开启正则后处理，但正则表达式为空` });
        else {
          try { new RegExp(c.regexPattern, c.regexFlags || 'g'); }
          catch (e) { errs.push({ id: n.id, msg: `${dn}：正则表达式非法（${e.message}）` }); }
        }
      }
    }

    if (n.type === 'loop') {
      const over = (c.overVar || '').trim();
      const iv = (c.itemVar || '').trim();
      if (!over) errs.push({ id: n.id, msg: `${dn}：未指定遍历的集合变量` });
      else if (!defs.has(over) || !defs.get(over).list) errs.push({ id: n.id, msg: `${dn}：集合变量「${over}」不存在或不是集合类型变量` });
      if (!iv) errs.push({ id: n.id, msg: `${dn}：当前项变量名必填` });
      else if (!VAR_NAME_RE.test(iv)) errs.push({ id: n.id, msg: `${dn}：当前项变量名「${iv}」含非法字符` });
    }

    if (n.type === 'condition') {
      const src = (c.sourceVar || '').trim();
      if (!src) errs.push({ id: n.id, msg: `${dn}：未指定来源变量` });
      else if (!vars.has(src)) errs.push({ id: n.id, msg: `${dn}：来源变量「${src}」未定义` });
      if (c.operator !== 'notEmpty' && c.operator !== 'isEmpty' && !(c.compareValue || '').trim()) {
        errs.push({ id: n.id, msg: `${dn}：当前判断条件需要填写比较值` });
      }
    }

    if (n.type === 'assemble') {
      if (!(c.title || '').trim()) errs.push({ id: n.id, msg: '文章组装：文章标题必填' });
      if (!(c.template || '').trim()) errs.push({ id: n.id, msg: '文章组装：Markdown 模板必填' });
      const refs = [...(c.template || '').matchAll(TEMPLATE_REF_RE)]
        .map((m) => m[1].trim())
        .filter((r) => r && !['item', 'index', 'this'].includes(r)
          && !r.startsWith('item.') && !r.startsWith('this.')
          && !r.startsWith('#each') && !r.startsWith('/each'));
      const undef = [...new Set(refs.filter((r) => !vars.has(r)))];
      if (undef.length) errs.push({ id: n.id, msg: `文章组装：模板引用了未定义变量：${undef.join('、')}` });
      // each 块中的集合变量需真实存在
      const eachNames = [...(c.template || '').matchAll(/\{\{#each\s+([^}]+?)\s*\}\}/g)].map((m) => m[1].trim());
      eachNames.forEach((name) => {
        if (!defs.has(name) || !defs.get(name).list) {
          errs.push({ id: n.id, msg: `文章组装：#each 引用的「${name}」不是集合变量` });
        }
      });
    }
  });

  validateBlocks(errs);
  return errs;
}

/* 块配对完整性校验 */
function validateBlocks(errs) {
  const stack = [];
  workflow.nodes.forEach((n) => {
    if (n.type === 'loop' || n.type === 'condition') {
      stack.push(n);
    } else if (n.type === 'loopEnd' || n.type === 'conditionEnd') {
      const want = n.type === 'loopEnd' ? 'loop' : 'condition';
      const top = stack[stack.length - 1];
      if (!top) {
        errs.push({ id: n.id, msg: `${NODE_TYPES[n.type].label}：缺少配对的开始节点` });
      } else if (top.type !== want) {
        errs.push({ id: n.id, msg: `${NODE_TYPES[n.type].label}：与「${NODE_TYPES[top.type].label}」嵌套顺序不匹配` });
        stack.pop();
      } else {
        stack.pop();
      }
    }
  });
  stack.forEach((n) => errs.push({ id: n.id, msg: `${NODE_TYPES[n.type].label}：缺少对应的结束节点` }));
}

/* 区间配对：开始节点 id -> 结束节点下标 */
function buildPairs(nodes) {
  const pairs = new Map();
  const stack = [];
  nodes.forEach((n, i) => {
    if (n.type === 'loop' || n.type === 'condition') {
      stack.push({ type: n.type, id: n.id });
    } else if (n.type === 'loopEnd' || n.type === 'conditionEnd') {
      const want = n.type === 'loopEnd' ? 'loop' : 'condition';
      const top = stack[stack.length - 1];
      if (top && top.type === want) {
        stack.pop();
        pairs.set(top.id, i);
      }
    }
  });
  return pairs;
}

/* 条件求值 */
function evalCondition(node, ctx) {
  const c = node.config;
  const raw = ctx.vars[c.sourceVar];
  const val = Array.isArray(raw) ? raw.join('\n') : (raw == null ? '' : String(raw));
  const cmp = c.compareValue == null ? '' : String(c.compareValue);
  switch (c.operator) {
    case 'isEmpty': return val.trim() === '';
    case 'notEmpty': return val.trim() !== '';
    case 'equals': return val.trim() === cmp.trim();
    case 'notEquals': return val.trim() !== cmp.trim();
    case 'contains': return val.includes(cmp);
    case 'notContains': return !val.includes(cmp);
    case 'gt': return parseFloat(val) > parseFloat(cmp);
    case 'lt': return parseFloat(val) < parseFloat(cmp);
    default: return false;
  }
}

async function runWorkflow() {
  if (running) return;
  const errors = validateWorkflow();
  invalidIds = new Set(errors.map((e) => e.id));
  if (errors.length) {
    switchTab('log');
    log('error', `运行前校验未通过（${errors.length} 项）：`);
    errors.forEach((e) => log('error', '· ' + e.msg));
    renderNodeList();
    return;
  }

  running = true;
  document.body.classList.add('running');
  $('#runBtn').disabled = true;
  $('#runBtn').textContent = '运行中…';
  resetStatuses();
  $('#logList').innerHTML = '';
  lastMarkdown = null;
  lastMarkdowns = [];
  resultIndex = 0;
  renderNodeList();
  switchTab('log');

  const ctx = {
    tabId: null, vars: {}, outputs: [], imgSeq: 0,
    markdown: null, title: '', markdowns: [], loopScope: null,
  };
  const pairs = buildPairs(workflow.nodes);
  log('info', '开始运行工作流…');

  try {
    await execRange(0, workflow.nodes.length, ctx, pairs);
    // 全部成功：按需自动关闭目标标签页
    if (ctx.autoClose && ctx.tabId != null) {
      try { await browser.tabs.remove(ctx.tabId); log('info', '已按配置自动关闭目标标签页。'); }
      catch (e) { /* 标签页可能已被用户关闭，忽略 */ }
    }
    log('success', '工作流执行完成。');
    showOutputs(ctx.outputs);
    if (ctx.markdowns.length) {
      showResults(ctx.markdowns);
      if (ctx.markdowns.length > 1) log('success', `共生成 ${ctx.markdowns.length} 篇 Markdown，可在结果面板切换或批量下载。`);
    } else {
      switchTab('output');
      log('info', '流程中没有文章组装节点，仅展示各节点输出。');
    }
  } catch (err) {
    switchTab('log');
    log('error', `[${err.nodeName || '流程'}] ${err.message}`);
    workflow.nodes.forEach((n) => {
      const s = nodeStatus[n.id];
      if (!s || s === 'running' || s === 'idle') nodeStatus[n.id] = 'skipped';
    });
    log('error', '流程已终止。修正配置后可重新运行。');
  } finally {
    running = false;
    document.body.classList.remove('running');
    $('#runBtn').disabled = false;
    $('#runBtn').textContent = '运行';
    renderNodeList();
  }
}

/* 区间执行：支持循环、条件跳过 */
async function execRange(from, to, ctx, pairs) {
  let i = from;
  while (i < to) {
    const node = workflow.nodes[i];

    if (node.type === 'loop') {
      const end = pairs.get(node.id);
      const items = ctx.vars[node.config.overVar];
      if (!Array.isArray(items)) throw makeNodeError(node, `集合变量「${node.config.overVar}」不存在或不是集合`);
      setStatus(node.id, 'success');
      log('info', `循环「${node.config.overVar}」共 ${items.length} 项，开始遍历。`);
      if (!items.length) log('warn', '集合为空，循环体不会执行。');
      for (let k = 0; k < items.length; k++) {
        ctx.vars[node.config.itemVar] = items[k];
        ctx.loopScope = { index: k + 1, item: items[k] };
        log('info', `· 第 ${k + 1}/${items.length} 项：${preview(items[k])}`);
        await execRange(i + 1, end, ctx, pairs);
      }
      ctx.vars[node.config.itemVar] = '';
      ctx.loopScope = null;
      setStatus(workflow.nodes[end].id, 'success');
      i = end + 1;
      continue;
    }

    if (node.type === 'condition') {
      const end = pairs.get(node.id);
      let ok = false;
      try { ok = evalCondition(node, ctx); }
      catch (e) { throw makeNodeError(node, e.message); }
      setStatus(node.id, ok ? 'success' : 'skipped');
      log(ok ? 'success' : 'info', `条件判断：${nodeSubtitle(node)} → ${ok ? '成立，执行分支' : '不成立，跳过分支'}`);
      if (ok) {
        await execRange(i + 1, end, ctx, pairs);
      } else {
        for (let k = i + 1; k < end; k++) setStatus(workflow.nodes[k].id, 'skipped');
      }
      setStatus(workflow.nodes[end].id, ok ? 'success' : 'skipped');
      i = end + 1;
      continue;
    }

    if (node.type === 'loopEnd' || node.type === 'conditionEnd') { i += 1; continue; }

    setStatus(node.id, 'running');
    log('info', `执行节点：${displayName(node)}`);
    try {
      await runNode(node, ctx);
    } catch (err) {
      setStatus(node.id, 'failed');
      err.nodeName = err.nodeName || displayName(node);
      throw err;
    }
    i += 1;
  }
}

function makeNodeError(node, msg) {
  const e = new Error(msg);
  e.nodeId = node.id;
  e.nodeName = displayName(node);
  return e;
}

function setStatus(id, status) {
  nodeStatus[id] = status;
  renderNodeList();
}

async function runNode(node, ctx) {
  switch (node.type) {
    case 'openTab': {
      await execOpenTab(node, ctx);
      setStatus(node.id, 'success');
      log('success', `页面已加载：${node.config.url}`);
      break;
    }
    case 'extract': {
      const value = await execExtractLike(node, ctx, {
        selectorType: node.config.selectorType || 'css',
        extractType: node.config.extractType,
        attrName: node.config.attrName,
        multiMode: node.config.multiMode,
        joinSep: node.config.joinSep || '\n',
        waitMs: (node.config.waitSec || 0) * 1000,
      });
      ctx.vars[node.config.varName] = value;
      ctx.outputs.push({
        name: Array.isArray(value) ? `${node.config.varName}（${value.length} 项）` : node.config.varName,
        value: stringifyValue(value),
      });
      if (Array.isArray(value)) {
        setStatus(node.id, value.length ? 'success' : 'empty');
        log(value.length ? 'success' : 'warn', `集合 {{${node.config.varName}}} 共 ${value.length} 项`);
      } else {
        setStatus(node.id, value === '' ? 'empty' : 'success');
        log(value === '' ? 'warn' : 'success', `变量 {{${node.config.varName}}} = ${preview(value)}`);
      }
      break;
    }
    case 'list': {
      const values = await execList(node, ctx);
      ctx.vars[node.config.varName] = values;
      ctx.outputs.push({ name: `${node.config.varName}（${values.length} 项）`, value: stringifyValue(values) });
      setStatus(node.id, values.length ? 'success' : 'empty');
      const fieldInfo = (node.config.fields || []).length ? `，字段：${node.config.fields.map((f) => f.key).filter(Boolean).join(' / ')}` : '';
      log(values.length ? 'success' : 'warn', `集合 {{${node.config.varName}}} 共 ${values.length} 项${fieldInfo}`);
      break;
    }
    case 'image': {
      const value = await execImage(node, ctx);
      ctx.vars[node.config.varName] = value;
      ctx.outputs.push({ name: node.config.varName, value });
      setStatus(node.id, value === '' ? 'empty' : 'success');
      log(value === '' ? 'warn' : 'success', `变量 {{${node.config.varName}}} = ${preview(value)}`);
      break;
    }
    case 'assemble': {
      const titleRaw = renderTemplate(node.config.title || '', ctx.vars, ctx.loopScope).trim();
      const title = sanitizeFilename(titleRaw || '未命名文章');
      const markdown = renderTemplate(node.config.template || '', ctx.vars, ctx.loopScope);
      ctx.title = title;
      ctx.markdown = markdown;
      ctx.markdowns.push({ title, markdown });
      setStatus(node.id, markdown.trim() ? 'success' : 'empty');
      log('success', `文章组装完成：${title}，共 ${markdown.length} 字符。`);
      break;
    }
  }
}

function preview(v) {
  const s = stringifyValue(v);
  return s.length > 80 ? s.slice(0, 80) + '…' : (s === '' ? '（空）' : s);
}

/* ----- 打开标签页 ----- */

async function execOpenTab(node, ctx) {
  const { url, openMode, extraWaitSec, autoClose } = node.config;
  const timeoutMs = (settings.pageTimeoutSec || 30) * 1000;
  let tab = null;

  if (openMode === 'current') {
    const editorPrefix = browser.runtime.getURL('');
    const [active] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (active && !active.url.startsWith(editorPrefix) && /^https?:/.test(active.url || '')) {
      tab = await browser.tabs.update(active.id, { url });
    }
  }
  if (!tab) tab = await browser.tabs.create({ url });
  ctx.tabId = tab.id;
  ctx.autoClose = !!autoClose;

  await waitTabComplete(tab.id, timeoutMs);

  const extra = Math.max(0, extraWaitSec || 0);
  if (extra > 0) {
    log('info', `页面已加载，额外等待 ${extra} 秒…`);
    await sleep(extra * 1000);
  }
}

function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`页面加载超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);

    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') { cleanup(); resolve(); }
    }
    function onRemoved(id) {
      if (id === tabId) { cleanup(); reject(new Error('目标标签页已被关闭')); }
    }
    function cleanup() {
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.tabs.onRemoved.removeListener(onRemoved);
    }

    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.onRemoved.addListener(onRemoved);
    // 若创建时已是完成状态（如缓存命中），直接返回
    browser.tabs.get(tabId).then((t) => {
      if (t && t.status === 'complete') { cleanup(); resolve(); }
    }).catch(() => {});
  });
}

async function ensureTabAlive(tabId) {
  try {
    await browser.tabs.get(tabId);
  } catch (e) {
    throw new Error('目标标签页已关闭，后续节点无法执行');
  }
}

/* ----- 提取（通用：文本 / 属性 / 图片地址） ----- */

async function execExtractLike(node, ctx, opts) {
  await ensureTabAlive(ctx.tabId);
  const cfg = node.config;
  let results;
  try {
    results = await browser.scripting.executeScript({
      target: { tabId: ctx.tabId },
      world: 'ISOLATED',
      func: pageExtract,
      args: [{
        selector: cfg.selector,
        selectorType: opts.selectorType || 'css',
        extractType: opts.extractType,
        attrName: opts.attrName || 'src',
        multiMode: opts.multiMode || 'first',
        joinSep: opts.joinSep || '\n',
        waitMs: opts.waitMs || 0,
      }],
    });
  } catch (e) {
    throw new Error('无法在目标页面执行脚本（可能是浏览器内置页面或受限制页面）：' + e.message);
  }
  const r = results && results[0] && results[0].result;
  if (!r) throw new Error('页面脚本无返回结果');
  if (!r.ok) {
    const continueOnMissing = cfg.onMissing === 'continue' || cfg.onFail === 'continue';
    if (continueOnMissing) {
      log('warn', `[${displayName(node)}] ${r.error}，按配置置空并继续。`);
      return opts.multiMode === 'list' ? [] : '';
    }
    throw new Error(r.error);
  }
  // 正则后处理（列表集合逐项处理）
  try {
    if (Array.isArray(r.values)) return r.values.map((v) => applyRegex(v, cfg));
    return applyRegex(r.value, cfg);
  } catch (e) {
    throw makeNodeError(node, e.message);
  }
}

/* 注入目标页面执行的提取函数（必须自包含，不能引用外部变量） */
function pageExtract(cfg) {
  function queryAll() {
    if (cfg.selectorType === 'xpath') {
      const snap = document.evaluate(cfg.selector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const out = [];
      for (let i = 0; i < snap.snapshotLength; i++) out.push(snap.snapshotItem(i));
      return out;
    }
    return Array.from(document.querySelectorAll(cfg.selector)); // 语法错误会抛异常
  }

  function pick(node) {
    if (!node) return '';
    if (cfg.extractType === 'attr') {
      if (node.nodeType !== 1) return '';
      let v = node.getAttribute(cfg.attrName);
      if (v && /^(href|src)$/i.test(cfg.attrName)) {
        try { v = new URL(v, location.href).href; } catch (e) { /* 保留原值 */ }
      }
      return v == null ? '' : v.trim();
    }
    const text = node.nodeType === 1 ? (node.innerText || node.textContent || '') : (node.nodeValue || '');
    return String(text).replace(/\s+/g, ' ').trim();
  }

  return new Promise((resolve) => {
    const start = Date.now();
    (function attempt() {
      let vals;
      try {
        vals = queryAll().map(pick);
      } catch (e) {
        resolve({ ok: false, error: `${cfg.selectorType === 'xpath' ? 'XPath' : 'CSS'} 选择器语法错误：` + e.message });
        return;
      }
      if (vals.length > 0) {
        if (cfg.multiMode === 'list') {
          resolve({ ok: true, values: vals.filter((v) => v !== '') });
          return;
        }
        let value;
        if (cfg.multiMode === 'all') {
          value = vals.filter((v) => v !== '').join(cfg.joinSep);
        } else {
          value = vals[0];
        }
        resolve({ ok: true, value });
        return;
      }
      if (Date.now() - start >= cfg.waitMs) {
        resolve({ ok: false, notFound: true, error: `选择器无匹配元素：${cfg.selector}` });
        return;
      }
      setTimeout(attempt, 200);
    })();
  });
}

/* ----- 批量提取：收集全部匹配项，可翻页累积 ----- */

async function execList(node, ctx) {
  await ensureTabAlive(ctx.tabId);
  const cfg = node.config;
  const fields = (Array.isArray(cfg.fields) ? cfg.fields : []).filter((fd) => (fd.key || '').trim());
  const objectMode = fields.length > 0;
  const maxPages = cfg.pagingOn ? Math.max(1, cfg.maxPages || 1) : 1;
  const seen = new Set();
  const values = [];

  for (let page = 1; page <= maxPages; page++) {
    if (page > 1) await sleep(Math.max(1, cfg.pageWaitSec || 2) * 1000);

    let r;
    try {
      const results = await browser.scripting.executeScript({
        target: { tabId: ctx.tabId },
        world: 'ISOLATED',
        func: pageExtractList,
        args: [{
          selector: cfg.selector,
          selectorType: cfg.selectorType || 'css',
          extractType: cfg.extractType,
          attrName: cfg.attrName || '',
          fields,
          pagingOn: !!cfg.pagingOn,
          nextSelector: cfg.nextSelector || '',
          nextSelectorType: cfg.nextSelectorType || 'css',
        }],
      });
      r = results && results[0] && results[0].result;
    } catch (e) {
      throw makeNodeError(node, '无法在目标页面执行脚本：' + e.message);
    }
    if (!r) throw makeNodeError(node, '页面脚本无返回结果');
    if (!r.ok) throw makeNodeError(node, r.error);

    let added = 0;
    r.values.forEach((raw) => {
      let v = raw;
      if (!objectMode) {
        try { v = applyRegex(raw, cfg); } catch (e) { throw makeNodeError(node, e.message); }
      }
      const sig = typeof v === 'string' ? v : JSON.stringify(v);
      if (sig === '') return;
      if (seen.has(sig)) return;
      seen.add(sig);
      values.push(v);
      added += 1;
    });

    if (!cfg.pagingOn) break;
    if (!r.clicked) {
      if (page === 1) log('warn', `未找到可点击的下一页元素：${cfg.nextSelector || '（未填写）'}`);
      else log('info', `第 ${page} 页后没有更多可翻页元素，翻页结束。`);
      break;
    }
    log('info', `已收集第 ${page} 页，新增 ${added} 项，累计 ${values.length} 项。`);
  }

  if (!values.length) log('warn', `选择器无匹配元素：${cfg.selector}`);
  return values;
}

/* 注入目标页面：收集本页全部匹配值（可为对象）；翻页开启时点击"下一页" */
function pageExtractList(cfg) {
  function queryAll(sel, type, root) {
    const ctx = root || document;
    if (type === 'xpath') {
      const snap = document.evaluate(sel, ctx, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const out = [];
      for (let i = 0; i < snap.snapshotLength; i++) out.push(snap.snapshotItem(i));
      return out.filter((n) => n && n.nodeType === 1);
    }
    return Array.from(ctx.querySelectorAll(sel));
  }

  function pick(el, extractType, attrName) {
    if (extractType === 'attr') {
      let v = el.getAttribute(attrName);
      if (v && /^(href|src)$/i.test(attrName)) {
        try { v = new URL(v, location.href).href; } catch (e) { /* 保留原值 */ }
      }
      return (v == null ? '' : v).trim();
    }
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function pickField(el, fd) {
    let target = el;
    if ((fd.selector || '').trim()) {
      try {
        target = queryAll(fd.selector, fd.selectorType || 'css', el)[0] || null;
      } catch (e) {
        target = null;
      }
    }
    if (!target) return '';
    return pick(target, fd.extractType || 'text', fd.attrName || '');
  }

  try {
    const els = queryAll(cfg.selector, cfg.selectorType);
    let values;
    if (cfg.fields && cfg.fields.length) {
      values = els
        .map((el) => {
          const obj = {};
          cfg.fields.forEach((fd) => { obj[(fd.key || '').trim()] = pickField(el, fd); });
          return obj;
        })
        .filter((obj) => Object.keys(obj).some((k) => obj[k] !== ''));
    } else {
      values = els.map((el) => pick(el, cfg.extractType, cfg.attrName || '')).filter((v) => v !== '');
    }

    let clicked = false;
    if (cfg.pagingOn && values.length) {
      const next = queryAll(cfg.nextSelector, cfg.nextSelectorType)[0];
      if (next && !next.disabled && next.getAttribute('aria-disabled') !== 'true') {
        next.click();
        clicked = true;
      }
    }
    return { ok: true, values, clicked };
  } catch (e) {
    return { ok: false, error: `${cfg.selectorType === 'xpath' ? 'XPath' : 'CSS'} 选择器语法错误：` + e.message };
  }
}

/* ----- 下载图片 ----- */

async function execImage(node, ctx) {
  const cfg = node.config;
  // 1. 取得图片 URL：来自选择器，或来自变量（配合循环实现批量下载）
  let url;
  if ((cfg.sourceMode || 'selector') === 'var') {
    const raw = ctx.vars[cfg.srcVar];
    url = Array.isArray(raw) ? (raw[0] || '') : (raw == null ? '' : String(raw));
    try { url = applyRegex(url, cfg); } catch (e) { throw makeNodeError(node, e.message); }
  } else {
    url = await execExtractLike(node, ctx, {
      selectorType: cfg.selectorType || 'css',
      extractType: 'attr',
      attrName: cfg.attrName || 'src',
      multiMode: 'first',
      waitMs: 5000,
    });
  }
  if (!url) {
    if (cfg.onFail === 'continue') return '';
    throw new Error('图片地址为空');
  }
  if (cfg.refMode === 'url') return url; // 不下载，直接引用原始 URL

  // 2. 下载到本地
  await ensureTabAlive(ctx.tabId);
  ctx.imgSeq += 1;
  const folder = sanitizeFolder(settings.imageFolder);
  const filename = `${folder}/${String(ctx.imgSeq).padStart(3, '0')}${guessExt(url)}`;
  let downloadId;
  try {
    downloadId = await browser.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
  } catch (e) {
    if (cfg.onFail === 'continue') { log('warn', `图片下载失败：${e.message}，按配置置空并继续。`); return ''; }
    throw new Error('图片下载失败：' + e.message);
  }
  try {
    await waitDownload(downloadId, 60000);
  } catch (e) {
    if (cfg.onFail === 'continue') { log('warn', `图片下载失败：${e.message}，按配置置空并继续。`); return ''; }
    throw new Error('图片下载失败：' + e.message);
  }
  return filename; // 相对下载目录的路径，可直接用于 Markdown
}

function guessExt(url) {
  try {
    const path = new URL(url).pathname;
    const m = path.match(/\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i);
    if (m) return m[0].toLowerCase();
  } catch (e) { /* ignore */ }
  return '.jpg';
}

function waitDownload(downloadId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('下载超时')); }, timeoutMs);
    function onChanged(delta) {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete') { cleanup(); resolve(); }
      else if (delta.state.current === 'interrupted') {
        cleanup();
        reject(new Error((delta.error && delta.error.current) || '下载被中断'));
      }
    }
    function cleanup() {
      clearTimeout(timer);
      browser.downloads.onChanged.removeListener(onChanged);
    }
    browser.downloads.onChanged.addListener(onChanged);
  });
}

/* ============================================================
 * 元素选择：在目标网页注入可拖动选择浮层（common/inspector.js）
 * ============================================================ */

let picking = false;
let pickRequestId = null;
let pickNodeId = null;
let pickBtnRef = null;
let pickFieldIndex = null;   // 非空表示正在为批量提取的某个字段点选

/* 找到最近浏览过的普通网页标签页（排除扩展页面自身） */
async function findTargetTab() {
  const selfPrefix = browser.runtime.getURL('');
  const self = await browser.tabs.getCurrent();
  const tabs = await browser.tabs.query({});
  const cands = tabs.filter((t) =>
    /^https?:/i.test(t.url || '')
    && !(t.url || '').startsWith(selfPrefix)
    && (!self || t.id !== self.id)
  );
  if (!cands.length) return null;
  cands.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return cands[0];
}

function resetPickState() {
  picking = false;
  pickRequestId = null;
  pickNodeId = null;
  pickFieldIndex = null;
  if (pickBtnRef) {
    pickBtnRef.classList.remove('picking');
    pickBtnRef.textContent = '选择元素';
  }
  pickBtnRef = null;
}

async function startPicker(node, btn, fieldIndex) {
  if (picking || running) return;
  const tab = await findTargetTab();
  if (!tab) {
    switchTab('log');
    log('error', '未找到可选择的网页：请先打开目标网页（http/https），再回到此处点击“选择元素”。');
    return;
  }

  const forField = Number.isInteger(fieldIndex);
  if (forField) {
    const itemSel = (node.config.selector || '').trim();
    if (!itemSel) {
      switchTab('log');
      log('error', '请先填写或点选“列表项选择器”，再为字段点选元素：字段选择器需要相对列表项生成。');
      return;
    }
    if ((node.config.selectorType || 'css') === 'xpath') {
      switchTab('log');
      log('error', '字段点选暂只支持 CSS 列表项选择器，请先把节点选择器类型切换为 CSS。');
      return;
    }
  }
  picking = true;
  pickNodeId = node.id;
  pickFieldIndex = forField ? fieldIndex : null;
  pickRequestId = 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  pickBtnRef = btn;
  btn.classList.add('picking');
  btn.textContent = '选择中…';

  const args = {
    mode: 'pick',
    requestId: pickRequestId,
    selectorType: forField ? 'css' : (node.config.selectorType || 'css'),
  };
  // 字段映射：把列表项选择器告诉浮层，回传“相对当前列表项”的选择器
  if (forField && node.type === 'list' && (node.config.selector || '').trim()) {
    args.relativeTo = {
      selector: node.config.selector,
      selectorType: node.config.selectorType || 'css',
    };
  }

  try {
    await browser.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      func: wcaInspector,
      args: [args],
    });
    // 切到目标页，让用户看到浮层
    await browser.tabs.update(tab.id, { active: true });
    switchTab('log');
    log('info', forField
      ? `已在「${tab.title || tab.url}」打开选择面板：点击列表项内部的元素，回传的会是相对当前列表项的选择器。`
      : `已在「${tab.title || tab.url}」打开选择面板：打开右上角开关，点击目标元素后点“使用此选择器”。`);
  } catch (e) {
    resetPickState();
    switchTab('log');
    log('error', '无法在目标页面注入选择面板：' + e.message);
  }
}

/* ============================================================
 * Markdown 渲染（轻量实现，用于预览）
 * ============================================================ */

function renderMarkdown(src) {
  const lines = String(src).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inCode = false, codeBuf = [], listType = null, para = [];

  const inline = (s) => escapeHtml(s)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

  function flushPara() {
    if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; }
  }
  function flushList() {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  }

  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      if (inCode) { out.push('<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>'); codeBuf = []; inCode = false; }
      else { flushPara(); flushList(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    const t = line.trim();
    if (!t) { flushPara(); flushList(); continue; }

    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); flushList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }

    if (/^(-{3,}|\*{3,})$/.test(t)) { flushPara(); flushList(); out.push('<hr>'); continue; }

    const ul = t.match(/^[-*]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (listType !== 'ul') { flushList(); out.push('<ul>'); listType = 'ul'; }
      out.push('<li>' + inline(ul[1]) + '</li>');
      continue;
    }
    const ol = t.match(/^\d+\.\s+(.*)$/);
    if (ol) {
      flushPara();
      if (listType !== 'ol') { flushList(); out.push('<ol>'); listType = 'ol'; }
      out.push('<li>' + inline(ol[1]) + '</li>');
      continue;
    }
    const quote = t.match(/^>\s?(.*)$/);
    if (quote) { flushPara(); flushList(); out.push('<blockquote>' + inline(quote[1]) + '</blockquote>'); continue; }

    flushList();
    para.push(t);
  }
  flushPara(); flushList();
  if (inCode) out.push('<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>');
  return out.join('\n');
}

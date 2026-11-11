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
  openTab:  { label: '打开标签页', badge: '页', fixed: true },
  extract:  { label: '提取内容',   badge: '取' },
  image:    { label: '下载图片',   badge: '图' },
  assemble: { label: '文章组装',   badge: '文', unique: true },
};

const DEFAULTS = {
  openTab:  () => ({ url: '', openMode: 'new', extraWaitSec: 0, autoClose: false }),
  extract:  () => ({ varName: '', selector: '', extractType: 'text', attrName: '', multiMode: 'first', joinSep: '\n', waitSec: 5, onMissing: 'stop' }),
  image:    () => ({ varName: '', selector: '', attrName: 'src', refMode: 'local', onFail: 'stop' }),
  assemble: () => ({ title: '', template: '# 文章标题\n\n在此编写正文，使用 {{变量名}} 引用前面节点提取的内容。\n' }),
};

const VAR_NAME_RE = /^[一-龥A-Za-z0-9_]{1,50}$/;
const TEMPLATE_REF_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

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
  if (node.type === 'extract' || node.type === 'image') {
    return node.config.varName ? `${t.label}：${node.config.varName}` : t.label;
  }
  if (node.type === 'assemble') {
    return node.config.title ? `${t.label}：${node.config.title}` : t.label;
  }
  return t.label;
}

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
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { WCAStore.save(state); }, 300);
}

/* ---------- 初始化与页面路由 ---------- */

init();

async function init() {
  state = await WCAStore.load();
  settings = state.settings;

  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  const wf = id ? state.workflows.find((w) => w.id === id) : null;

  if (!wf) { enterHome(); return; }

  workflow = wf;
  ensureOpenTabFirst();
  selectedId = workflow.nodes[0].id;
  resetStatuses();
  document.body.classList.add('editor-mode');
  document.title = `${workflow.name || '未命名工作流'} · TopData`;
  bindEditorUI();
  renderAll();
  log('info', '就绪。搭建节点流程后点击右上角"运行"。');

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
}

function renderHome() {
  const list = $('#homeList');
  list.innerHTML = '';
  const wfs = [...state.workflows].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  $('#homeEmpty').classList.toggle('hidden', wfs.length > 0);

  wfs.forEach((wf) => {
    const card = document.createElement('div');
    card.className = 'wf-card';
    card.innerHTML = `
      <div class="wf-info">
        <div class="wf-name">${escapeHtml(wf.name || '未命名工作流')}</div>
        <div class="wf-meta">${wf.nodes.length} 个节点 · 更新于 ${formatTime(wf.updatedAt)}</div>
      </div>
      <div class="wf-ops">
        <button class="btn btn-primary" data-op="run">运行</button>
        <button class="btn" data-op="rename">重命名</button>
        <button class="btn" data-op="open">编辑</button>
        <button class="btn danger" data-op="del">删除</button>
      </div>`;
    // 点击卡片主体进入编辑
    card.querySelector('.wf-info').addEventListener('click', () => openWorkflow(wf.id));
    card.querySelector('[data-op="open"]').addEventListener('click', () => openWorkflow(wf.id));
    card.querySelector('[data-op="run"]').addEventListener('click', () => openWorkflow(wf.id, true));
    card.querySelector('[data-op="rename"]').addEventListener('click', () => startRename(card, wf));
    card.querySelector('[data-op="del"]').addEventListener('click', () => deleteWorkflow(wf));
    list.appendChild(card);
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

function formatTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
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
  $('#addNodeBtn').addEventListener('click', toggleAddMenu);
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#settingsCancel').addEventListener('click', () => $('#settingsModal').classList.add('hidden'));
  $('#settingsSave').addEventListener('click', saveSettings);

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  $('#copyMdBtn').addEventListener('click', copyMarkdown);
  $('#downloadMdBtn').addEventListener('click', downloadMarkdown);

  // 接收目标页面选择浮层回传的选择器
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'WCA_INSPECTOR_RESULT') return;
    if (!pickRequestId || msg.requestId !== pickRequestId) return;
    const node = getNode(pickNodeId);
    if (msg.selector && node) {
      node.config.selector = msg.selector;
      invalidIds.delete(node.id);
      saveState();
      renderConfigForm();
      renderNodeList();
      switchTab('log');
      log('success', `已填入选择器：${msg.selector}`);
    } else {
      switchTab('log');
      log('info', '已关闭选择面板，未选择元素。');
    }
    resetPickState();
  });

  // 点击页面其它区域时收起"添加节点"菜单
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.add-node-wrap')) $('#addNodeMenu').classList.add('hidden');
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

/* ---------- 节点列表 ---------- */

function renderNodeList() {
  const list = $('#nodeList');
  list.innerHTML = '';
  workflow.nodes.forEach((node, i) => {
    if (i > 0) {
      const conn = document.createElement('div');
      conn.className = 'node-connector';
      list.appendChild(conn);
    }
    const t = NODE_TYPES[node.type];
    const card = document.createElement('div');
    card.className = 'node-card'
      + (node.id === selectedId ? ' selected' : '')
      + (invalidIds.has(node.id) ? ' invalid' : '');

    const sub = nodeSubtitle(node);
    card.innerHTML = `
      <span class="node-badge ${node.type}">${t.badge}</span>
      <div class="node-info">
        <div class="node-name">${escapeHtml(displayName(node))}</div>
        ${sub ? `<div class="node-sub">${escapeHtml(sub)}</div>` : ''}
      </div>
      <span class="node-ops">
        ${!t.fixed ? `<button class="btn" data-op="up" title="上移">↑</button>
        <button class="btn" data-op="down" title="下移">↓</button>
        <button class="btn danger" data-op="del" title="删除">×</button>` : ''}
      </span>
      <span class="status-dot ${nodeStatus[node.id] || 'idle'}" title="${statusTitle(node.id)}"></span>
    `;
    card.addEventListener('click', (e) => {
      const op = e.target.dataset && e.target.dataset.op;
      if (op) { e.stopPropagation(); handleNodeOp(node.id, op); return; }
      selectedId = node.id;
      renderNodeList();
      renderConfigForm();
    });
    list.appendChild(card);
  });
}

function nodeSubtitle(node) {
  const c = node.config;
  switch (node.type) {
    case 'openTab': return c.url || '未配置 URL';
    case 'extract': return c.selector ? `${c.selector} → ${c.extractType === 'attr' ? '@' + (c.attrName || '?') : '文本'}` : '未配置选择器';
    case 'image':   return c.selector ? `${c.selector} → ${c.refMode === 'url' ? '原始URL' : '本地下载'}` : '未配置选择器';
    case 'assemble':return c.title ? `《${c.title}》` : '未配置标题';
    default: return '';
  }
}

function statusTitle(id) {
  return { idle: '未运行', running: '运行中', success: '成功', empty: '成功（空值）', failed: '失败', skipped: '跳过' }[nodeStatus[id]] || '未运行';
}

function handleNodeOp(id, op) {
  const idx = workflow.nodes.findIndex((n) => n.id === id);
  if (idx < 0) return;
  if (op === 'del') {
    workflow.nodes.splice(idx, 1);
    if (selectedId === id) selectedId = workflow.nodes[Math.max(0, idx - 1)].id;
  } else if (op === 'up' && idx > 1) {   // 不能越过起始节点（index 0）
    [workflow.nodes[idx - 1], workflow.nodes[idx]] = [workflow.nodes[idx], workflow.nodes[idx - 1]];
  } else if (op === 'down' && idx < workflow.nodes.length - 1 && idx >= 1) {
    [workflow.nodes[idx + 1], workflow.nodes[idx]] = [workflow.nodes[idx], workflow.nodes[idx + 1]];
  }
  saveState();
  renderNodeList();
  renderConfigForm();
}

/* ---------- 添加节点 ---------- */

function toggleAddMenu() {
  const menu = $('#addNodeMenu');
  if (!menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
  const hasAssemble = workflow.nodes.some((n) => n.type === 'assemble');
  menu.innerHTML = `
    <button data-type="extract"><span class="node-badge extract">取</span>提取内容<span class="menu-desc">文本 / 属性值</span></button>
    <button data-type="image"><span class="node-badge image">图</span>下载图片<span class="menu-desc">保存到本地</span></button>
    <button data-type="assemble" ${hasAssemble ? 'disabled' : ''}><span class="node-badge assemble">文</span>文章组装<span class="menu-desc">${hasAssemble ? '已存在（最多一个）' : '生成 Markdown'}</span></button>
  `;
  menu.querySelectorAll('button[data-type]').forEach((btn) => {
    btn.addEventListener('click', () => {
      addNode(btn.dataset.type);
      menu.classList.add('hidden');
    });
  });
  menu.classList.remove('hidden');
}

function addNode(type) {
  const node = makeNode(type);
  // 插入到选中节点之后；未选中或选中的是最后一个则追加
  const idx = workflow.nodes.findIndex((n) => n.id === selectedId);
  const pos = idx >= 0 ? idx + 1 : workflow.nodes.length;
  workflow.nodes.splice(pos, 0, node);
  nodeStatus[node.id] = 'idle';
  selectedId = node.id;
  saveState();
  renderNodeList();
  renderConfigForm();
}

/* ---------- 配置表单 ---------- */

function renderConfigForm() {
  const box = $('#configForm');
  const node = getNode(selectedId);
  if (!node) { box.innerHTML = '<div class="empty-hint">请选择左侧节点</div>'; return; }
  const t = NODE_TYPES[node.type];
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
      <div class="form-field">
        <label>CSS 选择器<span class="req">*</span></label>
        <div class="picker-row">
          <input type="text" data-k="selector" value="${escapeAttr(c.selector)}" placeholder="如：h1.title  或  .article p">
          <button class="btn" data-action="pick" title="在当前页面上点击元素，自动生成选择器">选择元素</button>
        </div>
        <div class="field-hint">点击“选择元素”后，会在最近浏览的网页上打开选择面板：开启开关、点击目标元素，再点“使用此选择器”回填。</div>
      </div>
      ${f('提取类型', radio('extractType', c.extractType, [['text', '元素文本'], ['attr', '属性值']]), true)}
      <div class="form-field" data-show="attr" ${c.extractType === 'attr' ? '' : 'hidden'}>
        <label>属性名<span class="req">*</span></label>
        <input type="text" data-k="attrName" value="${escapeAttr(c.attrName)}" placeholder="如：href、src、alt、data-id">
        <div class="field-hint">href / src 会自动转为绝对 URL。</div>
      </div>
      ${f('多匹配处理', radio('multiMode', c.multiMode, [['first', '仅第一个'], ['all', '全部（拼接）']]), true)}
      <div class="form-field" data-show="all" ${c.multiMode === 'all' ? '' : 'hidden'}>
        <label>拼接分隔符</label>
        <input type="text" data-k="joinSep" value="${escapeAttr(c.joinSep)}" placeholder="默认换行">
      </div>
      <div class="form-row">
        ${f('等待元素出现（秒）', `<input type="number" data-k="waitSec" min="0" max="60" step="1" value="${c.waitSec}">`, false, '超时时间内持续查找元素，0 表示立即匹配。')}
        ${f('未匹配时', radio('onMissing', c.onMissing, [['stop', '停止并报错'], ['continue', '置空并继续']]), true)}
      </div>`;
  }

  if (node.type === 'image') {
    body = `
      ${f('变量名', `<input type="text" data-k="varName" value="${escapeAttr(c.varName)}" placeholder="如：封面图">`, true, '变量值为 Markdown 图片语法可用的引用路径或原始 URL。')}
      <div class="form-field">
        <label>CSS 选择器<span class="req">*</span></label>
        <div class="picker-row">
          <input type="text" data-k="selector" value="${escapeAttr(c.selector)}" placeholder="如：.cover img">
          <button class="btn" data-action="pick" title="在当前页面上点击图片元素，自动生成选择器">选择元素</button>
        </div>
        <div class="field-hint">建议直接点选页面中的 &lt;img&gt; 元素。</div>
      </div>
      ${f('属性名', `<input type="text" data-k="attrName" value="${escapeAttr(c.attrName)}" placeholder="默认 src">`, false, '取图片地址的属性，默认 src。')}
      ${f('引用方式', radio('refMode', c.refMode, [['local', '下载到本地（相对路径）'], ['url', '不下载，引用原始 URL']]), true)}
      ${f('未匹配 / 下载失败时', radio('onFail', c.onFail, [['stop', '停止并报错'], ['continue', '置空并继续']]), true)}`;
  }

  if (node.type === 'assemble') {
    const vars = workflow.nodes
      .filter((n) => (n.type === 'extract' || n.type === 'image') && n.config.varName)
      .map((n) => n.config.varName);
    const chips = vars.length
      ? vars.map((v) => `<span class="var-chip" data-var="${escapeAttr(v)}">{{${escapeHtml(v)}}}</span>`).join('')
      : '<span class="field-hint">暂无可引用变量，请先添加“提取内容 / 下载图片”节点并填写变量名。</span>';
    body = `
      ${f('文章标题', `<input type="text" data-k="title" value="${escapeAttr(c.title)}" placeholder="下载 .md 时作为文件名">`, true)}
      <div class="form-field">
        <label>Markdown 模板<span class="req">*</span></label>
        <textarea data-k="template" id="templateEditor" spellcheck="false">${escapeHtml(c.template)}</textarea>
        <div class="field-hint">使用 {{变量名}} 引用前面节点的产出，点击下面变量标签可插入到光标处。</div>
        <div class="var-chips">${chips}</div>
      </div>`;
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
}

function nodeDesc(type) {
  return {
    openTab: '起始节点：指定采集目标页面，每个工作流有且仅有一个。',
    extract: '按 CSS 选择器提取元素文本或属性值，产出命名变量。',
    image: '下载页面中的图片到本地，产出可用于 Markdown 的引用变量。',
    assemble: '用前面节点的变量组装 Markdown 短文（每个工作流最多一个）。',
  }[type];
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
  if (node.type === 'extract' && (key === 'extractType' || key === 'multiMode')) {
    const box = $('#configForm');
    const attrField = box.querySelector('[data-show="attr"]');
    const allField = box.querySelector('[data-show="all"]');
    if (attrField) attrField.hidden = node.config.extractType !== 'attr';
    if (allField) allField.hidden = node.config.multiMode !== 'all';
  }
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

function showResult(markdown, title) {
  lastMarkdown = markdown;
  lastTitle = title;
  $('#mdSource').value = markdown;
  $('#mdPreview').innerHTML = renderMarkdown(markdown);
  $('#resultHint').textContent = `《${title}》 共 ${markdown.length} 字符`;
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
  const blob = new Blob([lastMarkdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sanitizeFilename(lastTitle)}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  log('success', `已下载 ${sanitizeFilename(lastTitle)}.md`);
}

/* ============================================================
 * 执行引擎
 * ============================================================ */

function validateWorkflow() {
  const errs = [];
  const vars = new Set();

  // 第一轮：收集全部变量名（与节点顺序无关）
  workflow.nodes.forEach((n) => {
    if ((n.type === 'extract' || n.type === 'image') && (n.config.varName || '').trim()) {
      vars.add(n.config.varName.trim());
    }
  });

  // 第二轮：逐项校验
  workflow.nodes.forEach((n) => {
    const dn = displayName(n);
    if (n.type === 'openTab') {
      if (!/^https?:\/\/\S+/i.test((n.config.url || '').trim())) {
        errs.push({ id: n.id, msg: '起始节点：URL 为空或非法（仅支持 http/https）' });
      }
    }
    if (n.type === 'extract' || n.type === 'image') {
      const vn = (n.config.varName || '').trim();
      if (!vn) errs.push({ id: n.id, msg: `${dn}：变量名必填` });
      else if (!VAR_NAME_RE.test(vn)) errs.push({ id: n.id, msg: `${dn}：变量名「${vn}」含非法字符（允许中文、字母、数字、下划线，≤50 字）` });
      else if (workflow.nodes.filter((m) => (m.type === 'extract' || m.type === 'image') && (m.config.varName || '').trim() === vn).length > 1) {
        errs.push({ id: n.id, msg: `变量名「${vn}」重复` });
      }
      if (!(n.config.selector || '').trim()) errs.push({ id: n.id, msg: `${dn}：CSS 选择器必填` });
      if (n.type === 'extract' && n.config.extractType === 'attr' && !(n.config.attrName || '').trim()) {
        errs.push({ id: n.id, msg: `${dn}：提取属性值时属性名必填` });
      }
    }
    if (n.type === 'assemble') {
      if (!(n.config.title || '').trim()) errs.push({ id: n.id, msg: '文章组装：文章标题必填' });
      if (!(n.config.template || '').trim()) errs.push({ id: n.id, msg: '文章组装：Markdown 模板必填' });
      const refs = [...(n.config.template || '').matchAll(TEMPLATE_REF_RE)].map((m) => m[1].trim());
      const undef = [...new Set(refs.filter((r) => !vars.has(r)))];
      if (undef.length) errs.push({ id: n.id, msg: `文章组装：模板引用了未定义变量：${undef.join('、')}` });
    }
  });

  return errs;
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
  renderNodeList();
  switchTab('log');

  const ctx = { tabId: null, vars: {}, outputs: [], imgSeq: 0, markdown: null, title: '' };
  log('info', '开始运行工作流…');

  try {
    for (let i = 0; i < workflow.nodes.length; i++) {
      const node = workflow.nodes[i];
      setStatus(node.id, 'running');
      log('info', `执行节点：${displayName(node)}`);
      try {
        await runNode(node, ctx);
      } catch (err) {
        setStatus(node.id, 'failed');
        log('error', `[${displayName(node)}] ${err.message}`);
        workflow.nodes.slice(i + 1).forEach((n) => setStatus(n.id, 'skipped'));
        log('error', '流程已终止。修正配置后可重新运行。');
        return;
      }
    }
    // 全部成功：按需自动关闭目标标签页
    if (ctx.autoClose && ctx.tabId != null) {
      try { await chrome.tabs.remove(ctx.tabId); log('info', '已按配置自动关闭目标标签页。'); }
      catch (e) { /* 标签页可能已被用户关闭，忽略 */ }
    }
    log('success', '工作流执行完成。');
    showOutputs(ctx.outputs);
    if (ctx.markdown != null) {
      showResult(ctx.markdown, ctx.title);
    } else {
      switchTab('output');
      log('info', '流程中没有文章组装节点，仅展示各节点输出。');
    }
  } finally {
    running = false;
    document.body.classList.remove('running');
    $('#runBtn').disabled = false;
    $('#runBtn').textContent = '运行';
    renderNodeList();
  }
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
        extractType: node.config.extractType,
        attrName: node.config.attrName,
        multiMode: node.config.multiMode,
        joinSep: node.config.joinSep || '\n',
        waitMs: (node.config.waitSec || 0) * 1000,
      });
      ctx.vars[node.config.varName] = value;
      ctx.outputs.push({ name: node.config.varName, value });
      setStatus(node.id, value === '' ? 'empty' : 'success');
      log(value === '' ? 'warn' : 'success', `变量 {{${node.config.varName}}} = ${preview(value)}`);
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
      ctx.title = sanitizeFilename(node.config.title);
      ctx.markdown = (node.config.template || '').replace(TEMPLATE_REF_RE, (m, name) => {
        const key = name.trim();
        return Object.prototype.hasOwnProperty.call(ctx.vars, key) ? ctx.vars[key] : '';
      });
      setStatus(node.id, 'success');
      log('success', `文章组装完成，共 ${ctx.markdown.length} 字符。`);
      break;
    }
  }
}

function preview(v) {
  const s = String(v);
  return s.length > 80 ? s.slice(0, 80) + '…' : (s === '' ? '（空）' : s);
}

/* ----- 打开标签页 ----- */

async function execOpenTab(node, ctx) {
  const { url, openMode, extraWaitSec, autoClose } = node.config;
  const timeoutMs = (settings.pageTimeoutSec || 30) * 1000;
  let tab = null;

  if (openMode === 'current') {
    const editorPrefix = chrome.runtime.getURL('');
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active && !active.url.startsWith(editorPrefix) && /^https?:/.test(active.url || '')) {
      tab = await chrome.tabs.update(active.id, { url });
    }
  }
  if (!tab) tab = await chrome.tabs.create({ url });
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
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    // 若创建时已是完成状态（如缓存命中），直接返回
    chrome.tabs.get(tabId).then((t) => {
      if (t && t.status === 'complete') { cleanup(); resolve(); }
    }).catch(() => {});
  });
}

async function ensureTabAlive(tabId) {
  try {
    await chrome.tabs.get(tabId);
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
    results = await chrome.scripting.executeScript({
      target: { tabId: ctx.tabId },
      func: pageExtract,
      args: [{
        selector: cfg.selector,
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
      return '';
    }
    throw new Error(r.error);
  }
  return r.value;
}

/* 注入目标页面执行的提取函数（必须自包含，不能引用外部变量） */
function pageExtract(cfg) {
  function readVals() {
    const els = document.querySelectorAll(cfg.selector); // 语法错误会抛异常
    return Array.from(els).map((el) => {
      if (cfg.extractType === 'attr') {
        let v = el.getAttribute(cfg.attrName);
        if (v && /^(href|src)$/i.test(cfg.attrName)) {
          try { v = new URL(v, location.href).href; } catch (e) { /* 保留原值 */ }
        }
        return v == null ? '' : v.trim();
      }
      return (el.innerText || '').replace(/\s+/g, ' ').trim();
    });
  }

  return new Promise((resolve) => {
    const start = Date.now();
    (function attempt() {
      let vals;
      try {
        vals = readVals();
      } catch (e) {
        resolve({ ok: false, error: 'CSS 选择器语法错误：' + e.message });
        return;
      }
      if (vals.length > 0) {
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

/* ----- 下载图片 ----- */

async function execImage(node, ctx) {
  const cfg = node.config;
  // 1. 提取图片 URL（固定等待 5 秒，取第一个匹配）
  const url = await execExtractLike(node, ctx, {
    extractType: 'attr',
    attrName: cfg.attrName || 'src',
    multiMode: 'first',
    waitMs: 5000,
  });
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
    downloadId = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
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
      chrome.downloads.onChanged.removeListener(onChanged);
    }
    chrome.downloads.onChanged.addListener(onChanged);
  });
}

/* ============================================================
 * 元素选择：在目标网页注入可拖动选择浮层（common/inspector.js）
 * ============================================================ */

let picking = false;
let pickRequestId = null;
let pickNodeId = null;
let pickBtnRef = null;

/* 找到最近浏览过的普通网页标签页（排除扩展页面自身） */
async function findTargetTab() {
  const selfPrefix = chrome.runtime.getURL('');
  const self = await chrome.tabs.getCurrent();
  const tabs = await chrome.tabs.query({});
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
  if (pickBtnRef) {
    pickBtnRef.classList.remove('picking');
    pickBtnRef.textContent = '选择元素';
  }
  pickBtnRef = null;
}

async function startPicker(node, btn) {
  if (picking || running) return;
  const tab = await findTargetTab();
  if (!tab) {
    switchTab('log');
    log('error', '未找到可选择的网页：请先打开目标网页（http/https），再回到此处点击“选择元素”。');
    return;
  }

  picking = true;
  pickNodeId = node.id;
  pickRequestId = 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  pickBtnRef = btn;
  btn.classList.add('picking');
  btn.textContent = '选择中…';

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: wcaInspector,
      args: [{ mode: 'pick', requestId: pickRequestId }],
    });
    // 切到目标页，让用户看到浮层
    await chrome.tabs.update(tab.id, { active: true });
    switchTab('log');
    log('info', `已在「${tab.title || tab.url}」打开选择面板：打开右上角开关，点击目标元素后点“使用此选择器”。`);
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

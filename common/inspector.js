/* ============================================================
 * TopData · 页面可视化元素选择浮层（共享）
 *
 * 用法（popup / editor 页面内）：
 *   browser.scripting.executeScript({
 *     target: { tabId },
 *     func: wcaInspector,
 *     args: [{ mode: 'inspect' | 'pick', requestId }],
 *   });
 *
 * 说明：wcaInspector 会被序列化后注入页面执行，函数体内不可引用
 * 任何外部变量。pick 模式在用户确认后通过 browser.runtime.sendMessage
 * 回传 { type: 'WCA_INSPECTOR_RESULT', requestId, selector }。
 * ============================================================ */

'use strict';

function wcaInspector(opts) {
  const MODE = (opts && opts.mode) || 'inspect';
  const REQ = (opts && opts.requestId) || '';
  // 字段映射点选：传入列表项选择器后，回传“相对当前列表项”的选择器
  const REL = (opts && opts.relativeTo) || null;
  const REL_ON = !!(REL && REL.selector && (REL.selectorType || 'css') === 'css');
  const HOST_ID = '__topdata_inspector_host__';

  const existed = document.getElementById(HOST_ID);
  if (existed) existed.remove();

  const COPY_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 5.5A2.5 2.5 0 0 0 12.5 3H6.5A2.5 2.5 0 0 0 4 5.5v6A2.5 2.5 0 0 0 6.5 14"/></svg>';
  const DRAG_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/><circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/></svg>';
  const LIST_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1.4" fill="currentColor" stroke="none"/></svg>';

  /* ---------- 宿主与样式 ---------- */

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    * { box-sizing: border-box; }
    .panel {
      position: fixed; top: 16px; right: 16px; width: 344px;
      max-height: calc(100vh - 32px);
      display: flex; flex-direction: column;
      background: #fff; border-radius: 14px;
      box-shadow: 0 14px 44px rgba(15,23,42,.22), 0 2px 8px rgba(15,23,42,.08);
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
      color: #111827; overflow: hidden;
      border: 1px solid #eef0f4;
    }
    .hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px; flex: 0 0 auto; }
    .drag {
      display: inline-flex; align-items: center; justify-content: center;
      width: 24px; height: 24px; border: 0; background: transparent;
      color: #9ca3af; border-radius: 6px; cursor: grab; padding: 0;
      opacity: 0; transition: opacity .15s;
    }
    .panel:hover .drag { opacity: 1; }
    .drag:active { cursor: grabbing; }
    .brand { font-size: 15px; font-weight: 800; letter-spacing: .2px; color: #111827; }
    .spacer { flex: 1 1 auto; }
    .sw { position: relative; display: inline-flex; align-items: center; cursor: pointer; }
    .sw input { position: absolute; opacity: 0; width: 0; height: 0; }
    .track {
      width: 38px; height: 22px; border-radius: 999px; background: #d1d5db;
      transition: background .18s; display: inline-block; position: relative;
    }
    .track::after {
      content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px;
      border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.25);
      transition: transform .18s;
    }
    .sw input:checked + .track { background: #4f6ef7; }
    .sw input:checked + .track::after { transform: translateX(16px); }
    .x {
      width: 26px; height: 26px; border: 0; background: transparent; font-size: 19px;
      line-height: 1; color: #6b7280; cursor: pointer; border-radius: 6px; padding: 0;
    }
    .x:hover { background: #f3f4f6; color: #111827; }

    .row { display: flex; align-items: center; gap: 6px; padding: 0 12px 10px; flex: 0 0 auto; }
    .stype {
      flex: 0 0 auto; height: 32px; border: 0; border-radius: 9px;
      background: #f3f4f6; color: #374151; font-size: 12px;
      padding: 0 4px 0 7px; outline: none; cursor: pointer;
      font-family: inherit;
    }
    .selwrap {
      flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 6px;
      background: #f3f4f6; border-radius: 9px; padding: 7px 9px;
    }
    .selwrap input {
      flex: 1 1 auto; min-width: 0; border: 0; background: transparent; outline: none;
      font: 12px/1.4 "SF Mono", Menlo, Consolas, monospace; color: #374151;
      text-overflow: ellipsis;
    }
    .ic {
      display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto;
      width: 32px; height: 32px; border: 0; background: #f3f4f6; border-radius: 9px;
      color: #374151; cursor: pointer; padding: 0; transition: background .15s;
    }
    .ic:hover { background: #e5e7eb; }
    .ic.sm { width: 26px; height: 26px; background: #fff; }
    .ic.sm:hover { background: #f3f4f6; }
    .ic.multi.on {
      background: #dcfce7; color: #15803d;
      box-shadow: inset 0 0 0 2px #22c55e;
    }
    .ic.multi.on:hover { background: #bbf7d0; }

    .tabs { display: flex; gap: 18px; padding: 0 12px; border-bottom: 1px solid #eef0f4; flex: 0 0 auto; }
    .tab { padding: 6px 2px 9px; font-size: 13px; color: #6b7280; border-bottom: 2px solid transparent; }
    .tab.on { color: #111827; font-weight: 600; border-bottom-color: #111827; }

    .body { flex: 1 1 auto; overflow-y: auto; padding: 10px 12px 4px; min-height: 0; }
    .idx { font-size: 12px; color: #111827; margin: 2px 0 8px; }
    .attr { margin-bottom: 8px; }
    .attr .k { font-size: 12px; color: #6b7280; margin-bottom: 4px; }
    .attr .v {
      display: flex; align-items: center; gap: 6px;
      background: #f3f4f6; border-radius: 9px; padding: 6px 8px;
    }
    .attr .v span {
      flex: 1 1 auto; min-width: 0; font: 12px/1.5 "SF Mono", Menlo, Consolas, monospace;
      color: #111827; word-break: break-all; max-height: 42px; overflow: hidden;
    }
    .none { color: #9ca3af; font-size: 12px; padding: 6px 0; }
    .foot {
      flex: 0 0 auto; padding: 8px 12px 10px; border-top: 1px solid #eef0f4;
      font-size: 12px; color: #6b7280; text-align: center;
    }
    .use {
      width: 100%; border: 0; border-radius: 9px; padding: 9px 0;
      background: #4f6ef7; color: #fff; font-size: 13px; font-weight: 600;
      cursor: pointer; margin-bottom: 8px;
    }
    .use:hover { background: #3b58d8; }
    .use:disabled { background: #c7d2fe; cursor: not-allowed; }
    .note { margin: 0 0 8px; font-size: 11px; color: #6b7280; line-height: 1.5; }
    .note b { color: #374151; font-weight: 600; }
    .toast {
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      background: #111827; color: #fff; font-size: 12px; padding: 6px 14px;
      border-radius: 999px; opacity: 0; transition: opacity .2s; pointer-events: none;
    }
    .toast.on { opacity: .92; }
    .hl {
      position: fixed; display: none; pointer-events: none;
      border: 2px solid #4f6ef7; background: rgba(79,110,247,.12);
      border-radius: 3px; z-index: 2147483646; transition: all .04s;
    }
  `;
  root.appendChild(style);

  /* ---------- 面板结构 ---------- */

  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `
    <div class="hd">
      <button class="drag" title="按住拖动面板">${DRAG_SVG}</button>
      <span class="brand">TopData</span>
      <span class="spacer"></span>
      <label class="sw" title="可视化选择开关">
        <input type="checkbox" class="tog">
        <span class="track"></span>
      </label>
      <button class="x" title="关闭">×</button>
    </div>
    <div class="row">
      <select class="stype" title="选择器类型">
        <option value="css">CSS</option>
        <option value="xpath">XPath</option>
      </select>
      <div class="selwrap">
        <button class="ic sm copy" data-copy="selector" title="复制选择器">${COPY_SVG}</button>
        <input class="sel" readonly placeholder="尚未选择元素">
      </div>
      <button class="ic multi" title="匹配多个同类元素">${LIST_SVG}</button>
      <button class="ic up" title="选择父元素">↑</button>
      <button class="ic down" title="选择第一个子元素">↓</button>
    </div>
    <div class="tabs"><span class="tab on">属性</span></div>
    <div class="body">
      <div class="idx">未选择元素</div>
      <div class="attrs"><div class="none">打开开关后，点击页面中的元素</div></div>
    </div>
    <div class="foot"></div>
    <div class="toast"></div>
  `;
  root.appendChild(panel);

  const hl = document.createElement('div');
  hl.className = 'hl';
  root.appendChild(hl);

  document.documentElement.appendChild(host);

  /* ---------- 元素引用 ---------- */

  const elToggle = panel.querySelector('.tog');
  const elType = panel.querySelector('.stype');
  const elMulti = panel.querySelector('.multi');
  const elSelInput = panel.querySelector('.sel');
  const elIdx = panel.querySelector('.idx');
  const elAttrs = panel.querySelector('.attrs');
  const elFoot = panel.querySelector('.foot');
  const elToast = panel.querySelector('.toast');
  const elUse = document.createElement('button');

  let current = null;      // 当前选中的元素
  let enabled = false;     // 可视化选择开关
  let selectorOf = '';     // 当前元素对应的选择器
  let selType = 'css';     // 选择器类型：css | xpath
  let pickSeq = 0;         // 选择次数，用于 "#N Element"
  let multi = false;       // 匹配多个同类元素（高亮全部匹配项）
  const marked = [];       // 已加轮廓的元素，保存原内联样式以便还原

  /* ---------- 工具 ---------- */

  function sendMsg(payload) {
    try {
      const p = browser.runtime.sendMessage(payload);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) { /* 无接收方时忽略 */ }
  }

  function toast(text) {
    elToast.textContent = text;
    elToast.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => elToast.classList.remove('on'), 1200);
  }

  function copyText(text) {
    if (!text) return;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    if (!ok && navigator.clipboard) {
      navigator.clipboard.writeText(text).then(
        () => toast('已复制'),
        () => toast('复制失败，请手动选择文本')
      );
      return;
    }
    toast(ok ? '已复制' : '复制失败');
  }

  function buildSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    const segments = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      if (cur.id) { segments.unshift('#' + CSS.escape(cur.id)); break; }
      let seg = cur.tagName.toLowerCase();
      const cls = Array.from(cur.classList).filter((c) => c && c.length < 40).slice(0, 2);
      if (cls.length) seg += '.' + cls.map((c) => CSS.escape(c)).join('.');
      const parent = cur.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (sameTag.length > 1) seg += ':nth-of-type(' + (sameTag.indexOf(cur) + 1) + ')';
      }
      segments.unshift(seg);
      const candidate = segments.join(' > ');
      try {
        if (document.querySelectorAll(candidate).length === 1) return candidate;
      } catch (e) { /* 继续向上拼接 */ }
      cur = cur.parentElement;
    }
    return segments.join(' > ');
  }

  /* 生成 XPath：优先 id，其次逐级带同标签序号的绝对路径 */
  function buildXPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return `//*[@id="${el.id}"]`;
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1) {
      let idx = 1;
      let sib = cur.previousElementSibling;
      while (sib) {
        if (sib.tagName === cur.tagName) idx += 1;
        sib = sib.previousElementSibling;
      }
      parts.unshift(`${cur.tagName.toLowerCase()}[${idx}]`);
      cur = cur.parentElement;
    }
    return '/' + parts.join('/');
  }

  /* 多元素匹配：生成能命中同类的选择器（去掉唯一性限定） */
  function buildMultiSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    const tag = el.tagName.toLowerCase();
    const cls = Array.from(el.classList).filter((c) => c && c.length < 40);
    if (cls.length) return tag + '.' + cls.map((c) => CSS.escape(c)).join('.');
    const parent = el.parentElement;
    if (parent && parent !== document.documentElement) {
      const pTag = parent.tagName.toLowerCase();
      const pCls = Array.from(parent.classList).filter((c) => c && c.length < 40);
      return `${pCls.length ? pTag + '.' + pCls.map((c) => CSS.escape(c)).join('.') : pTag} > ${tag}`;
    }
    return tag;
  }

  function buildMultiXPath(el) {
    if (!el || el.nodeType !== 1) return '';
    const tag = el.tagName.toLowerCase();
    const cls = Array.from(el.classList).filter((c) => c && c.length < 40);
    if (cls.length) {
      const cond = cls
        .map((c) => `contains(concat(" ", normalize-space(@class), " "), " ${c} ")`)
        .join(' and ');
      return `//${tag}[${cond}]`;
    }
    const parent = el.parentElement;
    if (parent && parent !== document.documentElement) {
      return `//${parent.tagName.toLowerCase()}/${tag}`;
    }
    return `//${tag}`;
  }

  /* 相对当前列表项生成选择器：用于批量提取的字段映射 */
  function buildRelativeSelector(el) {
    if (!REL_ON || !el || el.nodeType !== 1) return '';
    let item = null;
    try { item = el.closest(REL.selector); } catch (e) { item = null; }
    // 不在列表项内：退化为同类选择器，至少能在项内命中
    if (!item) return buildMultiSelector(el);
    // 选中的就是列表项本身：留空表示取当前项元素
    if (item === el) return '';

    // 1) 优先 tag.class（项内唯一时）
    const tag = el.tagName.toLowerCase();
    const cls = Array.from(el.classList).filter((c) => c && c.length < 40);
    if (cls.length) {
      const simple = tag + '.' + cls.map((c) => CSS.escape(c)).join('.');
      try {
        const found = item.querySelectorAll(simple);
        if (found.length === 1 && found[0] === el) return simple;
      } catch (e) { /* 继续拼路径 */ }
    }

    // 2) 逐级拼接带 nth-of-type 的相对路径
    const segs = [];
    let cur = el;
    while (cur && cur !== item && cur.nodeType === 1) {
      let seg = cur.tagName.toLowerCase();
      const c1 = Array.from(cur.classList).filter((c) => c && c.length < 40);
      if (c1.length) seg += '.' + CSS.escape(c1[0]);
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) seg += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      segs.unshift(seg);
      const cand = segs.join(' > ');
      try {
        const got = item.querySelectorAll(cand);
        if (got.length === 1 && got[0] === el) return cand;
      } catch (e) { /* 继续向上 */ }
      cur = cur.parentElement;
    }
    return segs.join(' > ');
  }

  /* 重新计算选择器：多元素匹配时使用同类选择器 */
  function updateSelector() {
    if (!current) { selectorOf = ''; return; }
    if (multi) selectorOf = selType === 'xpath' ? buildMultiXPath(current) : buildMultiSelector(current);
    else selectorOf = selType === 'xpath' ? buildXPath(current) : buildSelector(current);
    elSelInput.value = selectorOf;
    updateUseBtn();
  }

  /* 按选择器类型查询全部匹配元素 */
  function queryAllBySelector(sel, type) {
    if (!sel) return [];
    if (type === 'xpath') {
      const snap = document.evaluate(sel, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const out = [];
      for (let i = 0; i < snap.snapshotLength; i++) {
        const n = snap.snapshotItem(i);
        if (n && n.nodeType === 1) out.push(n);
      }
      return out;
    }
    return Array.from(document.querySelectorAll(sel));
  }

  /* 清除多元素高亮，还原元素原样式 */
  function clearMulti() {
    marked.forEach((m) => {
      m.el.style.outline = m.outline;
      m.el.style.outlineOffset = m.offset;
    });
    marked.length = 0;
  }

  /* 高亮当前选择器匹配到的全部元素 */
  function markMulti() {
    clearMulti();
    elMulti.classList.toggle('on', multi);
    if (!multi || !enabled) {
      elFoot.textContent = multi
        ? '已开启多元素匹配，打开右侧开关后选中元素即可高亮同类'
        : (enabled ? '点击页面元素进行选择，Esc 退出选择' : '打开右侧开关后，点击页面元素进行选择');
      return;
    }
    if (!selectorOf) {
      elFoot.textContent = '已开启多元素匹配：选中元素后会高亮全部同类元素';
      return;
    }
    let list = [];
    try { list = queryAllBySelector(selectorOf, selType); } catch (e) { list = []; }
    list.forEach((el) => {
      marked.push({ el, outline: el.style.outline, offset: el.style.outlineOffset });
      el.style.outline = '2px solid #22c55e';
      el.style.outlineOffset = '-1px';
    });
    elFoot.textContent = list.length
      ? `多元素匹配：共 ${list.length} 个同类元素`
      : '多元素匹配：当前选择器没有匹配到元素';
  }

  /* ---------- 渲染选中元素 ---------- */

  function renderElement(el) {
    if (!el || el.nodeType !== 1) return;
    current = el;
    updateSelector();
    pickSeq += 1;
    elIdx.textContent = '#' + pickSeq + '  <' + el.tagName.toLowerCase() + '>';

    const attrs = Array.from(el.attributes || []);
    if (!attrs.length) {
      elAttrs.innerHTML = '<div class="none">该元素没有属性</div>';
    } else {
      elAttrs.innerHTML = attrs.map((a) => {
        const val = a.value == null ? '' : String(a.value);
        return `<div class="attr"><div class="k">${escapeHtml(a.name)}</div>`
          + `<div class="v"><span>${escapeHtml(val)}</span>`
          + `<button class="ic sm copy" data-copy="attr" data-val="${escapeAttr(val)}" title="复制">${COPY_SVG}</button></div></div>`;
      }).join('');
    }
    updateUseBtn();
    markMulti();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  /* ---------- 开关与点选 ---------- */

  function setEnabled(v) {
    enabled = v;
    elToggle.checked = v;
    hl.style.display = 'none';
    elFoot.textContent = v ? '点击页面元素进行选择，Esc 退出选择' : '打开右侧开关后，点击页面元素进行选择';
    if (!v) {
      document.body.style.cursor = '';
      clearMulti();
      markMulti();
    }
  }

  function onMove(e) {
    if (!enabled) return;
    if (e.composedPath && e.composedPath().indexOf(host) !== -1) { hl.style.display = 'none'; return; }
    const el = e.target;
    if (!el || el.nodeType !== 1 || el === host) return;
    const r = el.getBoundingClientRect();
    hl.style.display = 'block';
    hl.style.left = r.left + 'px';
    hl.style.top = r.top + 'px';
    hl.style.width = r.width + 'px';
    hl.style.height = r.height + 'px';
  }

  function onClick(e) {
    if (!enabled) return;
    if (e.composedPath && e.composedPath().indexOf(host) !== -1) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    renderElement(e.target);
  }

  function onKey(e) {
    if (e.key !== 'Escape') return;
    if (enabled) { setEnabled(false); e.preventDefault(); return; }
    close();
  }

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);

  /* ---------- 交互绑定 ---------- */

  elToggle.addEventListener('change', () => setEnabled(elToggle.checked));

  // 切换选择器类型：按当前元素重新生成
  elType.addEventListener('change', () => {
    selType = elType.value;
    updateSelector();
    markMulti();
  });

  // 匹配多个同类元素：切换为同类选择器并高亮全部匹配项
  elMulti.addEventListener('click', () => {
    multi = !multi;
    updateSelector();
    markMulti();
    toast(multi ? '已开启多元素匹配' : '已关闭多元素匹配');
  });

  panel.querySelector('.x').addEventListener('click', () => close());

  panel.querySelector('.up').addEventListener('click', () => {
    if (!current || !current.parentElement) return;
    renderElement(current.parentElement);
  });
  panel.querySelector('.down').addEventListener('click', () => {
    if (!current || !current.firstElementChild) return;
    renderElement(current.firstElementChild);
  });

  panel.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('[data-copy]');
    if (!btn) return;
    copyText(btn.dataset.copy === 'selector' ? elSelInput.value : (btn.dataset.val || ''));
  });

  /* 拖动：按住左上角拖动图标移动整个面板 */
  const dragBtn = panel.querySelector('.drag');
  dragBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const rect = panel.getBoundingClientRect();
    const dx = e.clientX - rect.left;
    const dy = e.clientY - rect.top;
    panel.style.right = 'auto';
    panel.style.left = rect.left + 'px';
    panel.style.top = rect.top + 'px';
    try { dragBtn.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }

    const onDragMove = (ev) => {
      let x = ev.clientX - dx;
      let y = ev.clientY - dy;
      x = Math.max(4, Math.min(window.innerWidth - rect.width - 4, x));
      y = Math.max(4, Math.min(window.innerHeight - 80, y));
      panel.style.left = x + 'px';
      panel.style.top = y + 'px';
    };
    const onDragEnd = () => {
      window.removeEventListener('pointermove', onDragMove);
      window.removeEventListener('pointerup', onDragEnd);
    };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
  });

  /* ---------- pick 模式：确认按钮 ---------- */

  if (MODE === 'pick') {
    elUse.className = 'use';
    elUse.textContent = REL_ON ? '使用此选择器（相对列表项）' : '使用此选择器';
    elUse.disabled = true;
    panel.querySelector('.foot').before(elUse);
    if (REL_ON) {
      const note = document.createElement('div');
      note.className = 'note';
      note.innerHTML = '字段模式：回传的选择器会写成相对列表项 <b>' + escapeHtml(REL.selector) + '</b> 的写法；选中列表项本身则留空（取当前项元素）。';
      elUse.before(note);
    }
    elUse.addEventListener('click', () => {
      if (!selectorOf) return;
      const payload = {
        type: 'WCA_INSPECTOR_RESULT',
        requestId: REQ,
        selector: selectorOf,
        selectorType: selType,
        multiMatch: multi,
      };
      if (REL_ON) {
        payload.relative = true;
        payload.relativeSelector = buildRelativeSelector(current);
      }
      sendMsg(payload);
      close(true);
    });
  }

  function updateUseBtn() {
    if (MODE === 'pick') elUse.disabled = !selectorOf;
  }

  /* ---------- 关闭 ---------- */

  function close(keepQuiet) {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    clearMulti();
    host.remove();
    if (!keepQuiet) {
      sendMsg({ type: 'WCA_INSPECTOR_RESULT', requestId: REQ, selector: null, closed: true });
    }
  }

  setEnabled(false);
  if (opts && (opts.selectorType === 'xpath' || opts.selectorType === 'css')) {
    selType = opts.selectorType;
    elType.value = selType;
  }
  return { ok: true };
}

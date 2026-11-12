/* ============================================================
 * 网页采集助手 · 共享存储模块
 * 编辑器（editor）与图标弹窗（popup）共用，保证数据结构一致。
 *
 * browser.storage.local 结构：
 *   state: {
 *     workflows: [{ id, name, nodes: [{id, type, config}], updatedAt, createdAt, folderId }],
 *     folders:   [{ id, name, createdAt }],
 *     settings:  { pageTimeoutSec, imageFolder }
 *   }
 *   folderId 为 null 表示未分组，仅出现在「全部」里。
 * ============================================================ */

'use strict';

const WCAStore = (() => {
  const KEY = 'state';
  const DEFAULT_SETTINGS = { pageTimeoutSec: 30, imageFolder: 'web-collector/images' };

  function uid(prefix) {
    return (prefix || 'n_') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // 起始节点默认配置（与编辑器 DEFAULTS.openTab 保持一致）
  function defaultOpenTabConfig() {
    return { url: '', openMode: 'new', extraWaitSec: 0, autoClose: false };
  }

  // 新建工作流：自带一个"打开标签页"起始节点
  function makeWorkflow(name, folderId) {
    const now = Date.now();
    return {
      id: uid('w_'),
      name: name || '未命名工作流',
      nodes: [{ id: uid(), type: 'openTab', config: defaultOpenTabConfig() }],
      updatedAt: now,
      createdAt: now,
      folderId: folderId || null,
    };
  }

  // 新建文件夹
  function makeFolder(name) {
    return { id: uid('f_'), name: name || '新建文件夹', createdAt: Date.now() };
  }

  // 读取全部状态；旧版本（单工作流 workflow/settings 两个 key）自动迁移
  async function load() {
    const data = await browser.storage.local.get([KEY, 'workflow', 'settings']);
    let state = data[KEY];
    if (!state || !Array.isArray(state.workflows)) {
      state = {
        workflows: [],
        folders: [],
        settings: Object.assign({}, DEFAULT_SETTINGS, data.settings || {}),
      };
      if (data.workflow && Array.isArray(data.workflow.nodes)) {
        state.workflows.push({
          id: uid('w_'),
          name: data.workflow.name || '未命名工作流',
          nodes: data.workflow.nodes,
          updatedAt: Date.now(),
          createdAt: Date.now(),
          folderId: null,
        });
      }
      await browser.storage.local.set({ [KEY]: state });
      await browser.storage.local.remove(['workflow', 'settings']);
    }
    // 兼容旧数据：补齐 folders / createdAt / folderId
    if (!Array.isArray(state.folders)) state.folders = [];
    state.workflows.forEach((wf) => {
      if (!wf.createdAt) wf.createdAt = wf.updatedAt || Date.now();
      if (wf.folderId === undefined) wf.folderId = null;
    });
    state.settings = Object.assign({}, DEFAULT_SETTINGS, state.settings || {});
    return state;
  }

  function save(state) {
    return browser.storage.local.set({ [KEY]: state });
  }

  return { KEY, DEFAULT_SETTINGS, uid, makeWorkflow, makeFolder, load, save };
})();

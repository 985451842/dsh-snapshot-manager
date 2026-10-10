/**
 * dsh-snapshot-manager — 浏览器半边（手写 __ModuleLoader__ bundle，无构建步骤）。
 *
 * 只依赖平台冻结的 seed：react / react/jsx-runtime。
 * UI 一律用自带 DOM + 主题变量（--dsw-alias-*），避免依赖 primitives 的导出面。
 *
 * 三个挂载点：
 *   conversation.session.header.actions  会话头部「快照」按钮
 *   conversation.chat.turnTail           每轮尾部「回到本轮开始 / 编辑并重来」
 *   shell.overlay                        快照时间线面板（含预览与回滚）
 */
window.__ModuleLoader__.load({
  id: 'dsh-snapshot-manager',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const jsxRuntime = require('react/jsx-runtime');
    const jsx = jsxRuntime.jsx;
    const jsxs = jsxRuntime.jsxs;
    const Fragment = jsxRuntime.Fragment;

    /** 接口前缀，与 Host 半边 host.js 的 ROUTE_VERSION 保持一致。 */
    const API = '/api/snapshot-manager/v3';

    /** 构建标记（每轮 UI 迭代递增，便于确认浏览器加载的是哪一版）。 */
    const BUILD = 'dev-5';

    /** 本地化命名空间。 */
    const NS = 'snapshot-manager';

    const zh = {
      'header.open': '快照',
      'panel.title': '会话快照 / 回滚',
      'panel.refresh': '刷新',
      'panel.capture': '立即打快照',
      'panel.close': '关闭',
      'panel.empty': '这个会话还没有快照。每个轮次开始/结束会自动采集一次。',
      'panel.loading': '读取中…',
      'panel.error': '出错了',
      'panel.col.time': '时间',
      'panel.col.phase': '阶段',
      'panel.col.turn': '轮次',
      'panel.col.changes': '改动',
      'panel.col.label': '说明',
      'panel.preview': '预览',
      'panel.rollback': '回滚…',
      'panel.rollbackHint': '展开回滚选项：可勾选恢复文件 / 回退对话，并可选择是否把输入发进新会话',
      'panel.selected': '已选快照',
      'panel.delete': '删除',
      'panel.phase.start': '起点',
      'panel.phase.end': '结果',
      'panel.phase.baseline': '基线',
      'panel.phase.manual': '手动',
      'panel.phase.prerollback': '回滚前',
      'panel.showEnd': '显示结果快照',
      'panel.showEnd.hint': '回滚语义统一为"回到本轮之前"，因此每轮只保留一条起点快照；这里是历史遗留的"结果"快照，默认折叠',
      'panel.onlyEndHidden': '当前只有历史遗留的"结果"快照，勾选上方「显示结果快照」即可查看',
      'panel.plan.restore': '将恢复',
      'panel.plan.remove': '将删除',
      'panel.plan.unchanged': '保持不变',
      'panel.plan.none': '工作区与这个时点一致，无需改动。',
      'panel.plan.conversation': '对话将回退到该时点之后（原会话完整保留）',
      'panel.opt.files': '恢复文件',
      'panel.opt.conversation': '回退对话（生成新会话）',
      'panel.edit.hint': '编辑后重来（这段文本预填的是该时点的用户输入）',
      'panel.opt.send': '回滚后自动发送这段输入',
      'panel.send.on': '将执行：回滚 + 把上面的输入发进新会话继续跑',
      'panel.send.off': '将执行：仅回滚（不发送任何输入，你在新会话里自己重新输入）',
      'panel.do': '执行回滚',
      'panel.cancel': '取消',
      'panel.busy': '执行中…',
      'panel.report': '回滚完成',
      'panel.report.files': '文件：恢复 {r} 个，删除 {x} 个，失败 {f} 个',
      'panel.report.new': '新会话：{id}',
      'panel.report.open': '打开新会话',
      'panel.report.sent': '已把编辑后的输入发进新会话',
      'panel.recovery': '回滚前恢复点：{id}',
      'panel.warn': '注意',
      'tail.back': '回到本轮开始',
      'tail.edit': '编辑并重来',
      'tail.back.hint': '把这轮的文件与对话退回到本轮输入之前，不发送任何输入（你在新会话里自己重新输入）',
      'tail.edit.hint': '就地编辑当轮原话并回退到本轮之前：可勾选是否发送、是否恢复文件、是否回退对话',
      'settings.archive.label': '归档列表',
      'archive.title': '归档列表',
      'archive.search': '搜索',
      'archive.searchPlaceholder': '在归档会话里搜索关键词…',
      'archive.empty': '没有归档的会话。',
      'archive.view': '查看',
      'archive.unarchive': '取消归档',
      'archive.delete': '删除',
      'archive.trashHint': '移入回收站：可还原',
      'archive.confirmDelete': '确认移入回收站？',
      'archive.hardDelete': '物理删除',
      'archive.hardDeleteHint': '物理删除：日志直接从磁盘抹掉，不可恢复',
      'archive.confirmHardDelete': '确认物理删除（不可恢复）？',
      'archive.hardDeleted': '已物理删除该会话日志',
      'archive.stillOnDisk': '警告：文件仍在磁盘上',
      'archive.trash': '回收站',
      'archive.trashEmpty': '回收站是空的。',
      'archive.restore': '还原',
      'archive.purge': '彻底删除',
      'archive.purgeAll': '清空回收站',
      'archive.confirmPurge': '确认彻底删除（不可撤销）？',
      'archive.running': '运行中',
      'archive.transcript': '对话记录',
      'archive.noTranscript': '选择左侧会话查看记录',
      'archive.transcriptOf': '对话记录',
      'archive.entries': '条',
      'archive.createdAt': '创建于',
      'archive.trashedAt': '删除于',
      'archive.hits': '命中',
      'archive.purged': '已彻底删除 {n} 条',
      'archive.restoredTrash': '已还原到原位置',
      'archive.trashed': '已移入回收站，可随时还原',
      'archive.unarchived': '已取消归档',
      'archive.missing': '日志缺失',
      'archive.lingering': '已删标记',
      'archive.lingeringHint': '归档标记已被物理移除、日志在回收站里。因为 DSH 只是把会话从归档集合中移除，界面上可能仍记得这个会话（刷新页面或重启应用后消失），这是官方没有删除接口导致的。',
      'archive.prune': '物理清理归档标记（{n}）',
      'archive.pruneHint': '这些归档条目的日志已经不存在了（历史删除留下的残留标记）。点击即调用官方接口把它们从归档集合中真正移除。',
      'archive.pruned': '已物理移除 {n} 条归档标记',
      'archive.cleanup': '清理快照垃圾',
      'archive.cleanupHint': '删除孤立快照（会话已不存在）、回收没有任何快照引用的内容对象，并把历史遗留的非规范化工作区索引归并掉。',
      'archive.cleaned': '已清理孤立快照 {s} 个会话、回收对象 {o} 个（{kb} KB）、归并索引 {k} 个',
      'archive.loading': '读取中…',
    };

    const en = {
      'header.open': 'Snapshots',
      'panel.title': 'Session snapshots / rollback',
      'panel.refresh': 'Refresh',
      'panel.capture': 'Snapshot now',
      'panel.close': 'Close',
      'panel.empty': 'No snapshots yet. They are captured automatically at each turn boundary.',
      'panel.loading': 'Loading…',
      'panel.error': 'Error',
      'panel.col.time': 'Time',
      'panel.col.phase': 'Phase',
      'panel.col.turn': 'Turn',
      'panel.col.changes': 'Changes',
      'panel.col.label': 'Label',
      'panel.preview': 'Preview',
      'panel.rollback': 'Roll back…',
      'panel.rollbackHint': 'Reveal rollback options: restore files / rewind conversation, and choose whether the input is sent',
      'panel.selected': 'Selected snapshot',
      'panel.delete': 'Delete',
      'panel.phase.start': 'start',
      'panel.phase.end': 'result',
      'panel.phase.baseline': 'baseline',
      'panel.phase.manual': 'manual',
      'panel.phase.prerollback': 'pre-rollback',
      'panel.showEnd': 'Show result snapshots',
      'panel.showEnd.hint': 'Rollback now always means "back to just before this turn", so each turn keeps a single start snapshot; these are legacy "result" snapshots, collapsed by default',
      'panel.onlyEndHidden': 'Only legacy "result" snapshots exist here; tick "Show result snapshots" above to see them',
      'panel.plan.restore': 'to restore',
      'panel.plan.remove': 'to delete',
      'panel.plan.unchanged': 'unchanged',
      'panel.plan.none': 'Workspace already matches this point.',
      'panel.plan.conversation': 'Conversation rewinds after this point (original session kept)',
      'panel.opt.files': 'Restore files',
      'panel.opt.conversation': 'Rewind conversation (new session)',
      'panel.edit.hint': 'Edit and retry (prefilled with the user input at that point)',
      'panel.opt.send': 'Send this input to the new session after rollback',
      'panel.send.on': 'Will do: roll back + send the input above into the new session',
      'panel.send.off': 'Will do: roll back only (nothing is sent; you type in the new session)',
      'panel.do': 'Roll back',
      'panel.cancel': 'Cancel',
      'panel.busy': 'Working…',
      'panel.report': 'Rollback finished',
      'panel.report.files': 'Files: {r} restored, {x} deleted, {f} failed',
      'panel.report.new': 'New session: {id}',
      'panel.report.open': 'Open new session',
      'panel.report.sent': 'Edited input was sent to the new session',
      'panel.recovery': 'Recovery point: {id}',
      'panel.warn': 'Warning',
      'tail.back': 'Back to turn start',
      'tail.edit': 'Edit & retry',
      'tail.back.hint': 'Rewind this turn\'s files and conversation to just before its input, and send nothing (you retype in the new session)',
      'tail.edit.hint': 'Edit this turn\'s original input in place and rewind: choose whether to send, restore files, and rewind the conversation',
      'settings.archive.label': 'Archive list',
      'archive.title': 'Archive list',
      'archive.search': 'Search',
      'archive.searchPlaceholder': 'Search keywords in archived sessions…',
      'archive.empty': 'No archived sessions.',
      'archive.view': 'View',
      'archive.unarchive': 'Unarchive',
      'archive.delete': 'Delete',
      'archive.trashHint': 'Move to trash: restorable',
      'archive.confirmDelete': 'Move to trash?',
      'archive.hardDelete': 'Delete permanently',
      'archive.hardDeleteHint': 'Permanently delete: the log is erased from disk, no recovery',
      'archive.confirmHardDelete': 'Delete permanently (no recovery)?',
      'archive.hardDeleted': 'Session log permanently deleted',
      'archive.stillOnDisk': 'warning: files still on disk',
      'archive.trash': 'Trash',
      'archive.trashEmpty': 'Trash is empty.',
      'archive.restore': 'Restore',
      'archive.purge': 'Delete permanently',
      'archive.purgeAll': 'Empty trash',
      'archive.confirmPurge': 'Delete permanently (cannot be undone)?',
      'archive.running': 'running',
      'archive.transcript': 'Transcript',
      'archive.noTranscript': 'Select a session on the left',
      'archive.transcriptOf': 'Transcript',
      'archive.entries': 'entries',
      'archive.createdAt': 'created',
      'archive.trashedAt': 'trashed',
      'archive.hits': 'hits',
      'archive.purged': 'Permanently deleted {n} item(s)',
      'archive.restoredTrash': 'Restored to its original location',
      'archive.trashed': 'Moved to trash (restorable)',
      'archive.unarchived': 'Unarchived',
      'archive.missing': 'log missing',
      'archive.lingering': 'marker removed',
      'archive.lingeringHint': 'The archive marker was physically removed and the log is in the trash. DSH only drops the session from the archive set, so the UI may still remember it until you refresh the page or restart the app — there is no official delete API.',
      'archive.prune': 'Physically remove archive markers ({n})',
      'archive.pruneHint': 'These archived entries have no log left (leftovers from earlier deletions). Clicking calls the official API to actually remove them from the archive set.',
      'archive.pruned': 'Physically removed {n} archive markers',
      'archive.cleanup': 'Clean snapshot store',
      'archive.cleanupHint': 'Deletes orphan snapshots (session no longer exists), reclaims content objects no snapshot references, and merges legacy non-normalized workspace index keys.',
      'archive.cleaned': 'Cleaned {s} orphan sessions, reclaimed {o} objects ({kb} KB), merged {k} index keys',
      'archive.loading': 'Loading…',
    };

    /* ------------------------------------------------------------------ *
     * 共享面板状态（header 按钮 / 每轮按钮 / overlay 面板三处共用）
     * ------------------------------------------------------------------ */
    const panelState = {
      open: false,
      /** 'snapshots' | 'archive' */
      mode: 'snapshots',
      sessionId: null,
      focusTurn: null,
      editMode: false,
      listeners: new Set(),
      set(patch) {
        Object.assign(this, patch);
        for (const listener of [...this.listeners]) {
          try {
            listener();
          } catch {
            /* 忽略 */
          }
        }
      },
      subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
    };

    /** 订阅面板状态的 hook。 */
    function usePanelState() {
      const [, force] = react.useReducer((n) => n + 1, 0);
      react.useEffect(() => panelState.subscribe(force), []);
      return panelState;
    }

    /* ------------------------------------------------------------------ *
     * 样式（全部走主题变量，自动适配明暗）
     * ------------------------------------------------------------------ */
    const S = {
      btn: {
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '18px',
        padding: '1px 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        color: 'var(--dsw-alias-label-primary, inherit)',
        cursor: 'pointer',
      },
      btnPrimary: {
        border: '1px solid var(--dsw-alias-button-primary-fill, #3b82f6)',
        background: 'var(--dsw-alias-button-primary-fill, #3b82f6)',
        color: '#fff',
      },
      btnDanger: {
        border: '1px solid var(--dsw-alias-state-error-secondary, rgba(200,60,60,.5))',
        color: 'var(--dsw-alias-state-error-secondary, #c33)',
      },
      overlay: {
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,.45))',
        pointerEvents: 'auto',
      },
      card: {
        width: 'min(880px, 92vw)',
        maxHeight: '84vh',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: '12px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))',
        background: 'var(--dsw-alias-bg-layer-1, #1b1b1d)',
        color: 'var(--dsw-alias-label-primary, #eee)',
        boxShadow: 'var(--dsw-shadow-lv3, 0 12px 40px rgba(0,0,0,.35))',
        overflow: 'hidden',
        fontSize: '13px',
      },
      head: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '10px 14px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2))',
      },
      title: { fontWeight: 600, marginRight: 'auto' },
      body: { overflow: 'auto', padding: '10px 14px' },
      row: {
        display: 'grid',
        gridTemplateColumns: '58px 52px 44px 64px 1fr auto',
        gap: '8px',
        alignItems: 'center',
        padding: '5px 0',
        borderBottom: '1px dashed var(--dsw-alias-border-l1, rgba(128,128,128,.16))',
      },
      chip: {
        fontSize: '11px',
        padding: '0 6px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))',
        color: 'var(--dsw-alias-label-secondary, #aaa)',
        textAlign: 'center',
      },
      muted: { color: 'var(--dsw-alias-label-secondary, #9a9a9a)', fontSize: '12px' },
      detail: {
        margin: '6px 0 10px',
        padding: '8px 10px',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2))',
      },
      mono: { fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)', fontSize: '12px' },
      input: {
        width: '100%',
        minHeight: '54px',
        resize: 'vertical',
        font: 'inherit',
        padding: '6px 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        color: 'inherit',
      },
      error: { color: 'var(--dsw-alias-state-error-secondary, #e66)' },
      archiveRow: {
        display: 'flex',
        gap: '8px',
        alignItems: 'center',
        padding: '6px 6px',
        borderBottom: '1px dashed var(--dsw-alias-border-l1, rgba(128,128,128,.16))',
      },
    };

    /** 组合按钮样式。 */
    const btn = (...extra) => Object.assign({}, S.btn, ...extra);

    /**
     * 统一的 JSON 请求。
     * @param {string} path - 相对 API 路径。
     * @param {object} [init] - fetch 选项。
     * @returns {Promise<object>} 解析后的响应体。
     */
    async function call(path, init) {
      const response = await fetch(`${API}${path}`, init);
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok || body === null || body.ok !== true) {
        throw new Error(body?.error ?? `HTTP ${response.status}`);
      }
      return body;
    }

    /** 阶段标签。 */
    const phaseLabel = (phase, t) => {
      if (phase === 'start') return t('panel.phase.start');
      if (phase === 'end') return t('panel.phase.end');
      if (phase === 'baseline') return t('panel.phase.baseline');
      if (phase === 'pre-rollback') return t('panel.phase.prerollback');
      return t('panel.phase.manual');
    };

    /** 时间格式化。 */
    const clockOf = (at) => {
      const date = new Date(at ?? Date.now());
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    };

    /* ------------------------------------------------------------------ *
     * 归档会话管理器
     * ------------------------------------------------------------------ */
    function ArchivePanel(props) {
      const t = props.t ?? ((key) => key);
      const state = usePanelState();

      const [sessions, setSessions] = react.useState([]);
      const [trash, setTrash] = react.useState([]);
      const [query, setQuery] = react.useState('');
      const [hits, setHits] = react.useState(null);
      const [selected, setSelected] = react.useState(null);
      const [transcript, setTranscript] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState(null);
      const [notice, setNotice] = react.useState(null);
      const [confirm, setConfirm] = react.useState(null);

      const loadArchived = react.useCallback(async () => {
        try {
          const body = await call('/archived');
          setSessions(body.items ?? []);
        } catch (caught) {
          setError(String(caught?.message ?? caught));
        }
      }, []);

      const loadTrash = react.useCallback(async () => {
        try {
          const body = await call('/trash');
          setTrash(body.items ?? []);
        } catch (caught) {
          setError(String(caught?.message ?? caught));
        }
      }, []);

      react.useEffect(() => {
        // 内联（设置页）模式下面板状态无关，挂载即载入
        if (props.inline !== true && (!state.open || state.mode !== 'archive')) return undefined;
        let cancelled = false;
        setError(null);
        (async () => {
          await Promise.all([loadArchived(), loadTrash()]);
          if (cancelled) return;
        })();
        return () => {
          cancelled = true;
        };
      }, [state.open, state.mode, loadArchived, loadTrash]);

      if (props.inline !== true && (!state.open || state.mode !== 'archive')) return null;

      const openTranscript = async (sessionId) => {
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
          const body = await call(`/transcript?sessionId=${encodeURIComponent(sessionId)}&limit=200`);
          setSelected(sessionId);
          setTranscript(body);
        } catch (caught) {
          setError(String(caught?.message ?? caught));
        } finally {
          setBusy(false);
        }
      };

      const search = async () => {
        const needle = query.trim();
        if (needle.length === 0) {
          setHits(null);
          return;
        }
        setBusy(true);
        setError(null);
        try {
          const body = await call(`/searchArchived?q=${encodeURIComponent(needle)}`);
          setHits(body.items ?? []);
        } catch (caught) {
          setError(String(caught?.message ?? caught));
        } finally {
          setBusy(false);
        }
      };

      const unarchive = async (sessionId) => {
        setBusy(true);
        setError(null);
        try {
          await call('/unarchive', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          });
          setNotice(t('archive.unarchived'));
          await loadArchived();
        } catch (caught) {
          setError(String(caught?.message ?? caught));
        } finally {
          setBusy(false);
        }
      };

      const moveToTrash = async (sessionId) => {
        setBusy(true);
        setError(null);
        try {
          await call('/trash', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          });
          setNotice(t('archive.trashed'));
          setConfirm(null);
          if (selected === sessionId) {
            setSelected(null);
            setTranscript(null);
          }
          await Promise.all([loadArchived(), loadTrash()]);
        } catch (caught) {
          setError(String(caught?.message ?? caught));
        } finally {
          setBusy(false);
        }
      };

      const hardDelete = async (sessionId) => {
        setBusy(true);
        setError(null);
        try {
          const body = await call('/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, confirm: true }),
          });
          const report = body.report ?? {};
          setNotice(
            `${t('archive.hardDeleted')}${report.stillOnDisk === true ? `（${t('archive.stillOnDisk')}）` : ''}`
            + `${(report.warnings ?? []).length > 0 ? ` ⚠ ${report.warnings.join('；')}` : ''}`,
          );
          setConfirm(null);
          if (selected === sessionId) {
            setSelected(null);
            setTranscript(null);
          }
          await Promise.all([loadArchived(), loadTrash()]);
        } catch (caught) {
          setError(String(caught?.message ?? caught));
        } finally {
          setBusy(false);
        }
      };

      const restoreTrash = async (folder) => {
        setBusy(true);
        setError(null);
        try {
          await call('/trash/restore', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ folder }),
          });
          setNotice(t('archive.restoredTrash'));
          await Promise.all([loadArchived(), loadTrash()]);
        } catch (caught) {
          setError(String(caught?.message ?? caught));
        } finally {
          setBusy(false);
        }
      };

      const purge = async (payload) => {
        setBusy(true);
        setError(null);
        try {
          const body = await call('/trash/purge', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
          setNotice(t('archive.purged').replace('{n}', String(body.report?.purged ?? 0)));
          setConfirm(null);
          await loadTrash();
        } catch (caught) {
          setError(String(caught?.message ?? caught));
        } finally {
          setBusy(false);
        }
      };

      const prune = async () => {
        setBusy(true);
        setError(null);
        try {
          const body = await call('/pruneArchived', { method: 'POST' });
          setNotice(t('archive.pruned').replace('{n}', String((body.report?.removed ?? []).length)));
          await loadArchived();
        } catch (caught) {
          setError(String(caught?.message ?? caught));
        } finally {
          setBusy(false);
        }
      };

      /** 清理快照垃圾：孤立快照 + 无引用对象 + 索引 key 归并。 */
      const cleanupStore = async () => {
        setBusy(true);
        setError(null);
        try {
          const pruned = await call('/pruneSnapshots', { method: 'POST' });
          const gc = await call('/gc', { method: 'POST' });
          const sessions = (pruned.report?.removed ?? []).length;
          const merged = (pruned.indexKeys?.merged ?? []).length + (pruned.indexKeys?.renamed ?? []).length;
          setNotice(
            t('archive.cleaned')
              .replace('{s}', String(sessions))
              .replace('{o}', String(gc.report?.removed ?? 0))
              .replace('{kb}', String(Math.round((gc.report?.bytes ?? 0) / 1024)))
              .replace('{k}', String(merged)),
          );
          await Promise.all([loadArchived(), loadTrash()]);
        } catch (caught) {
          setError(String(caught?.message ?? caught));
        } finally {
          setBusy(false);
        }
      };

      const sizeText = (bytes) => {
        if (!Number.isFinite(bytes)) return '–';
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
      };
      const dateText = (at) => (Number.isFinite(at) ? new Date(at).toLocaleString() : '–');

      const listRows = (hits ?? sessions).map((item) => {
        const isHit = hits !== null && item.snippet !== undefined;
        const pending = confirm;
        return jsxs('div', {
          key: item.sessionId,
          style: Object.assign({}, S.archiveRow, selected === item.sessionId ? { background: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14))' } : {}),
          children: [
            jsxs('div', {
              style: { flex: 1, minWidth: 0, cursor: 'pointer' },
              onClick: () => openTranscript(item.sessionId),
              children: [
                jsxs('div', {
                  style: { display: 'flex', gap: '8px', alignItems: 'baseline' },
                  children: [
                    jsx('span', {
                      style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                      children: item.title ?? '(未命名)',
                    }),
                    item.running === true ? jsx('span', { style: S.chip, children: t('archive.running') }) : null,
                    item.exists === false ? jsx('span', { style: S.chip, children: t('archive.missing') }) : null,
                    jsx('span', { style: S.muted, children: item.sizeBytes !== undefined ? sizeText(item.sizeBytes) : '' }),
                  ],
                }),
                jsx('div', { style: S.muted, children: `${t('archive.createdAt')} ${dateText(item.createdAt)}` }),
                isHit ? jsx('div', { style: Object.assign({}, S.mono, { marginTop: '3px' }), children: item.snippet }) : null,
              ],
            }),
            jsxs('span', {
              style: { display: 'inline-flex', gap: '6px', flex: 'none' },
              children: [
                jsx('button', { type: 'button', style: btn(), disabled: busy, onClick: () => unarchive(item.sessionId), children: t('archive.unarchive') }),
                pending === `trash:${item.sessionId}`
                  ? jsx('button', { type: 'button', style: btn(S.btnDanger), disabled: busy, onClick: () => moveToTrash(item.sessionId), children: t('archive.confirmDelete') })
                  : jsx('button', { type: 'button', style: btn(S.btnDanger), title: t('archive.trashHint'), onClick: () => setConfirm(`trash:${item.sessionId}`), children: t('archive.delete') }),
                pending === `hard:${item.sessionId}`
                  ? jsx('button', { type: 'button', style: btn(S.btnDanger, { fontWeight: 600 }), disabled: busy, onClick: () => hardDelete(item.sessionId), children: t('archive.confirmHardDelete') })
                  : jsx('button', { type: 'button', style: btn(S.btnDanger), title: t('archive.hardDeleteHint'), onClick: () => setConfirm(`hard:${item.sessionId}`), children: t('archive.hardDelete') }),
              ],
            }),
          ],
        });
      });

      const trashRows = trash.map((item) => {
        const pending = confirm === `purge:${item.folder}`;
        return jsxs('div', {
          key: item.folder,
          style: S.archiveRow,
          children: [
            jsxs('div', {
              style: { flex: 1, minWidth: 0 },
              children: [
                jsxs('div', {
                  style: { display: 'flex', gap: '8px', alignItems: 'baseline' },
                  children: [
                    jsx('span', {
                      style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                      children: item.title ?? item.sessionId,
                    }),
                    jsx('span', { style: S.chip, title: t('archive.lingeringHint'), children: t('archive.lingering') }),
                  ],
                }),
                jsx('div', { style: S.muted, children: `${t('archive.trashedAt')} ${dateText(item.trashedAt)}${item.present === false ? '（文件缺失）' : ''}` }),
              ],
            }),
            jsxs('span', {
              style: { display: 'inline-flex', gap: '6px', flex: 'none' },
              children: [
                jsx('button', { type: 'button', style: btn(), disabled: busy || item.present === false, onClick: () => restoreTrash(item.folder), children: t('archive.restore') }),
                pending
                  ? jsx('button', { type: 'button', style: btn(S.btnDanger), disabled: busy, onClick: () => purge({ folder: item.folder }), children: t('archive.confirmPurge') })
                  : jsx('button', { type: 'button', style: btn(S.btnDanger), onClick: () => setConfirm(`purge:${item.folder}`), children: t('archive.purge') }),
              ],
            }),
          ],
        });
      });

      const inline = props.inline === true;
      return jsx('div', {
        style: inline ? { display: 'block', height: '100%' } : S.overlay,
        onClick: inline
          ? undefined
          : (event) => {
              if (event.target === event.currentTarget) {
                panelState.set({ open: false, mode: 'snapshots' });
              }
            },
        children: jsxs('div', {
          style: inline
            ? { width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', color: 'var(--dsw-alias-label-primary, #eee)', fontSize: '13px' }
            : S.card,
          children: [
            jsxs('div', {
              style: S.head,
              children: [
                jsx('div', { style: S.title, children: `${t('archive.title')}（${sessions.length}）` }),
                jsx('button', {
                  type: 'button',
                  style: btn(),
                  disabled: busy,
                  onClick: () => {
                    setHits(null);
                    setQuery('');
                    void loadArchived();
                    void loadTrash();
                  },
                  children: t('panel.refresh'),
                }),
                // 内联（设置页）时由外壳提供关闭，这里不再重复
                inline
                  ? null
                  : jsx('button', {
                      type: 'button',
                      style: btn(),
                      disabled: busy,
                      onClick: () => panelState.set({ open: false, mode: 'snapshots' }),
                      children: t('panel.close'),
                    }),
                jsx('button', {
                  type: 'button',
                  style: btn(),
                  disabled: busy,
                  title: t('archive.cleanupHint'),
                  onClick: cleanupStore,
                  children: t('archive.cleanup'),
                }),              ],
            }),
            jsxs('div', {
              style: Object.assign({}, S.body, { display: 'flex', gap: '12px' }),
              children: [
                jsxs('div', {
                  style: { flex: '1 1 100%', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '8px' },
                  children: [
                    jsxs('div', {
                      style: { display: 'flex', gap: '6px' },
                      children: [
                        jsx('input', {
                          style: Object.assign({}, S.input, { minHeight: 'auto', flex: 1 }),
                          placeholder: t('archive.searchPlaceholder'),
                          value: query,
                          onChange: (event) => setQuery(event.target.value),
                          onKeyDown: (event) => {
                            if (event.key === 'Enter') search();
                          },
                        }),
                        jsx('button', { type: 'button', style: btn(S.btnPrimary), disabled: busy, onClick: search, children: t('archive.search') }),
                      ],
                    }),
                    hits !== null
                      ? jsx('div', { style: S.muted, children: `${t('archive.hits')}：${hits.length}` })
                      : null,
                    sessions.some((item) => item.exists === false)
                      ? jsx('button', {
                          type: 'button',
                          style: btn(),
                          disabled: busy,
                          title: t('archive.pruneHint'),
                          onClick: prune,
                          children: t('archive.prune').replace('{n}', String(sessions.filter((item) => item.exists === false).length)),
                        })
                      : null,
                    error !== null ? jsx('div', { style: S.error, children: error }) : null,
                    notice !== null ? jsx('div', { style: S.muted, children: notice }) : null,
                    sessions.length === 0 && hits === null
                      ? jsx('div', { style: S.muted, children: t('archive.empty') })
                      : jsxs('div', {
                          style: { overflow: 'auto', flex: '1 1 auto', minHeight: '12vh' },
                          children: [
                            ...listRows,
                            ...hits !== null && hits.length === 0 ? [jsx('div', { key: 'none', style: S.muted, children: '—' })] : [],
                          ],
                        }),
                    jsxs('div', {
                      style: Object.assign({}, S.detail, { marginTop: 'auto' }),
                      children: [
                        jsxs('div', {
                          style: { display: 'flex', alignItems: 'center', gap: '8px' },
                          children: [
                            jsx('div', { style: { fontWeight: 600 }, children: `${t('archive.trash')}（${trash.length}）` }),
                            trash.length > 0
                              ? confirm === '__all__'
                                ? jsx('button', { type: 'button', style: btn(S.btnDanger), disabled: busy, onClick: () => purge({ all: true }), children: t('archive.confirmPurge') })
                                : jsx('button', { type: 'button', style: btn(S.btnDanger), onClick: () => setConfirm('__all__'), children: t('archive.purgeAll') })
                              : null,
                          ],
                        }),
                        trash.length === 0
                          ? jsx('div', { style: S.muted, children: t('archive.trashEmpty') })
                          : jsx('div', { style: { maxHeight: '20vh', overflow: 'auto' }, children: trashRows }),
                      ],
                    }),
                  ],
                }),
                jsxs('div', {
                  style: { display: 'none' },
                  children: [
                    jsx('div', {
                      style: { fontWeight: 600, marginBottom: '6px' },
                      children: transcript === null
                        ? t('archive.transcript')
                        : `${t('archive.transcriptOf')}：${selected ?? ''}（${transcript.returned}/${transcript.total} ${t('archive.entries')}${transcript.truncated ? '，仅显示最近部分' : ''}）`,
                    }),
                    transcript === null
                      ? jsx('div', { style: S.muted, children: t('archive.noTranscript') })
                      : jsx('div', {
                          style: {
                            overflow: 'auto',
                            maxHeight: '56vh',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '6px',
                            paddingRight: '4px',
                          },
                          children: transcript.entries.map((entry, index) => jsxs('div', {
                            key: `${entry.seq}-${index}`,
                            style: {
                              padding: '5px 8px',
                              borderRadius: '6px',
                              background: entry.kind === 'user'
                                ? 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.10))'
                                : 'transparent',
                              border: entry.kind === 'tool' || entry.kind === 'tool-result'
                                ? '1px dashed var(--dsw-alias-border-l1, rgba(128,128,128,.25))'
                                : 'none',
                            },
                            children: [
                              jsx('div', {
                                style: S.muted,
                                children: `${entry.kind}${entry.turn !== null && entry.turn !== undefined ? ` · turn ${entry.turn}` : ''}${entry.seq !== undefined ? ` · #${entry.seq}` : ''}`,
                              }),
                              jsx('div', {
                                style: entry.kind === 'tool' || entry.kind === 'tool-result' ? S.mono : { whiteSpace: 'pre-wrap' },
                                children: entry.kind === 'tool'
                                  ? `${entry.name} ${entry.args ?? ''}`
                                  : entry.kind === 'tool-result'
                                    ? `${entry.isError === true ? '✗ ' : '✓ '}${entry.preview ?? ''}`
                                    : entry.text ?? '',
                              }),
                            ],
                          })),
                        }),
                  ],
                }),
              ],
            }),
          ],
        }),
      });
    }

    /* ------------------------------------------------------------------ *
     * 会话头部按钮
     * ------------------------------------------------------------------ */
    function SnapshotHeaderAction(props) {
      const t = props.t ?? ((key) => key);
      const sessionId = props.sessionId ?? null;
      const open = () => panelState.set({ open: true, mode: 'snapshots', sessionId, focusTurn: null, editMode: false });
      return jsx('button', {
        type: 'button',
        style: btn(),
        title: t('panel.title'),
        onClick: open,
        children: `⏱ ${t('header.open')}`,
      });
    }

    /**
     * 归档列表的设置页（挂在 `settings.section`）。
     *
     * 入口按需求从"会话头部按钮"移到设置列表，名字叫「归档列表」；
     * 内容复用归档管理器的内联渲染（`props.inline === true`）。
     * @param {object} props - 组件属性（含外壳给的 `close`）。
     * @returns {React.ReactNode} 视图。
     */
    function ArchiveSettingsSection(props) {
      return jsx(ArchivePanel, { t: props.t, inline: true });
    }

    /* ------------------------------------------------------------------ *
     * 每轮尾部动作
     * ------------------------------------------------------------------ */
    function TurnTailActions(props) {
      const t = props.t ?? ((key) => key);
      const sessionId = props.sessionId ?? null;
      const turn = props.turn ?? null;
      return jsx('button', {
        type: 'button',
        style: btn(),
        title: t('tail.edit.hint'),
        onClick: () => panelState.set({ open: true, mode: 'snapshots', sessionId, focusTurn: turn, editMode: true }),
        children: `✎ ${t('tail.edit')}`,
      });
    }

    /* ------------------------------------------------------------------ *
     * 快照时间线面板
     * ------------------------------------------------------------------ */
    function SnapshotPanel(props) {
      const t = props.t ?? ((key) => key);
      const openSession = props.openSession ?? (() => {});
      const state = usePanelState();

      const [items, setItems] = react.useState([]);
      const [status, setStatus] = react.useState('idle');
      const [error, setError] = react.useState(null);
      const [plan, setPlan] = react.useState(null);
      const [planFor, setPlanFor] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const [report, setReport] = react.useState(null);
      const [optFiles, setOptFiles] = react.useState(true);
      const [optConversation, setOptConversation] = react.useState(true);
      const [text, setText] = react.useState('');
      const [editMode, setEditMode] = react.useState(false);
      /** 是否显示历史遗留的"结果"快照（默认折叠，保持一轮一条）。 */
      const [showEnd, setShowEnd] = react.useState(false);

      const sessionId = state.sessionId;

      const load = react.useCallback(async () => {
        if (sessionId === null || sessionId === undefined) return;
        setStatus('loading');
        setError(null);
        try {
          const body = await call(`/snapshots?sessionId=${encodeURIComponent(sessionId)}`);
          const list = body.items ?? [];
          setItems(list);
          setStatus('ready');
          return list;
        } catch (caught) {
          setError(String(caught?.message ?? caught));
          setStatus('error');
          return [];
        }
      }, [sessionId]);

      const preview = react.useCallback(async (snapshotId) => {
        setError(null);
        setReport(null);
        setBusy(true);
        try {
          const body = await call(`/preview?sessionId=${encodeURIComponent(sessionId)}&snapshotId=${encodeURIComponent(snapshotId)}`);
          setPlan(body.plan);
          setPlanFor(snapshotId);
          setOptFiles((body.plan?.counts?.restore ?? 0) + (body.plan?.counts?.remove ?? 0) > 0);
          setOptConversation(true);
          setText(body.plan?.label ?? '');
        } catch (caught) {
          setError(String(caught?.message ?? caught));
        } finally {
          setBusy(false);
        }
      }, [sessionId]);

      /**
       * 预览区载入后把它自动滚入可视区。
       *
       * 两个必须守住的点：
       * 1) hook 一律放在"面板未打开就 return null"的早退**之前**——否则开关面板时
       *    hook 数量变化，React 会直接抛 "Rendered more hooks than during the previous render"，
       *    表现就是"面板打不开了"；
       * 2) 不用 `useRef`，改用数据属性 + querySelector，避免依赖我无法确证的 seed API 表面。
       */
      react.useEffect(() => {
        if (plan === null || planFor === null) return;
        if (typeof document === 'undefined') return;
        const node = document.querySelector('[data-snapshot-selected="1"]');
        if (node !== null && typeof node.scrollIntoView === 'function') {
          try {
            node.scrollIntoView({ block: 'nearest' });
          } catch {
            /* 忽略 */
          }
        }
      }, [plan, planFor]);

      // 打开面板时载入列表；带 focusTurn 时自动定位到该轮的起点快照。
      react.useEffect(() => {
        if (!state.open) return undefined;
        let cancelled = false;
        (async () => {
          const list = await load();
          if (cancelled) return;
          const focusTurnRaw = state.focusTurn;
          const focusTurn = turnNumberOf(focusTurnRaw);
          if (focusTurnRaw === null || focusTurnRaw === undefined || !Array.isArray(list)) return;
          const start = list.filter((item) => item.phase === 'start' && item.turn === focusTurn).pop();
          const previousEnd = list.filter((item) => item.phase === 'end' && item.turn === focusTurn - 1).pop();
          // 兜底同紧凑卡片：轮号对不上时退到不晚于该轮的最近起点快照
          const nearest = focusTurn === null
            ? undefined
            : list
                .filter((item) => item.phase === 'start' && typeof item.turn === 'number' && item.turn <= focusTurn)
                .sort((a, b) => b.turn - a.turn)[0];
          const target = start ?? previousEnd ?? nearest ?? null;
          setEditMode(state.editMode === true);
          beacon('panel-focus', {
            focusTurn: typeof focusTurnRaw === 'object' ? JSON.stringify(focusTurnRaw).slice(0, 200) : String(focusTurnRaw),
            normalized: focusTurn,
            matched: target === null ? null : { id: target.id, phase: target.phase, turn: target.turn },
          });
          if (target !== null) await preview(target.id);
        })();
        return () => {
          cancelled = true;
        };
      }, [state.open, state.focusTurn, state.editMode, load, preview]);

      if (!state.open || state.mode !== 'snapshots') return null;

      const snapshotMutate = (method) => async (snapshotId) => {
        setBusy(true);
        setError(null);
        try {
          if (method === 'DELETE') {
            await call(`/snapshot?sessionId=${encodeURIComponent(sessionId)}&snapshotId=${encodeURIComponent(snapshotId)}`, { method: 'DELETE' });
          }
          if (planFor === snapshotId) {
            setPlan(null);
            setPlanFor(null);
          }
          await load();
        } catch (caught) {
          setError(String(caught?.message ?? caught));
        } finally {
          setBusy(false);
        }
      };

      const captureNow = async () => {
        setBusy(true);
        setError(null);
        try {
          await call('/capture', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, label: t('panel.phase.manual') }),
          });
          await load();
        } catch (caught) {
          setError(String(caught?.message ?? caught));
        } finally {
          setBusy(false);
        }
      };

      const runRollback = async () => {
        if (planFor === null) return;
        setBusy(true);
        setError(null);
        setReport(null);
        try {
          const body = await call('/restore', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessionId,
              snapshotId: planFor,
              files: optFiles,
              conversation: optConversation,
              promptText: editMode && optConversation && text.trim().length > 0 ? text : undefined,
            }),
          });
          setReport(body.report);
          await load();
        } catch (caught) {
          setError(String(caught?.message ?? caught));
        } finally {
          setBusy(false);
        }
      };

      const close = () => {
        panelState.set({ open: false, focusTurn: null, editMode: false });
        setPlan(null);
        setPlanFor(null);
        setReport(null);
      };

      /**
       * 默认只显示"每轮一条"的快照：起点 / 手动 / 回滚前 / 基线。
       * 历史遗留的"结果"快照（回滚语义统一为"回到本轮之前"之前的旧模型）默认折叠，
       * 需要时用「显示结果快照」展开。
       */
      const visibleItems = items.filter((item) => showEnd || item.phase !== 'end');

      const rows = visibleItems.map((item) => {
        const selected = planFor === item.id;
        return jsxs('div', {
          key: item.id,
          'data-snapshot-selected': selected ? '1' : undefined,
          children: [
            jsxs('div', {
              style: Object.assign({}, S.row, selected ? { background: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12))' } : {}),
              children: [
                jsx('span', { style: S.muted, children: clockOf(item.at) }),
                jsx('span', { style: S.chip, children: phaseLabel(item.phase, t) }),
                jsx('span', { style: S.muted, children: item.turn === null || item.turn === undefined ? '–' : `#${item.turn}` }),
                jsx('span', { style: S.muted, children: item.changeCount ?? 0 }),
                jsx('span', {
                  style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                  title: item.label ?? '',
                  children: item.label ? item.label.split('\n')[0] : jsx('span', { style: S.muted, children: '—' }),
                }),
                jsxs('span', {
                  style: { display: 'inline-flex', gap: '6px' },
                  children: [
                    jsx('button', { type: 'button', style: btn(), onClick: () => preview(item.id), children: t('panel.preview') }),
                    jsx('button', {
                      type: 'button',
                      style: btn(S.btnPrimary),
                      title: t('panel.rollbackHint'),
                      onClick: () => preview(item.id),
                      children: t('panel.rollback'),
                    }),
                    jsx('button', { type: 'button', style: btn(S.btnDanger), onClick: () => snapshotMutate('DELETE')(item.id), children: t('panel.delete') }),
                  ],
                }),
              ],
            }),
            // 预览 / 回滚区：行内展开（在"预览/回滚"那一行下面），并自动滚入可视区
            selected && plan !== null ? renderPlan() : null,
          ],
        });
      });

      function renderPlan() {
        const counts = plan.counts ?? {};
        const restores = plan.restore ?? [];
        const removes = plan.remove ?? [];
        return jsxs('div', {
          style: S.detail,
          children: [
            jsxs('div', {
              style: { display: 'flex', gap: '14px', flexWrap: 'wrap', marginBottom: '6px' },
              children: [
                jsx('span', { children: `${t('panel.plan.restore')} ${counts.restore ?? 0}` }),
                jsx('span', { children: `${t('panel.plan.remove')} ${counts.remove ?? 0}` }),
                jsx('span', { style: S.muted, children: `${t('panel.plan.unchanged')} ${counts.unchanged ?? 0}` }),
              ],
            }),
            (counts.restore ?? 0) + (counts.remove ?? 0) === 0
              ? jsx('div', { style: S.muted, children: t('panel.plan.none') })
              : jsxs(Fragment, {
                  children: [
                    ...restores.slice(0, 8).map((item) => jsx('div', { key: `r-${item.rel}`, style: S.mono, children: `+ ${item.rel}  (${item.action})` })),
                    ...removes.slice(0, 8).map((item) => jsx('div', { key: `x-${item.rel}`, style: S.mono, children: `- ${item.rel}  (${item.action})` })),
                    (counts.restore ?? 0) + (counts.remove ?? 0) > 16
                      ? jsx('div', { style: S.muted, children: `… ${(counts.restore ?? 0) + (counts.remove ?? 0) - 16} more` })
                      : null,
                  ],
                }),
            jsx('div', {
              style: Object.assign({}, S.muted, { marginTop: '8px' }),
              children: plan.conversation?.note ?? '',
            }),
            jsxs('div', {
              style: { display: 'flex', gap: '14px', marginTop: '8px', flexWrap: 'wrap' },
              children: [
                jsxs('label', {
                  style: { display: 'inline-flex', gap: '6px', alignItems: 'center' },
                  children: [
                    jsx('input', { type: 'checkbox', checked: optFiles, onChange: (event) => setOptFiles(event.target.checked) }),
                    t('panel.opt.files'),
                  ],
                }),
                jsxs('label', {
                  style: { display: 'inline-flex', gap: '6px', alignItems: 'center' },
                  children: [
                    jsx('input', {
                      type: 'checkbox',
                      checked: optConversation,
                      disabled: plan.conversation?.available !== true,
                      onChange: (event) => setOptConversation(event.target.checked),
                    }),
                    t('panel.opt.conversation'),
                  ],
                }),
              ],
            }),
            jsxs('div', {
              style: { marginTop: '8px' },
              children: [
                jsx('div', { style: S.muted, children: t('panel.edit.hint') }),
                jsx('textarea', {
                  style: S.input,
                  value: text,
                  onChange: (event) => setText(event.target.value),
                }),
                jsxs('label', {
                  style: { display: 'inline-flex', gap: '6px', alignItems: 'center', marginTop: '6px' },
                  children: [
                    jsx('input', {
                      type: 'checkbox',
                      checked: editMode,
                      disabled: optConversation !== true,
                      onChange: (event) => setEditMode(event.target.checked),
                    }),
                    t('panel.opt.send'),
                  ],
                }),
              ],
            }),
            jsx('div', {
              style: Object.assign({}, S.muted, { marginTop: '6px' }),
              children: editMode && optConversation && text.trim().length > 0 ? t('panel.send.on') : t('panel.send.off'),
            }),
            jsxs('div', {
              style: { display: 'flex', gap: '8px', marginTop: '10px', alignItems: 'center' },
              children: [
                jsx('button', {
                  type: 'button',
                  style: btn(S.btnPrimary),
                  disabled: busy || (!optFiles && !optConversation),
                  onClick: runRollback,
                  children: busy ? t('panel.busy') : t('panel.do'),
                }),
                jsx('button', {
                  type: 'button',
                  style: btn(),
                  onClick: () => {
                    setPlan(null);
                    setPlanFor(null);
                  },
                  children: t('panel.cancel'),
                }),
                jsx('span', {
                  style: Object.assign({}, S.muted, { marginLeft: 'auto' }),
                  children: `forkSeq=${plan.forkSeq ?? '–'}`,
                }),
              ],
            }),
          ],
        });
      }

      return jsx('div', {
        style: S.overlay,
        onClick: (event) => {
          if (event.target === event.currentTarget) close();
        },
        children: jsxs('div', {
          style: S.card,
          children: [
            jsxs('div', {
              style: S.head,
              children: [
                jsx('div', { style: S.title, children: `${t('panel.title')}（${visibleItems.length}${visibleItems.length === items.length ? '' : ` / ${items.length}`}）` }),
                jsxs('label', {
                  style: { display: 'inline-flex', gap: '6px', alignItems: 'center', marginRight: '4px' },
                  title: t('panel.showEnd.hint'),
                  children: [
                    jsx('input', { type: 'checkbox', checked: showEnd, onChange: (event) => setShowEnd(event.target.checked) }),
                    t('panel.showEnd'),
                  ],
                }),
                jsx('button', { type: 'button', style: btn(), disabled: busy, onClick: load, children: t('panel.refresh') }),
                jsx('button', { type: 'button', style: btn(), disabled: busy, onClick: captureNow, children: t('panel.capture') }),
                jsx('button', { type: 'button', style: btn(), onClick: close, children: t('panel.close') }),
              ],
            }),
            jsxs('div', {
              style: S.body,
              children: [
                error !== null ? jsx('div', { style: Object.assign({}, S.error, { marginBottom: '8px' }), children: `${t('panel.error')}：${error}` }) : null,
                status === 'loading' ? jsx('div', { style: S.muted, children: t('panel.loading') }) : null,
                items.length === 0 && status !== 'loading' ? jsx('div', { style: S.muted, children: t('panel.empty') }) : null,
                items.length > 0 && visibleItems.length === 0 ? jsx('div', { style: S.muted, children: t('panel.onlyEndHidden') }) : null,
                ...rows,
                report !== null
                  ? jsxs('div', {
                      style: Object.assign({}, S.detail, { marginTop: '10px' }),
                      children: [
                        jsx('div', { style: { fontWeight: 600 }, children: t('panel.report') }),
                        report.files !== null && report.files !== undefined
                          ? jsx('div', {
                              children: t('panel.report.files')
                                .replace('{r}', String(report.files.restored ?? 0))
                                .replace('{x}', String(report.files.removed ?? 0))
                                .replace('{f}', String(report.files.failed ?? 0)),
                            })
                          : null,
                        report.recoveryPoint !== undefined
                          ? jsx('div', { style: S.muted, children: t('panel.recovery').replace('{id}', String(report.recoveryPoint)) })
                          : null,
                        report.conversation?.childSessionId !== undefined && report.conversation.childSessionId !== null
                          ? jsxs('div', {
                              style: { display: 'flex', gap: '10px', alignItems: 'center', marginTop: '6px' },
                              children: [
                                jsx('span', { style: S.mono, children: t('panel.report.new').replace('{id}', String(report.conversation.childSessionId)) }),
                                jsx('button', {
                                  type: 'button',
                                  style: btn(S.btnPrimary),
                                  onClick: () => openSession(report.conversation.childSessionId),
                                  children: t('panel.report.open'),
                                }),
                              ],
                            })
                          : null,
                        report.prompt?.accepted === true ? jsx('div', { style: S.muted, children: t('panel.report.sent') }) : null,
                        ...(report.warnings ?? []).map((warning, index) => jsx('div', { key: `w-${index}`, style: S.error, children: `${t('panel.warn')}：${warning}` })),
                      ],
                    })
                  : null,
              ],
            }),
          ],
        }),
      });
    }

    /**
     * 把槽位给的"轮次标识"归一化成数字。
     *
     * 踩过的坑：`conversation.chat.turnTail` 的 ownerProps 里 `turn` 是 **TurnLocation 对象**
     * （形如 `{ turn: 3, steps: [...] }`），不是裸数字；早期按数字比较导致"点了没反应"。
     * 这里对几种可能形状都做兼容，认不出来就返回 null（调用方走兜底）。
     * @param {unknown} value - 轮次标识。
     * @returns {number|null} 轮号，认不出时为 null。
     */
    function turnNumberOf(value) {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (value !== null && typeof value === 'object') {
        for (const key of ['turn', 'value', 'index', 'number']) {
          const candidate = value[key];
          if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
        }
      }
      return null;
    }


    /**
     * 兜底错误边界：任一组件渲染出错时显示一行红字，而不是让整个面板"点不开"。
     * 对平台暴露的 react 采取防御姿态：拿不到 Component 时退化成直通组件。
     */
    const RenderBoundary = typeof react.Component === 'function'
      ? class RenderBoundary extends react.Component {
          constructor(props) {
            super(props);
            this.state = { error: null };
          }

          static getDerivedStateFromError(error) {
            return { error };
          }

          render() {
            if (this.state.error !== null) {
              return jsx('div', {
                style: { color: '#e5534b', fontSize: '12px', padding: '4px 0' },
                children: `快照插件渲染出错：${String(this.state.error?.message ?? this.state.error)}`,
              });
            }
            return this.props.children;
          }
        }
      : (props) => props.children;

    /**
     * 给注册到槽位的组件套一层错误边界。
     * 保留原函数名（预检脚本按名字查找），并挂 `__inner` 供预检直接渲染内部组件。
     * @param {Function} Component - 原组件。
     * @returns {Function} 包装后的组件。
     */
    function guarded(Component) {
      const Wrapped = (props) => jsx(RenderBoundary, { children: jsx(Component, props) });
      try {
        Object.defineProperty(Wrapped, 'name', { value: Component.name, configurable: true });
      } catch {
        /* 忽略 */
      }
      Wrapped.__inner = Component;
      return Wrapped;
    }

    /**
     * 上报信标：让 Host 侧（以及没有浏览器窗口的开发者）确认 UI 是否真的挂上了。
     * @param {string} phase - 阶段名。
     * @param {object} [extra] - 附加信息。
     * @returns {void}
     */
    function beacon(phase, extra) {
      try {
        void fetch(`${API}/beacon`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ phase, rev: BUILD, ...(extra ?? {}) }),
        }).catch(() => {});
      } catch {
        /* 忽略 */
      }
    }

    /** 需要的浏览器侧服务。 */
    const inject = ['slots', 'locale'];

    /**
     * 挂载浏览器半边。
     * @param {object} ctx - 浏览器插件上下文。
     */
    function apply(ctx) {
      try {
        /** 已注册的槽位数量（仅用于挂载信标）。 */
        const registeredSlotCount = 4;
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'snapshot-manager: dictionaries');
        /** 供槽位 nav 标签使用的翻译函数（读当前语言，随语言切换自动跟随）。 */
        const translate = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NS) : (key) => key;

        // 会话头部按钮（快照时间线）
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'snapshot-manager-header',
          order: 30,
          locale: NS,
          inject: (sessionId) => ({ sessionId }),
        }, guarded(SnapshotHeaderAction)));

        // 归档列表：作为「设置 → 归档列表」的一个设置页。
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'snapshot-archive',
          order: 30,
          label: () => translate('settings.archive.label'),
          locale: NS,
          inject: () => ({ inline: true }),
        }, guarded(ArchiveSettingsSection)));

        // 每轮尾部动作
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'snapshot-manager-turn-tail',
          order: 40,
          locale: NS,
          inject: (sessionId) => ({ sessionId }),
        }, guarded(TurnTailActions)));

        // 时间线面板
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'snapshot-manager-panel',
          locale: NS,
          inject: () => ({
            openSession: (sessionId) => {
              try {
                const workspace = ctx.get('uiWorkspace');
                workspace?.openSession?.(sessionId);
              } catch {
                /* 忽略 */
              }
            },
          }),
        }, guarded(SnapshotPanel)));

        beacon('mounted', { detail: { slots: registeredSlotCount, build: BUILD } });
      } catch (error) {
        beacon('mount-failed', { error: String(error?.stack ?? error?.message ?? error) });
        throw error;
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
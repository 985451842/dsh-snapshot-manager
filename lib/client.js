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
    const API = '/api/snapshot-manager/v4';

    /** 构建标记（每轮 UI 迭代递增，便于确认浏览器加载的是哪一版）。 */
    const BUILD = '0.3.1-1';

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
      'panel.rollback': '回滚…',
      'panel.rollbackHint': '展开回滚选项：可勾选恢复文件 / 回退对话，并可选择是否把输入发进新会话',
      'panel.selected': '已选快照',
      'panel.delete': '删除',
      'panel.phase.start': '起点',
      'panel.phase.end': '结果',
      'panel.phase.baseline': '基线',
      'panel.phase.manual': '手动',
      'panel.phase.prerollback': '回滚前',
      'panel.plan.restore': '将恢复',
      'panel.plan.remove': '将删除',
      'panel.plan.dirs': '将清理空目录',
      'panel.plan.unchanged': '保持不变',
      'panel.plan.none': '工作区与这个时点一致，无需改动。',
      'panel.plan.conversation': '对话将回退到该时点之后（原会话完整保留）',
      'panel.opt.files': '恢复文件',
      'panel.opt.files.session': '只恢复本次会话修改的文件',
      'panel.opt.files.session.hint': '只动本次会话自己写入过的文件（write/edit 记录），包括把会话期间被删掉的这些文件重建回来；经终端命令、构建、子代理产生的改动不会被触碰，因此可能残留。不勾选则完整还原到该时点（含 git 合并/切换/构建等外部操作）',
      'panel.opt.files.session.empty': '本次会话没有记录到文件写入，勾选后不会有任何文件被恢复',
      'panel.plan.sessionScope': '当前只针对本次会话记录到的 {n} 个文件统计（工作区其余文件不在范围内，因此三个数字都会比全量小）',
      'panel.opt.conversation': '回退对话（生成新会话）',
      'panel.edit.hint': '编辑后重来（这段文本预填的是该时点的用户输入）',
      'panel.opt.send': '回滚后自动发送这段输入',
      'panel.send.on': '将执行：回滚 + 把上面的输入发进新会话继续跑',
      'panel.send.off': '将执行：仅回滚（不发送任何输入，你在新会话里自己重新输入）',
      'panel.do': '执行回滚',
      'panel.cancel': '取消',
      'panel.busy': '执行中…',
      'panel.confirm.title': '确认执行这次回滚？',
      'panel.confirm.hint': '请再核对一次下面的清单。执行后会修改工作区；文件回滚可用“回滚前自动恢复点”反向恢复，对话回退会创建新会话且不能自动撤销。',
      'panel.confirm.do': '确认执行',
      'panel.confirm.cancel': '再想想',
      'panel.confirm.filesOnly': '只恢复文件，对话不会回退',
      'panel.confirm.conversationOnly': '只回退对话，文件不会变化',
      'panel.confirm.both': '文件与对话一起回退',
      'panel.plan.truncated': '清单过长，仅显示前 {n} 条；执行会处理完整清单。',
      'panel.plan.untracked': '未纳入快照：符号链接 {s}、排除项 {e}、超大 {o}、不可读 {u}；这些不会被回滚。',
      'panel.plan.risk': '该快照采集窗口内有 {n} 个文件被修改，可能包含本轮改动。',
      'panel.plan.list': '完整清单',
      'panel.plan.collapse': '收起清单',
      'panel.undo': '撤销这次回滚…',
      'panel.undoHint': '回到这次回滚之前的状态（只恢复文件；对话不会被反向 fork）',
      'panel.running.title': '当前会话正在运行',
      'panel.running.hint': '回滚已禁用：请先停止当前轮（及子代理），等待结束（turn/end）后重新预览。',
      'panel.report.partial': '部分失败',
      'panel.report.failures': '失败详情',
      'panel.report.recoveryHint': '如需撤销，可在时间线里选择“回滚前”这一条再恢复。',
      'panel.recovery.title': '检测到上次回滚中断',
      'panel.recovery.hint': '回滚在完成前中断，文件可能处于半完成状态。可以继续还原目标快照，或回到回滚前恢复点。',
      'panel.recovery.resume': '继续还原目标',
      'panel.recovery.revert': '回到回滚前',
      'panel.recovery.done': '恢复完成',
      'panel.captureError': '自动采集失败',
      'panel.storageError': '快照存储不可用',
      'panel.plan.changed': '工作区已变化，请重新预览',
      'panel.report.plan': '计划：恢复 {r} / 删除 {x} / 目录 {d}',
      'panel.report.transaction': '事务：{id}',
      'panel.report': '回滚完成',
      'panel.report.files': '文件：恢复 {r} 个，删除 {x} 个，失败 {f} 个',
      'panel.report.dirs': '目录：清理空目录 {d} 个',
      'panel.report.new': '新会话：{id}',
      'panel.report.open': '打开新会话',
      'panel.report.sent': '已把编辑后的输入发进新会话',
      'panel.recovery': '回滚前恢复点：{id}',
      'panel.warn': '注意',
      'tail.back': '回到本轮开始',
      'tail.edit': '编辑并重来',
      'tail.back.hint': '把这轮的文件与对话退回到本轮输入之前，不发送任何输入（你在新会话里自己重新输入）',
      'tail.edit.hint': '就地编辑当轮原话并回退到本轮之前：可勾选是否发送、是否恢复文件、是否回退对话',
      'panel.cleanup': '清理快照垃圾',
      'panel.cleanupHint': '删除孤立快照（会话日志已不存在）、回收没有任何快照引用的内容对象，并把历史遗留的非规范化工作区索引归并掉。',
      'panel.cleaned': '已清理孤立快照 {s} 个会话、回收对象 {o} 个（{kb} KB）、归并索引 {k} 个',
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
      'panel.rollback': 'Roll back…',
      'panel.rollbackHint': 'Reveal rollback options: restore files / rewind conversation, and choose whether the input is sent',
      'panel.selected': 'Selected snapshot',
      'panel.delete': 'Delete',
      'panel.phase.start': 'start',
      'panel.phase.end': 'result',
      'panel.phase.baseline': 'baseline',
      'panel.phase.manual': 'manual',
      'panel.phase.prerollback': 'pre-rollback',
      'panel.plan.restore': 'to restore',
      'panel.plan.remove': 'to delete',
      'panel.plan.dirs': 'empty dirs to prune',
      'panel.plan.unchanged': 'unchanged',
      'panel.plan.none': 'Workspace already matches this point.',
      'panel.plan.conversation': 'Conversation rewinds after this point (original session kept)',
      'panel.opt.files': 'Restore files',
      'panel.opt.files.session': 'Only files this conversation changed',
      'panel.opt.files.session.hint': 'Touch only files this conversation wrote (from write/edit records), including recreating any of them that were deleted during the conversation. Changes made via shell commands, builds, or subagents are left alone, so they may remain. Unchecked restores the workspace fully to that point (including external git merges/checkouts/builds).',
      'panel.opt.files.session.empty': 'This conversation has no recorded file writes, so ticking this would restore nothing',
      'panel.plan.sessionScope': 'Counting only the {n} files recorded for this conversation (other workspace files are out of scope, so all three numbers are smaller than the full scope)',
      'panel.opt.conversation': 'Rewind conversation (new session)',
      'panel.edit.hint': 'Edit and retry (prefilled with the user input at that point)',
      'panel.opt.send': 'Send this input to the new session after rollback',
      'panel.send.on': 'Will do: roll back + send the input above into the new session',
      'panel.send.off': 'Will do: roll back only (nothing is sent; you type in the new session)',
      'panel.do': 'Roll back',
      'panel.cancel': 'Cancel',
      'panel.busy': 'Working…',
      'panel.confirm.title': 'Run this rollback?',
      'panel.confirm.hint': 'Check the list once more. Rollback modifies the workspace; file changes can be reversed from the automatic pre-rollback point, while a conversation rewind creates a new session and cannot be undone automatically.',
      'panel.confirm.do': 'Run rollback',
      'panel.confirm.cancel': 'Not yet',
      'panel.confirm.filesOnly': 'Files only: the conversation stays in this session',
      'panel.confirm.conversationOnly': 'Conversation only: files are left as they are',
      'panel.confirm.both': 'Files and conversation together',
      'panel.plan.truncated': 'List is long; showing the first {n} entries. Execution still uses the complete list.',
      'panel.plan.untracked': 'Not snapshotted: {s} symlinks, {e} excluded, {o} oversized, {u} unreadable; rollback will not touch them.',
      'panel.plan.risk': '{n} files changed during this snapshot\'s capture window and may already include this turn\'s edits.',
      'panel.plan.list': 'Full list',
      'panel.plan.collapse': 'Collapse list',
      'panel.undo': 'Undo this rollback…',
      'panel.undoHint': 'Return to the state before this rollback (files only; the conversation is not re-forked)',
      'panel.running.title': 'This session is still running',
      'panel.running.hint': 'Rollback is disabled. Stop the current turn (and subagents), wait for it to finish, then preview again.',
      'panel.report.partial': 'Partially failed',
      'panel.report.failures': 'Failure details',
      'panel.report.recoveryHint': 'To undo, select the pre-rollback row in the timeline and restore it.',
      'panel.recovery.title': 'Interrupted rollback detected',
      'panel.recovery.hint': 'A rollback stopped before finishing; files may be half-restored. Resume the target snapshot or return to the pre-rollback point.',
      'panel.recovery.resume': 'Resume target',
      'panel.recovery.revert': 'Back to pre-rollback',
      'panel.recovery.done': 'Recovery finished',
      'panel.plan.changed': 'The workspace changed; preview again',
      'panel.report.plan': 'Plan: {r} restore / {x} delete / {d} dirs',
      'panel.report.transaction': 'Transaction: {id}',
      'panel.captureError': 'Automatic capture failed',
      'panel.storageError': 'Snapshot storage unavailable',
      'panel.report': 'Rollback finished',
      'panel.report.files': 'Files: {r} restored, {x} deleted, {f} failed',
      'panel.report.dirs': 'Directories: {d} empty dirs pruned',
      'panel.report.new': 'New session: {id}',
      'panel.report.open': 'Open new session',
      'panel.report.sent': 'Edited input was sent to the new session',
      'panel.recovery': 'Recovery point: {id}',
      'panel.warn': 'Warning',
      'tail.back': 'Back to turn start',
      'tail.edit': 'Edit & retry',
      'tail.back.hint': 'Rewind this turn\'s files and conversation to just before its input, and send nothing (you retype in the new session)',
      'tail.edit.hint': 'Edit this turn\'s original input in place and rewind: choose whether to send, restore files, and rewind the conversation',
      'panel.cleanup': 'Clean snapshot store',
      'panel.cleanupHint': 'Deletes orphan snapshots (session log no longer exists), reclaims content objects no snapshot references, and merges legacy non-normalized workspace index keys.',
      'panel.cleaned': 'Cleaned {s} orphan sessions, reclaimed {o} objects ({kb} KB), merged {k} index keys',
    };

    /* ------------------------------------------------------------------ *
     * 共享面板状态（header 按钮 / 每轮按钮 / overlay 面板三处共用）
     * ------------------------------------------------------------------ */
    const panelState = {
      open: false,
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
    };

    /** 组合按钮样式。 */
    const btn = (...extra) => Object.assign({}, S.btn, ...extra);

    /**
     * 内联 SVG 图标集。
     *
     * 为什么自己画：DSH 的客户端半边只暴露 ctx / React / host / styles / console，
     * **没有图标组件库**；DSH 自己的界面用的就是内联 SVG（viewBox 0 0 16 16、fill=none、
     * stroke 走 currentColor），所以这里沿用同一套约定，颜色随按钮文字自动适配亮/暗主题。
     * @param {string} name - refresh | camera | close。
     * @param {number} [size] - 边长（px）。
     * @returns {object} React 元素。
     */
    const icon = (name, size = 14) => {
      const shapes = {
        // 环形箭头 + 右上角箭头头
        refresh: [
          jsx('path', { key: 'a', d: 'M13 8A5 5 0 1 1 11.6 4.4' }),
          jsx('path', { key: 'b', d: 'M13.5 1.5V4.7H10.3' }),
        ],
        // 相机：机身矩形（闭合）+ 顶部取景凸起 + 镜头圆
        camera: [
          jsx('path', { key: 'a', d: 'M1.8 4.8h3.3l1.1-1.6h3.6l1.1 1.6h3.3v9H1.8z' }),
          jsx('circle', { key: 'b', cx: '8', cy: '9.2', r: '2.6' }),
        ],
        close: [
          jsx('path', { key: 'a', d: 'M3.5 3.5L12.5 12.5' }),
          jsx('path', { key: 'b', d: 'M12.5 3.5L3.5 12.5' }),
        ],
      }[name];
      if (shapes === undefined) return null;
      return jsxs('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block', flex: '0 0 auto' },
        children: shapes,
      });
    };

    /** 图标按钮专属样式：正方、居中，只放图标。 */
    const iconBtn = (...extra) => Object.assign({}, S.btn, {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '4px',
      lineHeight: '0',
    }, ...extra);

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
     * 会话头部按钮
     * ------------------------------------------------------------------ */
    function SnapshotHeaderAction(props) {
      const t = props.t ?? ((key) => key);
      const sessionId = props.sessionId ?? null;
      const open = () => panelState.set({ open: true, sessionId, focusTurn: null, editMode: false });
      return jsx('button', {
        type: 'button',
        style: btn(),
        title: t('panel.title'),
        onClick: open,
        children: `⏱ ${t('header.open')}`,
      });
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
        onClick: () => panelState.set({ open: true, sessionId, focusTurn: turn, editMode: true }),
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
      /** 维护类操作的提示文案（例如清理快照垃圾的结果）。 */
      const [notice, setNotice] = react.useState(null);
      /** 是否恢复文件（不勾选则只回退对话）。 */
      const [restoreFiles, setRestoreFiles] = react.useState(true);
      /** 恢复范围：false = 全量（默认），true = 只恢复本次会话修改的文件。仅在 restoreFiles 为真时可选。 */
      const [sessionOnly, setSessionOnly] = react.useState(false);
      const [optConversation, setOptConversation] = react.useState(true);
      const [text, setText] = react.useState('');
      const [editMode, setEditMode] = react.useState(false);
      /** 当前预览签发的一次性确认令牌。 */
      const [planToken, setPlanToken] = react.useState(null);
      /** 是否已进入“再确认一次”的状态。 */
      const [confirming, setConfirming] = react.useState(false);
      /** 是否展开完整预览清单。 */
      const [showAll, setShowAll] = react.useState(false);
      /** 上次回滚中断/部分失败的事务。 */
      const [recoveries, setRecoveries] = react.useState([]);
      /** 上次自动采集失败的原因（服务端记录）。 */
      const [captureError, setCaptureError] = react.useState(null);
      /** 快照存储根不可写的原因。 */
      const [storageError, setStorageError] = react.useState(null);

      const sessionId = state.sessionId;

      const loadRecoveries = react.useCallback(async () => {
        if (sessionId === null || sessionId === undefined) return;
        try {
          const body = await call(`/recoveries?sessionId=${encodeURIComponent(sessionId)}`);
          setRecoveries(body.items ?? []);
        } catch {
          setRecoveries([]);
        }
      }, [sessionId]);

      const load = react.useCallback(async () => {
        if (sessionId === null || sessionId === undefined) return;
        setStatus('loading');
        setError(null);
        try {
          const body = await call(`/snapshots?sessionId=${encodeURIComponent(sessionId)}`);
          const list = body.items ?? [];
          setItems(list);
          setCaptureError(typeof body.lastError?.message === 'string' ? body.lastError.message : null);
          setStorageError(typeof body.storageError === 'string' ? body.storageError : null);
          setStatus('ready');
          await loadRecoveries();
          return list;
        } catch (caught) {
          setError(String(caught?.message ?? caught));
          setStatus('error');
          return [];
        }
      }, [sessionId, loadRecoveries]);

      // 每次打开面板都把“编辑并重来”的本地状态同步到本次打开的来源，
      // 否则上次勾过“发送到新会话”会泄漏到下一次普通回滚。
      react.useEffect(() => {
        if (!state.open) return;
        setEditMode(state.editMode === true);
      }, [state.open, state.editMode]);

      const preview = react.useCallback(async (snapshotId) => {
        setError(null);
        setReport(null);
        setBusy(true);
        setConfirming(false);
        setShowAll(false);
        try {
          const body = await call(`/preview?sessionId=${encodeURIComponent(sessionId)}&snapshotId=${encodeURIComponent(snapshotId)}`);
          setPlan(body.plan);
          setPlanFor(snapshotId);
          setPlanToken(body.plan?.planToken ?? null);
          // 每次打开都回到默认：恢复文件 + 全量范围（收窄必须是显式选择）。
          setRestoreFiles(true);
          setSessionOnly(false);
          // “回滚前”这一条是撤销回滚的入口：默认只恢复文件，不重复 fork 对话。
          const undoEntry = body.plan?.phase === 'pre-rollback';
          setOptConversation(!undoEntry);
          if (undoEntry) setEditMode(false);
          setText(undoEntry ? '' : (body.plan?.label ?? ''));
        } catch (caught) {
          setError(String(caught?.message ?? caught));
          setPlanToken(null);
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

      if (!state.open) return null;

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
            setPlanToken(null);
            setConfirming(false);
            setShowAll(false);
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

      /**
       * 清理快照垃圾：删除孤立快照（会话日志已不存在）+ 回收无引用内容对象 + 归并索引 key。
       * 原本挂在已移除的归档面板上，现在作为快照库的维护入口留在快照面板。
       */
      const cleanupStore = async () => {
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
          const pruned = await call('/pruneSnapshots', { method: 'POST' });
          const gc = await call('/gc', { method: 'POST' });
          const sessions = (pruned.report?.removed ?? []).length;
          const merged = (pruned.indexKeys?.merged ?? []).length + (pruned.indexKeys?.renamed ?? []).length;
          setNotice(
            t('panel.cleaned')
              .replace('{s}', String(sessions))
              .replace('{o}', String(gc.report?.removed ?? 0))
              .replace('{kb}', String(Math.round((gc.report?.bytes ?? 0) / 1024)))
              .replace('{k}', String(merged)),
          );
          await load();
        } catch (caught) {
          setError(String(caught?.message ?? caught));
        } finally {
          setBusy(false);
        }
      };

      const runRollback = async () => {
        if (planFor === null) return;
        if (plan?.running === true) {
          setError(t('panel.running.hint'));
          setConfirming(false);
          return;
        }
        if (planToken === null) {
          setError(t('panel.plan.changed'));
          setConfirming(false);
          return;
        }
        setBusy(true);
        setError(null);
        setReport(null);
        setConfirming(false);
        try {
          const body = await call('/restore', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessionId,
              snapshotId: planFor,
              files: restoreFiles,
              scope: sessionOnly ? 'session' : 'all',
              conversation: optConversation,
              promptText: editMode && optConversation && text.trim().length > 0 ? text : undefined,
              planToken,
            }),
          });
          setReport(body.report);
          setPlanToken(null);
          // 不自动跳转/关闭：报告（尤其是文件失败与警告）必须先让用户看到。
          // 新会话由报告里的“打开新会话”按钮显式打开。
          await load();
        } catch (caught) {
          const message = String(caught?.message ?? caught);
          setError(message);
          if (/令牌|planToken|重新预览|已使用|已过期|发生变化/.test(message)) setPlanToken(null);
        } finally {
          setBusy(false);
        }
      };

      /**
       * 继续/回退一条中断的回滚事务。
       * @param {string} id - 事务 id。
       * @param {'resume'|'revert'} action - 动作。
       * @returns {Promise<void>}
       */
      const recoverTransaction = async (id, action) => {
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
          const body = await call('/recover', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id, action }),
          });
          const files = body.report?.files ?? {};
          setNotice(
            `${t('panel.recovery.done')}：+${files.restored ?? 0} / -${files.removed ?? 0} / 失败 ${files.failed ?? 0}`,
          );
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
        setPlanToken(null);
        setConfirming(false);
        setShowAll(false);
        setReport(null);
        setNotice(null);
        setRecoveries([]);
      };

      // 快照只按"每轮一条"采集：起点 / 手动 / 回滚前 / 基线，全部直接展示。
      const rows = items.map((item) => {
        const selected = planFor === item.id;
        const undoEntry = item.phase === 'pre-rollback';
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
                  children: [
                    item.windowRisk > 0
                      ? jsx('span', {
                          style: { color: 'var(--dsw-alias-warning, #d29922)', marginRight: '4px' },
                          title: t('panel.plan.risk').replace('{n}', String(item.windowRisk)),
                          children: '⚠',
                        })
                      : null,
                    item.label ? item.label.split('\n')[0] : jsx('span', { style: S.muted, children: '—' }),
                  ],
                }),
                jsxs('span', {
                  style: { display: 'inline-flex', gap: '6px' },
                  children: [
                    jsx('button', {
                      type: 'button',
                      style: btn(S.btnPrimary),
                      title: undoEntry ? t('panel.undoHint') : t('panel.rollbackHint'),
                      onClick: () => preview(item.id),
                      children: undoEntry ? t('panel.undo') : t('panel.rollback'),
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
        const sessionScope = plan.sessionScope ?? {};
        const sessionCounts = sessionScope.counts ?? {};
        // 两个范围都可选中：没有差异时仍允许切换，好让用户直观看到各范围的差异量。
        // 「只恢复本次会话修改的文件」是否真有记录，只用于给出差别的提示文案。
        const sessionTracked = (sessionScope.trackedFiles ?? 0) > 0;
        // 当前生效范围：只回退对话时不谈文件范围；否则按 sessionOnly 选择。
        const activeScope = !restoreFiles ? null : (sessionOnly ? 'session' : 'all');
        const shownCounts = activeScope === 'session' ? sessionCounts : counts;
        const restores = activeScope === 'session' ? (sessionScope.restore ?? []) : (plan.restore ?? []);
        const removes = activeScope === 'session' ? (sessionScope.remove ?? []) : (plan.remove ?? []);
        const nRestore = shownCounts.restore ?? 0;
        const nRemove = shownCounts.remove ?? 0;
        const nUnchanged = shownCounts.unchanged ?? 0;
        // 回滚时会被一并收掉的"快照之后新建、删完即空"的目录数。
        const nDirs = shownCounts.dirsRemove ?? 0;
        const warnings = Array.isArray(plan.warnings) ? plan.warnings : [];
        const untracked = plan.untracked ?? null;
        const untrackedTotal = untracked
          ? (untracked.symlinks ?? 0) + (untracked.excluded ?? 0) + (untracked.oversized ?? 0) + (untracked.unreadable ?? 0)
          : 0;
        const undoEntry = plan.phase === 'pre-rollback';
        const running = plan.running === true;
        const riskCount = Array.isArray(plan.window?.risk) ? plan.window.risk.length : 0;
        const listLimit = showAll ? 500 : 8;
        const visibleRestores = restores.slice(0, listLimit);
        const visibleRemoves = removes.slice(0, listLimit);
        const hiddenCount = Math.max(0, restores.length - visibleRestores.length)
          + Math.max(0, removes.length - visibleRemoves.length);
        const scopeText = !restoreFiles
          ? t('panel.confirm.conversationOnly')
          : (optConversation ? t('panel.confirm.both') : t('panel.confirm.filesOnly'));
        const planSummary = t('panel.report.plan')
          .replace('{r}', String(nRestore))
          .replace('{x}', String(nRemove))
          .replace('{d}', String(nDirs));
        return jsxs('div', {
          style: S.detail,
          children: [
            undoEntry
              ? jsx('div', { style: Object.assign({}, S.muted, { marginBottom: '6px' }), children: t('panel.undoHint') })
              : null,
            jsx('div', {
              style: Object.assign({}, S.muted, { marginBottom: '6px' }),
              children: plan.conversation?.note ?? '',
            }),
            running
              ? jsxs('div', {
                  style: Object.assign({}, S.error, {
                    marginBottom: '8px',
                    padding: '8px',
                    border: '1px solid var(--dsw-alias-danger, #e5534b)',
                    borderRadius: '5px',
                    color: 'inherit',
                  }),
                  children: [
                    jsx('div', { style: { fontWeight: 600 }, children: t('panel.running.title') }),
                    jsx('div', { style: { marginTop: '2px' }, children: t('panel.running.hint') }),
                  ],
                })
              : null,
            ...warnings.map((warning, index) => jsx('div', {
              key: `w-${index}`,
              style: S.error,
              children: `${t('panel.warn')}：${warning}`,
            })),
            untrackedTotal > 0
              ? jsx('div', {
                  style: Object.assign({}, S.muted, { marginTop: '2px' }),
                  children: t('panel.plan.untracked')
                    .replace('{s}', String(untracked.symlinks ?? 0))
                    .replace('{e}', String(untracked.excluded ?? 0))
                    .replace('{o}', String(untracked.oversized ?? 0))
                    .replace('{u}', String(untracked.unreadable ?? 0)),
                })
              : null,
            riskCount > 0
              ? jsx('div', {
                  style: Object.assign({}, S.muted, { marginTop: '2px' }),
                  children: t('panel.plan.risk').replace('{n}', String(riskCount)),
                })
              : null,
            jsxs('div', {
              style: { display: 'flex', gap: '14px', flexWrap: 'wrap', marginTop: '6px' },
              children: [
                // ① 恢复文件（总开关）
                jsxs('label', {
                  style: { display: 'inline-flex', gap: '6px', alignItems: 'center' },
                  children: [
                    jsx('input', {
                      type: 'checkbox',
                      checked: restoreFiles,
                      onChange: (event) => {
                        setRestoreFiles(event.target.checked);
                        setConfirming(false);
                      },
                    }),
                    t('panel.opt.files'),
                  ],
                }),
                // ② 只恢复本次会话修改的文件（勾选①后才出现，二选一语义）
                restoreFiles
                  ? jsxs('label', {
                      style: { display: 'inline-flex', gap: '6px', alignItems: 'center' },
                      title: sessionTracked ? t('panel.opt.files.session.hint') : t('panel.opt.files.session.empty'),
                      children: [
                        jsx('input', {
                          type: 'checkbox',
                          checked: sessionOnly,
                          onChange: (event) => {
                            setSessionOnly(event.target.checked);
                            setConfirming(false);
                          },
                        }),
                        t('panel.opt.files.session'),
                      ],
                    })
                  : null,
                jsxs('label', {
                  style: { display: 'inline-flex', gap: '6px', alignItems: 'center' },
                  children: [
                    jsx('input', {
                      type: 'checkbox',
                      checked: optConversation,
                      disabled: plan.conversation?.available !== true,
                      onChange: (event) => {
                        setOptConversation(event.target.checked);
                        setConfirming(false);
                      },
                    }),
                    t('panel.opt.conversation'),
                  ],
                }),
              ],
            }),
            // ③ 差异量随所选范围实时变化；只回退对话时不显示文件数字。
            restoreFiles
              ? jsxs(Fragment, {
                  children: [
                    jsxs('div', {
                      style: { display: 'flex', gap: '14px', flexWrap: 'wrap', marginTop: '8px' },
                      children: [
                        jsx('span', { children: `${t('panel.plan.restore')} ${nRestore}` }),
                        jsx('span', { children: `${t('panel.plan.remove')} ${nRemove}` }),
                        jsx('span', { style: S.muted, children: `${t('panel.plan.unchanged')} ${nUnchanged}` }),
                        nDirs > 0 ? jsx('span', { style: S.muted, children: `${t('panel.plan.dirs')} ${nDirs}` }) : null,
                      ],
                    }),
                    // 收窄范围后这三个数字的含义也变了（只看本会话记录到的文件），必须说清楚，
                    // 否则「保持不变」变小会被误读成"工作区没东西可保"。
                    activeScope === 'session'
                      ? jsx('div', {
                          style: Object.assign({}, S.muted, { marginTop: '2px' }),
                          children: t('panel.plan.sessionScope').replace('{n}', String(sessionScope.trackedFiles ?? 0)),
                        })
                      : null,
                    activeScope === 'session' && !sessionTracked
                      ? jsx('div', { style: Object.assign({}, S.muted, { marginTop: '4px' }), children: t('panel.opt.files.session.empty') })
                      : null,
                    nRestore + nRemove === 0
                      ? jsx('div', { style: Object.assign({}, S.muted, { marginTop: '4px' }), children: t('panel.plan.none') })
                      : jsxs('div', {
                          style: { marginTop: '4px' },
                          children: [
                            jsxs('div', {
                              style: {
                                maxHeight: showAll ? '260px' : '160px',
                                overflowY: 'auto',
                                padding: '4px 6px',
                                border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.25))',
                                borderRadius: '4px',
                              },
                              children: [
                                ...visibleRestores.map((item) => jsx('div', {
                                  key: `r-${item.rel}`,
                                  style: S.mono,
                                  children: `+ ${item.rel}  (${item.action})`,
                                })),
                                ...visibleRemoves.map((item) => jsx('div', {
                                  key: `x-${item.rel}`,
                                  style: S.mono,
                                  children: `- ${item.rel}  (${item.action})`,
                                })),
                              ],
                            }),
                            hiddenCount > 0
                              ? jsx('button', {
                                  type: 'button',
                                  style: btn(),
                                  onClick: () => setShowAll(!showAll),
                                  children: showAll
                                    ? t('panel.plan.collapse')
                                    : `${t('panel.plan.list')} (+${hiddenCount})`,
                                })
                              : null,
                            plan.truncated || (activeScope === 'session' && sessionScope.truncated)
                              ? jsx('div', {
                                  style: Object.assign({}, S.muted, { marginTop: '4px' }),
                                  children: t('panel.plan.truncated').replace('{n}', '500'),
                                })
                              : null,
                          ],
                        }),
                  ],
                })
              : null,
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
                      onChange: (event) => {
                        setEditMode(event.target.checked);
                        setConfirming(false);
                      },
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
            confirming
              ? jsxs('div', {
                  style: Object.assign({}, S.error, {
                    marginTop: '10px',
                    padding: '8px',
                    border: '1px solid var(--dsw-alias-danger, #e5534b)',
                    borderRadius: '5px',
                    color: 'inherit',
                  }),
                  children: [
                    jsx('div', { style: { fontWeight: 600 }, children: t('panel.confirm.title') }),
                    jsx('div', { style: { marginTop: '4px' }, children: t('panel.confirm.hint') }),
                    jsx('div', { style: { marginTop: '4px', fontWeight: 600 }, children: `${scopeText}；${planSummary}` }),
                  ],
                })
              : null,
            jsxs('div', {
              style: { display: 'flex', gap: '8px', marginTop: '10px', alignItems: 'center', flexWrap: 'wrap' },
              children: [
                !confirming
                  ? jsx('button', {
                      type: 'button',
                      style: btn(S.btnPrimary),
                      disabled: busy || running || planToken === null || (!restoreFiles && !optConversation),
                      onClick: () => setConfirming(true),
                      children: busy ? t('panel.busy') : t('panel.do'),
                    })
                  : jsx('button', {
                      type: 'button',
                      style: btn(S.btnDanger),
                      disabled: busy || running || planToken === null || (!restoreFiles && !optConversation),
                      onClick: runRollback,
                      children: busy ? t('panel.busy') : t('panel.confirm.do'),
                    }),
                confirming
                  ? jsx('button', {
                      type: 'button',
                      style: btn(),
                      disabled: busy,
                      onClick: () => setConfirming(false),
                      children: t('panel.confirm.cancel'),
                    })
                  : null,
                planToken === null || running
                  ? jsx('button', {
                      type: 'button',
                      style: btn(),
                      disabled: busy,
                      onClick: () => preview(planFor),
                      children: t('panel.refresh'),
                    })
                  : null,
                jsx('button', {
                  type: 'button',
                  style: btn(),
                  disabled: busy,
                  onClick: () => {
                    setPlan(null);
                    setPlanFor(null);
                    setPlanToken(null);
                    setConfirming(false);
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
                jsx('div', { style: S.title, children: `${t('panel.title')}（${items.length}）` }),
                jsx('button', {
                  type: 'button',
                  style: iconBtn(),
                  disabled: busy,
                  onClick: load,
                  title: t('panel.refresh'),
                  'aria-label': t('panel.refresh'),
                  children: icon('refresh'),
                }),
                jsx('button', {
                  type: 'button',
                  style: iconBtn(),
                  disabled: busy,
                  onClick: captureNow,
                  title: t('panel.capture'),
                  'aria-label': t('panel.capture'),
                  children: icon('camera'),
                }),
                jsx('button', {
                  type: 'button',
                  style: btn(),
                  disabled: busy,
                  title: t('panel.cleanupHint'),
                  onClick: cleanupStore,
                  children: t('panel.cleanup'),
                }),
                jsx('button', {
                  type: 'button',
                  style: iconBtn(),
                  onClick: close,
                  title: t('panel.close'),
                  'aria-label': t('panel.close'),
                  children: icon('close'),
                }),
              ],
            }),
            jsxs('div', {
              style: S.body,
              children: [
                recoveries.length > 0
                  ? jsxs('div', {
                      style: Object.assign({}, S.detail, {
                        marginBottom: '8px',
                        border: '1px solid var(--dsw-alias-warning, #d29922)',
                        borderRadius: '5px',
                        padding: '8px',
                      }),
                      children: [
                        jsx('div', { style: { fontWeight: 600 }, children: t('panel.recovery.title') }),
                        jsx('div', { style: Object.assign({}, S.muted, { marginTop: '2px' }), children: t('panel.recovery.hint') }),
                        ...recoveries.map((item, index) => jsxs('div', {
                          key: `rec-${item.id}-${index}`,
                          style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginTop: '6px' },
                          children: [
                            jsx('span', {
                              style: S.mono,
                              children: `${item.status} · ${clockOf(item.startedAt)} · ${String(item.snapshotId ?? '')}`,
                            }),
                            jsx('button', {
                              type: 'button',
                              style: btn(),
                              disabled: busy,
                              onClick: () => recoverTransaction(item.id, 'resume'),
                              children: t('panel.recovery.resume'),
                            }),
                            item.preRollbackId
                              ? jsx('button', {
                                  type: 'button',
                                  style: btn(),
                                  disabled: busy,
                                  onClick: () => recoverTransaction(item.id, 'revert'),
                                  children: t('panel.recovery.revert'),
                                })
                              : null,
                          ],
                        })),
                      ],
                    })
                  : null,
                error !== null ? jsx('div', { style: Object.assign({}, S.error, { marginBottom: '8px' }), children: `${t('panel.error')}：${error}` }) : null,
                notice !== null ? jsx('div', { style: Object.assign({}, S.muted, { marginBottom: '8px' }), children: notice }) : null,
                captureError !== null
                  ? jsx('div', { style: Object.assign({}, S.error, { marginBottom: '8px' }), children: `${t('panel.captureError')}：${captureError}` })
                  : null,
                storageError !== null
                  ? jsx('div', { style: Object.assign({}, S.error, { marginBottom: '8px' }), children: `${t('panel.storageError')}：${storageError}` })
                  : null,
                status === 'loading' ? jsx('div', { style: S.muted, children: t('panel.loading') }) : null,
                items.length === 0 && status !== 'loading' ? jsx('div', { style: S.muted, children: t('panel.empty') }) : null,
                ...rows,
                report !== null
                  ? jsxs('div', {
                      style: Object.assign({}, S.detail, { marginTop: '10px' }),
                      children: [
                        jsx('div', {
                          style: { fontWeight: 600, color: (report.files?.failed ?? 0) > 0 ? 'var(--dsw-alias-danger, #e5534b)' : undefined },
                          children: (report.files?.failed ?? 0) > 0 ? t('panel.report.partial') : t('panel.report'),
                        }),
                        report.files !== null && report.files !== undefined
                          ? jsx('div', {
                              children: t('panel.report.files')
                                .replace('{r}', String(report.files.restored ?? 0))
                                .replace('{x}', String(report.files.removed ?? 0))
                                .replace('{f}', String(report.files.failed ?? 0)),
                            })
                          : null,
                        report.files?.dirsRemoved !== undefined
                          ? jsx('div', {
                              style: S.muted,
                              children: t('panel.report.dirs').replace('{d}', String(report.files.dirsRemoved ?? 0)),
                            })
                          : null,
                        report.plan?.counts
                          ? jsx('div', {
                              style: S.muted,
                              children: t('panel.report.plan')
                                .replace('{r}', String(report.plan.counts.restore ?? 0))
                                .replace('{x}', String(report.plan.counts.remove ?? 0))
                                .replace('{d}', String(report.plan.counts.dirsRemove ?? 0)),
                            })
                          : null,
                        report.transactionId
                          ? jsx('div', { style: S.muted, children: t('panel.report.transaction').replace('{id}', String(report.transactionId)) })
                          : null,
                        report.recoveryPoint !== undefined && report.recoveryPoint !== null
                          ? jsx('div', { style: S.muted, children: t('panel.recovery').replace('{id}', String(report.recoveryPoint)) })
                          : null,
                        report.recoveryPoint !== undefined && report.recoveryPoint !== null
                          ? jsx('div', { style: Object.assign({}, S.muted, { marginTop: '2px' }), children: t('panel.report.recoveryHint') })
                          : null,
                        report.conversation?.childSessionId !== undefined && report.conversation.childSessionId !== null
                          ? jsxs('div', {
                              style: { display: 'flex', gap: '10px', alignItems: 'center', marginTop: '6px' },
                              children: [
                                jsx('span', { style: S.mono, children: t('panel.report.new').replace('{id}', String(report.conversation.childSessionId)) }),
                                jsx('button', {
                                  type: 'button',
                                  style: btn(S.btnPrimary),
                                  onClick: () => {
                                    openSession(report.conversation.childSessionId);
                                    close();
                                  },
                                  children: t('panel.report.open'),
                                }),
                              ],
                            })
                          : null,
                        report.prompt?.accepted === true ? jsx('div', { style: S.muted, children: t('panel.report.sent') }) : null,
                        ...(report.warnings ?? []).map((warning, index) => jsx('div', { key: `w-${index}`, style: S.error, children: `${t('panel.warn')}：${warning}` })),
                        (report.files?.failures ?? []).length > 0
                          ? jsxs('div', {
                              style: { marginTop: '6px' },
                              children: [
                                jsx('div', { style: { fontWeight: 600 }, children: t('panel.report.failures') }),
                                ...(report.files.failures ?? []).map((failure, index) => jsx('div', {
                                  key: `f-${index}`,
                                  style: S.mono,
                                  children: `${failure.rel} (${failure.action}): ${failure.error}`,
                                })),
                              ],
                            })
                          : null,
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
        const registeredSlotCount = 3;
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'snapshot-manager: dictionaries');

        // 会话头部按钮（快照时间线）
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'snapshot-manager-header',
          order: 30,
          locale: NS,
          inject: (sessionId) => ({ sessionId }),
        }, guarded(SnapshotHeaderAction)));

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
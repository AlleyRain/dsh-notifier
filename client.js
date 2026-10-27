window.__ModuleLoader__.load({
  id: '@local/dsh-notifier',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'dsh-notifier';
    const STREAM_URL = '/dsh-notifier/events';
    const MAX_OPEN_NOTIFICATIONS = 6;
    const MAX_SEEN_IDS = 200;

    /** Simplified Chinese dictionary; also the key-set source of truth. */
    const zh = {
      title: '浏览器通知',
      description: '当 DSH 需要你回答、审批或做出其他响应时，发送系统通知。',
      enable: '启用通知',
      enabled: '已开启',
      test: '发送测试',
      requesting: '请求权限…',
      denied: '通知已被阻止',
      deniedHint: '此网站的通知已被浏览器阻止。请在浏览器的网站设置中允许通知，然后刷新页面。',
      unsupported: '此浏览器不支持系统通知。',
      insecureHint: '浏览器通知需要 HTTPS 或 localhost 环境。',
      showFailed: '浏览器拒绝了这条通知。',
      testTitle: 'DSH 浏览器通知',
      testBody: '通知已开启。DSH 需要你操作时，会在这里提醒你。',
      approvalTitle: 'DSH 需要你的批准',
      approvalBody: '工具 {tool} 请求执行权限，请回到 DSH 处理。',
      approvalBodyGeneric: '有一项操作需要你的批准，请回到 DSH 处理。',
      approvalReason: '原因：{reason}',
      questionTitle: 'DSH 需要你的回答',
      questionBodyGeneric: '有一个问题等待你的回答，请回到 DSH 处理。',
      questionMore: '还有 {count} 个问题等待回答。',
    };

    /** English dictionary with the same key set. */
    const en = {
      title: 'Browser notifications',
      description: 'Show a system notification when DSH needs your answer, approval, or other response.',
      enable: 'Enable notifications',
      enabled: 'Enabled',
      test: 'Send test',
      requesting: 'Requesting…',
      denied: 'Notifications blocked',
      deniedHint: 'Notifications are blocked for this site. Allow them in your browser settings, then reload this page.',
      unsupported: 'This browser does not support system notifications.',
      insecureHint: 'Browser notifications require HTTPS or localhost.',
      showFailed: 'The browser refused to show a notification.',
      testTitle: 'DSH browser notifications',
      testBody: 'Notifications are on. DSH will remind you here when it needs your response.',
      approvalTitle: 'DSH needs your approval',
      approvalBody: 'Tool {tool} requested permission. Return to DSH to respond.',
      approvalBodyGeneric: 'An operation needs your approval. Return to DSH to respond.',
      approvalReason: 'Reason: {reason}',
      questionTitle: 'DSH needs your answer',
      questionBodyGeneric: 'A question is waiting for your answer. Return to DSH to respond.',
      questionMore: '{count} more question(s) are waiting.',
    };

    const css = `
      .dshNotifier_row{border-bottom:.5px solid var(--dsw-alias-border-l2);align-items:center;gap:16px;padding:16px 0;display:flex}
      .dshNotifier_rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}
      .dshNotifier_titleRow{align-items:center;gap:8px;display:flex}
      .dshNotifier_bell{flex:none;color:var(--dsw-alias-label-secondary);display:inline-flex}
      .dshNotifier_title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}
      .dshNotifier_description{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
      .dshNotifier_error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
      .dshNotifier_success{color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px}
      .dshNotifier_actions{align-items:center;gap:10px;display:inline-flex;flex:none}
      .dshNotifier_action{border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);height:36px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;align-items:center;gap:8px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex;flex:none}
      .dshNotifier_action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
      .dshNotifier_action:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}
      .dshNotifier_action:disabled{opacity:.5;cursor:default}
    `;

    /** Open notifications, keyed by tag, so focus/teardown can close them. */
    const openNotifications = new Map();

    /**
     * Check for the browser API, including the secure-context requirement.
     * @returns whether Web Notifications can be used here.
     */
    function supportsNotifications() {
      return typeof window !== 'undefined'
        && 'Notification' in window
        && window.isSecureContext !== false;
    }

    /**
     * Check whether this page is loaded outside a secure context.
     * @returns whether HTTPS or localhost is required.
     */
    function isInsecureContext() {
      return typeof window !== 'undefined' && window.isSecureContext === false;
    }

    /**
     * Read the current permission without throwing in unusual embeds.
     * @returns `granted`, `denied`, `default`, or `unsupported`.
     */
    function readPermission() {
      if (!supportsNotifications()) return 'unsupported';
      try {
        return Notification.permission;
      } catch {
        return 'unsupported';
      }
    }

    /**
     * Ask for permission. The settings row is the user gesture behind this call.
     * @returns the resolved permission.
     */
    async function requestPermission() {
      if (!supportsNotifications()) return 'unsupported';
      try {
        const result = await Notification.requestPermission();
        return typeof result === 'string' ? result : readPermission();
      } catch (error) {
        console.warn('[dsh-notifier] notification permission request failed:', error);
        return readPermission();
      }
    }

    /**
     * Only disturb the user while the page is out of sight. When it is focused,
     * the in-app approval/question UI is the better signal.
     * @returns whether a notification should be shown.
     */
    function shouldNotify() {
      if (typeof document === 'undefined') return false;
      if (document.visibilityState === 'hidden') return true;
      try {
        return !document.hasFocus();
      } catch {
        return true;
      }
    }

    /**
     * Shorten one value for a notification body.
     * @param value - candidate text.
     * @param limit - maximum code units.
     * @returns the trimmed text, or undefined.
     */
    function clip(value, limit) {
      if (typeof value !== 'string') return undefined;
      const text = value.trim();
      if (text.length === 0) return undefined;
      return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
    }

    /**
     * Choose the display text for the active locale.
     * @param value - string or locale-to-string map from the host.
     * @param locale - active locale id.
     * @returns the best available text.
     */
    function pickLocalized(value, locale) {
      if (typeof value === 'string') return value;
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
      const primary = String(locale ?? 'en').split('-')[0];
      return value[locale] ?? value[primary] ?? value.en ?? value.zh;
    }

    /**
     * Build the visible title and body for one payload.
     * @param payload - wire payload from the host.
     * @param t - locale-bound translator.
     * @param locale - active locale id.
     * @returns title/body, or null for an unknown kind.
     */
    function formatPayload(payload, t, locale) {
      if (payload.kind === 'test') {
        return { title: t('testTitle'), body: t('testBody') };
      }
      if (payload.kind === 'approval') {
        const tool = clip(payload.toolName, 100);
        let body = tool === undefined ? t('approvalBodyGeneric') : t('approvalBody', { tool });
        const reason = clip(pickLocalized(payload.displayReason, locale) ?? payload.reason, 300);
        if (reason !== undefined) body += `\n${t('approvalReason', { reason })}`;
        return { title: t('approvalTitle'), body };
      }
      if (payload.kind === 'question') {
        const questions = Array.isArray(payload.questions) ? payload.questions : [];
        const first = questions.find((question) => question !== null && typeof question === 'object' && typeof question.question === 'string');
        let body;
        if (first === undefined) {
          body = t('questionBodyGeneric');
        } else {
          const header = clip(first.header, 80);
          body = `${header === undefined ? '' : `${header}\n`}${clip(first.question, 320) ?? ''}`;
          const total = typeof payload.questionCount === 'number' ? payload.questionCount : questions.length;
          if (total > 1) body += `\n${t('questionMore', { count: total - 1 })}`;
          if (body.trim() === '') body = t('questionBodyGeneric');
        }
        return { title: t('questionTitle'), body };
      }
      return null;
    }

    /**
     * Close one tracked notification.
     * @param tag - notification tag.
     */
    function closeNotification(tag) {
      const notification = openNotifications.get(tag);
      if (notification === undefined) return;
      openNotifications.delete(tag);
      try {
        notification.close();
      } catch {
        // The browser already dismissed it.
      }
    }

    /** Close every notification this page opened. */
    function closeAllNotifications() {
      for (const tag of [...openNotifications.keys()]) closeNotification(tag);
    }

    /** Keep the number of simultaneously retained notifications bounded. */
    function trimOpenNotifications() {
      while (openNotifications.size > MAX_OPEN_NOTIFICATIONS) {
        const oldest = openNotifications.keys().next().value;
        if (oldest === undefined) return;
        closeNotification(oldest);
      }
    }

    /**
     * Show one Web Notification.
     * @param ctx - Client plugin context.
     * @param payload - wire payload.
     * @param options - `force` bypasses focus suppression; `test` marks a test.
     * @returns whether a notification was created.
     */
    function showNotification(ctx, payload, options = {}) {
      if (!supportsNotifications() || readPermission() !== 'granted') return false;
      if (!options.force && !shouldNotify()) return false;

      const t = ctx.locale.bind(NS);
      const locale = ctx.locale.getSnapshot().active;
      const formatted = formatPayload(payload, t, locale);
      if (formatted === null) return false;

      const tag = typeof payload.id === 'string' ? payload.id : `dsh-notifier:${Date.now()}`;
      closeNotification(tag);

      let notification;
      try {
        notification = new Notification(formatted.title, {
          body: formatted.body,
          tag,
          lang: locale,
          requireInteraction: options.test !== true,
        });
      } catch (error) {
        console.warn('[dsh-notifier] could not show a browser notification:', error);
        return false;
      }

      openNotifications.set(tag, notification);
      const forget = () => {
        if (openNotifications.get(tag) === notification) openNotifications.delete(tag);
      };
      notification.onclose = forget;
      notification.onerror = forget;
      notification.onclick = () => {
        try {
          window.focus();
        } catch {
          // Some browsers do not let a notification focus the page.
        }
        if (typeof payload.sessionId === 'string') {
          try {
            ctx.get('uiWorkspace')?.openSession(payload.sessionId);
          } catch (error) {
            console.warn('[dsh-notifier] could not open the session from the notification:', error);
          }
        }
        try {
          notification.close();
        } catch {
          // The browser already dismissed it.
        }
        forget();
      };
      trimOpenNotifications();
      return true;
    }

    /**
     * Subscribe to the Host SSE stream and turn notifications into Web Notifications.
     * @param ctx - Client plugin context.
     * @returns a disposer closing the stream.
     */
    function connect(ctx) {
      if (typeof EventSource === 'undefined') {
        console.warn('[dsh-notifier] EventSource is unavailable; browser notifications are disabled.');
        return () => {};
      }

      let source;
      let disposed = false;
      const seen = new Set();

      const openStream = () => {
        if (disposed) return;
        try {
          source = new EventSource(STREAM_URL);
        } catch (error) {
          console.warn('[dsh-notifier] could not open the notification stream:', error);
          return;
        }
        source.addEventListener('notify', (event) => {
          let payload;
          try {
            payload = JSON.parse(event.data);
          } catch {
            return;
          }
          if (payload === null || typeof payload !== 'object' || payload.v !== 1) return;
          if (payload.kind !== 'approval' && payload.kind !== 'question') return;
          const id = typeof payload.id === 'string' ? payload.id : undefined;
          if (id !== undefined) {
            if (seen.has(id)) return;
            seen.add(id);
            if (seen.size > MAX_SEEN_IDS) {
              const oldest = seen.values().next().value;
              if (oldest !== undefined) seen.delete(oldest);
            }
          }
          showNotification(ctx, payload);
        });
      };

      openStream();

      const reconnect = () => {
        if (disposed) return;
        if (source !== undefined && source.readyState !== 2) return;
        try {
          source?.close();
        } catch {
          // Already closed.
        }
        openStream();
      };
      window.addEventListener('online', reconnect);
      window.addEventListener('pageshow', reconnect);

      return () => {
        disposed = true;
        window.removeEventListener('online', reconnect);
        window.removeEventListener('pageshow', reconnect);
        try {
          source?.close();
        } catch {
          // Already closed.
        }
        source = undefined;
      };
    }

    /**
     * Render one small bell; artwork only, so its colors follow the text token.
     * @returns the bell SVG element.
     */
    function BellIcon() {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 16,
        height: 16,
        className: 'dshNotifier_bell',
        'aria-hidden': true,
      },
      h('path', {
        d: 'M8 1.6a4.2 4.2 0 0 0-4.2 4.2v3.1L2.4 11a.7.7 0 0 0 .6 1.1h10a.7.7 0 0 0 .6-1.1L12.2 8.9V5.8A4.2 4.2 0 0 0 8 1.6Z',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 1.2,
        'stroke-linejoin': 'round',
      }),
      h('path', {
        d: 'M6.3 13.2a1.8 1.8 0 0 0 3.4 0',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 1.2,
        'stroke-linecap': 'round',
      }));
    }

    /**
     * Client plugin body.
     * @param ctx - Client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-notifier: dictionaries');

      ctx.effect(() => {
        const tag = document.createElement('style');
        tag.dataset.plugin = '@local/dsh-notifier';
        tag.textContent = css;
        document.head.appendChild(tag);
        return () => tag.remove();
      }, 'dsh-notifier: settings styles');

      ctx.effect(() => connect(ctx), 'dsh-notifier: notification stream');

      const closeOnFocus = () => closeAllNotifications();
      ctx.effect(() => {
        window.addEventListener('focus', closeOnFocus);
        return () => window.removeEventListener('focus', closeOnFocus);
      }, 'dsh-notifier: focus suppression');

      ctx.effect(() => () => closeAllNotifications(), 'dsh-notifier: close notifications');

      /**
       * The General settings row. It is both the permission entry point and the
       * place to ask for a test notification.
       * @param props - slot props; the locale option injects `t`.
       * @returns the row element.
       */
      function SettingsRow(props) {
        const t = typeof props.t === 'function' ? props.t : ctx.locale.bind(NS);
        const [permission, setPermission] = React.useState(readPermission);
        const [busy, setBusy] = React.useState(false);
        const [error, setError] = React.useState('');

        React.useEffect(() => {
          const sync = () => setPermission(readPermission());
          window.addEventListener('focus', sync);
          document.addEventListener('visibilitychange', sync);
          return () => {
            window.removeEventListener('focus', sync);
            document.removeEventListener('visibilitychange', sync);
          };
        }, []);

        const showTest = () => {
          setError('');
          const shown = showNotification(ctx, {
            v: 1,
            kind: 'test',
            id: `dsh-notifier:test:${Date.now()}`,
          }, { force: true, test: true });
          if (!shown) setError(t('showFailed'));
        };

        const enable = async () => {
          setBusy(true);
          setError('');
          try {
            const result = await requestPermission();
            setPermission(result);
            if (result === 'granted') {
              showTest();
            } else if (result === 'denied') {
              setError(t('deniedHint'));
            }
          } finally {
            setBusy(false);
          }
        };

        let description = t('description');
        let descriptionClass = 'dshNotifier_description';
        let action = null;

        if (isInsecureContext()) {
          description = t('insecureHint');
        } else if (!supportsNotifications()) {
          description = t('unsupported');
        } else if (permission === 'denied') {
          description = t('deniedHint');
          descriptionClass = 'dshNotifier_error';
        } else if (permission === 'granted') {
          action = h('div', { className: 'dshNotifier_actions' },
            h('span', { className: 'dshNotifier_success' }, t('enabled')),
            h('button', {
              type: 'button',
              className: 'dshNotifier_action',
              onClick: showTest,
            }, t('test')));
        } else {
          action = h('button', {
            type: 'button',
            className: 'dshNotifier_action',
            disabled: busy,
            onClick: enable,
          }, busy ? t('requesting') : t('enable'));
        }

        if (error !== '') {
          description = error;
          descriptionClass = 'dshNotifier_error';
        }

        return h('div', { className: 'dshNotifier_row' },
          h('div', { className: 'dshNotifier_rowText' },
            h('div', { className: 'dshNotifier_titleRow' },
              h(BellIcon),
              h('div', { className: 'dshNotifier_title' }, t('title'))),
            h('div', {
              className: descriptionClass,
              role: 'status',
              'aria-live': 'polite',
            }, description)),
          action);
      }

      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'browser-notifications',
        order: 5,
        locale: NS,
      }, SettingsRow));
    }

    return { inject: ['slots', 'locale'], apply };
  },
});

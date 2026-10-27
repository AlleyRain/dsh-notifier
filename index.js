/**
 * Host half of browser notifications.
 *
 * DSH forwards approval and user-question requests to the browser through a
 * waterfall. A listener that only records the request can be reached too late:
 * the shipped browser answerer owns the chain and awaits the user before it
 * delegates. This plugin therefore registers first (`prepend: true`) and only
 * observes, then hands the request to the next listener unchanged.
 *
 * The observation reaches the page over one authenticated SSE endpoint. The
 * Client half turns it into a Web Notification; nothing here depends on a
 * desktop notification daemon, `notify-send`, or a platform-specific binary.
 */

import { randomUUID } from 'node:crypto';

/** Exact same-origin SSE endpoint consumed by the Client half. */
export const EVENTS_PATH = '/dsh-notifier/events';

const HEARTBEAT_MS = 25_000;
const MAX_CLIENTS = 32;
const MAX_TEXT = 600;

const NAME = 'dsh-notifier';

/**
 * Trim one host-provided string for transport and display.
 * @param value - untrusted value from a request.
 * @param limit - maximum retained code units.
 * @returns the trimmed string, or undefined for a non-string or blank value.
 */
function clipped(value, limit = MAX_TEXT) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text.length === 0) return undefined;
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * Preserve the localized display reason in a JSON-safe, bounded shape.
 * @param request - approval request.
 * @returns a locale-to-text map, a plain string, or undefined.
 */
function displayReasonOf(request) {
  const display = request?.displayReason;
  if (display !== null && typeof display === 'object' && !Array.isArray(display)) {
    const entries = {};
    for (const [locale, value] of Object.entries(display)) {
      const text = clipped(value, 300);
      if (text !== undefined) entries[locale] = text;
    }
    if (Object.keys(entries).length > 0) return entries;
  }
  return clipped(request?.reason, MAX_TEXT);
}

/**
 * Build the wire value for one approval request.
 * @param request - `approval/request` payload.
 * @returns a versioned notification payload.
 */
export function buildApprovalPayload(request) {
  const sessionId = typeof request?.agent?.id === 'string' ? request.agent.id : undefined;
  const callId = typeof request?.callId === 'string' ? request.callId : undefined;
  const reason = clipped(request?.reason, MAX_TEXT);
  const displayReason = displayReasonOf(request);

  const payload = {
    v: 1,
    id: `approval:${sessionId ?? 'unknown'}:${callId ?? randomUUID()}`,
    kind: 'approval',
    toolName: clipped(request?.toolName, 160) ?? '',
  };
  if (sessionId !== undefined) payload.sessionId = sessionId;
  if (callId !== undefined) payload.callId = callId;
  if (reason !== undefined) payload.reason = reason;
  if (displayReason !== undefined) payload.displayReason = displayReason;
  return payload;
}

/**
 * Build the wire value for one user-question request.
 * @param request - `user-questions/request` payload.
 * @returns a versioned notification payload.
 */
export function buildQuestionPayload(request) {
  const sessionId = typeof request?.agent?.id === 'string' ? request.agent.id : undefined;
  const callId = typeof request?.wait?.callId === 'string' ? request.wait.callId : undefined;
  const questions = Array.isArray(request?.questions) ? request.questions.slice(0, 5) : [];

  const payload = {
    v: 1,
    id: `question:${sessionId ?? 'unknown'}:${callId ?? randomUUID()}`,
    kind: 'question',
    questions: questions.map((question) => {
      const item = {
        id: clipped(question?.id, 80) ?? '',
        question: clipped(question?.question, 400) ?? '',
      };
      const header = clipped(question?.header, 120);
      if (header !== undefined) item.header = header;
      if (typeof question?.multiSelect === 'boolean') item.multiSelect = question.multiSelect;
      if (Array.isArray(question?.options)) item.optionCount = question.options.length;
      return item;
    }),
  };
  if (sessionId !== undefined) payload.sessionId = sessionId;
  if (callId !== undefined) payload.callId = callId;
  if (Array.isArray(request?.questions)) payload.questionCount = request.questions.length;
  return payload;
}

/**
 * Frame one Server-Sent Event.
 * @param event - event name.
 * @param data - JSON-serializable payload.
 * @returns the wire frame.
 */
export function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The Web server route carrier and the authenticated connection fence. */
export const inject = ['webServer', 'connection'];

/**
 * Register the SSE endpoint and prepend observation listeners for the two
 * requests that require a user response.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  /** One live SSE response; `close` owns its heartbeat and registry entry. */
  const clients = new Set();

  /**
   * Remove one SSE client and end its response.
   * @param client - client record.
   */
  const drop = (client) => {
    if (!clients.delete(client)) return;
    try {
      if (!client.res.writableEnded) client.res.end();
    } catch {
      // The peer is already gone; there is nothing left to close.
    }
  };

  /**
   * Deliver one frame to every live page. A page that stays connected receives
   * every request; the Client half decides whether it is in the foreground.
   * @param event - event name.
   * @param payload - JSON-serializable payload.
   */
  const broadcast = (event, payload) => {
    if (clients.size === 0) return;
    const frame = sseFrame(event, payload);
    for (const client of [...clients]) {
      try {
        if (client.res.destroyed || client.res.writableEnded) {
          drop(client);
          continue;
        }
        client.res.write(frame);
      } catch {
        drop(client);
      }
    }
  };

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: EVENTS_PATH,
    handler: (req, res) => {
      let rejection;
      try {
        rejection = ctx.connection.requestRejection(req);
      } catch {
        rejection = 401;
      }
      if (rejection !== undefined) {
        res.statusCode = rejection;
        res.end();
        return;
      }
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('allow', 'GET');
        res.end();
        return;
      }
      if (clients.size >= MAX_CLIENTS) {
        res.statusCode = 429;
        res.setHeader('retry-after', '30');
        res.end();
        return;
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.flushHeaders?.();
      res.write('retry: 3000\n\n');
      res.write(sseFrame('ready', { v: 1 }));

      let heartbeat;
      let closed = false;
      const client = { res };
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clients.delete(client);
        try {
          if (!res.writableEnded) res.end();
        } catch {
          // The peer is already gone.
        }
      };

      heartbeat = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          close();
        }
      }, HEARTBEAT_MS);
      heartbeat.unref?.();

      clients.add(client);
      req.on('close', close);
      res.on('close', close);
      res.on('error', close);
    },
  }), 'dsh-notifier: SSE endpoint');

  const publish = (payload) => {
    try {
      broadcast('notify', payload);
    } catch (error) {
      // Notification delivery must never interfere with the request itself.
      console.warn('[dsh-notifier] notification delivery failed:', error);
    }
  };

  ctx.effect(() => ctx.on('approval/request', function (request, next) {
    publish(buildApprovalPayload(request));
    return next();
  }, { prepend: true }), 'dsh-notifier: approval notifications');

  ctx.effect(() => ctx.on('user-questions/request', function (request, next) {
    publish(buildQuestionPayload(request));
    return next();
  }, { prepend: true }), 'dsh-notifier: question notifications');

  ctx.effect(() => () => {
    for (const client of [...clients]) drop(client);
  }, 'dsh-notifier: close SSE clients');
}

/** Cordis function-plugin name. */
export const name = NAME;

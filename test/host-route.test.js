import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { apply, EVENTS_PATH } from '../index.js';

/**
 * Minimal Cordis stand-in for the Host seam this plugin uses. It records the
 * event listeners and the registered web route without booting a Harness.
 * @returns the fake context and captured route/listeners.
 */
function createHarness({ rejection } = {}) {
  const listeners = new Map();
  let route;
  const ctx = {
    effect(execute) {
      return execute();
    },
    on(event, listener, options) {
      listeners.set(event, { listener, options });
      return () => {};
    },
    webServer: {
      register(candidate) {
        route = candidate;
        return () => {};
      },
    },
    connection: {
      requestRejection() {
        return rejection;
      },
    },
  };
  apply(ctx);
  return { ctx, route, listeners };
}

/**
 * Fake `node:http` response for the SSE route.
 * @returns the response and its recorded frames.
 */
function createResponse() {
  const frames = [];
  const response = Object.assign(new EventEmitter(), {
    statusCode: 0,
    headers: {},
    writableEnded: false,
    destroyed: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(status, headers) {
      this.statusCode = status;
      Object.assign(this.headers, headers);
    },
    flushHeaders() {},
    write(chunk) {
      frames.push(String(chunk));
      return true;
    },
    end() {
      this.writableEnded = true;
    },
  });
  return { response, frames };
}

test('registers the authenticated SSE route at the documented path', () => {
  const { route } = createHarness();
  assert.equal(route.kind, 'exact');
  assert.equal(route.path, EVENTS_PATH);
});

test('unauthenticated SSE requests are rejected before streaming', () => {
  const { route } = createHarness({ rejection: 401 });
  const { response, frames } = createResponse();
  route.handler(new EventEmitter(), response);

  assert.equal(response.statusCode, 401);
  assert.equal(response.writableEnded, true);
  assert.deepEqual(frames, []);
});

test('an approval request is broadcast to a connected SSE client', () => {
  const { route, listeners } = createHarness();
  const { response, frames } = createResponse();
  const request = Object.assign(new EventEmitter(), { method: 'GET' });
  route.handler(request, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.ok(frames.some((frame) => frame.includes('event: ready')));

  const approval = listeners.get('approval/request');
  assert.equal(approval.options.prepend, true);
  let nextCalled = false;
  approval.listener({
    agent: { id: 'session-1' },
    toolName: 'bash',
    callId: 'call-1',
    reason: 'needs approval',
  }, () => {
    nextCalled = true;
    return 'unavailable';
  });

  assert.equal(nextCalled, true);
  const notify = frames.find((frame) => frame.startsWith('event: notify\n'));
  assert.ok(notify !== undefined);
  assert.match(notify, /"kind":"approval"/u);
  assert.match(notify, /"toolName":"bash"/u);
  assert.match(notify, /"sessionId":"session-1"/u);
});

test('a question request is broadcast and the chain still delegates', () => {
  const { route, listeners } = createHarness();
  const { response, frames } = createResponse();
  route.handler(Object.assign(new EventEmitter(), { method: 'GET' }), response);

  const question = listeners.get('user-questions/request');
  assert.equal(question.options.prepend, true);
  let nextCalled = false;
  question.listener({
    agent: { id: 'session-2' },
    wait: { callId: 'call-2' },
    questions: [{ id: 'q1', header: 'Pick', question: 'Which one?', options: ['A', 'B'] }],
  }, () => {
    nextCalled = true;
    return { answers: [] };
  });

  assert.equal(nextCalled, true);
  const notify = frames.find((frame) => frame.startsWith('event: notify\n'));
  assert.ok(notify !== undefined);
  assert.match(notify, /"kind":"question"/u);
  assert.match(notify, /"question":"Which one\?"/u);
});

test('connected clients are closed when the plugin unloads', () => {
  const disposers = [];
  const listeners = new Map();
  let route;
  const ctx = {
    effect(execute) {
      const dispose = execute();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    on(event, listener) {
      listeners.set(event, listener);
      return () => {};
    },
    webServer: {
      register(candidate) {
        route = candidate;
        return () => {};
      },
    },
    connection: { requestRejection: () => undefined },
  };
  apply(ctx);

  const { response } = createResponse();
  route.handler(Object.assign(new EventEmitter(), { method: 'GET' }), response);
  for (const dispose of disposers.reverse()) dispose();
  assert.equal(response.writableEnded, true);
});

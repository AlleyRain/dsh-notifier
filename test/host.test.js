import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildApprovalPayload,
  buildQuestionPayload,
  sseFrame,
} from '../index.js';

test('approval payload carries the tool, reason, and session id', () => {
  const payload = buildApprovalPayload({
    agent: { id: 'session-1' },
    toolName: 'bash',
    callId: 'call-1',
    reason: 'Write outside the workspace',
    displayReason: { en: 'Write outside the workspace', zh: '写入工作区之外' },
  });

  assert.equal(payload.v, 1);
  assert.equal(payload.kind, 'approval');
  assert.equal(payload.id, 'approval:session-1:call-1');
  assert.equal(payload.sessionId, 'session-1');
  assert.equal(payload.callId, 'call-1');
  assert.equal(payload.toolName, 'bash');
  assert.deepEqual(payload.displayReason, {
    en: 'Write outside the workspace',
    zh: '写入工作区之外',
  });
});

test('approval payload stays valid without an agent or call id', () => {
  const payload = buildApprovalPayload({ toolName: 'edit' });

  assert.equal(payload.kind, 'approval');
  assert.match(payload.id, /^approval:unknown:/u);
  assert.equal(payload.toolName, 'edit');
  assert.equal(Object.hasOwn(payload, 'sessionId'), false);
  assert.equal(Object.hasOwn(payload, 'callId'), false);
});

test('approval payload bounds long text', () => {
  const payload = buildApprovalPayload({
    agent: { id: 's' },
    toolName: 't'.repeat(500),
    reason: 'r'.repeat(2000),
  });

  assert.ok(payload.toolName.length <= 160);
  assert.ok(payload.reason.length <= 600);
});

test('question payload keeps just the notification-facing question fields', () => {
  const payload = buildQuestionPayload({
    agent: { id: 'session-2' },
    wait: { callId: 'call-2', timed: true },
    questions: [{
      id: 'q1',
      header: 'Choose',
      question: 'Which route?',
      detail: 'a very long plan',
      multiSelect: false,
      options: [{ label: 'A' }, { label: 'B' }],
    }],
  });

  assert.equal(payload.kind, 'question');
  assert.equal(payload.id, 'question:session-2:call-2');
  assert.equal(payload.sessionId, 'session-2');
  assert.equal(payload.callId, 'call-2');
  assert.equal(payload.questionCount, 1);
  assert.deepEqual(payload.questions, [{
    id: 'q1',
    question: 'Which route?',
    header: 'Choose',
    multiSelect: false,
    optionCount: 2,
  }]);
  assert.equal(Object.hasOwn(payload.questions[0], 'detail'), false);
});

test('question payload tolerates an agentless request', () => {
  const payload = buildQuestionPayload({ questions: [] });

  assert.match(payload.id, /^question:unknown:/u);
  assert.deepEqual(payload.questions, []);
});

test('SSE framing is a single retryable event block', () => {
  assert.equal(
    sseFrame('notify', { v: 1, kind: 'approval' }),
    'event: notify\ndata: {"v":1,"kind":"approval"}\n\n',
  );
});

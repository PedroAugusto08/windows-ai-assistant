// These checks run without Windows, a WebView, native IPC, or an application.
import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeConversationRun } from './validate-conversation-windows.mjs';

function observation({ tokens = { dashboard: '0:1', assistant: '0:1' }, activeOwner = 'dashboard', status = 'processing', messageId = '0:1:user' } = {}) {
  const run = new NativeConversationRun({ mode: 'fixture', manifest: { executableSha256: 'synthetic', testBoundaries: [] } }, 9284);
  run.dashboard = {}; run.assistant = {};
  run.fixtureStatus = async () => ({ lastTokens: tokens });
  run.snapshot = async () => ({ activeOwner, status, messages: messageId === null ? [] : [{ id: messageId }] });
  // A token-validation failure must be local to the observer, rather than
  // dispatching an invalid command that could be mistaken for a safe refusal.
  run.invoke = () => { throw Error('Unexpected native IPC dispatch'); };
  return run;
}
const missingToken = /Missing verified active fixture token/;

test('rejects missing, empty and non-string observed tokens before native IPC', async () => {
  for (const token of [undefined, null, '', 0, {}, []]) {
    const run = observation({ tokens: { dashboard: token } });
    await assert.rejects(run.currentToken(run.dashboard), missingToken);
  }
});

test('rejects a token that does not identify the current user turn', async () => {
  for (const messageId of [null, '0:2:user', '0:1:assistant', 'other-turn:user']) {
    const run = observation({ messageId });
    await assert.rejects(run.currentToken(run.dashboard), missingToken);
  }
});

test('rejects foreign-owner or settled-session observations', async () => {
  const foreign = observation();
  await assert.rejects(foreign.currentToken(foreign.assistant), missingToken);
  for (const status of ['idle', 'awaiting_approval']) {
    const run = observation({ status });
    await assert.rejects(run.currentToken(run.dashboard), missingToken);
  }
});

test('returns the actual matching token for a processing or executing origin', async () => {
  for (const status of ['processing', 'executing']) {
    const run = observation({ status });
    assert.equal(await run.currentToken(run.dashboard), '0:1');
  }
});

import assert from 'node:assert/strict';
import { askRpcQuestionnaire, isRpcQuestionnaireHost } from '../lib/rpc-questionnaire.mjs';
const question = { header: 'Approval', question: 'May I edit the disposable test?', options: [
  { label: 'Approve edit', description: 'Back up and change only the fixture.', preview: '+ test_generator_input' },
  { label: 'Do not edit', description: 'Leave the fixture unchanged.' },
] };
assert.equal(isRpcQuestionnaireHost(['node', 'pi', '--mode', 'rpc', '-a']), true);
assert.equal(isRpcQuestionnaireHost(['node', 'pi', '--mode', 'text']), false);
assert.equal(isRpcQuestionnaireHost(['node', 'pi', '--resume', 'rpc']), false);
let resolveDialog, settled = false, observedChoices;
const pending = askRpcQuestionnaire({ questions: [question] }, {
  select(title, choices) { assert.match(title, /May I edit/); observedChoices = choices; return new Promise(resolve => { resolveDialog = resolve; }); },
}).then(result => { settled = true; return result; });
await new Promise(resolve => setTimeout(resolve, 25));
assert.equal(settled, false, 'No answer may be fabricated while the native dialog is pending.');
resolveDialog(observedChoices[1]);
const denied = await pending;
assert.equal(denied.cancelled, false);
assert.equal(denied.answers[0].answer, 'Do not edit');
const approved = await askRpcQuestionnaire({ questions: [question] }, { select: async (_title, choices) => choices[0] });
assert.equal(approved.answers[0].preview, '+ test_generator_input');
const custom = await askRpcQuestionnaire({ questions: [question] }, { select: async (_title, choices) => choices.at(-2), input: async () => 'Only after a backup — café 中文' });
assert.equal(custom.answers[0].kind, 'custom');
assert.match(custom.answers[0].answer, /café 中文/);
const cancelled = await askRpcQuestionnaire({ questions: [question] }, { select: async () => undefined });
assert.deepEqual(cancelled, { answers: [], cancelled: true });
const aborter = new AbortController();
const interrupted = await askRpcQuestionnaire({ questions: [question] }, {
  select: async (_title, choices, opts) => { assert.equal(opts.signal, aborter.signal); aborter.abort(); return choices[0]; },
}, aborter.signal);
assert.deepEqual(interrupted, { answers: [], cancelled: true });
let step = 0;
const multi = await askRpcQuestionnaire({ questions: [{ ...question, multiSelect: true }, question] }, {
  select: async (_title, choices) => [choices[0], choices[1], choices.at(-1), choices[1]][step++],
  notify() { throw new Error('Unexpected empty selection'); },
});
assert.equal(multi.answers.length, 2);
assert.deepEqual(multi.answers[0].selected, ['Approve edit', 'Do not edit']);
assert.equal(multi.answers[1].answer, 'Do not edit');
await assert.rejects(askRpcQuestionnaire({ questions: [question] }, { select: async () => 'forged response' }), /unknown choice/);
console.log('PASS: pending answer, approve/deny, free text, preview, cancellation, abort, multi-select, multiple questions, terminal routing.');

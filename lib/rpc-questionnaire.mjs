// Adapter for the pinned questionnaire extension's RPC host. The interactive
// terminal continues to use its own custom UI; only RPC calls use this helper.
export function isRpcQuestionnaireHost(argv = process.argv) {
  return argv.some((value, index) => value === '--mode' && argv[index + 1] === 'rpc');
}

export async function askRpcQuestionnaire(params, ui, signal) {
  const answers = [];
  const cancelled = () => ({ answers, cancelled: true });
  const opts = { signal };
  for (const [questionIndex, question] of params.questions.entries()) {
    if (signal?.aborted) return cancelled();
    const title = `${question.header} (${questionIndex + 1}/${params.questions.length})\n${question.question}`;
    const answer = { questionIndex, question: question.question };
    const labels = question.options.map((option, index) =>
      `${index + 1}. ${option.label}\n${option.description}${option.preview ? `\nPreview:\n${option.preview}` : ''}`);
    if (question.multiSelect) {
      const selected = new Set();
      for (;;) {
        const choices = labels.map((label, index) => `${selected.has(index) ? '[x]' : '[ ]'} ${label}`);
        const done = 'Submit selected answers';
        const choice = await ui.select(title, [...choices, done], opts);
        if (signal?.aborted || choice === undefined) return cancelled();
        if (choice === done) {
          if (!selected.size) { ui.notify('Select at least one answer, or cancel the question.', 'info'); continue; }
          answers.push({ ...answer, kind: 'multi', answer: null,
            selected: [...selected].sort((a, b) => a - b).map(index => question.options[index].label) });
          break;
        }
        const index = choices.indexOf(choice);
        if (index < 0) throw new Error('Question dialog returned an unknown choice.');
        if (selected.has(index)) selected.delete(index); else selected.add(index);
      }
      continue;
    }
    const custom = 'Type an answer', discuss = 'Discuss this question in chat';
    const choice = await ui.select(title, [...labels, custom, discuss], opts);
    if (signal?.aborted || choice === undefined) return cancelled();
    if (choice === custom) {
      const value = await ui.input(title, 'Your answer', opts);
      if (signal?.aborted || value === undefined) return cancelled();
      answers.push({ ...answer, kind: 'custom', answer: value });
    } else if (choice === discuss) {
      answers.push({ ...answer, kind: 'chat', answer: 'Chat about this' });
    } else {
      const index = labels.indexOf(choice);
      if (index < 0) throw new Error('Question dialog returned an unknown choice.');
      const option = question.options[index];
      answers.push({ ...answer, kind: 'option', answer: option.label, ...(option.preview ? { preview: option.preview } : {}) });
    }
  }
  return { answers, cancelled: false };
}

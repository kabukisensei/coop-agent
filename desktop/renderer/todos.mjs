// The todo panel (`@juicesharp/rpiv-todo`) in the window. The extension draws
// its panel in the terminal as a TUI component (the factory form of Pi's
// `setWidget`), which Pi's RPC mode drops, so the window rebuilds the same
// panel from the session itself, the way the extension does: every `todo` tool
// result carries the full task list in `details`, the last one wins, and the
// list is read from `get_messages` on load and from each `tool_execution_end`
// after that. Nothing is stored; a session switch starts over.
//
// The lines follow the extension's overlay (its docs/overlay.md): a heading
// with the done/total count, one row per task with the status glyph, the
// activeForm of the task in progress, dependencies as `⛓ #1,#2`, task ids
// only when a dependency points at them, completed rows kept until the next
// turn starts, and a row budget that drops completed rows first.

export const TODO_TOOL = "todo";
/** The extension's `maxWidgetLines` default: heading plus rows. */
export const MAX_ROWS = 12;
export const COLLAPSE_KEY = "Alt+T";

const GLYPH = { pending: "○", in_progress: "◐", completed: "✓", deleted: "✗" };

/** The `details` envelope every successful `todo` call returns (tasks plus the next id). */
export function isTaskDetails(value) {
  return Boolean(value) && typeof value === "object" && Array.isArray(value.tasks) && typeof value.nextId === "number";
}

export function createTodos() {
  return { tasks: [], nextId: 1, hidden: new Set(), found: false };
}

/** Replace the list with a tool result's snapshot; other results change nothing. */
export function applyTodoResult(state, result) {
  const details = result && typeof result === "object" ? result.details : undefined;
  if (!isTaskDetails(details)) return false;
  // A `clear` starts the ids over: nothing hidden belongs to the new list.
  if (details.nextId < state.nextId) state.hidden.clear();
  state.tasks = details.tasks.filter((task) => task && typeof task === "object").map((task) => ({ ...task }));
  state.nextId = details.nextId;
  state.found = true;
  for (const id of [...state.hidden]) {
    const task = state.tasks.find((t) => t.id === id);
    if (!task || task.status !== "completed") state.hidden.delete(id);
  }
  return true;
}

/**
 * The list a session carries: the last `todo` tool result in its messages, as
 * the extension replays it. `found` says whether the messages carried one at
 * all: after a compaction `get_messages` holds the summary and what came after
 * it, so a caller keeps the list it has when nothing was found and the session
 * is the same.
 */
export function todosFromMessages(messages) {
  const state = createTodos();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.role !== "toolResult" || message.toolName !== TODO_TOOL) continue;
    applyTodoResult(state, message);
  }
  // Rows completed in earlier turns stay out of the way on a resume.
  startTurn(state);
  return state;
}

/** A new turn: the rows completed during the last one leave the panel. */
export function startTurn(state) {
  for (const task of state.tasks) if (task.status === "completed") state.hidden.add(task.id);
}

function visibleTasks(state) {
  return state.tasks.filter((task) => task.status !== "deleted" && !(task.status === "completed" && state.hidden.has(task.id)));
}

// The extension's selectOverlayLayout: drop completed rows first, then the
// tail of the unfinished ones, with one row kept for the summary.
function layout(tasks, budget) {
  if (tasks.length <= budget) return { visible: tasks, hiddenCompleted: 0, truncatedTail: 0 };
  const inner = budget - 1;
  const unfinished = tasks.filter((task) => task.status !== "completed");
  const completed = tasks.length - unfinished.length;
  if (unfinished.length <= inner) {
    const kept = new Set(unfinished);
    for (const task of tasks) {
      if (kept.size >= inner) break;
      if (task.status === "completed") kept.add(task);
    }
    const visible = tasks.filter((task) => kept.has(task));
    return { visible, hiddenCompleted: completed - visible.filter((task) => task.status === "completed").length, truncatedTail: 0 };
  }
  return { visible: unfinished.slice(0, inner), hiddenCompleted: completed, truncatedTail: unfinished.length - inner };
}

function row(task, showIds) {
  let line = GLYPH[task.status] || "○";
  if (showIds) line += ` #${task.id}`;
  line += ` ${String(task.subject || "").replace(/[\r\n\t]+/g, " ")}`;
  if (task.status === "in_progress" && task.activeForm) line += ` (${String(task.activeForm).replace(/[\r\n\t]+/g, " ")})`;
  if (Array.isArray(task.blockedBy) && task.blockedBy.length) line += ` ⛓ ${task.blockedBy.map((id) => `#${id}`).join(",")}`;
  return line;
}

/**
 * The panel's lines, or none when nothing is left to show. `collapsed` keeps
 * the heading and a hint, as the terminal's collapse key does; `rows` is the
 * row budget including the heading (`MAX_ROWS` by default, every row when
 * tool output is expanded).
 */
export function todoLines(state, { collapsed = false, rows = MAX_ROWS } = {}) {
  const tasks = visibleTasks(state);
  if (!tasks.length) return [];
  const completed = tasks.filter((task) => task.status === "completed").length;
  const active = tasks.some((task) => task.status === "pending" || task.status === "in_progress");
  const heading = `${active ? "●" : "○"} Todos (${completed}/${tasks.length})`;
  if (collapsed) return [heading, `└─ collapsed, ${COLLAPSE_KEY} expands`];
  const showIds = tasks.some((task) => Array.isArray(task.blockedBy) && task.blockedBy.length > 0);
  const { visible, hiddenCompleted, truncatedTail } = layout(tasks, Math.max(2, rows) - 1);
  const lines = [heading, ...visible.map((task) => `├─ ${row(task, showIds)}`)];
  if (!hiddenCompleted && !truncatedTail) {
    lines[lines.length - 1] = lines[lines.length - 1].replace("├─", "└─");
    return lines;
  }
  const parts = [];
  if (hiddenCompleted) parts.push(`${hiddenCompleted} completed`);
  if (truncatedTail) parts.push(`${truncatedTail} pending`);
  lines.push(`└─ +${hiddenCompleted + truncatedTail} more (${parts.join(", ")})`);
  return lines;
}

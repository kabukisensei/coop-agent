// J0, the classifier trial (master plan section 6.6, register row 15b): score
// TypeSafe's Jev and Cloudflare's Clef against the coop/auto routing rule and
// against hand labels, on a synthetic prompt set. Runs on a workstation, never a
// client VM: it refuses on Windows, reads only the set it is given (the shipped
// one holds no client data) and prints no prompt text, only ids. Keys come from
// the environment for this one process (TYPESAFE_API_KEY, CLOUDFLARE_API_KEY and
// CLOUDFLARE_ACCOUNT_ID), which `coop router-trial` on a Mac fills from the
// keychain; coop never stores them, and `coop doctor` flags one on a client
// profile. A classifier replaces the rule only if it routes measurably better.
//
//   node lib/router-trial.mjs --pi <pi-coding-agent dir> [--set <jsonl>] \
//        [--classifiers typesafe,cloudflare,cloudflare-flash] [--out <json>]
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyRequest, TIERS } from "./router-rules.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SET = join(HERE, "..", "tests", "fixtures", "router-trial", "prompts.jsonl");

/** The classifiers the trial knows, by short name: Pi provider and model id. */
export const CLASSIFIERS = {
  typesafe: { provider: "typesafe", id: "jev-latest", keys: ["TYPESAFE_API_KEY"] },
  cloudflare: { provider: "cloudflare-workers-ai", id: "@cf/cloudflare/clef", keys: ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"] },
  "cloudflare-flash": { provider: "cloudflare-workers-ai", id: "@cf/cloudflare/clef-flash", keys: ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"] },
};

/** The one question every classifier answers, phrased like the rule it competes with. */
export const QUESTION = {
  tier: {
    type: "choice",
    instructions: "coop routes `prompt` (asked at thinking level `thinkingLevel`) to one of three OpenAI Codex models. Which tier fits the work it asks for?",
    criteria: {
      build: "A quick answer or lookup: a short factual question, a one-line explanation, a definition, something a small model answers well",
      standard: "An ordinary task: one feature, fix, query, measure, review or document change with a clear scope",
      plan: "Demanding work: subtle design, cross-cutting changes across several files or systems, hard debugging, or a long brief that needs planning first",
    },
  },
};

export function readSet(path) {
  const rows = readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  for (const r of rows) {
    if (!r.id || typeof r.prompt !== "string" || !TIERS.includes(r.label)) throw new Error(`router-trial: bad row ${JSON.stringify(r).slice(0, 80)}`);
    r.thinkingLevel = r.thinkingLevel ?? "medium";
  }
  return rows;
}

export function parseArgs(argv) {
  const out = { set: DEFAULT_SET, classifiers: ["typesafe", "cloudflare"], out: "", pi: "", help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--set") out.set = argv[++i];
    else if (a === "--classifiers") out.classifiers = String(argv[++i]).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--pi") out.pi = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`router-trial: unknown argument ${a}`);
  }
  for (const c of out.classifiers) if (!CLASSIFIERS[c]) throw new Error(`router-trial: unknown classifier ${c} (known: ${Object.keys(CLASSIFIERS).join(", ")})`);
  return out;
}

/** Which of a classifier's keys are missing from the environment. */
export function missingKeys(name, env = process.env) {
  return CLASSIFIERS[name].keys.filter((k) => !env[k]);
}

/**
 * Run the set through the rule and each classifier. `classify(name, row)` returns
 * `{ choice, probabilities, confidence, cost, error }`; the real one is in main(),
 * tests inject their own. Prints no prompt text.
 */
export async function runTrial(rows, classifierNames, classify) {
  const rule = rows.map((r) => ({ id: r.id, label: r.label, rule: classifyRequest(r.prompt, r.thinkingLevel) }));
  const result = { rows: rows.length, rule: score(rule.map((r) => r.rule), rule.map((r) => r.label)), classifiers: {} };
  for (const name of classifierNames) {
    const answers = [];
    let cost = 0, errors = 0, latency = 0;
    for (const row of rows) {
      const t0 = Date.now();
      let a;
      try { a = await classify(name, row); } catch (e) { a = { error: String(e?.message ?? e) }; }
      latency += Date.now() - t0;
      if (a.error) { errors++; answers.push(undefined); continue; }
      cost += a.cost ?? 0;
      answers.push(a.choice);
    }
    const labels = rule.map((r) => r.label);
    result.classifiers[name] = {
      ...score(answers, labels),
      agreesWithRule: agreement(answers, rule.map((r) => r.rule)),
      errors,
      meanLatencyMs: rows.length ? Math.round(latency / rows.length) : 0,
      cost: Number(cost.toFixed(4)),
      disagreements: rows.map((r, i) => ({ id: r.id, label: r.label, rule: rule[i].rule, classifier: answers[i] })).filter((d) => d.classifier !== undefined && d.classifier !== d.label),
    };
  }
  return result;
}

function score(predicted, labels) {
  let correct = 0; const perTier = {};
  for (const t of TIERS) perTier[t] = { n: 0, correct: 0 };
  labels.forEach((label, i) => { perTier[label].n++; if (predicted[i] === label) { correct++; perTier[label].correct++; } });
  return { accuracy: labels.length ? Number((correct / labels.length).toFixed(3)) : 0, correct, perTier };
}
function agreement(a, b) {
  let same = 0, n = 0;
  a.forEach((x, i) => { if (x !== undefined) { n++; if (x === b[i]) same++; } });
  return n ? Number((same / n).toFixed(3)) : 0;
}

/** The report Aaron reads: one line per scorer, then the disagreements by id. */
export function formatReport(result) {
  const lines = [`rows: ${result.rows}`, `rule (coop/auto today): accuracy ${pct(result.rule.accuracy)} (${tiers(result.rule.perTier)})`];
  for (const [name, c] of Object.entries(result.classifiers)) {
    lines.push(`${name}: accuracy ${pct(c.accuracy)} (${tiers(c.perTier)}), agrees with rule ${pct(c.agreesWithRule)}, errors ${c.errors}, mean ${c.meanLatencyMs} ms, cost $${c.cost}`);
    if (c.disagreements.length) lines.push(`  off the label: ${c.disagreements.map((d) => `${d.id} ${d.label}>${d.classifier}`).join(", ")}`);
  }
  const best = Object.entries(result.classifiers).sort((a, b) => b[1].accuracy - a[1].accuracy)[0];
  lines.push(best && best[1].accuracy > result.rule.accuracy
    ? `verdict: ${best[0]} routes better than the rule by ${pct(best[1].accuracy - result.rule.accuracy)} on this set`
    : "verdict: no classifier beats the rule on this set; coop/auto keeps the rule");
  return lines.join("\n");
}
const pct = (x) => `${Math.round(x * 100)}%`;
const tiers = (p) => TIERS.map((t) => `${t} ${p[t].correct}/${p[t].n}`).join(", ");

/** A classify() over Pi's ModelRuntime from the installed pi-coding-agent. */
export async function createPiClassify(piDir, env = process.env) {
  const require = createRequire(join(piDir, "package.json"));
  const entry = require.resolve("@earendil-works/pi-coding-agent");
  const { ModelRuntime } = await import(pathToFileURL(entry).href);
  // Keys come from the environment; the throw-away auth file keeps the trial out of coop's sign-ins.
  const runtime = await ModelRuntime.create({ authPath: join(mkdtempSync(join(tmpdir(), "coop-router-trial-")), "auth.json"), refreshOnCreate: false });
  return async (name, row) => {
    const { provider, id } = CLASSIFIERS[name];
    const model = runtime.getModelOfType("classifier", provider, id);
    if (!model) return { error: `${provider}/${id} is not in this Pi's catalog` };
    const result = await runtime.classify(model, { state: { prompt: row.prompt.slice(0, 16_000), thinkingLevel: row.thinkingLevel }, questions: QUESTION });
    if (result.stopReason !== "stop") return { error: result.errorMessage || result.stopReason };
    const answer = result.answers.tier;
    return { choice: answer?.choice, probabilities: answer?.probabilities, confidence: answer?.confidence, cost: result.usage?.cost?.total ?? 0 };
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.help) { console.log("usage: coop router-trial [--set <jsonl>] [--classifiers typesafe,cloudflare,cloudflare-flash] [--out <json>]"); return 0; }
  if (process.platform === "win32") { console.error("router-trial: runs on a workstation (macOS or Linux), never on a client VM."); return 2; }
  const rows = readSet(args.set);
  const names = [];
  for (const name of args.classifiers) {
    const missing = missingKeys(name, env);
    if (missing.length) console.error(`router-trial: skipping ${name}: ${missing.join(" and ")} not set`);
    else names.push(name);
  }
  if (!names.length) { console.error("router-trial: no classifier has its key; set TYPESAFE_API_KEY (and/or CLOUDFLARE_API_KEY with CLOUDFLARE_ACCOUNT_ID) for this one process"); return 2; }
  if (!args.pi) { console.error("router-trial: --pi <pi-coding-agent dir> is required (coop router-trial finds it)"); return 2; }
  const classify = await createPiClassify(args.pi, env);
  const result = await runTrial(rows, names, classify);
  console.log(formatReport(result));
  if (args.out) { writeFileSync(args.out, JSON.stringify(result, null, 2) + "\n"); console.log(`written: ${args.out}`); }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((rc) => process.exit(rc), (e) => { console.error(`router-trial: ${e?.message ?? e}`); process.exit(1); });
}

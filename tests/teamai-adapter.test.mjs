// Tests for the config-gated TeamAI adapter (lib/teamai-adapter.mjs).
// Isolated: a fake teamai CLI sentinel records argv/env/cwd — no network, no
// real TeamAI state, synthetic notes only.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { resolveTeamaiConfig, contributeTeamaiKnowledge, recallTeamaiKnowledge } = await import("../lib/teamai-adapter.mjs");

const profile = mkdtempSync(join(tmpdir(), "teamai-adapter-test-"));
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ✓ ${name}`); };

// Fake teamai CLI: records invocations, prints scripted output.
function makeFakeCli({ output = "", exit = 0, recordPath }) {
  const script = join(profile, `fake-teamai-${n}-${Math.random().toString(36).slice(2, 6)}.mjs`);
  writeFileSync(script, `import { writeFileSync, appendFileSync } from "node:fs";
const rec = ${JSON.stringify(recordPath)};
appendFileSync(rec, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), hermesHome: process.env.HERMES_HOME ?? null, gitPrompt: process.env.GIT_TERMINAL_PROMPT ?? null }) + "\\n");
process.stdout.write(${JSON.stringify(output)});
process.exit(${exit});
`);
  return { cli: process.execPath, cliArgsPrefix: [script] };
}

// Wrap execFileImpl so "cli" invocations go through the fake script.
function fakeExec(fake, behaviors = {}) {
  return (cmd, args, opts) => {
    if (cmd === fake.cli) {
      const line = JSON.parse(readFileSync(fake.recordPath, "utf8").trim().split("\n").pop() || "{}");
      const b = behaviors[line.argv.join(" ")] ?? {};
      if (b.output !== undefined || b.exit !== undefined) {
        if ((b.exit ?? 0) !== 0) { const e = new Error("fake exit " + b.exit); e.stderr = b.stderr || "fake failure"; throw e; }
        return b.output ?? "";
      }
      return "";
    }
    if (cmd === "git") return execFileSync(cmd, args, { ...opts, encoding: "utf8" });
    return execFileSync(cmd, args, { ...opts, encoding: "utf8" });
  };
}

const enabledEnv = (over = {}) => ({ COOP_TEAMAI_ENABLED: "1", COOP_TEAMAI_REPO: "cooptimize/coop-team-knowledge", COOP_TEAMAI_WORKTREE: join(profile, "wt"), COOP_TEAMAI_HERMES_HOME: join(profile, "hhome"), ...over });

await t("default OFF: every operation reports disabled, no spawn occurs", async () => {
  const cfg = resolveTeamaiConfig({});
  assert.equal(cfg.ok, false); assert.equal(cfg.reason, "disabled");
  const c = await contributeTeamaiKnowledge(cfg, { file: "/x.md" });
  assert.equal(c.ok, false); assert.equal(c.reason, "disabled");
  const r = await recallTeamaiKnowledge(cfg, "query");
  assert.equal(r.ok, false); assert.equal(r.reason, "disabled");
});

await t("enabled but missing/invalid config reports unavailable explicitly", async () => {
  const bad = resolveTeamaiConfig(enabledEnv({ COOP_TEAMAI_REPO: "not-a-repo" }));
  assert.equal(bad.ok, false); assert.equal(bad.reason, "unavailable");
  const empty = resolveTeamaiConfig(enabledEnv({ COOP_TEAMAI_CLI: "   " }));
  assert.equal(empty.ok, false); assert.equal(empty.reason, "unavailable");
});

await t("contribute uses the PR path with isolated HERMES_HOME and absolute file", async () => {
  const recordPath = join(profile, "rec-contribute.jsonl");
  const fake = { cli: process.execPath, recordPath };
  const wt = join(profile, "wt"); mkdirSync(join(wt, ".teamai"), { recursive: true });
  writeFileSync(join(wt, ".teamai", "teamai.yaml"), "mode: self\nrepo: cooptimize/coop-team-knowledge\n");
  const note = join(profile, "synthetic-note.md"); writeFileSync(note, "# synthetic\n");
  const cfg = resolveTeamaiConfig(enabledEnv({ COOP_TEAMAI_CLI: fake.cli }));
  const execImpl = (cmd, args, opts) => {
    if (cmd === fake.cli) {
      writeFileSync(recordPath, JSON.stringify({ argv: args, cwd: opts.cwd, hermesHome: opts.env.HERMES_HOME, gitPrompt: opts.env.GIT_TERMINAL_PROMPT }));
      return "Contributed via PR: learnings/x.md\nPR: https://github.com/cooptimize/coop-team-knowledge/pull/7\n";
    }
    return execFileSync(cmd, args, { ...opts, encoding: "utf8" });
  };
  const res = await contributeTeamaiKnowledge(cfg, { file: note, title: "Synthetic" }, { execFileImpl: execImpl });
  assert.equal(res.ok, true);
  assert.equal(res.value.prUrl, "https://github.com/cooptimize/coop-team-knowledge/pull/7");
  const rec = JSON.parse(readFileSync(recordPath, "utf8"));
  assert.deepEqual(rec.argv.slice(0, 2), ["contribute", "--file"]);
  assert.equal(rec.argv[2], resolve(note));
  assert.equal(rec.argv.includes("--title"), true);
  assert.equal(rec.hermesHome, join(profile, "hhome"));
  assert.equal(rec.gitPrompt, "0");
  assert.equal(rec.cwd, wt);
});

await t("exit-0 without PR identity is publication-unverified, not success", async () => {
  const wt = join(profile, "wt2"); mkdirSync(join(wt, ".teamai"), { recursive: true });
  writeFileSync(join(wt, ".teamai", "teamai.yaml"), "mode: self\n");
  const cfg = resolveTeamaiConfig(enabledEnv({ COOP_TEAMAI_WORKTREE: wt, COOP_TEAMAI_CLI: process.execPath }));
  const execImpl = (cmd, args, opts) => {
    if (cmd === process.execPath) return "Your session knowledge has been shared with the team.\n"; // prose only, no PR
    return execFileSync(cmd, args, { ...opts, encoding: "utf8" });
  };
  const res = await contributeTeamaiKnowledge(cfg, { file: join(profile, "synthetic-note.md") }, { execFileImpl: execImpl });
  assert.equal(res.ok, false); assert.equal(res.reason, "publication-unverified");
});

await t("non-self mode checkout refuses contribution (no direct-push path)", async () => {
  const wt = join(profile, "wt3"); mkdirSync(join(wt, ".teamai"), { recursive: true });
  writeFileSync(join(wt, ".teamai", "teamai.yaml"), "mode: team\n");
  const cfg = resolveTeamaiConfig(enabledEnv({ COOP_TEAMAI_WORKTREE: wt }));
  const res = await contributeTeamaiKnowledge(cfg, { file: join(profile, "synthetic-note.md") });
  assert.equal(res.ok, false); assert.equal(res.reason, "unsafe-mode");
});

await t("recall pins the approved revision and scopes output before context", async () => {
  const wt = join(profile, "wt4"); mkdirSync(join(wt, ".teamai"), { recursive: true });
  execFileSync("git", ["-C", wt, "init", "-q"], { encoding: "utf8" });
  execFileSync("git", ["-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"], { encoding: "utf8" });
  const cfg = resolveTeamaiConfig(enabledEnv({ COOP_TEAMAI_WORKTREE: wt, COOP_TEAMAI_CLI: process.execPath }));
  const execImpl = (cmd, args, opts) => {
    if (cmd === process.execPath) return "File: learnings/a.md\nRelevance: high\nExcerpt about semantic recall.\n\nFile: learnings/b.md\nRelevance: medium\nSecond excerpt.\n";
    return execFileSync(cmd, args, { ...opts, encoding: "utf8" });
  };
  const res = await recallTeamaiKnowledge(cfg, "how does recall work", { execFileImpl: execImpl });
  assert.equal(res.ok, true);
  assert.match(res.value.approvedRevision, /^[0-9a-f]{40}$/);
  assert.equal(res.value.items.length, 2);
  assert.equal(res.value.items[0].scope, "team");
  assert.ok(res.value.items[0].source.includes("teamai:cooptimize/coop-team-knowledge@"));
  assert.ok(res.value.items[0].excerpt.length <= 1200);
});

await t("recall on uninitialized checkout reports unavailable", async () => {
  const cfg = resolveTeamaiConfig(enabledEnv({ COOP_TEAMAI_WORKTREE: join(profile, "nowt") }));
  const res = await recallTeamaiKnowledge(cfg, "q");
  assert.equal(res.ok, false); assert.equal(res.reason, "unavailable");
});

await t("F1 regression: commented-out or prefixed mode values are refused", async () => {
  const mk = (name, yaml) => {
    const wt = join(profile, name); mkdirSync(join(wt, ".teamai"), { recursive: true });
    writeFileSync(join(wt, ".teamai", "teamai.yaml"), yaml);
    return wt;
  };
  for (const [name, yaml] of [
    ["wt-comment", "mode: team\n# mode: self\n"],
    ["wt-prefix", "mode: self-destruct\n"],
    ["wt-double", "mode: self\nmode: team\n"],
  ]) {
    const wt = mk(name, yaml);
    const cfg = resolveTeamaiConfig(enabledEnv({ COOP_TEAMAI_WORKTREE: wt }));
    const res = await contributeTeamaiKnowledge(cfg, { file: join(profile, "synthetic-note.md") });
    assert.equal(res.ok, false, name);
    assert.equal(res.reason, "unsafe-mode", name);
  }
});

await t("F2 regression: malformed PR URLs do not satisfy the publication gate", async () => {
  const wt = join(profile, "wt-badurl"); mkdirSync(join(wt, ".teamai"), { recursive: true });
  writeFileSync(join(wt, ".teamai", "teamai.yaml"), "mode: self\n");
  const cfg = resolveTeamaiConfig(enabledEnv({ COOP_TEAMAI_WORKTREE: wt, COOP_TEAMAI_CLI: process.execPath }));
  for (const bad of ["Contributed via PR:\nhttps://]/pull/7\n", "Contributed via PR:\nhttp://github.com/a/b/pull/7\n", "Contributed via PR:\nhttps://localhost/pull/7\n", "Contributed via PR:\nhttps://github.com/a/b/issues/7\n"]) {
    const execImpl = (cmd, args, opts) => {
      if (cmd === process.execPath) return bad;
      return execFileSync(cmd, args, { ...opts, encoding: "utf8" });
    };
    const res = await contributeTeamaiKnowledge(cfg, { file: join(profile, "synthetic-note.md") }, { execFileImpl: execImpl });
    assert.equal(res.ok, false, bad);
    assert.equal(res.reason, "publication-unverified", bad);
  }
});

await t("parsePrIdentity accepts GitHub and GitLab merge-request URLs", async () => {
  const { parsePrIdentity } = await import("../lib/teamai-adapter.mjs");
  assert.equal(parsePrIdentity("Contributed via PR: x\nPR https://github.com/o/r/pull/42"), "https://github.com/o/r/pull/42");
  assert.equal(parsePrIdentity("Contributed via PR: x\nsee https://gitlab.example.com/o/r/merge_requests/9"), "https://gitlab.example.com/o/r/merge_requests/9");
  assert.equal(parsePrIdentity("no pr here https://github.com/o/r/pull/1"), null);
});

console.log(`  ${n} teamai-adapter tests passed`);

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bindReviewerProvenance, promoteReviewRun, resolveAcceptedReviewRun, resolveStandard, validateReviewerReport } from "../lib/standards.mjs";

const tmp = mkdtempSync(join(tmpdir(), "coop-review-generation-"));
const snapshots = join(tmp, "snapshots"), project = join(tmp, "project"), outdir = join(tmp, "reviews");
const h = (value) => createHash("sha256").update(value).digest("hex");
let count = 0;
const test = (name, fn) => { fn(); count++; console.log(`  ✓ ${name}`); };
const validReport = (domain, resolution, tag = "clean") => ({
  tool: `coop-${domain}-review`, schema_version: domain === "sql" ? 4 : 3, version: "pinned-test",
  [domain === "sql" ? "files_checked" : "models_checked"]: 1,
  standards: { path: resolution.path, sha256: resolution.sha256 },
  findings: tag === "clean" ? [] : [{ rule_id: `${domain.toUpperCase()}-TEST`, severity: "warning", ...(domain === "dax" ? { model: "Sales" } : {}), file: `${tag}.${domain}`, line: 1, object: "object", message: tag, standard_ref: "§1", fingerprint: h(`${domain}-${tag}`) }],
  diagnostics: [], agent_review: [], summary: { error: 0, warning: tag === "clean" ? 0 : 1, info: 0 },
  verdict: { clean: tag === "clean", highest_severity: tag === "clean" ? null : "warning" },
});
const writeInputs = (tag) => {
  const entries = [];
  for (const domain of ["sql", "dax"]) {
    const resolution = resolveStandard(domain, { cwd: project, canonicalRoot: join(tmp, "none", "canonical"), snapshotRoot: snapshots, refresh: false, reviewerBins: { sql: join(tmp, "none-sql"), dax: join(tmp, "none-dax") } });
    const resolutionPath = join(tmp, `${tag}-${domain}-resolution.json`), reportPath = join(tmp, `${tag}-${domain}-report.json`);
    writeFileSync(resolutionPath, JSON.stringify(resolution)); writeFileSync(reportPath, JSON.stringify(validReport(domain, resolution, tag)));
    entries.push({ domain, resolutionPath, reportPath });
  }
  return entries;
};
const publish = (tag, options = {}) => promoteReviewRun(outdir, writeInputs(tag), options);

try {
  mkdirSync(join(project, ".coop"), { recursive: true }); mkdirSync(join(project, "standards")); mkdirSync(outdir);
  writeFileSync(join(project, "standards", "sql.md"), "# SQL\n"); writeFileSync(join(project, "standards", "dax.md"), "# DAX\n");
  writeFileSync(join(project, ".coop", "project.yml"), "standards:\n  sql: standards/sql.md\n  dax: standards/dax.md\n");

  test("real schema-4/schema-3 nested envelopes and error-diagnostic verdict semantics", () => {
    for (const domain of ["sql", "dax"]) {
      const resolution = resolveStandard(domain, { cwd: project, canonicalRoot: join(tmp, "none", "canonical"), snapshotRoot: snapshots, refresh: false });
      const report = validReport(domain, resolution);
      report.diagnostics = [{ severity: "error", category: "file_unreadable", file: "broken", line: 0, message: "unreadable", rule_id: "" }]; report.verdict = { clean: false, highest_severity: "error" };
      assert.deepEqual(validateReviewerReport(domain, report), { ok: true }); assert.deepEqual(bindReviewerProvenance(resolution, report).ok, true);
      const mutations = [
        (x) => { x.diagnostics = [null]; }, (x) => { x.diagnostics = [42]; }, (x) => { x.agent_review = [null]; }, (x) => { x.agent_review = [42]; },
        (x) => { x.diagnostics[0].unknown = true; }, (x) => { x.verdict.clean = true; }, (x) => { x.summary.warning = 1; },
        (x) => { x.findings = [{ rule_id: "X", severity: "warning", file: "x", line: 1, message: "x" }]; x.summary.warning = 1; },
        (x) => { x.agent_review = [{ rule_id: "X", ...(domain === "dax" ? { model: "M" } : {}), file: "x", object: "o", line: 1, note: "judge", standard_ref: "§1", fingerprint: h("judge"), extra: true }]; },
      ];
      for (const mutate of mutations) { const copy = structuredClone(report); mutate(copy); assert.equal(validateReviewerReport(domain, copy).ok, false, JSON.stringify(copy)); }
      for (const sha256 of [[report.standards.sha256], 7, {}, null]) { const copy = structuredClone(report); copy.standards.sha256 = sha256; assert.equal(validateReviewerReport(domain, copy).ok, false); }
      if (domain === "dax") { const copy = validReport(domain, resolution, "finding"); delete copy.findings[0].model; assert.equal(validateReviewerReport(domain, copy).ok, false); }
    }
  });

  const stages = ["review:sql:report", "review:sql:binding", "review:dax:report", "review:dax:binding", "review:metadata", "review:generation", "review:before-pointer", "review:after-pointer"];
  for (const stage of stages) test(`atomic review generation survives fault at ${stage}`, () => {
    rmSync(outdir, { recursive: true, force: true }); mkdirSync(outdir); assert.equal(publish("old").ok, true);
    const old = resolveAcceptedReviewRun(outdir); const result = publish("new", { fault: stage }); assert.equal(result.ok, false);
    const active = resolveAcceptedReviewRun(outdir); assert.equal(active.ok, true, JSON.stringify(active));
    const expected = stage === "review:after-pointer" ? "new" : "old";
    assert.equal(JSON.parse(readFileSync(active.reports.sql)).findings[0].message, expected);
    assert.equal(JSON.parse(readFileSync(active.reports.dax)).findings[0].message, expected);
    assert.equal(JSON.parse(readFileSync(old.reports.sql)).findings[0].message, "old");
  });

  test("abrupt process death before/after pointer leaves one complete accepted set", () => {
    for (const stage of ["review:sql:report", "review:dax:binding", "review:metadata", "review:generation", "review:before-pointer", "review:after-pointer"]) {
      rmSync(outdir, { recursive: true, force: true }); mkdirSync(outdir); assert.equal(publish("old").ok, true);
      const entries = writeInputs("new");
      const script = `import {promoteReviewRun} from ${JSON.stringify(new URL("../lib/standards.mjs", import.meta.url).href)}; const entries=${JSON.stringify(entries)}; promoteReviewRun(${JSON.stringify(outdir)},entries,{fault:(s)=>{if(s===${JSON.stringify(stage)})process.exit(77)}});`;
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", script]); assert.equal(child.status, 77, stage);
      const active = resolveAcceptedReviewRun(outdir); assert.equal(active.ok, true, stage);
      const expected = stage === "review:after-pointer" ? "new" : "old";
      assert.equal(JSON.parse(readFileSync(active.reports.sql)).findings[0].message, expected, stage);
      assert.equal(JSON.parse(readFileSync(active.reports.dax)).findings[0].message, expected, stage);
    }
  });
  test("concurrent-style pinned reader never mixes old SQL with new DAX", () => {
    rmSync(outdir, { recursive: true, force: true }); mkdirSync(outdir); assert.equal(publish("old").ok, true); const old = resolveAcceptedReviewRun(outdir);
    assert.equal(publish("new").ok, true); const current = resolveAcceptedReviewRun(outdir);
    assert.equal(JSON.parse(readFileSync(old.reports.sql)).findings[0].message, "old"); assert.equal(JSON.parse(readFileSync(old.reports.dax)).findings[0].message, "old");
    assert.equal(JSON.parse(readFileSync(current.reports.sql)).findings[0].message, "new"); assert.equal(JSON.parse(readFileSync(current.reports.dax)).findings[0].message, "new");
  });
  test("publisher stages captured report bytes and returns its own generation", () => {
    rmSync(outdir, { recursive: true, force: true }); mkdirSync(outdir);
    const captured = writeInputs("captured"), daxInput = captured.find((entry) => entry.domain === "dax").reportPath;
    const first = promoteReviewRun(outdir, captured, { fault(step) { if (step === "review:sql:report") writeFileSync(daxInput, "{}\n"); } });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(JSON.parse(readFileSync(first.reports.dax)).findings[0].message, "captured");
    let nested;
    const outer = promoteReviewRun(outdir, writeInputs("outer"), { fault(step) { if (step === "review:after-pointer") nested = publish("nested"); } });
    assert.equal(outer.ok, true, JSON.stringify(outer)); assert.equal(nested.ok, true, JSON.stringify(nested));
    assert.equal(JSON.parse(readFileSync(outer.reports.sql)).findings[0].message, "outer");
    assert.equal(JSON.parse(readFileSync(resolveAcceptedReviewRun(outdir).reports.sql)).findings[0].message, "nested");
  });
  test("accepted reader rejects consistently rehashed empty envelopes", () => {
    rmSync(outdir, { recursive: true, force: true }); mkdirSync(outdir); assert.equal(publish("forgery").ok, true);
    const active = resolveAcceptedReviewRun(outdir), pointerPath = join(outdir, "active-review-generation.json"), pointer = JSON.parse(readFileSync(pointerPath));
    const metadataPath = join(active.generation, "generation.json"), metadata = JSON.parse(readFileSync(metadataPath));
    for (const key of ["sql_report", "dax_report", "sql_binding", "dax_binding"]) {
      const path = join(active.generation, metadata.files[key].file); writeFileSync(path, "{}\n"); metadata.files[key].sha256 = h(readFileSync(path));
    }
    writeFileSync(metadataPath, JSON.stringify(metadata)); pointer.metadata_sha256 = h(readFileSync(metadataPath)); writeFileSync(pointerPath, JSON.stringify(pointer));
    assert.equal(resolveAcceptedReviewRun(outdir).ok, false);
  });
  test("unsafe review pointer and symlink root fail closed", () => {
    const pointer = join(outdir, "active-review-generation.json"), saved = readFileSync(pointer), real = `${pointer}.real`; writeFileSync(real, saved); rmSync(pointer); symlinkSync(real, pointer); assert.equal(resolveAcceptedReviewRun(outdir).ok, false);
    const link = join(tmp, "reviews-link"); symlinkSync(outdir, link); assert.equal(resolveAcceptedReviewRun(link).ok, false);
  });
  test("publication rejects swapped domains and malformed accepted metadata", () => {
    rmSync(outdir, { recursive: true, force: true }); mkdirSync(outdir);
    const swapped = writeInputs("swapped"); [swapped[0].resolutionPath, swapped[1].resolutionPath] = [swapped[1].resolutionPath, swapped[0].resolutionPath];
    assert.equal(promoteReviewRun(outdir, swapped).ok, false);
    assert.equal(resolveAcceptedReviewRun(outdir).ok, false);
    assert.equal(publish("strict").ok, true);
    const active = resolveAcceptedReviewRun(outdir), pointerPath = join(outdir, "active-review-generation.json"), pointer = JSON.parse(readFileSync(pointerPath));
    const metadataPath = join(active.generation, "generation.json"), metadata = JSON.parse(readFileSync(metadataPath));
    metadata.domains.push("sql"); writeFileSync(metadataPath, JSON.stringify(metadata));
    pointer.metadata_sha256 = h(readFileSync(metadataPath)); writeFileSync(pointerPath, JSON.stringify(pointer));
    assert.equal(resolveAcceptedReviewRun(outdir).ok, false);
  });
  console.log(`standards review generations: ${count} tests passed`);
} finally { rmSync(tmp, { recursive: true, force: true }); }

// Tests for Step 1.4 recall wiring: teamKnowledgeNote predicate and skill conventions.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.env.COOP_TEST_DIST;
const {
  teamKnowledgeNote,
} = await import(pathToFileURL(`${dist}/coop-tools.mjs`).href);

let n = 0;
const t = async (name, fn) => {
  await fn();
  n++;
  console.log(`  ✓ ${name}`);
};

const tmp = mkdtempSync(join(tmpdir(), "coop-tk-test-"));

try {
  const coopDir = join(tmp, "coop");
  const homeDir = join(tmp, "home");
  const kbDir = join(tmp, "kb", "incremental-bi");
  mkdirSync(join(coopDir, ".coop"), { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(kbDir, { recursive: true });

  await t("returns note when fixture repo exists", () => {
    writeFileSync(
      join(coopDir, ".coop", "config"),
      JSON.stringify({
        schema_version: 1,
        knowledge: {
          enabled: true,
          repos: [{ url: "https://example.com/repo.git", local_path: kbDir }],
        },
      })
    );
    const note = teamKnowledgeNote(coopDir, homeDir);
    assert.ok(note);
    assert.match(note, /Team knowledge available at/);
    assert.match(note, /see the team-knowledge skill/);
    assert.ok(note.includes(kbDir));
  });

  await t("expands ~ in local_path against homeDir", () => {
    const homeKb = join(homeDir, ".coop", "knowledge", "incremental-bi");
    mkdirSync(homeKb, { recursive: true });
    writeFileSync(
      join(coopDir, ".coop", "config"),
      JSON.stringify({
        schema_version: 1,
        knowledge: {
          enabled: true,
          repos: [{ url: "https://example.com/repo.git", local_path: "~/.coop/knowledge/incremental-bi" }],
        },
      })
    );
    const note = teamKnowledgeNote(coopDir, homeDir);
    assert.ok(note);
    assert.ok(note.includes(homeKb));
  });

  await t("returns null when local_path does not exist on disk", () => {
    writeFileSync(
      join(coopDir, ".coop", "config"),
      JSON.stringify({
        schema_version: 1,
        knowledge: {
          enabled: true,
          repos: [{ url: "https://example.com/repo.git", local_path: join(tmp, "nonexistent-kb") }],
        },
      })
    );
    const note = teamKnowledgeNote(coopDir, homeDir);
    assert.equal(note, null);
  });

  await t("returns null when knowledge is disabled", () => {
    writeFileSync(
      join(coopDir, ".coop", "config"),
      JSON.stringify({
        schema_version: 1,
        knowledge: {
          enabled: false,
          repos: [{ url: "https://example.com/repo.git", local_path: kbDir }],
        },
      })
    );
    const note = teamKnowledgeNote(coopDir, homeDir);
    assert.equal(note, null);
  });

  await t("returns null when knowledge block is absent", () => {
    writeFileSync(
      join(coopDir, ".coop", "config"),
      JSON.stringify({
        schema_version: 1,
      })
    );
    const note = teamKnowledgeNote(coopDir, homeDir);
    assert.equal(note, null);
  });

  await t("formats multiple repo paths when multiple clones exist on disk", () => {
    const kb2 = join(tmp, "kb", "second-repo");
    mkdirSync(kb2, { recursive: true });
    writeFileSync(
      join(coopDir, ".coop", "config"),
      JSON.stringify({
        schema_version: 1,
        knowledge: {
          enabled: true,
          repos: [
            { url: "https://example.com/repo1.git", local_path: kbDir },
            { url: "https://example.com/repo2.git", local_path: kb2 },
          ],
        },
      })
    );
    const note = teamKnowledgeNote(coopDir, homeDir);
    assert.ok(note);
    assert.equal(note, `Team knowledge available at ${kbDir}, ${kb2}; see the team-knowledge skill`);
  });

  await t("returns null when config file does not exist", () => {
    const emptyCoop = join(tmp, "empty-coop");
    mkdirSync(emptyCoop, { recursive: true });
    const note = teamKnowledgeNote(emptyCoop, homeDir);
    assert.equal(note, null);
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

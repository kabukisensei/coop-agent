/**
 * Automated tests for Coop rotating feature-discovery vibes & tips contract.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const VIBES_DIR = join(ROOT, "vibes");

let passed = 0;
let failed = 0;

function ok(desc) {
  console.log(`  ✓ ${desc}`);
  passed++;
}

function ko(desc, err) {
  console.error(`  ✗ ${desc}`);
  if (err) console.error(`    ${err}`);
  failed++;
}

function readLines(filePath) {
  return readPool(filePath).map(({ line }) => line);
}

function readPool(filePath) {
  let section = "tips";
  const messages = [];
  for (const raw of readFileSync(filePath, "utf8").split("\n")) {
    const line = raw.trim();
    const heading = line.match(/^# --- (.+?) ---$/);
    if (heading) {
      section = heading[1].toLowerCase();
      continue;
    }
    if (line.length > 0 && !line.startsWith("#")) messages.push({ line, section });
  }
  return messages;
}

const POOL_NAMES = [
  "professional.txt",
  "data-doc.txt",
  "sql-review.txt",
  "dax-review.txt",
  "fabric.txt",
  "coop-internal.txt",
];

const CREW_MEMBERS = ["Joel", "Eric", "Tanner", "Josh", "Simar", "April", "Aaron"];

const DISALLOWED_PATTERNS = [
  /\b(Spock|Starship|Klingon|Scotty|assimilated|Resistance is futile|Make it so|She cannae|Data, the final frontier|beam me up)\b/i,
  /\b(Leeloo|multipass|Aziz|Korben|meat popsicle|Big bada boom)\b/i,
];

const ACTIONABLE_PREFIX = /^(Add|Ask|Configure|Include|Open|Read|Run|Save|Scan|Set|Try|Type|Use)\b/;
const CLIENT_UNSAFE_PATTERNS = [/\bbastards\b/i, /screw you guys/i];
const OUT_OF_AGENT_PATTERNS = [
  /^Run coop\b/i,
  /^Run fab\b/i,
  /^Run te\b/i,
  /^Run powerbi-report-author\b/i,
  /^Import fabric_cicd\b/i,
];

console.log("→ vibes files existence and syntax");
for (const pool of POOL_NAMES) {
  const p = join(VIBES_DIR, pool);
  if (!existsSync(p)) {
    ko(`${pool} exists`);
    continue;
  }
  const lines = readLines(p);
  if (lines.length > 0) {
    ok(`${pool} exists with ${lines.length} lines`);
  } else {
    ko(`${pool} has non-empty lines`);
  }
}

console.log("→ plain text & visible length contract");
for (const pool of POOL_NAMES) {
  const lines = readLines(join(VIBES_DIR, pool));
  let invalidMarkdown = false;
  let excessiveLength = false;
  for (const l of lines) {
    if (l.includes("**") || l.includes("`") || l.includes("](")) {
      invalidMarkdown = true;
      console.error(`    [${pool}] Markdown found: ${l}`);
    }
    if (l.length > 100) {
      excessiveLength = true;
      console.error(`    [${pool}] Line too long (${l.length} chars): ${l}`);
    }
  }
  if (!invalidMarkdown) {
    ok(`${pool} contains only plain text (no markdown)`);
  } else {
    ko(`${pool} contains invalid markdown`);
  }
  if (!excessiveLength) {
    ok(`${pool} lines all within max length`);
  } else {
    ko(`${pool} contains overly long lines`);
  }
}

console.log("→ duplicate-message contract");
const allMessages = [];
for (const pool of POOL_NAMES) {
  const entries = readPool(join(VIBES_DIR, pool));
  const seen = new Set();
  const duplicates = [];
  for (const entry of entries) {
    const key = entry.line.toLowerCase();
    if (seen.has(key)) duplicates.push(entry.line);
    seen.add(key);
    allMessages.push({ ...entry, pool });
  }
  if (duplicates.length === 0) {
    ok(`${pool} has no duplicate messages`);
  } else {
    ko(`${pool} has duplicate messages`, duplicates.join(" | "));
  }
}

const repeatedLegacy = [];
const legacySeen = new Map();
for (const entry of allMessages.filter(({ section }) => section !== "tips")) {
  const key = entry.line.toLowerCase();
  if (legacySeen.has(key)) repeatedLegacy.push(`${legacySeen.get(key)} and ${entry.pool}: ${entry.line}`);
  else legacySeen.set(key, entry.pool);
}
if (repeatedLegacy.length === 0) {
  ok("legacy easter eggs are deduplicated across pools");
} else {
  ko("legacy easter eggs repeat across pools", repeatedLegacy.join(" | "));
}

console.log("→ disallowed themes removal (Star Trek and Fifth Element)");
for (const pool of POOL_NAMES) {
  const lines = readLines(join(VIBES_DIR, pool));
  let matchedDisallowed = false;
  for (const l of lines) {
    for (const pat of DISALLOWED_PATTERNS) {
      if (pat.test(l)) {
        matchedDisallowed = true;
        console.error(`    [${pool}] Disallowed theme match: ${l}`);
      }
    }
  }
  if (!matchedDisallowed) {
    ok(`${pool} contains zero disallowed theme references`);
  } else {
    ko(`${pool} contains disallowed theme references`);
  }
}

console.log("→ client-safety: real names restricted to coop-internal.txt");
for (const pool of POOL_NAMES) {
  const lines = readLines(join(VIBES_DIR, pool));
  if (pool === "coop-internal.txt") {
    // Give every worker several turns in the rotation, not a token mention.
    let allFound = true;
    for (const person of CREW_MEMBERS) {
      const references = lines.filter((l) => new RegExp(`\\b${person}\\b`).test(l)).length;
      if (references < 5) {
        allFound = false;
        console.error(`    ${person} has only ${references} internal references; expected at least 5`);
      }
    }
    if (allFound) {
      ok(`coop-internal.txt gives every crew member at least 5 references`);
    } else {
      ko(`coop-internal.txt is missing some crew members`);
    }
  } else {
    // Client-safe pool: MUST NOT contain any crew member names
    let foundName = false;
    for (const l of lines) {
      for (const person of CREW_MEMBERS) {
        if (new RegExp(`\\b${person}\\b`).test(l)) {
          foundName = true;
          console.error(`    [${pool}] Client-safe pool leaked real name: ${l}`);
        }
      }
    }
    if (!foundName) {
      ok(`${pool} is strictly client-safe (0 crew member names)`);
    } else {
      ko(`${pool} leaked real name`);
    }
    const unsafe = lines.filter((line) => CLIENT_UNSAFE_PATTERNS.some((pattern) => pattern.test(line)));
    if (unsafe.length === 0) {
      ok(`${pool} has no client-unsafe legacy phrases`);
    } else {
      ko(`${pool} has client-unsafe legacy phrases`, unsafe.join(" | "));
    }
  }
}

console.log("→ tips stay runnable from inside the active Coop session");
for (const pool of POOL_NAMES) {
  const tips = readPool(join(VIBES_DIR, pool)).filter(({ section }) => section === "tips");
  const escaped = tips.filter(({ line }) => OUT_OF_AGENT_PATTERNS.some((pattern) => pattern.test(line)));
  if (escaped.length === 0) {
    ok(`${pool} has no shell-only tips`);
  } else {
    ko(`${pool} contains tips that require leaving Coop`, escaped.map(({ line }) => line).join(" | "));
  }
}

console.log("→ actionable tip ratio (>= 80% tips in client-safe aggregate)");
let totalClientSafeLines = 0;
let totalClientSafeTips = 0;
for (const pool of POOL_NAMES) {
  if (pool === "coop-internal.txt") continue;
  const entries = readPool(join(VIBES_DIR, pool));
  const tips = entries.filter(({ section }) => section === "tips");
  const malformed = tips.filter(({ line }) => !ACTIONABLE_PREFIX.test(line));
  const pct = Math.round((tips.length / entries.length) * 100);
  totalClientSafeLines += entries.length;
  totalClientSafeTips += tips.length;
  if (malformed.length === 0) {
    ok(`${pool} marks only imperative, actionable lines as tips`);
  } else {
    ko(`${pool} has non-actionable lines in its tips section`, malformed.map(({ line }) => line).join(" | "));
  }
  if (pct >= 80) {
    ok(`${pool} has ${tips.length}/${entries.length} actionable tips (${pct}%)`);
  } else {
    ko(`${pool} tip percentage is below 80% (${pct}%)`);
  }
}

console.log("→ preserved and restored internal references");
const internalEntries = readPool(join(VIBES_DIR, "coop-internal.txt"));
for (const franchise of [
  "south park",
  "star wars",
  "monty python and the holy grail",
  "the office (us)",
  "office space",
]) {
  const count = internalEntries.filter(({ section }) => section === franchise).length;
  if (count > 0) ok(`coop-internal.txt preserves ${franchise} references (${count})`);
  else ko(`coop-internal.txt is missing ${franchise} references`);
}

const aggPct = Math.round((totalClientSafeTips / totalClientSafeLines) * 100);
if (aggPct >= 80) {
  ok(`client-safe aggregate has ${totalClientSafeTips}/${totalClientSafeLines} tips (${aggPct}% >= 80%)`);
} else {
  ko(`client-safe aggregate tip ratio too low (${aggPct}%)`);
}

console.log("→ key feature discoverability tips");
const defaultLines = POOL_NAMES.filter((p) => p !== "coop-internal.txt")
  .flatMap((p) => readLines(join(VIBES_DIR, p)));

// Product-discovery coverage only. Command validity is verified against the
// pinned tools and Pi documentation during review; string presence is not proof.
const WEBSITE_SLASH_COMMANDS = [
  "/start",
  "/setup-docs",
  "/openai-usage",
  "/discovery",
  "/impact-analysis",
  "/semantic-model-review",
  "/fabric-architecture-review",
  "/daily-log",
  "/weekly-log",
  "/spec-first",
  "/slice-next",
  "/annotate",
  "/explain",
  "/handoff",
  "/pr-description",
  "/skill:<name>",
  "/model",
  "/new",
  "/compact",
  "/coop-vibe",
  "/coop-splash",
  "/coop-guardrails",
];

const REQUIRED_NEEDLES = [
  "/copy",
  ...WEBSITE_SLASH_COMMANDS,
  "build Markdown docs",
  "SQL review",
  "DAX review",
];

let allNeedlesFound = true;
for (const needle of REQUIRED_NEEDLES) {
  const found = defaultLines.some((l) => l.includes(needle));
  if (!found) {
    allNeedlesFound = false;
    console.error(`    Missing required tip needle: ${needle}`);
  }
}
if (allNeedlesFound) {
  ok(`all ${WEBSITE_SLASH_COMMANDS.length} website slash commands appear in client-safe pools`);
  ok(`all ${REQUIRED_NEEDLES.length} key feature discovery needles found in client-safe pools`);
} else {
  ko(`some key feature needles missing`);
}

console.log("→ coop-powerline FALLBACK_VIBES");
const powerlineSrc = readFileSync(join(ROOT, "extensions/coop-powerline/index.ts"), "utf8");
if (!powerlineSrc.includes('if (name === "coop-internal.txt") continue;')) {
  ok("default rotation includes coop-internal.txt");
} else {
  ko("default rotation still excludes coop-internal.txt");
}
const match = powerlineSrc.match(/const FALLBACK_VIBES = \[([\s\S]*?)\];/);
if (match) {
  const rawArray = match[1];
  const items = rawArray
    .split("\n")
    .map((l) => l.trim().replace(/^"/, "").replace(/",?$/, ""))
    .filter(Boolean);
  let safe = items.length >= 2;
  for (const item of items) {
    if (
      !ACTIONABLE_PREFIX.test(item) ||
      item.length > 100 ||
      CREW_MEMBERS.some((m) => item.includes(m)) ||
      DISALLOWED_PATTERNS.some((p) => p.test(item)) ||
      CLIENT_UNSAFE_PATTERNS.some((p) => p.test(item))
    ) {
      safe = false;
    }
  }
  if (safe && items.some((i) => i.includes("/copy"))) {
    ok(`FALLBACK_VIBES has ${items.length} safe tips including /copy`);
  } else {
    ko(`FALLBACK_VIBES is unsafe or missing /copy`);
  }
} else {
  ko(`Could not find FALLBACK_VIBES in coop-powerline/index.ts`);
}

console.log(`\n${passed} vibes tests passed, ${failed} failed.`);
if (failed > 0) process.exit(1);

/** Pure markdown read adapter for normalized knowledge documents. */

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;

function diagnostic(code, message, source, path) {
  const location = [source, path].filter(isNonEmptyString).join(":");
  return `${code}: ${message}${location ? ` (${location})` : ""}`;
}

function stableId(sourceId, path) {
  const input = `${sourceId}\0${path}`;
  let hash = 2166136261;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `knowledge-${hash.toString(16).padStart(8, "0")}`;
}

function titleFromMarkdown(path, text) {
  let fence = null;
  for (const line of text.split(/\r\n|\n|\r/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      const closing = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (closing && closing[1][0] === fence.character && closing[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (marker) {
      fence = { character: marker[1][0], length: marker[1].length };
      continue;
    }

    const heading = line.match(/^ {0,3}#(?!#)[ \t]+(.*?)[ \t]*$/);
    if (heading) {
      const title = heading[1].replace(/[ \t]+#+[ \t]*$/, "").trim();
      if (title) return title;
    }
  }
  return path.replace(/\\/g, "/").split("/").pop() || path;
}

function providerError(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Read all markdown documents for one normalized registry source. */
export async function readSourceDocuments(source, provider) {
  const sourceId = isObject(source) && isNonEmptyString(source.id) ? source.id : undefined;
  if (!sourceId) {
    return { documents: [], errors: [diagnostic("invalid-source", "source.id must be a non-empty string")] };
  }
  if (source.agent_read === false) {
    return { documents: [], errors: [diagnostic("agent-read-denied", "source is not readable by the agent", sourceId)] };
  }
  if (!isObject(provider) || typeof provider.listFiles !== "function" || typeof provider.readFiles !== "function") {
    return { documents: [], errors: [diagnostic("invalid-provider", "provider must define listFiles and readFiles", sourceId)] };
  }

  let listedFiles;
  try {
    listedFiles = await provider.listFiles(source);
  } catch (error) {
    return { documents: [], errors: [diagnostic("list-files-failed", providerError(error), sourceId)] };
  }
  if (!Array.isArray(listedFiles) || listedFiles.some((path) => !isNonEmptyString(path))) {
    return { documents: [], errors: [diagnostic("malformed-list-files", "listFiles must return an array of non-empty paths", sourceId)] };
  }
  if (listedFiles.length === 0) return { documents: [], errors: [] };

  let files;
  try {
    files = await provider.readFiles(source);
  } catch (error) {
    return { documents: [], errors: [diagnostic("read-files-failed", providerError(error), sourceId)] };
  }
  if (!Array.isArray(files)) {
    return { documents: [], errors: [diagnostic("malformed-read-files", "readFiles must return an array", sourceId)] };
  }

  const returnedPaths = new Set();
  for (const file of files) {
    if (isObject(file) && isNonEmptyString(file.path)) {
      returnedPaths.add(file.path);
    }
  }
  const missingPaths = listedFiles.filter((path) => !returnedPaths.has(path));
  if (missingPaths.length > 0) {
    return {
      documents: [],
      errors: [diagnostic("incomplete-read-files", `readFiles did not return listed paths: ${missingPaths.join(", ")}`, sourceId)],
    };
  }
  const documents = [];
  const errors = [];
  for (const file of files) {
    if (!isObject(file) || !isNonEmptyString(file.path)) {
      errors.push(diagnostic("invalid-file", "file must have a non-empty path", sourceId));
      continue;
    }
    if (typeof file.text !== "string" || file.text.length === 0) {
      errors.push(diagnostic("unreadable-file", "file text must be a non-empty string", sourceId, file.path));
      continue;
    }
    const path = file.path;
    const revision = isNonEmptyString(file.revision) ? file.revision : "unknown";
    documents.push({
      id: stableId(sourceId, path),
      title: titleFromMarkdown(path, file.text),
      path,
      revision,
      source: sourceId,
      scope: source.scope,
      sensitivity: source.sensitivity,
      text: file.text,
      citations: [{ source: sourceId, path, revision }],
    });
  }
  return { documents, errors };
}

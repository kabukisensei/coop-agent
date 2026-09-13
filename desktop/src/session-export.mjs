import { copyFile, lstat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";

const MAX_EXPORT_BYTES = 50 * 1024 * 1024;

export function runtimeExportSource(value) {
  const path = value?.data?.path;
  if (value?.success !== true || typeof path !== "string" || !isAbsolute(path) || /[\0\r\n]/.test(path) || extname(path).toLowerCase() !== ".html") {
    throw new Error("Coop Runtime returned an invalid session export.");
  }
  return path;
}

export async function saveRuntimeExport(value, destination, { lstatImpl = lstat, copyFileImpl = copyFile } = {}) {
  const source = runtimeExportSource(value);
  if (typeof destination !== "string" || !isAbsolute(destination) || /[\0\r\n]/.test(destination) || extname(destination).toLowerCase() !== ".html") {
    throw new Error("The session export destination must be an absolute HTML path.");
  }
  const sourceInfo = await lstatImpl(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size < 0 || sourceInfo.size > MAX_EXPORT_BYTES) {
    throw new Error("The generated session export is not a safe regular HTML file.");
  }
  await copyFileImpl(source, destination);
  return { ok: true, fileName: basename(destination), bytes: sourceInfo.size };
}

export { MAX_EXPORT_BYTES };

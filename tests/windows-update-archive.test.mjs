import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
const result = spawnSync(python, ["-B", fileURLToPath(new URL("./windows-update-archive.test.py", import.meta.url))], { windowsHide: true, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error("Windows update archive checks failed.");

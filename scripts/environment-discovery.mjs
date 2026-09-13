#!/usr/bin/env node
import { discoverFabricItems, discoverFabricWorkspaces, discoverLocalRepositories } from "../web/environment-discovery.mjs";

function value(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

const args = process.argv.slice(2);
const kind = args[0];
try {
  let output;
  if (kind === "repositories") {
    output = await discoverLocalRepositories({ workspace: value(args, "--workspace") || process.cwd() });
  } else if (kind === "workspaces") {
    output = await discoverFabricWorkspaces();
  } else if (kind === "items" || kind === "semantic-models") {
    const workspaceId = value(args, "--workspace-id");
    const itemTypes = args.flatMap((arg, index) => arg === "--type" && args[index + 1] ? [args[index + 1]] : []);
    output = await discoverFabricItems({ workspaceId, itemTypes, kind: kind === "semantic-models" ? "semantic-models" : "fabric-items" });
  } else {
    process.stderr.write("usage: environment-discovery.mjs repositories [--workspace PATH] | workspaces | items --workspace-id UUID [--type TYPE] | semantic-models --workspace-id UUID\n");
    process.exitCode = 2;
    output = null;
  }
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  process.stderr.write(`${error?.message || "Environment discovery failed."}\n`);
  process.exitCode = 2;
}

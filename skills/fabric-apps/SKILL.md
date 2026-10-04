---
name: fabric-apps
description: Build a Fabric App (preview) with Rayfin – scaffold a web app, connect it to the client's semantic models or warehouses, and deploy it to the dev workspace.
---

# Fabric Apps (Rayfin)

## Purpose

A Fabric App is a Fabric workspace item that hosts a TypeScript web app with its
own Fabric SQL database, a GraphQL API (Data API Builder) and Fabric SSO.
**Rayfin** (`@microsoft/rayfin-cli`, command `rayfin`) scaffolds and deploys it.
Connectors let the app read the client's data in place: Lakehouse SQL endpoints
(read), Warehouses and Fabric SQL databases (read/write), semantic models (DAX).

This skill is coop's thin layer: when to use it, the prerequisites, the dev-only
deploy rule and the approval gate. Rayfin's own agent files carry the how-to, so
read them instead of guessing APIs from memory. Rayfin is preview and changes
weekly. Run it inside the `coop-workflow` skill (spec, plan, approval).

## Before you start

1. Read `.coop/project.yml`: the dev workspace is `fabric.default_workspace_id`.
   If it is missing, ask the user for the dev workspace before any deploy.
2. Confirm with the user (do not test by deploying):
   - a tenant admin turned on **Tenant settings > Fabric Apps (preview)**;
   - the dev workspace has a Fabric capacity (F SKU or trial);
   - Node 20, 22 or 24 is on PATH (`node --version`).
3. Sign-in is the user's: ask them to run `npx rayfin login` (browser). Never pass
   a client secret on the command line and never print `~/.rayfin/` contents.

## Build

1. Scaffold in a new folder, with telemetry off (`$env:RAYFIN_TELEMETRY_OPTOUT = '1'`
   in every Rayfin shell):
   `npx --yes @microsoft/create-rayfin@latest <app> --project-name <app> --template <name>`
   (`npx --yes @microsoft/rayfin-cli@latest init --list-templates` lists the names;
   the sample app is `todoapp`). Do not use the `npm create ... -- --template` form:
   PowerShell drops the `--` and the scaffolder stops with "--project-name is
   required". The CLI is a project dev dependency; never install it globally.
2. `npx rayfin init ai-files install --yes` writes the project's `AGENTS.md` and
   Rayfin skills under `.agents/skills/`. Pi asks once to trust the project; after
   that they load in a new session. coop ignores the project `.mcp.json` it also
   writes; use `npx rayfin docs search "<query>"` and the docs under
   `node_modules/@microsoft/rayfin-guide/assets/docs/` instead.
3. Connect data read-first: `npx rayfin connector search`, then `connector add`,
   then `connector inspect` (SQL) or `connector invoke` (semantic model). Look up
   the source object's lineage with `data_doc` first. Grant only `read` unless the
   spec asks for write-back.
4. Iterate locally with `npm run dev`.

## Deploy (dev only)

1. Dry run first: `npx rayfin up --dry-run --workspace-id <dev workspace id> --item-name <app> --output json`.
2. Then the same command without `--dry-run`. The guardrails ask before every
   `rayfin up`, `up db|staticapp|functions|secrets|connector|storage ...` and
   `secret set|delete`; the prompt shows the dev workspace and the target, and
   warns when they differ.
3. Never deploy to test or prod, never omit the workspace on a first deploy (it
   would create a new workspace), never pass `--capacity-id` or `--yes` unless
   the user asked for that capacity assignment.

## Never

- Delete a Fabric App item or its SQL database (the user does it in Fabric).
- Commit `rayfin/.env`, secrets or `.deployments.json` changes without approval.
- Bundle or pin Rayfin in coop; the client project's `package.json` owns the version.

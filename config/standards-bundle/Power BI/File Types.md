---
id: powerbi_file_types
title: Power BI File Types
domain: powerbi
layer: agnostic
artifact: file_type
technology: power_bi
status: active
---
# Choosing a Power BI File Type

## File selection standards

| Workflow | Required format |
|---|---|
| OneDrive or SharePoint | PBIX |
| Git | PBIP with PBIR |

Do not use PBIP for OneDrive/SharePoint workflows or PBIX as the canonical Git artifact. PBIX is binary and does not provide useful diffs or merges.

## Project format standards

- PBIP contains the report and semantic model; use TMDL for the model.
- PBIR defines the report inside that project. It stores pages, visuals, bookmarks, and report metadata as separate JSON files under `definition/`.

```text
Report/definition/pages/…
```

## Enhanced report format standards

- Enable PBIR for new Git projects through **Store reports using enhanced metadata format (PBIR)**.
- Get explicit project approval before converting PBIR-Legacy: Desktop cannot reverse the upgrade through its UI.
- Review preview limitations before conversion or deployment.
- PBIR replaces the legacy `report.json` representation. Enabling it inside a PBIX does not make that binary file useful for Git and is not required for OneDrive/SharePoint.

## PBIP Git exclusions

Exclude local data caches and per-user settings from Git. Check these entries even when `.gitignore` already exists; Desktop only creates the file when one is absent.

```gitignore
**/.pbi/localSettings.json
**/.pbi/cache.abf
```

Do not ignore the entire `.pbi` folder: it can also contain shared project settings. Adding ignore rules does not remove files already tracked by Git; untrack those files while retaining local copies.

## References (non-normative)


- [Power BI Desktop project report folder](https://learn.microsoft.com/power-bi/developer/projects/projects-report)
- [Power BI Desktop OneDrive and SharePoint integration](https://learn.microsoft.com/power-bi/create-reports/desktop-sharepoint-save-share)
- [Microsoft: PBIP files and default Git exclusions](https://learn.microsoft.com/en-us/power-bi/developer/projects/projects-overview)
- [Microsoft: semantic-model project files](https://learn.microsoft.com/en-us/power-bi/developer/projects/projects-dataset)

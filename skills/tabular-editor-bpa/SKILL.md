---
name: tabular-editor-bpa
description: Create, validate, and audit Tabular Editor Best Practice Analyzer rules for Power BI semantic models. Use when the user mentions BPA rules, Best Practice Analyzer, or wants to codify model standards.
---

# Tabular Editor BPA rules

Best Practice Analyzer (BPA) rules are automated checks for Power BI / Analysis
Services tabular models. They run in Tabular Editor 2, 3, or the TE CLI and can
flag issues or auto-fix them with `FixExpression`.

This skill helps you write and validate BPA rules that match Cooptimize
standards. It operates under the `coop-workflow` skill.

## Coop conventions

- **Inspect the model first.** Read TMDL, `.bim`, or query via TE CLI / Fabric
  MCP before writing rules.
- **Start simple.** Draft one rule, validate it, then expand the rule set.
- **FixExpression is dangerous.** Only include auto-fixes that are safe and
  unambiguous; otherwise omit `FixExpression` and let the human decide.
- **Never commit source.** Deliver rule files or annotations; let the human
  commit model source.
- **Log.** Append a summary to the daily log.

See `examples/rules.json` for starter rules.

## When to use

- The user wants to create a BPA rule for a model, team, or CI/CD pipeline.
- Auditing or improving existing BPA rules.
- Converting an ad-hoc model check into a reusable rule.
- Debugging a rule expression or `FixExpression`.

## Rule JSON structure

```json
{
  "ID": "META_MEASURE_NO_DESCRIPTION",
  "Name": "Measure has no description",
  "Category": "Metadata",
  "Description": "All measures should have descriptions for documentation and Copilot grounding.",
  "Severity": 2,
  "Scope": "Measure",
  "Expression": "string.IsNullOrWhitespace(Description)"
}
```

Allowed fields: `ID`, `Name`, `Category`, `Description`, `Severity`, `Scope`,
`Expression`, `FixExpression`, `CompatibilityLevel`, `Source`, `Remarks`. Do not
add extra properties such as `_comment`, `ObjectCount`, or `ErrorMessage`.

## Severity levels

| Level | Meaning |
|---|---|
| 1 | Error |
| 2 | Warning |
| 3 | Info |

## Common scopes

Use the exact TOM scope names:

| Scope | Checks |
|---|---|
| `Measure` | Measures |
| `Column` | Data columns, calculated columns, calculated table columns |
| `Table` | Tables |
| `ModelRole` | Roles (not `Role`) |
| `ModelRoleMember` | Role members (not `Member`) |
| `NamedExpression` | Named expressions / M parameters (not `Expression`) |
| `ProviderDataSource` / `StructuredDataSource` | Data sources |
| `CalculationGroup` / `CalculationItem` | Calculation groups and items |
| `Hierarchy` | Hierarchies |

## Expression basics

BPA expressions are C# evaluated against each object in scope. Common patterns:

```csharp
// Measure without description
string.IsNullOrWhitespace(Description)

// Hidden column with no references
IsHidden && ReferencedBy.Count == 0 && !UsedInRelationships.Any()

// Measure name does not follow PascalCase
!RegEx.IsMatch(Name, "^[A-Z]")

// Filter/ALL pattern in DAX
RegEx.IsMatch(Expression, "FILTER\\s*\\(\\s*ALL")

// Calculation group precedence too high
Precedence > 100
```

Regex notes:

- No `@` verbatim prefix: use `"..."` with escaped backslashes.
- No `RegexOptions` parameter: use inline flags like `(?i)` for case-insensitive.

## FixExpression safety

`FixExpression` runs when a user clicks **Fix** in Tabular Editor. Only include
one when the fix is safe and unambiguous.

```json
{
  "ID": "PERF_UNUSED_HIDDEN_COLUMN",
  "Name": "Remove hidden columns not used",
  "Category": "Performance",
  "Severity": 3,
  "Scope": "Column",
  "Expression": "IsHidden && ReferencedBy.Count == 0 && !UsedInRelationships.Any()",
  "FixExpression": "Delete()"
}
```

Before suggesting a `FixExpression`, verify it cannot delete the wrong object,
break relationships, or remove data the user needs.

## Compatibility requirements

Tabular Editor is strict about rule file formatting:

- **CRLF line endings** are required on Windows. Convert with:
  ```bash
  sed -i 's/$/\r/' rules.json
  ```
- **Absolute paths** work best when loading rule files in TE.
- **No extra properties** in JSON.
- **Scope names** must match the TOM enum exactly.

## Validate a rule file

If you write a validation helper, run it before handing rules to the user:

```bash
python3 scripts/validate-bpa-rules.py rules.json
python3 scripts/validate-bpa-rules.py --fix rules.json   # auto-fix CRLF, nulls, comments
```

A minimal manual check:

```bash
# Check CRLF
file rules.json

# Check for disallowed fields
python3 -c "import json; rules=json.load(open('rules.json')); [print(r['ID']) for r in rules if any(k.startswith('_') or k in ('ObjectCount','ErrorMessage') for k in r)]"
```

## Saving rules

BPA rules can live in several places:

- **Model-embedded** — stored as annotations in the model (best for team sharing).
- **User-level** — `%LocalAppData%\TabularEditor3\BPARules.json` on Windows.
- **Machine-level** — `%ProgramData%\TabularEditor3\BPARules.json` on Windows.
- **URL** — raw JSON hosted somewhere TE can fetch.
- **CI/CD** — rule file committed to the repo and loaded by `te bpa run`.

For Cooptimize workflows, prefer model-embedded rules or a rule file committed to
the repo and referenced from `.coop/project.yml`.

## Workflow

1. **Scope.** Confirm the model, audience, and categories to enforce.
2. **Inspect.** Read the model via TMDL, `.bim`, or the TE CLI / Fabric MCP.
3. **Draft.** Write one rule at a time; start with a simple expression.
4. **Validate.** Check JSON syntax, scope names, and expression safety.
5. **Test.** Run the rule against the model with Tabular Editor CLI if available.
6. **Deliver.** Provide the rule file or annotations; explain each rule and any
   `FixExpression`.
7. **Log.** Append to the daily log.

## Example rules

### Measure without description

```json
{
  "ID": "META_MEASURE_NO_DESCRIPTION",
  "Name": "Measure has no description",
  "Category": "Metadata",
  "Description": "All measures should have descriptions.",
  "Severity": 2,
  "Scope": "Measure",
  "Expression": "string.IsNullOrWhitespace(Description)"
}
```

### Hidden unused column

```json
{
  "ID": "PERF_HIDDEN_UNUSED_COLUMN",
  "Name": "Hidden column has no references",
  "Category": "Performance",
  "Description": "Hidden columns with no references waste memory.",
  "Severity": 3,
  "Scope": "Column",
  "Expression": "IsHidden && ReferencedBy.Count == 0 && !UsedInRelationships.Any()",
  "FixExpression": "Delete()"
}
```

### Measure name starts with lowercase

```json
{
  "ID": "NAME_MEASURE_LOWERCASE",
  "Name": "Measure name starts with lowercase",
  "Category": "Naming",
  "Description": "Measure names should start with an uppercase letter.",
  "Severity": 3,
  "Scope": "Measure",
  "Expression": "!RegEx.IsMatch(Name, \"^[A-Z]\")"
}
```

## Related skills and tools

- **`dax-review`** / **`coop-dax-review`** — review DAX and model standards.
- **`power-bi-impact-analysis`** — understand blast radius before rule-driven
  deletions or renames.
- **`coop-workflow`** — plan-and-approve, never commit source without review.

## Fetching current docs

Use the Microsoft Learn MCP for the latest TOM property names and Tabular Editor
BPA guidance.

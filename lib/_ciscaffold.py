import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _yaml

GITHUB_TEMPLATE = """name: coop gates

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read
  security-events: write

jobs:
{jobs}
"""

ADO_TEMPLATE = """# coop suite gates — three independent jobs, hosted ubuntu agents.
trigger:
  branches:
    include:
      - main

pool:
  vmImage: ubuntu-latest

stages:
  - stage: coop_gates
    displayName: coop suite gates
    jobs:
{jobs}
"""

def generate_github_sql(repo, path, sql_ver):
    return f"""  sql-review:
    name: SQL standards (coop-sql-review)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install coop-sql-review
        run: pipx install coop-sql-review=={sql_ver}

      - name: SQL standards review
        run: >
          coop-sql-review check {path}
          --strict --min-severity warning
          --format sarif -o coop-sql-review.sarif
          --html coop-sql-review.html
          --md coop-sql-review.md

      - name: Upload SARIF to code scanning
        if: always()
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: coop-sql-review.sarif

      - name: Upload review reports
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: coop-sql-review-report
          path: |
            coop-sql-review.sarif
            coop-sql-review.html
            coop-sql-review.md
"""

def generate_github_dax(repo, paths, dax_ver):
    pstr = " ".join(paths)
    return f"""  dax-review:
    name: DAX / model standards (coop-dax-review)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install coop-dax-review
        run: pipx install coop-dax-review=={dax_ver}

      - name: DAX standards review
        run: >
          coop-dax-review check {pstr}
          --strict --min-severity warning
          --html coop-dax-review.html
          --md coop-dax-review.md

      - name: Upload review reports
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: coop-dax-review-report
          path: |
            coop-dax-review.html
            coop-dax-review.md
"""

def generate_github_docs(doc_ver):
    return f"""  data-docs:
    name: Lineage docs freshness + strict rebuild (coop-data-doc)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install coop-data-doc
        run: pipx install coop-data-doc=={doc_ver}

      - name: Docs freshness gate
        run: coop-data-doc check

      - name: Build lineage docs (strict)
        run: coop-data-doc build --non-interactive --strict

      - name: Upload built docs
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: coop-data-docs
          path: |
            data-docs/
            data-docs-site/
"""

def generate_ado_sql(repo, path, sql_ver):
    return f"""      - job: sql_review
        displayName: SQL standards (coop-sql-review)
        steps:
          - checkout: self

          - script: pipx install coop-sql-review=={sql_ver}
            displayName: Install coop-sql-review

          - script: |
              mkdir -p "$(Build.ArtifactStagingDirectory)/CodeAnalysisLogs" "$(Build.ArtifactStagingDirectory)/reports"
              coop-sql-review check {path} \\
                --strict --min-severity warning \\
                --format sarif -o "$(Build.ArtifactStagingDirectory)/CodeAnalysisLogs/coop-sql-review.sarif" \\
                --html "$(Build.ArtifactStagingDirectory)/reports/coop-sql-review.html" \\
                --md "$(Build.ArtifactStagingDirectory)/reports/coop-sql-review.md"
            displayName: SQL standards review

          - task: PublishBuildArtifacts@1
            condition: succeededOrFailed()
            displayName: Publish SARIF (Scans tab)
            inputs:
              PathtoPublish: $(Build.ArtifactStagingDirectory)/CodeAnalysisLogs
              ArtifactName: CodeAnalysisLogs

          - task: PublishPipelineArtifact@1
            condition: succeededOrFailed()
            displayName: Publish review reports
            inputs:
              targetPath: $(Build.ArtifactStagingDirectory)/reports
              artifact: coop-sql-review-report
"""

def generate_ado_dax(repo, paths, dax_ver):
    pstr = " ".join(paths)
    return f"""      - job: dax_review
        displayName: DAX / model standards (coop-dax-review)
        steps:
          - checkout: self

          - script: pipx install coop-dax-review=={dax_ver}
            displayName: Install coop-dax-review

          - script: |
              mkdir -p "$(Build.ArtifactStagingDirectory)/reports"
              coop-dax-review check {pstr} \\
                --strict --min-severity warning \\
                --html "$(Build.ArtifactStagingDirectory)/reports/coop-dax-review.html" \\
                --md "$(Build.ArtifactStagingDirectory)/reports/coop-dax-review.md"
            displayName: DAX standards review

          - task: PublishPipelineArtifact@1
            condition: succeededOrFailed()
            displayName: Publish review reports
            inputs:
              targetPath: $(Build.ArtifactStagingDirectory)/reports
              artifact: coop-dax-review-report
"""

def generate_ado_docs(doc_ver):
    return f"""      - job: data_docs
        displayName: Lineage docs freshness + strict rebuild (coop-data-doc)
        steps:
          - checkout: self

          - script: pipx install coop-data-doc=={doc_ver}
            displayName: Install coop-data-doc

          - script: coop-data-doc check
            displayName: Docs freshness gate

          - script: coop-data-doc build --non-interactive --strict
            displayName: Build lineage docs (strict)

          - task: PublishPipelineArtifact@1
            condition: succeededOrFailed()
            displayName: Publish built docs (lineage graph + Markdown)
            inputs:
              targetPath: data-docs
              artifact: coop-data-docs

          - task: PublishPipelineArtifact@1
            condition: succeededOrFailed()
            displayName: Publish docs portal (open index.html)
            inputs:
              targetPath: data-docs-site
              artifact: coop-data-docs-site
"""

def is_todo(value):
    return not value or str(value).strip().upper().startswith('TODO')

def get_sql_path(proj_data):
    repos = proj_data.get('repositories', {})
    if not isinstance(repos, dict): return None
    for name, entry in repos.items():
        if not isinstance(entry, dict): continue
        lp = entry.get('local_path')
        if is_todo(lp): continue
        if 'sql_root' in entry:
            sr = entry.get('sql_root')
            return f"{lp}/{sr}" if not is_todo(sr) else lp
        desc = f"{name} {entry.get('description', '')}".lower()
        if 'sql' in desc or 'warehouse' in desc or 'lakehouse' in desc or ' dw ' in desc:
            return lp
    return None

def get_pbi_paths(proj_data):
    paths = []
    pbi = proj_data.get('power_bi', {})
    if not isinstance(pbi, dict): return paths
    sms = pbi.get('semantic_models', [])
    if isinstance(sms, list):
        for sm in sms:
            if isinstance(sm, dict) and 'path' in sm and not is_todo(sm['path']):
                paths.append(sm['path'])
    return paths

def main():
    if len(sys.argv) < 5:
        sys.exit(1)
    ci_type = sys.argv[1]
    proj_path = sys.argv[2]
    defaults_path = sys.argv[3]
    out_dir = sys.argv[4]

    if ci_type not in ["github", "ado"]:
        sys.stderr.write("error: invalid ci type\n")
        sys.exit(1)

    try:
        proj_data = _yaml.load(proj_path)
        defaults_data = _yaml.load(defaults_path)
    except Exception as e:
        sys.stderr.write(f"error reading yamls: {e}\n")
        sys.exit(1)
    
    tested_with = defaults_data.get('tested_with', {})
    sql_ver = tested_with.get('coop_sql_review', '0.12.0')
    dax_ver = tested_with.get('coop_dax_review', '0.15.0')
    doc_ver = tested_with.get('coop_data_doc', '0.33.0')

    sql_path = get_sql_path(proj_data)
    pbi_paths = get_pbi_paths(proj_data)

    jobs = ""
    if ci_type == "github":
        if sql_path: jobs += generate_github_sql("sql", sql_path, sql_ver)
        if pbi_paths: jobs += generate_github_dax("pbi", pbi_paths, dax_ver)
        if os.path.exists("coop-data-doc.yml"): jobs += generate_github_docs(doc_ver)
        if not jobs:
            sys.stderr.write("error: nothing to generate, missing paths\n")
            sys.exit(3)
        res = GITHUB_TEMPLATE.format(jobs=jobs.rstrip() + "\n")
        out_file = os.path.join(out_dir, ".github", "workflows", "coop-gates.yml")
    else:
        if sql_path: jobs += generate_ado_sql("sql", sql_path, sql_ver)
        if pbi_paths: jobs += generate_ado_dax("pbi", pbi_paths, dax_ver)
        if os.path.exists("coop-data-doc.yml"): jobs += generate_ado_docs(doc_ver)
        if not jobs:
            sys.stderr.write("error: nothing to generate, missing paths\n")
            sys.exit(3)
        res = ADO_TEMPLATE.format(jobs=jobs.rstrip() + "\n")
        out_file = os.path.join(out_dir, "azure-pipelines", "coop-gates.yml")

    os.makedirs(os.path.dirname(out_file), exist_ok=True)
    with open(out_file, 'w') as f:
        f.write(res)
    print(out_file)
    sys.exit(0)

if __name__ == '__main__':
    main()

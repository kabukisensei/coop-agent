import re
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _yaml


def _valid_version(v):
    return bool(re.match(r'^[0-9]+\.[0-9]+\.[0-9]+$', str(v)))


GITHUB_TEMPLATE = """name: coop gates

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
{jobs}
"""

ADO_TEMPLATE = """# coop suite gates — lineage-docs job, hosted ubuntu agents.
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

def main():
    if len(sys.argv) < 5:
        sys.exit(1)
    ci_type = sys.argv[1]
    proj_path = sys.argv[2]
    manifest_path = sys.argv[3]   # config/release-manifest.json (the one pin list)
    out_dir = sys.argv[4]

    if ci_type not in ["github", "ado"]:
        sys.stderr.write("error: invalid ci type\n")
        sys.exit(1)

    try:
        proj_data = _yaml.load(proj_path)
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)
    except Exception as e:
        sys.stderr.write(f"error reading project yml / release manifest: {e}\n")
        sys.exit(1)

    if not isinstance(proj_data, dict) or not isinstance(manifest, dict):
        sys.stderr.write("error: project yml and release manifest must be mappings\n")
        sys.exit(1)

    python_tools = manifest.get('python_tools', {})
    if not isinstance(python_tools, dict):
        sys.stderr.write("error: release manifest python_tools must be a mapping\n")
        sys.exit(1)

    # The generated pipeline pins exactly what the release installs: no fallback
    # version, a missing or malformed pin is an error.
    doc_ver = python_tools.get('coop-data-doc')
    if doc_ver is None or not _valid_version(doc_ver):
        sys.stderr.write(f"error: release manifest python_tools.coop-data-doc {doc_ver!r} is not a valid semver\n")
        sys.exit(1)

    # The only gate left (ST1 retired the coop-sql-review / coop-dax-review jobs): the
    # lineage-docs freshness check, which needs the repo's coop-data-doc.yml. The
    # project contract is still read and validated so a malformed one fails here.
    docs_config = os.path.join(out_dir, "coop-data-doc.yml")
    if not os.path.exists(docs_config) and not os.path.exists("coop-data-doc.yml"):
        sys.stderr.write("error: nothing to generate: no coop-data-doc.yml (set up lineage docs first: coop data-doc setup)\n")
        sys.exit(3)

    if ci_type == "github":
        jobs = generate_github_docs(doc_ver)
        res = GITHUB_TEMPLATE.format(jobs=jobs.rstrip() + "\n")
        out_file = os.path.join(out_dir, ".github", "workflows", "coop-gates.yml")
    else:
        jobs = generate_ado_docs(doc_ver)
        res = ADO_TEMPLATE.format(jobs=jobs.rstrip() + "\n")
        out_file = os.path.join(out_dir, "azure-pipelines", "coop-gates.yml")

    os.makedirs(os.path.dirname(out_file), exist_ok=True)
    with open(out_file, 'w', encoding='utf-8', newline='\n') as f:
        f.write(res)
    print(out_file)
    sys.exit(0)

if __name__ == '__main__':
    main()

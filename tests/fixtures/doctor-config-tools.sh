#!/usr/bin/env bash
# Configuration-reporting tests should not launch the workstation's installed
# Pi/extensions or probe its pipx environments. Inventory behavior has its own
# fixtures; these tests keep the real doctor parser and config checks.
doctor_config_tools() {
  local root="$1" command
  mkdir -p "$root/bin" "$root/agent"
  for command in pi npm pipx fab az te coop-data-doc coop-sql-review coop-dax-review; do
    cat > "$root/bin/$command" <<'SH'
#!/usr/bin/env bash
case "$1" in
  --version|-v|version) printf '0.0.0\n' ;;
  list) printf '{}\n' ;;
  *) exit 1 ;;
esac
SH
    chmod +x "$root/bin/$command"
  done
  PATH="$root/bin:$PATH"
  COOP_AGENT_DIR="$root/agent"
  PI_CODING_AGENT_DIR="$root/agent"
  export PATH COOP_AGENT_DIR PI_CODING_AGENT_DIR
}

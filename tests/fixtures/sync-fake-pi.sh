#!/bin/sh
# Parameterized fake `pi` for tests/inventory.test.sh.
# A behavior file may be concatenated onto this script defining:
#   COOP_TEST_FAKE_PI_OK=1            behave honestly (install exactly the spec)
#   COOP_TEST_FAKE_PI_WRONG=<name>    report success but install a WRONG version
#                                     (COOP_TEST_FAKE_PI_INSTALL_VERSION)
#   COOP_TEST_FAKE_PI_SKIP=<name>     report success but install NOTHING
# Behavior variables are read from the optional file named by
# COOP_TEST_FAKE_PI_BEHAVIOR (one VAR=value per line), which must be exported.
# The point: `pi install` exiting 0 proves nothing — sync must verify the tree.
[ -n "${COOP_TEST_FAKE_PI_BEHAVIOR:-}" ] && . "$COOP_TEST_FAKE_PI_BEHAVIOR"
case "${1:-}" in
  --version)
    echo "0.80.2"
    exit 0
    ;;
  install)
    spec="${2:-npm:}"
    rest="${spec#npm:}"
    name="${rest%@*}"
    ver="${rest##*@}"
    if [ "$name" = "${COOP_TEST_FAKE_PI_WRONG:-}" ]; then
      ver="${COOP_TEST_FAKE_PI_INSTALL_VERSION:-0.0.1}"
    fi
    case "${COOP_TEST_FAKE_PI_SKIP:-}" in
      "$name") exit 0 ;;
    esac
    dir="${PI_CODING_AGENT_DIR:?}/npm/node_modules/$name"
    mkdir -p "$dir"
    printf '{"name":"%s","version":"%s"}\n' "$name" "$ver" > "$dir/package.json"
    exit 0
    ;;
esac
exit 1

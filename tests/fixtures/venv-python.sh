#!/bin/sh
# Fake pipx-venv interpreter for inventory tests.
# Env at creation time: FAKEPY_VERSION, FAKEPY_RP (baked into the copy).
# At runtime: answers Pi-inventory probes:
#   -c '<version probe>'            -> prints $FAKEPY_VERSION
#   -c '<coop-requires-python-probe>' -> prints $FAKEPY_RP
case "$2" in
  *pyodbc.drivers*)
    case "${FAKEPY_SQL_STATE:-ready}" in
      ready) printf 'ready\t5.3.0\t18\n' ;;
      driver_missing) printf 'driver_missing\t5.3.0\n'; exit 5 ;;
      pyodbc_missing) printf 'pyodbc_missing\n'; exit 2 ;;
    esac
    ;;
  *'import pyodbc'*) exit 0 ;;
  *coop-requires-python-probe*) printf '%s\n' "$FAKEPY_RP" ;;
  *sys.executable*) exit 0 ;;
  *) printf '%s\n' "$FAKEPY_VERSION" ;;
esac

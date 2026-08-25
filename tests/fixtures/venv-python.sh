#!/bin/sh
# Fake pipx-venv interpreter for inventory tests.
# Env at creation time: FAKEPY_VERSION, FAKEPY_RP (baked into the copy).
# At runtime: answers Pi-inventory probes:
#   -c '<version probe>'            -> prints $FAKEPY_VERSION
#   -c '<coop-requires-python-probe>' -> prints $FAKEPY_RP
case "$2" in
  *coop-requires-python-probe*) printf '%s\n' "$FAKEPY_RP" ;;
  *)                            printf '%s\n' "$FAKEPY_VERSION" ;;
esac

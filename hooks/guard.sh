#!/bin/bash
# ---------------------------------------------------------------------------
# THE LEAK GUARD, WHICH IS NOT IN THIS REPOSITORY AND MUST NOT BE.
#
# Its patterns are names: a person, a company, a supplier, a machine. Writing
# them here to check for them would put every one of them in the history --
# the exact thing it exists to prevent. So it lives outside, and this file
# holds only how to find it.
#
# WHERE IT IS LOOKED FOR, in this order:
#
#   1. git config parley.guard <path>      an explicit choice wins
#   2. the PARLEY_GUARD environment variable
#   3. ../.parley-guard/guard.sh, then ../.clavarium-guard/guard.sh
#                                             NEXT TO the repository (the second
#                                             is the guard of the sister project,
#                                             which holds the same names)
#
# The third is a path RELATIVE to the repository, and that is the point of it:
# it names nobody, and it does not depend on anything a restart, a new shell
# or a fresh clone could forget. Put the guard directory beside the clone and
# every commit finds it.
#
# NO GUARD MEANS NO COMMIT. A clone that cannot find it stops here rather than
# committing unchecked -- the one thing worse than a guard that refuses is one
# that shrugs.
# ---------------------------------------------------------------------------
set -u
GUARD="$(git config --get parley.guard || true)"
[ -n "${GUARD}" ] || GUARD="${PARLEY_GUARD:-}"
if [ -z "${GUARD}" ]; then
    top="$(git rev-parse --show-toplevel 2>/dev/null || true)"
    for beside in .parley-guard .clavarium-guard; do
        [ -z "${GUARD}" ] && [ -n "${top}" ] && [ -x "${top}/../${beside}/guard.sh" ] && GUARD="${top}/../${beside}/guard.sh"
    done
fi
if [ -z "${GUARD}" ]; then
    echo "The leak guard was not found."
    echo "  Put it next to the repository, as ../.parley-guard/guard.sh, or:"
    echo "  git config parley.guard <path to the checking script>"
    echo "It lives outside this repository on purpose: its patterns are names."
    exit 1
fi
if [ ! -x "${GUARD}" ]; then
    echo "The declared leak guard is not executable."
    exit 1
fi
exec "${GUARD}" "$@"

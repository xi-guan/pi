set shell := ["bash", "-euo", "pipefail", "-c"]

# log helpers inlined into recipes via `{{LOG}}`
LOG := '''
_RED=$'\033[31m'; _GREEN=$'\033[32m'; _YELLOW=$'\033[33m'; _RESET=$'\033[0m'
log_info()  { printf "%s→%s %s\n" "$_GREEN"  "$_RESET" "$*"; }
log_warn()  { printf "%s⚠%s %s\n" "$_YELLOW" "$_RESET" "$*" >&2; }
log_error() { printf "%s✗%s %s\n" "$_RED"    "$_RESET" "$*" >&2; }
log_done()  { printf "%s✓%s %s\n" "$_GREEN"  "$_RESET" "$*"; }
_BUILD_LOG="${_BUILD_LOG:-$(mktemp)}"; trap 'rm -f "$_BUILD_LOG"' EXIT
run_quiet() {
    local label="$1"; shift
    log_info "$label"
    if "$@" > "$_BUILD_LOG" 2>&1; then return 0
    else local rc=$?; log_error "$label failed. Log:"; cat "$_BUILD_LOG" >&2; exit $rc; fi
}
'''

_default:
    @just --list --unsorted --list-heading '' --list-prefix='- '

# sync fork with upstream earendil-works/pi, then rebase local changes on top
pull:
    #!/usr/bin/env bash
    set -euo pipefail
    {{LOG}}
    log_info "syncing fork with upstream"
    gh repo sync xi-guan/pi
    log_info "pulling from origin with rebase"
    git pull --rebase --autostash origin main
    log_done "pull complete"

# install all workspace dependencies
setup:
    #!/usr/bin/env bash
    set -euo pipefail
    {{LOG}}
    log_info "installing dependencies"
    npm install
    log_done "setup complete"

# build all packages and link pi CLI globally
install:
    #!/usr/bin/env bash
    set -euo pipefail
    {{LOG}}
    run_quiet "building packages" npm run build
    log_info "linking pi CLI globally"
    cd packages/coding-agent && npm link
    log_done "pi installed — run 'pi' from anywhere"

# unlink pi CLI and remove node_modules
uninstall:
    #!/usr/bin/env bash
    set -euo pipefail
    {{LOG}}
    log_info "unlinking pi CLI"
    npm unlink -g @earendil-works/pi-coding-agent 2>/dev/null || true
    log_info "removing node_modules"
    rm -rf node_modules packages/*/node_modules
    log_done "uninstalled"

# build all packages
build:
    @npm run build

# show monorepo and per-package versions
version:
    #!/usr/bin/env bash
    set -euo pipefail
    printf "monorepo: %s\n" "$(node -p "require('./package.json').version")"
    for pkg in packages/*/package.json; do
        name=$(node -p "require('./$pkg').name")
        ver=$(node -p "require('./$pkg').version")
        printf "  %-40s %s\n" "$name" "$ver"
    done

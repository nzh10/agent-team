#!/usr/bin/env bash
# Unified macOS (launchd) and Linux (systemd --user) service manager for YAAT.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
source "$REPO_DIR/scripts/runtime-paths.sh"
source "$REPO_DIR/scripts/deploy-lock.sh"
runtime_init_path
OS_NAME="${YAAT_SERVICE_OS:-$(uname -s)}"
UID_VAL="${YAAT_UID:-$(id -u)}"
LAUNCHCTL_BIN="${YAAT_LAUNCHCTL_BIN:-launchctl}"
SYSTEMCTL_BIN="${YAAT_SYSTEMCTL_BIN:-systemctl}"
SYSTEMD_RUN_BIN="${YAAT_SYSTEMD_RUN_BIN:-systemd-run}"

BASE_DIR="${AGENT_TEAM_BASE_DIR:-$HOME/.yaat}"
PORT="${AGENT_TEAM_PORT:-9800}"
HOST="${AGENT_TEAM_HOST:-0.0.0.0}"
HOST_EXPLICIT=0
if [ -n "${AGENT_TEAM_HOST:-}" ]; then
  HOST_EXPLICIT=1
fi
LABEL=""
LABEL_EXPLICIT=0
PLIST_DIR="${YAAT_PLIST_DIR:-$HOME/Library/LaunchAgents}"
UNIT_DIR="${YAAT_UNIT_DIR:-$HOME/.config/systemd/user}"
MODEL=""
EFFORT=""
USERNAME="agent"
PASSWORD=""
NO_AUTH=0
NO_BUILD=0
NO_START=0
VERIFY=0
FORCE=0
DRY_RUN=0
WAIT_SEC=""
LOG_LINES=50
NO_FOLLOW=0

usage() {
  cat <<'EOF'
Usage: scripts/yaat-service.sh <command> [options]

Commands:
  init-config               Create base dir and generate config.toml
  install-deps              Run local npm install in this checkout (use instance pins if present)
  install                   Init config if needed, build, write & load OS service
  start                     Start the service
  stop                      Stop the service
  restart                   Restart the service
  status                    Show service status
  logs                      View service logs (-n <lines>, --no-follow)
  health                    Check http://127.0.0.1:<port>/manifest.webmanifest
  deploy                    Build, restart, and wait for health (--verify)
  deploy-deferred --when-idle --timeout <sec>  Stage and schedule a safe deploy (systemd or launchd)
  deploy-status <id>        Show deferred deployment state
  deploy-cancel <id>        Cancel before cutover
  deploy-gc                 Prune finished staging jobs and unused generations older than one day
  deploy-deferred [delay]   Legacy disruptive deploy for an unstaged instance
  uninstall                 Remove service registration (preserves base dir data)

Options:
  --base-dir <dir>          Data/config directory (default: $AGENT_TEAM_BASE_DIR or ~/.yaat)
  --port <port>             Server port (default: $AGENT_TEAM_PORT or 9800)
  --host <host>             Bind address (default: 0.0.0.0, or 127.0.0.1 with --no-auth)
  --label <name>            Service label (default: com.yaat.server / agent-team-server)
  --plist-dir <dir>         macOS LaunchAgents dir (default: ~/Library/LaunchAgents)
  --unit-dir <dir>          Linux systemd user unit dir (default: ~/.config/systemd/user)
  --model <id>              Default model for [pi] and [projects] in init-config
  --effort <lvl>            Default effort for [pi] and [projects] in init-config
  --username <name>         Auth username for init-config (default: agent)
  --password <pw>           Auth password for init-config (default: random)
  --no-auth                 Omit [auth] in init-config and bind 127.0.0.1 if --host unset
  --no-build                Skip npm run build in install/deploy
  --no-start                Write service file in install without loading/starting it
  --verify                  Run npm run check && npm test in deploy before building
  --force                   Overwrite existing config.toml in init-config
  --dry-run                 Print actions without modifying files or services
  --wait <sec>              Wait up to <sec> seconds in health/deploy
  -n <lines>                Number of log lines (default: 50)
  --no-follow               Print recent logs and exit instead of following
  -h, --help                Show this help
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_arg() {
  if [ "$2" -lt 2 ]; then
    die "option $1 requires an argument"
  fi
}

is_uint() {
  case "$1" in
    ""|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

to_abs_path() {
  local p="$1"
  case "$p" in
    ~) p="$HOME" ;;
    ~/*) p="$HOME/${p#~/}" ;;
  esac
  case "$p" in
    /*) ;;
    .) p="$PWD" ;;
    ./*) p="$PWD/${p#./}" ;;
    *) p="$PWD/$p" ;;
  esac
  while [ "$p" != "/" ] && [ "${p%/}" != "$p" ]; do
    p="${p%/}"
  done
  if [ -d "$p" ]; then
    (cd "$p" && pwd)
  elif [ -d "$(dirname "$p")" ]; then
    local parent
    parent="$(cd "$(dirname "$p")" && pwd)"
    if [ "$parent" = "/" ]; then
      printf '/%s' "$(basename "$p")"
    else
      printf '%s/%s' "$parent" "$(basename "$p")"
    fi
  else
    printf '%s' "$p"
  fi
}

toml_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

systemd_specifier_escape() {
  printf '%s' "${1//%/%%}"
}

systemd_quote() {
  local escaped
  escaped="$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g')"
  printf '"%s"' "$escaped"
}

reject_control_chars() {
  local name="$1"
  local val="$2"
  case "$val" in
    *$'\n'*|*$'\r'*|*[[:cntrl:]]*)
      die "$name must not contain newlines or control characters"
      ;;
  esac
}

validate_label() {
  local lbl="$1"
  case "$lbl" in
    ""|.|..|-*|*..*)
      die "invalid --label '$lbl': must match [A-Za-z0-9._@-]+, not start with '-', and not contain '..'"
      ;;
  esac
  if ! printf '%s' "$lbl" | grep -Eq '^[A-Za-z0-9._@-]+$'; then
    die "invalid --label '$lbl': must match [A-Za-z0-9._@-]+, not start with '-', and not contain '..'"
  fi
}

run_cmd() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run]'
    for arg in "$@"; do
      printf ' %q' "$arg"
    done
    printf '\n'
    return 0
  fi
  "$@"
}

SUBCOMMAND=""
EXTRA_ARGS=""
WHEN_IDLE=0
DEPLOY_TIMEOUT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --base-dir)
      require_arg "$1" "$#"
      BASE_DIR="$2"
      shift 2
      ;;
    --port)
      require_arg "$1" "$#"
      PORT="$2"
      shift 2
      ;;
    --host)
      require_arg "$1" "$#"
      HOST="$2"
      HOST_EXPLICIT=1
      shift 2
      ;;
    --label)
      require_arg "$1" "$#"
      LABEL="$2"
      LABEL_EXPLICIT=1
      shift 2
      ;;
    --plist-dir)
      require_arg "$1" "$#"
      PLIST_DIR="$2"
      shift 2
      ;;
    --unit-dir)
      require_arg "$1" "$#"
      UNIT_DIR="$2"
      shift 2
      ;;
    --model)
      require_arg "$1" "$#"
      MODEL="$2"
      shift 2
      ;;
    --effort)
      require_arg "$1" "$#"
      EFFORT="$2"
      shift 2
      ;;
    --username)
      require_arg "$1" "$#"
      USERNAME="$2"
      shift 2
      ;;
    --password)
      require_arg "$1" "$#"
      PASSWORD="$2"
      shift 2
      ;;
    --no-auth)
      NO_AUTH=1
      shift
      ;;
    --no-build)
      NO_BUILD=1
      shift
      ;;
    --no-start)
      NO_START=1
      shift
      ;;
    --verify)
      VERIFY=1
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --when-idle)
      WHEN_IDLE=1
      shift
      ;;
    --timeout)
      require_arg "$1" "$#"
      DEPLOY_TIMEOUT="$2"
      shift 2
      ;;
    --wait)
      require_arg "$1" "$#"
      WAIT_SEC="$2"
      shift 2
      ;;
    -n)
      require_arg "$1" "$#"
      LOG_LINES="$2"
      shift 2
      ;;
    --no-follow)
      NO_FOLLOW=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      die "unknown option: $1"
      ;;
    *)
      if [ -z "$SUBCOMMAND" ]; then
        SUBCOMMAND="$1"
      elif [ -z "$EXTRA_ARGS" ]; then
        EXTRA_ARGS="$1"
      else
        die "unexpected argument: $1"
      fi
      shift
      ;;
  esac
done

if [ -z "$SUBCOMMAND" ]; then
  usage
  exit 1
fi

if [ "$WHEN_IDLE" -ne 0 ] || [ -n "$DEPLOY_TIMEOUT" ]; then
  [ "$SUBCOMMAND" = deploy-deferred ] && [ "$WHEN_IDLE" -eq 1 ] && [ -n "$DEPLOY_TIMEOUT" ] ||
    die '--when-idle and --timeout must be used together with deploy-deferred'
fi

case "$OS_NAME" in
  Darwin|Linux) ;;
  *) die "unsupported OS '$OS_NAME' (expected Darwin or Linux)" ;;
esac

if [ "$NO_AUTH" -eq 1 ] && [ "$HOST_EXPLICIT" -eq 0 ]; then
  HOST="127.0.0.1"
fi

if [ "$LABEL_EXPLICIT" -eq 0 ]; then
  if [ "$OS_NAME" = "Darwin" ]; then
    LABEL="${YAAT_SERVICE_LABEL:-com.yaat.server}"
  else
    LABEL="${YAAT_SERVICE_LABEL:-agent-team-server}"
  fi
fi

reject_control_chars "--base-dir" "$BASE_DIR"
reject_control_chars "--host" "$HOST"
reject_control_chars "--plist-dir" "$PLIST_DIR"
reject_control_chars "--unit-dir" "$UNIT_DIR"
reject_control_chars "--model" "$MODEL"
reject_control_chars "--effort" "$EFFORT"
reject_control_chars "--username" "$USERNAME"
reject_control_chars "--password" "$PASSWORD"
reject_control_chars "--label" "$LABEL"
validate_label "$LABEL"

if [ "$OS_NAME" = "Darwin" ]; then
  LABEL="${LABEL%.plist}"
else
  LABEL="${LABEL%.service}"
fi
validate_label "$LABEL"

is_uint "$PORT" && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "--port must be an integer between 1 and 65535 (got '$PORT')"
if [ -n "$WAIT_SEC" ]; then
  is_uint "$WAIT_SEC" || die "--wait must be a non-negative integer (got '$WAIT_SEC')"
fi
is_uint "$LOG_LINES" || die "-n must be a non-negative integer (got '$LOG_LINES')"

BASE_DIR="$(to_abs_path "$BASE_DIR")"
PLIST_DIR="$(to_abs_path "$PLIST_DIR")"
UNIT_DIR="$(to_abs_path "$UNIT_DIR")"

PLIST_PATH="$PLIST_DIR/${LABEL}.plist"
UNIT_PATH="$UNIT_DIR/${LABEL}.service"
OUT_LOG="$BASE_DIR/logs/server.out.log"
ERR_LOG="$BASE_DIR/logs/server.err.log"

generate_hex() {
  local bytes="$1"
  local hex
  if command -v openssl >/dev/null 2>&1 && hex=$(openssl rand -hex "$bytes"); then
    printf '%s\n' "$hex"
  else
    if [ "$SUBCOMMAND" = init-config ]; then runtime_load_pins "$BASE_DIR" || return 1; fi
    runtime_require_node || return 1
    "$YAAT_NODE_BIN" -e "process.stdout.write(require('crypto').randomBytes($bytes).toString('hex'))"
  fi
}

cmd_init_config() {
  local cfg="$BASE_DIR/config.toml"
  if [ -f "$cfg" ] && [ "$FORCE" -eq 0 ]; then
    printf 'Keeping existing %s (pass --force to overwrite).\n' "$cfg"
    if [ "$DRY_RUN" -eq 0 ]; then
      mkdir -p "$BASE_DIR/logs"
    fi
    return 0
  fi

  local gen_pw=0
  local pw="$PASSWORD"
  local secret=""
  if [ "$NO_AUTH" -eq 0 ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      pw="<redacted>"
      secret="<redacted>"
    else
      if [ -z "$pw" ]; then
        pw="$(generate_hex 12)"
        gen_pw=1
      fi
      secret="$(generate_hex 32)"
    fi
  fi

  local content=""
  content="# YAAT / Agent Team configuration (generated by scripts/yaat-service.sh)
"
  content="${content}
[server]
"
  if [ "$OS_NAME" = "Darwin" ]; then
    content="${content}restart_command = [\"launchctl\", \"kickstart\", \"-k\", \"gui/${UID_VAL}/$(toml_escape "$LABEL")\"]
"
  else
    if [ "$LABEL" != "agent-team-server" ]; then
      content="${content}restart_command = [\"systemctl\", \"--user\", \"restart\", \"$(toml_escape "$LABEL")\"]
"
    else
      content="${content}# restart_command defaults to systemctl --user restart agent-team-server on Linux
"
    fi
  fi

  if [ "$NO_AUTH" -eq 0 ]; then
    content="${content}
[auth]
username = \"$(toml_escape "$USERNAME")\"
password = \"$(toml_escape "$pw")\"
session_secret = \"$(toml_escape "$secret")\"
max_age_days = 30
"
  else
    content="${content}
# [auth] omitted (--no-auth); keep server bound to 127.0.0.1 unless behind an authenticating proxy.
"
  fi

  content="${content}
[workspace]
archive_after_days = 14

[hosts.local]
label = \"Local\"
type = \"local\"
"

  content="${content}
[pi]
# Keeping [pi] enabled populates the Pi model picker at startup.
# Omit packages (or leave it unset) to auto-discover ~/.pi/agent; use exclude_packages to block specific ones.
"
  if [ -n "$MODEL" ]; then
    content="${content}default_model = \"$(toml_escape "$MODEL")\"
"
  else
    content="${content}# default_model = \"provider/model\"
"
  fi
  if [ -n "$EFFORT" ]; then
    content="${content}default_effort = \"$(toml_escape "$EFFORT")\"
"
  else
    content="${content}# default_effort = \"medium\"
"
  fi

  content="${content}
[user]
language = \"简体中文\"
"

  if [ -n "$MODEL" ] || [ -n "$EFFORT" ]; then
    content="${content}
[projects]
"
    if [ -n "$MODEL" ]; then
      content="${content}model = \"$(toml_escape "$MODEL")\"
"
    fi
    if [ -n "$EFFORT" ]; then
      content="${content}effort = \"$(toml_escape "$EFFORT")\"
"
    fi
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] mkdir -p %q && chmod 700 %q && mkdir -p %q\n' "$BASE_DIR" "$BASE_DIR" "$BASE_DIR/logs"
    printf '[dry-run] write %s (chmod 600)\n' "$cfg"
    printf '%s' "$content"
    return 0
  fi

  mkdir -p "$BASE_DIR"
  chmod 700 "$BASE_DIR"
  mkdir -p "$BASE_DIR/logs"
  umask 077
  printf '%s' "$content" >"$cfg"
  chmod 600 "$cfg"

  printf 'Wrote %s\n' "$cfg"
  if [ "$NO_AUTH" -eq 0 ] && [ "$gen_pw" -eq 1 ]; then
    printf 'Generated login credentials (saved in %s, shown once):\n' "$cfg"
    printf '  username: %s\n' "$USERNAME"
    printf '  password: %s\n' "$pw"
  fi
}

write_darwin_plist() {
  local content
  content="$(cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$LABEL")</string>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$REPO_DIR")</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$(xml_escape "$REPO_DIR/scripts/start-server.sh")</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENT_TEAM_HOST</key>
    <string>$(xml_escape "$HOST")</string>
    <key>AGENT_TEAM_PORT</key>
    <string>$(xml_escape "$PORT")</string>
    <key>AGENT_TEAM_BASE_DIR</key>
    <string>$(xml_escape "$BASE_DIR")</string>
    <key>YAAT_SERVICE_LABEL</key>
    <string>$(xml_escape "$LABEL")</string>
    <key>YAAT_PLIST_DIR</key>
    <string>$(xml_escape "$PLIST_DIR")</string>
  </dict>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$OUT_LOG")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$ERR_LOG")</string>
</dict>
</plist>
EOF
)"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] mkdir -p %q && write %s\n' "$PLIST_DIR" "$PLIST_PATH"
    printf '%s\n' "$content"
    return 0
  fi
  mkdir -p "$PLIST_DIR"
  printf '%s\n' "$content" >"$PLIST_PATH"
  if command -v plutil >/dev/null 2>&1; then
    plutil -lint "$PLIST_PATH" >/dev/null
  fi
  printf 'Wrote %s\n' "$PLIST_PATH"
}

write_linux_unit() {
  local content
  content="$(cat <<EOF
[Unit]
Description=YAAT Agent Team Server
After=network.target

[Service]
Type=simple
WorkingDirectory=$(systemd_specifier_escape "$REPO_DIR")
Environment=$(systemd_quote "AGENT_TEAM_HOST=$HOST")
Environment=$(systemd_quote "AGENT_TEAM_PORT=$PORT")
Environment=$(systemd_quote "AGENT_TEAM_BASE_DIR=$BASE_DIR")
Environment=$(systemd_quote "YAAT_SERVICE_LABEL=$LABEL")
Environment=$(systemd_quote "YAAT_UNIT_DIR=$UNIT_DIR")
ExecStart=$(systemd_quote "$REPO_DIR/scripts/start-server.sh")
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
)"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] mkdir -p %q && write %s\n' "$UNIT_DIR" "$UNIT_PATH"
    printf '%s\n' "$content"
    return 0
  fi
  mkdir -p "$UNIT_DIR"
  printf '%s\n' "$content" >"$UNIT_PATH"
  printf 'Wrote %s\n' "$UNIT_PATH"
}

inspect_install_config() {
  local cfg="$BASE_DIR/config.toml"
  local toml_module="$REPO_DIR/node_modules/@iarna/toml"
  local has_auth restart_state
  if [ "$OS_NAME" = "Darwin" ]; then
    set -- "gui/${UID_VAL}/${LABEL}"
  else
    set -- "$LABEL" "${LABEL}.service"
  fi

  if [ -d "$toml_module" ]; then
    local inspection
    inspection="$("$YAAT_NODE_BIN" - "$toml_module" "$cfg" "$@" 2>/dev/null <<'JS'
const [tomlModule, configPath, ...targets] = process.argv.slice(2);
const config = require(tomlModule).parse(require('fs').readFileSync(configPath, 'utf8'));
const auth = config.auth;
const hasAuth = auth && typeof auth === 'object' && Object.getPrototypeOf(auth) === Object.prototype;
const restart = config.server?.restart_command;
const restartState = restart === undefined ? 'missing'
  : Array.isArray(restart) && targets.some((target) => restart.includes(target)) ? 'current' : 'stale';
console.log(hasAuth ? 'yes' : 'no', restartState);
JS
)" || die "could not inspect $cfg with @iarna/toml; check the TOML syntax"
    read -r has_auth restart_state <<< "$inspection"
  elif [ "${YAAT_DISABLE_TOMLLIB:-0}" != "1" ] && command -v python3 >/dev/null 2>&1 && python3 -c "import tomllib" >/dev/null 2>&1; then
    local inspection
    inspection="$(python3 - "$cfg" "$@" 2>/dev/null <<'PY'
import sys
import tomllib

config_path = sys.argv[1]
targets = sys.argv[2:]
with open(config_path, "rb") as f:
    config = tomllib.load(f)

has_auth = isinstance(config.get("auth"), dict)
server = config.get("server")
restart = server.get("restart_command") if isinstance(server, dict) else None
if restart is None:
    restart_state = "missing"
elif isinstance(restart, list) and any(target in restart for target in targets):
    restart_state = "current"
else:
    restart_state = "stale"

print("yes" if has_auth else "no", restart_state)
PY
)" || die "could not inspect $cfg with python3 tomllib; check the TOML syntax"
    read -r has_auth restart_state <<< "$inspection"
  else
    # Fail closed when neither @iarna/toml nor Python 3.11+ tomllib is available.
    has_auth=unknown
    restart_state=unknown
    if [ "$HOST_EXPLICIT" -eq 0 ] && [ "$NO_AUTH" -eq 0 ]; then
      HOST="127.0.0.1"
      printf '[warn] Cannot parse %s (neither @iarna/toml nor Python 3.11+ tomllib available); binding to 127.0.0.1 for safety (pass --host explicitly to override).\n' "$cfg"
    fi
    printf "[warn] Cannot verify [server].restart_command in %s without a TOML parser; confirm it targets '%s'.\n" "$cfg" "$1"
  fi

  if [ "$restart_state" = "stale" ]; then
    printf "[warn] Existing %s restart_command does not reference target '%s'; update [server].restart_command or re-run init-config --force.\n" "$cfg" "$1"
  elif [ "$restart_state" = "missing" ]; then
    if [ "$OS_NAME" = "Darwin" ]; then
      printf "[warn] Existing %s is missing [server].restart_command; set it to target '%s' to enable UI-triggered restart.\n" "$cfg" "$1"
    elif [ "$LABEL" != "agent-team-server" ]; then
      printf "[warn] Existing %s is missing [server].restart_command; UI-triggered restart will target 'agent-team-server' instead of '%s'.\n" "$cfg" "$LABEL"
    fi
  fi

  if [ "$has_auth" = "no" ] && [ "$HOST_EXPLICIT" -eq 0 ] && [ "$NO_AUTH" -eq 0 ]; then
    HOST="127.0.0.1"
    printf '[note] No [auth] section in %s; binding to 127.0.0.1 (pass --host explicitly to override).\n' "$cfg"
  fi
}

cmd_install_deps() {
  local runtime_install_cwd=""
  runtime_load_pins "$BASE_DIR"
  if [ -z "${YAAT_RUNTIME_PINS:-}" ]; then runtime_install_cwd="$REPO_DIR"; fi
  runtime_require_node
  runtime_require_npm
  runtime_use_paths
  (cd "$REPO_DIR" && run_cmd "$YAAT_NPM_BIN" install --global=false --location=project --prefix "$REPO_DIR")
}

cmd_install() {
  # Install (including re-install) explicitly selects and saves the runtime for this instance.
  local runtime_install_cwd="$REPO_DIR"
  runtime_require_node
  runtime_require_npm
  runtime_require_pi
  runtime_use_paths
  if [ "$DRY_RUN" -eq 0 ]; then
    PI_OFFLINE=1 "$YAAT_PI_BIN" --version >/dev/null 2>&1 || die "could not run Pi at $YAAT_PI_BIN"
  fi

  if [ ! -f "$BASE_DIR/config.toml" ]; then
    cmd_init_config
  else
    inspect_install_config
    if [ "$DRY_RUN" -eq 0 ]; then
      mkdir -p "$BASE_DIR/logs"
    fi
  fi

  if [ "$NO_BUILD" -eq 0 ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      printf '[dry-run] (cd %q && %q run build)\n' "$REPO_DIR" "$YAAT_NPM_BIN"
    else
      (cd "$REPO_DIR" && "$YAAT_NPM_BIN" run build)
    fi
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] pin runtime in %s/.yaat-runtime-paths:\n  node: %s\n  npm: %s\n  pi: %s\n' "$BASE_DIR" "$YAAT_NODE_BIN" "$YAAT_NPM_BIN" "$YAAT_PI_BIN"
  else
    runtime_write_pins "$BASE_DIR"
  fi

  if [ "$OS_NAME" = "Darwin" ]; then
    write_darwin_plist
    if [ "$NO_START" -eq 0 ]; then
      if [ "$DRY_RUN" -eq 1 ]; then
        printf '[dry-run] %s bootout gui/%s/%s || true\n' "$LAUNCHCTL_BIN" "$UID_VAL" "$LABEL"
        printf '[dry-run] %s bootstrap gui/%s %q\n' "$LAUNCHCTL_BIN" "$UID_VAL" "$PLIST_PATH"
      else
        "$LAUNCHCTL_BIN" bootout "gui/${UID_VAL}/${LABEL}" >/dev/null 2>&1 || true
        "$LAUNCHCTL_BIN" bootstrap "gui/${UID_VAL}" "$PLIST_PATH"
      fi
    fi
  else
    write_linux_unit
    if [ "$NO_START" -eq 0 ]; then
      local unit="${LABEL}.service"
      local default_unit_dir
      default_unit_dir="$(to_abs_path "$HOME/.config/systemd/user")"
      if [ "$UNIT_DIR" != "$default_unit_dir" ] && [ ! "$UNIT_DIR" -ef "$default_unit_dir" ]; then
        unit="$UNIT_PATH"
      fi
      run_cmd "$SYSTEMCTL_BIN" --user daemon-reload
      run_cmd "$SYSTEMCTL_BIN" --user enable --now "$unit"
    fi
  fi
}

cmd_start() {
  if [ "$OS_NAME" = "Darwin" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      printf '[dry-run] %s kickstart/bootstrap gui/%s/%s\n' "$LAUNCHCTL_BIN" "$UID_VAL" "$LABEL"
      return 0
    fi
    if "$LAUNCHCTL_BIN" print "gui/${UID_VAL}/${LABEL}" >/dev/null 2>&1; then
      "$LAUNCHCTL_BIN" kickstart "gui/${UID_VAL}/${LABEL}"
    elif [ -f "$PLIST_PATH" ]; then
      "$LAUNCHCTL_BIN" bootstrap "gui/${UID_VAL}" "$PLIST_PATH"
    else
      die "service plist not found at $PLIST_PATH (run 'scripts/yaat-service.sh install' first)"
    fi
  else
    run_cmd "$SYSTEMCTL_BIN" --user start "${LABEL}.service"
  fi
}

cmd_stop() {
  if [ "$OS_NAME" = "Darwin" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      printf '[dry-run] %s bootout gui/%s/%s\n' "$LAUNCHCTL_BIN" "$UID_VAL" "$LABEL"
      return 0
    fi
    if "$LAUNCHCTL_BIN" print "gui/${UID_VAL}/${LABEL}" >/dev/null 2>&1; then
      "$LAUNCHCTL_BIN" bootout "gui/${UID_VAL}/${LABEL}"
    else
      printf 'Service gui/%s/%s is not loaded.\n' "$UID_VAL" "$LABEL"
    fi
  else
    run_cmd "$SYSTEMCTL_BIN" --user stop "${LABEL}.service"
  fi
}

cmd_restart() {
  if [ "$OS_NAME" = "Darwin" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      printf '[dry-run] %s kickstart -k gui/%s/%s\n' "$LAUNCHCTL_BIN" "$UID_VAL" "$LABEL"
      return 0
    fi
    if "$LAUNCHCTL_BIN" print "gui/${UID_VAL}/${LABEL}" >/dev/null 2>&1; then
      "$LAUNCHCTL_BIN" kickstart -k "gui/${UID_VAL}/${LABEL}"
    elif [ -f "$PLIST_PATH" ]; then
      "$LAUNCHCTL_BIN" bootstrap "gui/${UID_VAL}" "$PLIST_PATH"
    else
      die "service plist not found at $PLIST_PATH (run 'scripts/yaat-service.sh install' first)"
    fi
  else
    run_cmd "$SYSTEMCTL_BIN" --user restart "${LABEL}.service"
  fi
}

cmd_status() {
  if [ "$OS_NAME" = "Darwin" ]; then
    run_cmd "$LAUNCHCTL_BIN" print "gui/${UID_VAL}/${LABEL}"
  else
    run_cmd "$SYSTEMCTL_BIN" --user status "${LABEL}.service"
  fi
}

cmd_logs() {
  if [ "$OS_NAME" = "Darwin" ]; then
    local files=""
    if [ -f "$OUT_LOG" ] && [ -f "$ERR_LOG" ]; then
      if [ "$NO_FOLLOW" -eq 1 ]; then
        run_cmd tail -n "$LOG_LINES" "$OUT_LOG" "$ERR_LOG"
      else
        run_cmd tail -n "$LOG_LINES" -f "$OUT_LOG" "$ERR_LOG"
      fi
    elif [ -f "$OUT_LOG" ]; then
      files="$OUT_LOG"
      if [ "$NO_FOLLOW" -eq 1 ]; then
        run_cmd tail -n "$LOG_LINES" "$files"
      else
        run_cmd tail -n "$LOG_LINES" -f "$files"
      fi
    elif [ -f "$ERR_LOG" ]; then
      files="$ERR_LOG"
      if [ "$NO_FOLLOW" -eq 1 ]; then
        run_cmd tail -n "$LOG_LINES" "$files"
      else
        run_cmd tail -n "$LOG_LINES" -f "$files"
      fi
    else
      die "no log files found at $OUT_LOG or $ERR_LOG"
    fi
  else
    if [ "$NO_FOLLOW" -eq 1 ]; then
      run_cmd journalctl --user -u "${LABEL}.service" -n "$LOG_LINES" --no-pager
    else
      run_cmd journalctl --user -u "${LABEL}.service" -n "$LOG_LINES" -f
    fi
  fi
}

cmd_uninstall() {
  if [ "$OS_NAME" = "Darwin" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      printf '[dry-run] %s bootout gui/%s/%s || true\n' "$LAUNCHCTL_BIN" "$UID_VAL" "$LABEL"
      printf '[dry-run] rm -f %q\n' "$PLIST_PATH"
    else
      "$LAUNCHCTL_BIN" bootout "gui/${UID_VAL}/${LABEL}" >/dev/null 2>&1 || true
      rm -f "$PLIST_PATH"
    fi
  else
    if [ "$DRY_RUN" -eq 1 ]; then
      printf '[dry-run] %s --user disable --now %s || true\n' "$SYSTEMCTL_BIN" "${LABEL}.service"
      printf '[dry-run] rm -f %q\n' "$UNIT_PATH"
      printf '[dry-run] %s --user daemon-reload || true\n' "$SYSTEMCTL_BIN"
    else
      "$SYSTEMCTL_BIN" --user disable --now "${LABEL}.service" >/dev/null 2>&1 || true
      rm -f "$UNIT_PATH"
      "$SYSTEMCTL_BIN" --user daemon-reload >/dev/null 2>&1 || true
    fi
  fi
  printf 'Service %s removed. Data under %s was preserved.\n' "$LABEL" "$BASE_DIR"
}

probe_once() {
  local url="$1"
  local timeout="${2:-2}"
  if command -v curl >/dev/null 2>&1; then
    local code
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$timeout" "$url" 2>/dev/null || true)"
    [ "$code" = "200" ]
  else
    runtime_load_pins "$BASE_DIR" && runtime_require_node || return 1
    "$YAAT_NODE_BIN" -e "
      fetch('$url', { signal: AbortSignal.timeout(${timeout} * 1000) })
        .then((r) => process.exit(r.status === 200 ? 0 : 1))
        .catch(() => process.exit(1));
    " >/dev/null 2>&1
  fi
}

cmd_health() {
  local wait="${1:-0}"
  local url="http://127.0.0.1:${PORT}/manifest.webmanifest"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] check %s (wait=%ss)\n' "$url" "$wait"
    return 0
  fi
  local start_sec="$SECONDS"
  local deadline=$((start_sec + wait))
  local remaining=$((deadline - SECONDS))
  local probe_timeout
  while true; do
    probe_timeout=$((remaining < 2 ? remaining : 2))
    if [ "$probe_timeout" -lt 1 ]; then
      probe_timeout=1
    fi
    if probe_once "$url" "$probe_timeout"; then
      printf 'healthy: %s (HTTP 200)\n' "$url"
      return 0
    fi
    [ "$SECONDS" -lt "$deadline" ] || break
    sleep 1
    remaining=$((deadline - SECONDS))
    [ "$remaining" -gt 0 ] || break
  done
  printf 'unhealthy: %s did not return HTTP 200 (waited %ss)\n' "$url" "$((SECONDS - start_sec))" >&2
  return 1
}

prepare_deploy_runtime() {
  runtime_load_pins "$BASE_DIR"
  runtime_require_node
  runtime_select_pi || true
  if [ "$NO_BUILD" -eq 0 ] || [ "$VERIFY" -eq 1 ]; then runtime_require_npm; fi
  runtime_use_paths
}

cmd_deploy() {
  if [ "$DRY_RUN" -eq 0 ]; then
    deploy_lock || die 'Another deploy holds the release lock'
  fi
  if [ -L "$REPO_DIR/.agent-team/releases/current" ] || [ -e "$REPO_DIR/.agent-team/releases/transaction.json" ]; then
    die 'Use deploy-deferred --when-idle --timeout <seconds> for staged releases'
  fi
  local wait="${WAIT_SEC:-15}"
  prepare_deploy_runtime
  if [ "$VERIFY" -eq 1 ]; then
    (cd "$REPO_DIR" && run_cmd "$YAAT_NPM_BIN" run check && run_cmd "$YAAT_NPM_BIN" test)
  fi
  if [ "$NO_BUILD" -eq 0 ]; then
    (cd "$REPO_DIR" && run_cmd "$YAAT_NPM_BIN" run build)
  fi
  cmd_restart
  cmd_health "$wait"
}

enqueue_linux_deploy() {
  if ! command -v "$SYSTEMD_RUN_BIN" >/dev/null 2>&1 || \
    ! command -v "$SYSTEMCTL_BIN" >/dev/null 2>&1 || \
    ! "$SYSTEMCTL_BIN" --user show-environment >/dev/null 2>&1; then
    return 1
  fi

  local args=(--user --no-block --collect --unit="yaat-deploy-${DEPLOY_JOB_ID:-$(date +%s)-$$}")
  local name
  # Transient services do not inherit the caller's environment like scopes do.
  for name in AGENT_TEAM_PORT AGENT_TEAM_BASE_DIR YAAT_SERVICE_LABEL YAAT_PLIST_DIR YAAT_UNIT_DIR \
    YAAT_DEPLOY_SKIP_BUILD YAAT_DEPLOY_LOG YAAT_DEPLOY_RESTART_CMD YAAT_SERVICE_OS YAAT_UID \
    YAAT_SYSTEMCTL_BIN YAAT_LAUNCHCTL_BIN YAAT_NODE_BIN YAAT_NPM_BIN YAAT_PI_BIN PATH; do
    if printenv "$name" >/dev/null 2>&1; then
      args+=("--setenv=$name")
    fi
  done
  if "$SYSTEMD_RUN_BIN" "${args[@]}" "$@" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

# Bootstrap a separate, one-shot LaunchAgent. Unlike a background child of the
# server it has its own launchd process group throughout kickstart and rollback.
enqueue_darwin_deploy() (
  umask 077
  local dir="$REPO_DIR/.agent-team/releases/jobs/$DEPLOY_JOB_ID" name arg
  local plist="$dir/controller.plist" log="$dir/controller.log" label="com.yaat.deploy.$DEPLOY_JOB_ID"
  : >"$log" || return 1
  {
    printf '%s\n' '<plist version="1.0"><dict>' "<key>Label</key><string>$label</string>" \
      '<key>RunAtLoad</key><true/><key>LaunchOnlyOnce</key><true/>' \
      '<key>ProgramArguments</key><array>'
    for arg in /bin/bash -c '
      repo=$1 job=$2; shift 2
      "$@" || "$YAAT_NODE_BIN" "$repo/scripts/deploy-controller.mjs" controller-failed "$repo" "$job"
      exec "$YAAT_LAUNCHCTL_BIN" bootout "$YAAT_JOB_TARGET"
    ' deploy "$REPO_DIR" "$DEPLOY_JOB_ID" "$@"; do
      printf '<string>%s</string>\n' "$(xml_escape "$arg")"
    done
    printf '%s\n' '</array><key>EnvironmentVariables</key><dict>'
    for name in AGENT_TEAM_PORT AGENT_TEAM_BASE_DIR YAAT_SERVICE_LABEL YAAT_PLIST_DIR YAAT_SERVICE_OS YAAT_UID YAAT_LAUNCHCTL_BIN YAAT_NODE_BIN YAAT_NPM_BIN YAAT_PI_BIN PATH; do
      printf '<key>%s</key><string>%s</string>\n' "$name" "$(xml_escape "${!name:-}")"
    done
    printf '<key>YAAT_JOB_TARGET</key><string>%s</string></dict>\n' "$(xml_escape "gui/$UID_VAL/$label")"
    printf '<key>StandardOutPath</key><string>%s</string><key>StandardErrorPath</key><string>%s</string></dict></plist>\n' "$(xml_escape "$log")" "$(xml_escape "$log")"
  } >"$plist" || return 1
  "$LAUNCHCTL_BIN" bootstrap "gui/$UID_VAL" "$plist"
)

cmd_deploy_safe() {
  local enqueue
  case "$OS_NAME" in
    Linux) [ "$(uname -s)" = Linux ] && command -v flock >/dev/null || die 'Safe deployment requires Linux systemd and flock'; enqueue=enqueue_linux_deploy ;;
    Darwin) enqueue=enqueue_darwin_deploy ;;
    *) die 'Unsupported service manager' ;;
  esac
  [[ "$DEPLOY_TIMEOUT" =~ ^[1-9][0-9]{0,4}$ ]] && [ "$DEPLOY_TIMEOUT" -le 86400 ] || die 'Timeout must be 1–86400 seconds'
  [ -z "$EXTRA_ARGS" ] && [ "$NO_BUILD" -eq 0 ] && [ "$VERIFY" -eq 0 ] || die 'Safe deployment takes no delay, --verify, or --no-build'
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] schedule safe deploy with %ss timeout\n' "$DEPLOY_TIMEOUT"
    return
  fi
  prepare_deploy_runtime
  local job
  job="$("$YAAT_NODE_BIN" -e 'console.log(require("node:crypto").randomUUID())')"
  local controller="$REPO_DIR/scripts/deploy-controller.mjs"
  "$YAAT_NODE_BIN" "$controller" prepare "$REPO_DIR" "$job"
  export AGENT_TEAM_PORT="$PORT" AGENT_TEAM_BASE_DIR="$BASE_DIR" YAAT_SERVICE_LABEL="$LABEL"
  export YAAT_SYSTEMCTL_BIN="$SYSTEMCTL_BIN"
  export YAAT_LAUNCHCTL_BIN="$LAUNCHCTL_BIN" YAAT_UID="$UID_VAL" YAAT_SERVICE_OS="$OS_NAME" YAAT_PLIST_DIR="$PLIST_DIR"
  if ! DEPLOY_JOB_ID="$job" "$enqueue" "$REPO_DIR/scripts/deploy-deferred.sh" --when-idle --timeout "$DEPLOY_TIMEOUT" --job "$job"; then
    "$YAAT_NODE_BIN" "$controller" launch-failed "$REPO_DIR" "$job"
    die "Could not schedule safe deploy $job via $enqueue; no fallback"
  fi
  printf 'Scheduled safe deploy %s. Check with deploy-status %s.\n' "$job" "$job"
}

cmd_deploy_job() {
  [ -n "$EXTRA_ARGS" ] || die 'A deploy ID is required'
  runtime_load_pins "$BASE_DIR"
  runtime_require_node
  run_cmd "$YAAT_NODE_BIN" "$REPO_DIR/scripts/deploy-controller.mjs" "$1" "$REPO_DIR" "$EXTRA_ARGS"
}

cmd_deploy_gc() {
  runtime_load_pins "$BASE_DIR"
  runtime_require_node
  if [ "$DRY_RUN" -eq 0 ]; then
    deploy_lock || die 'Another deploy holds the release lock'
  fi
  run_cmd "$YAAT_NODE_BIN" "$REPO_DIR/scripts/deploy-controller.mjs" gc "$REPO_DIR"
}

cmd_deploy_deferred() {
  if [ "$WHEN_IDLE" -eq 1 ]; then cmd_deploy_safe; return; fi
  local delay="${EXTRA_ARGS:-10}"
  is_uint "$delay" || die "delay must be a non-negative integer (got '$delay')"
  local script="$REPO_DIR/scripts/deploy-deferred.sh"
  [ -x "$script" ] || [ -f "$script" ] || die "missing $script"
  prepare_deploy_runtime

  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] detach %q %s\n' "$script" "$delay"
    return 0
  fi

  export AGENT_TEAM_PORT="$PORT" AGENT_TEAM_BASE_DIR="$BASE_DIR"
  export YAAT_SERVICE_LABEL="$LABEL"
  export YAAT_PLIST_DIR="$PLIST_DIR"
  export YAAT_UNIT_DIR="$UNIT_DIR"
  if [ "$NO_BUILD" -eq 1 ]; then
    export YAAT_DEPLOY_SKIP_BUILD=1
  fi

  if [ "$OS_NAME" = "Linux" ]; then
    if ! enqueue_linux_deploy "$script" "$delay"; then
      printf '[warn] systemd-run unavailable; using legacy best-effort nohup fallback.\n' >&2
      if command -v setsid >/dev/null 2>&1; then
        setsid nohup "$script" "$delay" >/dev/null 2>&1 < /dev/null &
      else
        nohup "$script" "$delay" >/dev/null 2>&1 < /dev/null &
      fi
    fi
  elif command -v perl >/dev/null 2>&1; then
    perl -MPOSIX -e '
      my $pid = fork();
      die "fork failed: $!" unless defined $pid;
      exit 0 if $pid;
      POSIX::setsid() or die "setsid failed: $!";
      exec @ARGV or die "exec failed: $!";
    ' "$script" "$delay" >/dev/null 2>&1 < /dev/null
  else
    nohup "$script" "$delay" >/dev/null 2>&1 < /dev/null &
  fi

  printf 'Scheduled deferred deploy in %ss (log: %s).\n' "$delay" "${YAAT_DEPLOY_LOG:-$HOME/.cache/agent-team-deploy.log}"
}

case "$SUBCOMMAND" in
  init-config)
    cmd_init_config
    ;;
  install-deps)
    cmd_install_deps
    ;;
  install)
    cmd_install
    ;;
  start)
    cmd_start
    ;;
  stop)
    cmd_stop
    ;;
  restart)
    cmd_restart
    ;;
  status)
    cmd_status
    ;;
  logs)
    cmd_logs
    ;;
  health)
    cmd_health "${WAIT_SEC:-0}"
    ;;
  deploy)
    cmd_deploy
    ;;
  deploy-deferred)
    cmd_deploy_deferred
    ;;
  deploy-status)
    cmd_deploy_job status
    ;;
  deploy-gc)
    cmd_deploy_gc
    ;;
  deploy-cancel)
    cmd_deploy_job cancel
    ;;
  uninstall)
    cmd_uninstall
    ;;
  *)
    die "unknown command: $SUBCOMMAND (run with --help for usage)"
    ;;
esac

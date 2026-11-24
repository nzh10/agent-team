# Source from a deploy script. The caller retains fd 9 across exec; never unlink
# the lock file. flock(2) locks the open file description, not the Perl process.
deploy_lock() {
  mkdir -p "$REPO_DIR/.agent-team" || return 1
  exec 9>>"$REPO_DIR/.agent-team/deploy.lock" || return 1
  case "$(uname -s)" in
    Darwin) /usr/bin/perl -MFcntl=:flock -e 'open(my $fd, ">&=9") or die $!; flock($fd, LOCK_EX | LOCK_NB) or exit 1' ;;
    Linux) flock -n 9 ;;
    *) return 1 ;;
  esac
}

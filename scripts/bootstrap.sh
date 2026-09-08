#!/usr/bin/env bash
#
# One paste, from nothing to a floor answering you in a browser.
#
# Written for bash 3.2, because that is what ships on macOS and this is meant to
# be piped straight into it. Every step is idempotent: run it twice and the
# second run updates rather than duplicates, and it never deletes a checkout it
# did not create.
set -u

BRANCH="${OFFICE_BRANCH:-claude/direction-change-hn4e27}"
REPO="${OFFICE_REPO:-https://github.com/pbelfand-dot/ai-office.git}"
SRC="${OFFICE_SRC:-$HOME/ai-office}"
WORK="${OFFICE_WORK:-$HOME/office}"
PORT="${OFFICE_PORT:-4319}"
PLAN="${OFFICE_PLAN:-max5x}"
FIRST_MESSAGE="${OFFICE_MESSAGE:-introduce yourselves in one line each, then tell me what this repo is missing}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() { printf '\n\033[31mstopped:\033[0m %s\n\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------- requirements
say "Checking what is already here"

command -v git >/dev/null 2>&1 || die "git is not installed. On a Mac: xcode-select --install"
command -v node >/dev/null 2>&1 || die "node is not installed. Get it from https://nodejs.org (LTS), then run this again."
printf '    node %s\n' "$(node --version)"

# The office spawns this binary itself and never opens a shell, so a shell alias
# is not enough: we need a real path, and we pin it into the config below.
CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
if [ -z "$CLAUDE_BIN" ]; then
  for candidate in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" "/opt/homebrew/bin/claude" "/usr/local/bin/claude"; do
    [ -x "$candidate" ] && CLAUDE_BIN="$candidate" && break
  done
fi
if [ -z "$CLAUDE_BIN" ]; then
  say "Installing the Claude CLI (it is not on this machine yet)"
  npm install -g @anthropic-ai/claude-code >/dev/null 2>&1 || die "could not install @anthropic-ai/claude-code. Try it yourself, then run this again."
  CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
fi
[ -n "$CLAUDE_BIN" ] || die "the claude CLI installed but is still not on PATH. Open a new terminal and run this again."
printf '    claude %s\n' "$CLAUDE_BIN"

# Checked here rather than discovered two minutes later by four desks failing
# one after another with an auth error nobody reads as "you are logged out".
if ! "$CLAUDE_BIN" auth status 2>/dev/null | grep -q '"loggedIn": *true'; then
  die "the claude CLI is not signed in. Run:  claude auth login   then run this again."
fi
printf '    signed in\n'

# ---------------------------------------------------------------------- source
if [ -d "$SRC/.git" ]; then
  say "Updating $SRC"
  git -C "$SRC" fetch --quiet origin "$BRANCH" || die "could not reach GitHub"
  # --ff-only on purpose: if there is local work here, this stops rather than
  # trampling it, and says so.
  git -C "$SRC" checkout --quiet "$BRANCH" 2>/dev/null || git -C "$SRC" checkout --quiet -b "$BRANCH" "origin/$BRANCH"
  git -C "$SRC" merge --ff-only --quiet "origin/$BRANCH" || printf '    (local commits here; keeping them and building what you have)\n'
else
  say "Cloning into $SRC"
  git clone --quiet --branch "$BRANCH" "$REPO" "$SRC" || die "could not clone $REPO"
fi

say "Building"
cd "$SRC" || die "cannot enter $SRC"
npm install --silent >/dev/null 2>&1 || npm install || die "npm install failed"
npm run build --silent >/dev/null 2>&1 || npm run build || die "build failed"

# tsc does not set the executable bit, and npm does not always set it on link
# either -- which produces an `office` on PATH that exists and cannot run.
chmod +x dist/cli.js 2>/dev/null || true

# `office` on PATH matters beyond convenience: agents run `office done` and
# `office mail` inside their own turns. Tested by running it, not by finding
# it: the failure this catches is a command that exists and refuses to execute.
OFFICE="office"
npm link >/dev/null 2>&1 || true
if ! office help >/dev/null 2>&1; then
  OFFICE="node $SRC/dist/cli.js"
  printf '    (no global `office` command; using: %s)\n' "$OFFICE"
fi

# ------------------------------------------------------------------- workspace
if [ ! -d "$WORK/.git" ]; then
  say "Creating a workspace at $WORK"
  mkdir -p "$WORK" && cd "$WORK" || die "cannot create $WORK"
  git init --quiet -b main
  [ -f README.md ] || printf '# workspace\n\nWhatever you want the floor to work on goes here.\n' > README.md
  git add -A
  git -c user.email=you@local -c user.name=you commit --quiet -m "start" || true
else
  say "Using the workspace at $WORK"
  cd "$WORK" || die "cannot enter $WORK"
fi

if [ ! -f office.config.json ]; then
  say "Hiring the floor"
  $OFFICE init --plan "$PLAN" || die "office init failed"
fi

# Belt and braces: PATH resolution already looks in the usual places, but a
# pinned absolute path cannot be defeated by whatever PATH a launcher hands us.
node -e '
  var fs = require("fs"), f = "office.config.json";
  var c = JSON.parse(fs.readFileSync(f, "utf8"));
  c.providers.claude.bin = process.argv[1];
  fs.writeFileSync(f, JSON.stringify(c, null, 2));
' "$CLAUDE_BIN"

# ------------------------------------------------------------------------ live
say "Asking the floor something, so you can see it work (about 30 seconds)"
$OFFICE chat "$FIRST_MESSAGE" || printf '    (that turn did not land; the dashboard still comes up below)\n'

say "Opening the room at http://127.0.0.1:$PORT"
if command -v open >/dev/null 2>&1; then (sleep 2 && open "http://127.0.0.1:$PORT") & fi

# Pasting this twice is the normal case, not a mistake. If a floor is already
# serving on that port, hand over to it rather than racing it for the socket.
if command -v curl >/dev/null 2>&1 && curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/" 2>/dev/null; then
  printf '\n  A floor is already serving on %s. Leaving it running -- it is open in your browser.\n\n' "$PORT"
  exit 0
fi

cat <<EOF

  The floor is at http://127.0.0.1:$PORT -- type in the box at the bottom.
  Ctrl-C stops it. To come back later:

      cd $WORK && $OFFICE serve

  Or stay in the terminal:

      cd $WORK && $OFFICE chat "whatever you want"

EOF

exec $OFFICE serve --port "$PORT"

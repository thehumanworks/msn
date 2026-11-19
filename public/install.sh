#!/bin/sh
# Install the msn CLI from a GitHub release.
#
#   curl -fsSL https://msn.thehuman.sh/install.sh | sh
#   curl -fsSL https://msn.thehuman.sh/install.sh | sh -s -- --version v0.1.14 --dir ~/bin
#
# Supports Linux and macOS on x86_64 and arm64. Linux systems with glibc 2.28 or
# newer get the glibc build; musl systems (Alpine) and older glibc get the static
# musl build. It installs into
# ~/.local/bin by default and never uses sudo. It refuses to install a binary
# whose SHA-256 does not match the checksum published with the release.
#
# Environment (flags win):
#   MSN_VERSION      release tag to install, for example v0.1.14 (default: latest)
#   MSN_INSTALL_DIR  directory for the msn binary (default: $HOME/.local/bin)
#   MSN_RELEASES_URL release base URL (default: https://github.com/thehumanworks/msn/releases)
#   MSN_TARGET       Rust target triple to install instead of the detected one,
#                    for example x86_64-unknown-linux-musl

# Everything runs inside main, called on the last line, so a partial download
# (for example a dropped `curl | sh` connection) runs nothing.
main() {
set -eu

REPO_RELEASES="${MSN_RELEASES_URL:-https://github.com/thehumanworks/msn/releases}"
version="${MSN_VERSION:-}"
dir="${MSN_INSTALL_DIR:-}"
target="${MSN_TARGET:-}"

say() { printf 'msn install: %s\n' "$*" >&2; }
fail() {
  say "error: $*"
  exit 1
}

usage() {
  cat <<'EOF'
Install the msn CLI.

Usage: install.sh [--version vX.Y.Z] [--dir DIRECTORY]

  --version  release tag to install (default: the latest release)
  --dir      directory for the msn binary (default: ~/.local/bin)

No sudo is used. Choose a directory you can write to.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
  --version)
    [ $# -ge 2 ] || fail "--version needs a value"
    version="$2"
    shift 2
    ;;
  --version=*)
    version="${1#*=}"
    shift
    ;;
  --dir)
    [ $# -ge 2 ] || fail "--dir needs a value"
    dir="$2"
    shift 2
    ;;
  --dir=*)
    dir="${1#*=}"
    shift
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *) fail "unknown option: $1 (see --help)" ;;
  esac
done

if [ -z "$dir" ]; then
  [ -n "${HOME:-}" ] || fail "HOME is not set; pass --dir DIRECTORY"
  dir="$HOME/.local/bin"
fi

# Pick a downloader. Both fail on HTTP errors and refuse non-HTTPS URLs,
# including redirects, unless MSN_RELEASES_URL itself is a plain-HTTP test server.
allow_http=0
proto='=https'
case "$REPO_RELEASES" in
http://*)
  allow_http=1
  proto='=https,http'
  ;;
esac
if command -v curl >/dev/null 2>&1; then
  fetch() { curl --proto "$proto" --proto-redir "$proto" -fsSL --retry 3 -o "$2" "$1"; }
  final_url() { curl --proto "$proto" --proto-redir "$proto" -fsSL --retry 3 -o /dev/null -w '%{url_effective}' "$1"; }
elif command -v wget >/dev/null 2>&1; then
  # wget's --https-only covers only recursive downloads, so check the start URL
  # and every redirect it followed; anything fetched over plain HTTP is
  # discarded before it is used.
  https_ok() {
    case "$1" in
    https://* | /*) return 0 ;;
    http://*) [ "$allow_http" = 1 ] ;;
    *) return 1 ;;
    esac
  }
  wget_get() { # URL OUT; prints the final URL
    https_ok "$1" || fail "refusing non-HTTPS URL $1"
    log="$(mktemp)"
    if ! wget -q --server-response -O "$2" "$1" 2>"$log"; then
      rm -f "$log"
      return 1
    fi
    final="$1"
    for location in $(sed -n 's/^ *[Ll]ocation: *//p' "$log" | tr -d '\r'); do
      if ! https_ok "$location"; then
        rm -f "$log" "$2"
        fail "refusing redirect to non-HTTPS URL $location"
      fi
      case "$location" in
      /*) final="$(printf '%s' "$final" | sed 's#^\([a-z]*://[^/]*\).*#\1#')$location" ;;
      *) final="$location" ;;
      esac
    done
    rm -f "$log"
    printf '%s\n' "$final"
  }
  fetch() { wget_get "$1" "$2" >/dev/null; }
  final_url() { wget_get "$1" /dev/null; }
else
  fail "curl or wget is required"
fi

# Pick a SHA-256 tool.
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
elif command -v openssl >/dev/null 2>&1; then
  sha256() { openssl dgst -sha256 -r "$1" | cut -d ' ' -f 1; }
else
  fail "sha256sum, shasum or openssl is required to verify the download"
fi

detect_target() {
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$arch" in
  x86_64 | amd64) arch=x86_64 ;;
  aarch64 | arm64) arch=aarch64 ;;
  *) fail "no msn release for CPU '$arch'. Releases cover x86_64 and arm64; build from source with cargo instead" ;;
  esac
  case "$os" in
  Linux)
    # The glibc build needs glibc 2.28 or newer. Anything else (musl, an older
    # glibc, or a libc we cannot identify) gets the static musl build, which
    # needs no libc at all.
    libc=musl
    if ! { ldd --version 2>&1 | grep -qi musl || ls /lib/ld-musl-* >/dev/null 2>&1; }; then
      glibc="$(getconf GNU_LIBC_VERSION 2>/dev/null | sed -n 's/^glibc \([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p')"
      if [ -n "$glibc" ] && [ "${glibc%%.*}" -eq 2 ] && [ "${glibc#*.}" -ge 28 ]; then
        libc=gnu
      elif [ -n "$glibc" ] && [ "${glibc%%.*}" -gt 2 ]; then
        libc=gnu
      fi
    fi
    echo "${arch}-unknown-linux-${libc}"
    ;;
  Darwin)
    # An x86_64 shell under Rosetta on Apple silicon should still get the native build.
    if [ "$arch" = x86_64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then
      arch=aarch64
    fi
    echo "${arch}-apple-darwin"
    ;;
  *) fail "no msn release for '$os'. Releases cover Linux and macOS; on Windows use WSL" ;;
  esac
}

[ -n "$target" ] || target="$(detect_target)"

if [ -z "$version" ]; then
  latest="$(final_url "$REPO_RELEASES/latest")" || fail "cannot reach $REPO_RELEASES/latest"
  version="${latest##*/}"
  case "$version" in
  v[0-9]*) ;;
  *) fail "cannot find the latest release (got '$latest'); pass --version vX.Y.Z" ;;
  esac
fi
case "$version" in
v*) ;;
*) version="v$version" ;;
esac

asset="msn-${version}-${target}.tar.gz"
tmp="$(mktemp -d 2>/dev/null || mktemp -d -t msn-install)"
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT TERM

say "downloading msn $version for $target"
fetch "$REPO_RELEASES/download/$version/$asset" "$tmp/$asset" ||
  fail "cannot download $asset. Check that release $version exists and has a $target build"
fetch "$REPO_RELEASES/download/$version/$asset.sha256" "$tmp/$asset.sha256" ||
  fail "cannot download the checksum for $asset; not installing an unverified binary"

expected="$(cut -d ' ' -f 1 <"$tmp/$asset.sha256" | tr 'A-F' 'a-f')"
actual="$(sha256 "$tmp/$asset" | tr 'A-F' 'a-f')"
case "$expected" in
[0-9a-f]*) [ ${#expected} -eq 64 ] || fail "checksum file for $asset is malformed" ;;
*) fail "checksum file for $asset is malformed" ;;
esac
[ "$expected" = "$actual" ] || fail "checksum mismatch for $asset (expected $expected, got $actual); not installing"
say "checksum verified"

tar -xzf "$tmp/$asset" -C "$tmp" || fail "cannot unpack $asset"
binary="$tmp/msn-${version}-${target}/msn"
[ -f "$binary" ] || fail "$asset does not contain msn"

mkdir -p "$dir" 2>/dev/null || fail "cannot create $dir. Choose a directory you can write to with --dir (no sudo needed)"
[ -w "$dir" ] || fail "cannot write to $dir. Choose a directory you can write to with --dir (no sudo needed)"
# Copy beside the destination, then rename, so a running msn is never half-written.
cp "$binary" "$dir/.msn.tmp.$$" || fail "cannot write to $dir"
chmod 755 "$dir/.msn.tmp.$$"
mv -f "$dir/.msn.tmp.$$" "$dir/msn" || {
  rm -f "$dir/.msn.tmp.$$"
  fail "cannot replace $dir/msn"
}

if installed="$("$dir/msn" --version 2>"$tmp/run.err")"; then
  say "installed $installed to $dir/msn"
else
  say "installed msn $version to $dir/msn, but it does not run on this system:"
  sed 's/^/  /' "$tmp/run.err" >&2
  case "$target" in
  *-linux-gnu)
    say "The glibc build needs glibc 2.28 or newer (Debian 10, Ubuntu 20.04, RHEL 8 or later)."
    say "Try the static build instead: curl -fsSL https://msn.thehuman.sh/install.sh | MSN_TARGET=${target%-gnu}-musl sh"
    say "Or build it: cargo install --git https://github.com/thehumanworks/msn msn-cli"
    ;;
  esac
  exit 1
fi

case ":${PATH:-}:" in
*":$dir:"*) ;;
*)
  # zsh (the macOS default) reads ~/.zprofile; most other login shells read ~/.profile.
  # shellcheck disable=SC2088 # The tilde is shown to the person, not expanded.
  case "${SHELL:-}" in
  */zsh) profile='~/.zprofile' ;;
  *) profile='~/.profile' ;;
  esac
  say "$dir is not on your PATH. Add it to $profile (~/.zprofile for zsh, ~/.profile otherwise), for example:"
  say "  echo 'export PATH=\"$dir:\$PATH\"' >> $profile && export PATH=\"$dir:\$PATH\""
  ;;
esac
}

main "$@"

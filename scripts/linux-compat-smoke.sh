#!/bin/sh
# Prove a Linux release binary of msn starts on older and non-glibc systems.
#   scripts/linux-compat-smoke.sh BINARY TARGET [EXPECTED_VERSION]
# Runs `msn --version` and `msn --help` inside each container image listed for
# TARGET, on the host's own CPU architecture (no emulation). Needs Docker.
# A glibc build must also link no glibc symbol newer than GLIBC_FLOOR.
# Run by release.yml for every Linux build; also by hand.
set -eu

GLIBC_FLOOR=2.28

binary="$1"
target="$2"
expected="${3:-}"

[ -x "$binary" ] || {
  echo "no executable at $binary" >&2
  exit 2
}
case "$binary" in
/*) ;;
*) binary="$(pwd)/$binary" ;;
esac

case "$target" in
*-linux-gnu)
  # Debian 10 ships glibc 2.28, the floor. Debian 12 and Ubuntu 22.04 are common
  # agent container bases. Ubuntu 24.04 is what the runners use.
  images="debian:10 debian:12 ubuntu:22.04 ubuntu:24.04"
  newest="$(objdump -T "$binary" | grep -o 'GLIBC_[0-9][0-9.]*' | sed 's/GLIBC_//' | sort -u -t . -k 1,1n -k 2,2n -k 3,3n | tail -n 1)"
  [ -n "$newest" ] || {
    echo "$binary links no versioned glibc symbol; is it a glibc build?" >&2
    exit 1
  }
  if [ "$(printf '%s\n%s\n' "$GLIBC_FLOOR" "$newest" | sort -t . -k 1,1n -k 2,2n -k 3,3n | tail -n 1)" != "$GLIBC_FLOOR" ]; then
    echo "$binary needs glibc $newest; releases must run on glibc $GLIBC_FLOOR" >&2
    exit 1
  fi
  echo "ok: newest glibc symbol is GLIBC_$newest (floor $GLIBC_FLOOR)"
  ;;
*-linux-musl)
  # Static: runs on musl and on glibc systems alike.
  images="alpine:3.20 debian:12 ubuntu:22.04"
  ;;
*)
  echo "unknown Linux target $target" >&2
  exit 2
  ;;
esac

for image in $images; do
  out="$(docker run --rm -v "$binary:/usr/local/bin/msn:ro" "$image" sh -c 'msn --version && msn --help >/dev/null')" || {
    echo "msn does not start in $image" >&2
    exit 1
  }
  if [ -n "$expected" ] && [ "$out" != "msn $expected" ]; then
    echo "$image: msn --version printed '$out', expected 'msn $expected'" >&2
    exit 1
  fi
  echo "ok: $image: $out"
done

#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
output_root="$PWD/dist/checkout-agent"
mkdir -p "$output_root"
for platform in darwin/arm64 darwin/amd64 windows/amd64 linux/amd64 linux/arm64; do
  target_os="${platform%/*}"
  target_arch="${platform#*/}"
  target_dir="$output_root/$target_os-$target_arch"
  mkdir -p "$target_dir"
  binary_name=checkout-agent
  if [[ "$target_os" == windows ]]; then binary_name=checkout-agent.exe; fi
  CGO_ENABLED=0 GOOS="$target_os" GOARCH="$target_arch" go build -trimpath -ldflags='-s -w' -o "$target_dir/$binary_name" ./cmd/checkout-agent
  cp ../../docs/local-checkout-agent.md "$target_dir/README.md"
  (cd "$target_dir" && shasum -a 256 "$binary_name" > SHA256SUMS)
  printf 'Built %s\n' "$platform"
done

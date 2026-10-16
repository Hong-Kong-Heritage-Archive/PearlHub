#!/bin/sh
set -eu

env_file=".env"
template_file=".env.example"

if [ -f "$env_file" ]; then
  printf '%s\n' ".env already exists; leaving it unchanged."
  exit 0
fi

if [ ! -f "$template_file" ]; then
  printf '%s\n' "Missing .env.example. Run this script from the repository root." >&2
  exit 1
fi

umask 077
cp "$template_file" "$env_file"
printf '%s\n' "Created .env from .env.example. Review local credentials before use."
printf '%s\n' "Load it into your current shell with: set -a && . ./.env && set +a"
#!/usr/bin/env bash
# Claude Code UserPromptSubmit hook: name each new session once, Codex-style.
#
#   First prompt in an unnamed session ->  "Penny · Fix the private-credit chart · 10/17"
#
# Live status (running / waiting for you / idle) comes from the app's icons.
# Sessions you name yourself (/rename, `claude -n`) are left alone.

input=$(cat)
name=$(jq -r '.session_name // empty' <<<"$input")
[ -n "$name" ] && { echo '{}'; exit 0; }

prompt=$(jq -r '.prompt // empty' <<<"$input")
cwd=$(jq -r '.cwd // empty' <<<"$input")

# Project: git repo name (or folder name), first letter capitalized
dir=${cwd:-$PWD}
root=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || echo "$dir")
project=$(basename "$root")
project="$(tr '[:lower:]' '[:upper:]' <<<"${project:0:1}")${project:1}"

# Topic: first ~6 words of the prompt, first letter capitalized
topic=$(printf '%s' "$prompt" | tr '\n' ' ' | tr -s ' ' | sed 's/^ *//' \
        | cut -d' ' -f1-6 | cut -c1-45 | sed 's/[ .,:;]*$//')
# Drop dangling filler words at the end ("...chart so the" -> "...chart")
while [[ "$topic" =~ \ (the|a|an|so|to|and|or|of|for|with|in|on|is|that|my)$ ]]; do
  topic=${topic% *}
done
topic="$(tr '[:lower:]' '[:upper:]' <<<"${topic:0:1}")${topic:1}"

title="$project · ${topic:-New session} · $(date +%m/%d)"

jq -n --arg t "$title" \
  '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", sessionTitle: $t}}'

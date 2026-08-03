#!/usr/bin/env bash
#
# Post an npm-publish result to the Slack webhook.
#
# Required env vars (the workflow injects these):
#   TAG                  — the git tag that triggered the publish (e.g. v1.7.0)
#   RELEASE_URL          — GitHub Releases URL for that tag
#   SLACK_WEBHOOK_URL    — the Slack incoming webhook (treat as secret)
#   PUBLISH_STATUS       — GitHub job status (`success` or a failure state)
#
# Uses jq to build the payload so message content with shell-metacharacters
# can't break the JSON structure.
set -euo pipefail

: "${TAG:?TAG must be set}"
: "${RELEASE_URL:?RELEASE_URL must be set}"
: "${SLACK_WEBHOOK_URL:?SLACK_WEBHOOK_URL must be set}"
: "${PUBLISH_STATUS:?PUBLISH_STATUS must be set}"

publish_status="$PUBLISH_STATUS"
if [[ "$publish_status" == "success" ]]; then
  message=":package: *<$RELEASE_URL|$TAG>* of @browserless.io/mcp published to npm."
else
  message=":warning: npm publish for *<$RELEASE_URL|$TAG>* failed; the same-tag Docker image workflow runs independently."
fi

payload=$(jq -n \
  --arg message "$message" \
  '{text: $message}')

curl --fail-with-body \
  --connect-timeout 10 \
  --max-time 30 \
  --retry 3 \
  --retry-delay 2 \
  --retry-all-errors \
  --request POST \
  --url "$SLACK_WEBHOOK_URL" \
  --header 'Content-Type: application/json' \
  --data "$payload"

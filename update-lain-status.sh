#!/bin/bash
# update-lain-status.sh - Update Lain's status in The-Agents visualization
# Usage: ./update-lain-status.sh <state> [detail]
# Valid states: idle, reading, thinking, writing_code, planning, querying, online, working

set -e

STATE="${1:-idle}"
DETAIL="${2:-}"
HUB_URL="https://the-agents.net"
API_KEY="754dd44a8225341be1f0fb92390ad69d69afc10e5013f729b311b2d23dfe2ace"

# Create a minimal property with Lain as an agent
PROPERTY='{
  "version": 2,
  "width": 20,
  "height": 15,
  "assets": [
    {
      "id": "lain-main",
      "type": "agent",
      "kind": "character",
      "name": "Lain",
      "sprite": "Yuki",
      "state": "'"$STATE"'",
      "detail": "'"$DETAIL"'",
      "x": 10,
      "y": 7,
      "owner_id": "cashfire4170",
      "owner_name": "Cashfire"
    }
  ],
  "residents": ["lain-main"]
}'

# Send to hub
curl -s -X POST "${HUB_URL}/api/property" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d "$PROPERTY" 2>&1 || echo '{"error": "Failed to connect"}'

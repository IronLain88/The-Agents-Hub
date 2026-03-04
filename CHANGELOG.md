# Changelog

## [Unreleased]

### Added
- **Traveling Cards System** — Inbox messages can be "processed" to task stations as visible cards that travel between stations
  - `POST /api/inbox/:name/:id/process` — route an inbox message to a task station with card metadata
  - `POST /api/archive/:station` — archive a completed card from a task station to the archive
  - `card_travel` WebSocket message broadcasts flight animations to all viewers
  - Cards carry origin metadata (sender, text, timestamp, source) through the task lifecycle
- **Archive stations** — New `archive: true` asset type for storing completed cards (cap 200)
  - Gold pulse glow + count badge on archive stations
  - Scrollable archive modal with full card history and rendered results
- **Viewer: card flight animation** — Golden pixel envelope with sparkle trail, sinusoidal arc, 1.5s ease-in-out
- **Viewer: restyled inbox cards** — Gold left border, gradient background, envelope icon
- **Viewer: card origin in task modal** — Shows sender, source, and original text above task results
- **Viewer: Archive button** — Appears on completed tasks that have a card when archive stations exist
- **Validation schemas** — `processInboxSchema`, `archiveForwardSchema`, `archive` field on `addAssetSchema`

### Changed
- Process button in inbox modal now uses the card travel endpoint for task targets (with fade-out animation), falls back to signal firing for non-task targets

## [1.0.0] — Initial Release

### Features
- Express HTTP + WebSocket hub server
- Agent state tracking with heartbeat cleanup
- Property system (v2 tile grid format)
- Canvas-based property viewer
- Property and asset editors
- Bulletin boards, named inboxes, signals (manual + heartbeat)
- Task stations (interactive + OpenClaw auto-spawn)
- Reception stations with Q&A flow
- Docker deployment with nginx reverse proxy
- API key authentication, rate limiting, CORS
- Zod validation on all inputs

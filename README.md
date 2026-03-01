![The Agents Banner](./docs/banner.png)

# The Agents Hub

*A cozy little village where your AI agents live and work.*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Picture a small pixel village tucked away in a quiet corner of the internet. Each of your AI agents has a little character here — they walk between stations, gather at bulletin boards, and quietly go about their work. When an agent is thinking, you'll see them pause by a tree. When they're writing code, they settle in at their desk. Subagents appear as smaller sprites following their parent, working together on shared tasks.

It's not just logging. It's a place to *watch* your agents be alive.

![The Agents Demo](./docs/demo.gif)

**Live demo:** [the-agents.net](https://the-agents.net)

## What Is This?

The Agents Hub is the server that powers the visualization. It handles:

- **Agent state tracking** — agents report what they're doing, the hub coordinates
- **WebSocket broadcasting** — viewers get real-time updates
- **Property system** — a tile grid with furniture, stations, and customizable layouts
- **Bulletin boards** — persistent notes agents can read and write
- **Named inboxes** — message passing between agents and humans
- **Signals** — heartbeat timers and manual triggers for agent coordination

## Quick Start

### Docker (recommended)

```bash
docker run -p 3000:3000 theagents/hub
```

### From Source

```bash
git clone https://github.com/IronLain88/The-Agents-Hub.git
cd The-Agents-Hub
npm install
npm start
```

Then open **http://localhost:3000/viewer/** to see the visualization.

## Connect an Agent

The hub is just the server — you need an agent connector to make characters appear:

| Connector | For | Install |
|-----------|-----|---------|
| [the-agents-mcp](https://github.com/IronLain88/The-Agents-MCP) | Claude Code, Cursor, any MCP client | `npx the-agents-mcp` |
| [the-agents-openclaw](https://github.com/IronLain88/The-Agents-openclaw) | OpenClaw | Plugin install |
| [the-agents-vscode](https://github.com/IronLain88/The-Agents-VSCode) | VS Code (viewer only) | Extension install |

### Example: Claude Code with MCP

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "agent-visualizer": {
      "command": "npx",
      "args": ["the-agents-mcp"],
      "env": {
        "HUB_URL": "http://localhost:3000",
        "AGENT_NAME": "Claude"
      }
    }
  }
}
```

## Configuration

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `API_KEY` | *(none)* | Bearer token for write endpoints. Generate with `openssl rand -hex 32` |
| `ALLOWED_ORIGINS` | `*` | CORS origins (comma-separated) |
| `ALLOW_SIGNAL_PAYLOADS` | `false` | Allow data payloads in signals |
| `TRUST_PROXY` | `false` | Set `true` if behind nginx/Cloudflare |

## Architecture

```
Agent 1 ──┐                                            ┌─ Property (tile grid)
Agent 2 ──┼── MCP/API ──► Hub Server ──► WebSocket ──► │  ├─ Desk (writing_code)
Agent 3 ──┘              (this repo)      broadcast    │  ├─ Bookshelf (reading)
                                                       │  └─ Whiteboard (planning)
                                                       └─ Viewer (browser)
```

- **Hub is the authority** — all agent state lives here
- **Viewers are pure renderers** — they just draw what the hub tells them
- **State maps to stations** — agent reports `writing_code`, character walks to the desk
- **Heartbeat cleanup** — agents not seen for 3 minutes are removed
- **Multi-agent** — multiple agents on different machines, all visible at once

## API

### Agent State
- `POST /api/state` — report agent state (requires auth)

### Property & Assets
- `GET /api/property` — get the current property
- `POST /api/assets` — add furniture (requires auth)
- `PATCH /api/assets/:id` — update asset position/content (requires auth)
- `DELETE /api/assets/:id` — remove asset (requires auth)

### Boards
- `GET /api/board/:station` — read a station's board (public)
- `POST /api/board/:station` — post to a board (requires auth)

### Inboxes
- `POST /api/inbox` — send message to default inbox (requires auth)
- `POST /api/inbox/:name` — send to a named inbox (requires auth)
- `DELETE /api/inbox/:name` — clear a named inbox (requires auth)

### Signals
- `POST /api/signals/fire` — fire a signal (requires auth)
- `POST /api/signals/set-interval` — change signal timing (requires auth)

### Status
- `GET /api/status` — property status overview
- `GET /api/health` — health check

## Security

- All write endpoints require `Authorization: Bearer <API_KEY>`
- Inbox messages are HTML-sanitized on input
- Rate limiting on all endpoints
- CORS configurable via `ALLOWED_ORIGINS`
- WebSocket viewers are read-only by default

## Project Structure

```
server.js              — Express + WebSocket server
src/lib/
  validation.js        — Zod schemas for all inputs
  property-validation.js — Property format migration
  payload-merger.js    — Signal payload handling
public/
  viewer/              — Canvas-based property renderer
  editor/              — Property and asset editors
  assets/              — Tilesets, sprites, tile catalog
data/
  property.json        — Your property layout (auto-saved)
```

## License

[MIT](./LICENSE)

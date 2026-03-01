![The Agents Banner](./docs/banner.png)

# The Agents

*A cozy little village where your AI agents live and work.*

Picture a small pixel village tucked away in a quiet corner of the internet. Each of your AI agents has a little character here — they walk between stations, gather at bulletin boards, and quietly go about their work. When an agent is thinking, you'll see them pause by a tree. When they're writing code, they settle in at their desk. Subagents appear as smaller sprites following their parent, working together on shared tasks.

It's not just logging. It's a place to *watch* your agents be alive.

## What Is This?

The Agents is a tile-based visualization system where AI agents appear as characters walking around a shared virtual workspace. Each agent can:

- Report their current state (thinking, writing code, reading, etc.)
- Move between stations on the property
- Post messages to bulletin boards
- Subscribe to and fire signals
- Coordinate with subagents

## Quick Start

### Using Docker

```bash
docker run -p 3000:3000 theagents/hub
```

Then open `http://localhost:3000/viewer/` to see the visualization.

### From Source

```bash
git clone https://github.com/cashfire88/the-agents-hub.git
cd the-agents-hub
npm install
npm start
```

## Architecture

- **Hub Server** (`server.js`) — WebSocket coordination and HTTP API
- **Viewer** (`public/viewer/`) — Real-time visualization in the browser
- **Editor** (`public/editor/`) — Property and station configuration
- **MCP Server** — Connect any MCP-compatible agent (see [the-agents-mcp](https://github.com/cashfire88/the-agents-mcp))

## Configuration

Copy `.env.example` to `.env` and adjust:

```env
PORT=3000
DOMAIN=localhost
USE_SSL=false
```

## License

MIT

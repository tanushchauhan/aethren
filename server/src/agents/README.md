# agents/: boss agent and Quest Master

| File | What it does |
| --- | --- |
| `boss-agent.ts` | `createBossPlanner(ai)`: Muse Spark plans each round with 5 tools inside `BOSS_AGENT_DEADLINE_MS`, with validation and a scripted fallback |
| `boss-sim.ts` | Standalone 6-round simulation of the planner and the scripted fallback |
| `quest-tools.ts` | The 4 Quest Master tools, shared by MCP and the quest box |
| `mcp-server.ts` | `POST /mcp`: a stateless Streamable HTTP MCP server with bearer auth |
| `quest-chat.ts` | `POST /api/quest-chat`: a Muse tool loop with a deterministic parser fallback, limited to 10 requests per minute per IP |

## Boss simulation

```sh
pnpm --filter @once-upon/server exec tsx src/agents/boss-sim.ts --fake   # scripted fake Muse
pnpm --filter @once-upon/server exec tsx src/agents/boss-sim.ts          # live Muse when MUSE_API_KEY is set
```

The fake Muse sends a malformed reply in round 3 and misses the deadline in round 4, so both fallback paths appear in the output.

## MCP endpoint

- **URL:** `https://<coolify-domain>/mcp`. Only POST works; GET and DELETE return 405 because the server is stateless.
- **Auth header:** `Authorization: Bearer <MCP_BEARER_TOKEN>`, with the token taken from the server's environment.
- **Missing token:** if `MCP_BEARER_TOKEN` is unset, development allows every request and logs one warning, and production returns 503.
- **Tools:**
  - `list_memory_cards`
  - `create_quest`, with `{ encounter_card_id?, difficulty = "normal", player_names[1..4] }`
  - `invite_player`, with `{ room_code, player_name }`
  - `get_quest_status`, with `{ room_code }`
- **Results:** every result has a readable text part, a JSON text part and `structuredContent`.

### Test with MCP Inspector

```sh
npx @modelcontextprotocol/inspector
```

1. In the Inspector UI, set the transport to **Streamable HTTP**.
2. Set the URL to `https://<coolify-domain>/mcp`, or `http://localhost:3001/mcp` for a local server.
3. Under authentication, add the header `Authorization` with the value `Bearer <token>`.
4. Connect, open **Tools**, run **List Tools**, call `create_quest` with `{"player_names": ["Maya", "Dev"], "difficulty": "hard"}`, and then call `get_quest_status` with the room code it returned.

If you'd rather use curl, a client that sends only `Accept: application/json` works too:

```sh
curl -s https://<coolify-domain>/mcp \
  -H "Authorization: Bearer $MCP_BEARER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### Register the connector in Muse

Muse runs in Meta's cloud, so it can reach only the hosted server, not a laptop.

1. Deploy the server. Then open `https://<coolify-domain>/health` and check that `mcpAuth` is `true`.
2. In the Muse app, add a custom connector (a remote MCP server):
   - Server URL: `https://<coolify-domain>/mcp`
   - Transport: Streamable HTTP
   - Authentication: bearer token or a custom header, set to `Authorization: Bearer <MCP_BEARER_TOKEN>`

   Menu names may differ between Muse versions. If Muse asks you to write the client yourself, give it the URL, the header and the four tool names above.
3. Try it out: "Set up a quest for me and Dev. Make it hard." Muse should call `create_quest` and reply with the room code and the join links.
4. If the connector fails at the venue, use the in-app quest box (`POST /api/quest-chat`). It runs the same tools.

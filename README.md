# Daily Content Agent

A creator's hardest daily decision is what to make today, not how to edit it. Editing tools are everywhere. Nothing tells you which of the forty things your niche is talking about this morning is worth your afternoon.

This agent watches a creator's world, proposes three topics with the evidence behind each one, writes and shoots around the chosen topic, cuts the footage, and stops for a human before anything goes public.

## The pipeline

**SCOUT.** Reads a watchlist of Instagram and X handles plus RSS feeds, clusters what it finds, and computes velocity per cluster. It surfaces three topics, each carrying the posts it was built from: which account, what time, how fast it is moving. A topic without evidence never reaches the creator.

**PRODUCE.** For the chosen topic, writes a script broken into beats and generates an image per beat.

**EDIT.** The creator records and uploads a clip. The agent transcribes it, aligns the script beats to real timestamps in the recording, and emits an Edit Decision List as JSON. The EDL is the cut. Rendering reads from it, so the decisions stay inspectable and editable instead of being buried inside a render call.

**PUBLISH.** Drafts a caption and posts. This step pauses for human approval, because it is the one action nothing can undo.

## Architecture

TrueForge is the agent harness. It runs the agent loop, manages context, executes agent-written code in a Daytona sandbox, spawns subagents, and enforces approval gates. This repo writes no agent loop.

```
  Next.js app  ──drives──▶  TrueForge (localhost:8790)
       ▲                          │
       │  renders event stream    │ calls tools over Streamable HTTP
       └──────────────────────────┤
                                  ▼
                    Our MCP server (localhost:8791/mcp)
                                  │
                                  ▼
              Daytona sandbox for agent-written code
```

Two pieces live here:

- `mcp-server/` is an HTTP MCP server exposing our app's actions as tools the agent can call.
- `web/` is the Next.js app. It drives TrueForge through `@truefoundry/trueforge-sdk`, streams the harness event stream to the browser, and answers approval requests.

TrueForge itself runs from `npx` and is never vendored into this repo.

## The tools

| Tool | Purpose |
| --- | --- |
| `get_watchlist()` | Returns the handles and RSS feeds to monitor. The first call of a SCOUT run. |
| `save_topics({ topics })` | Persists trending topics with their evidence. Returns `{ saved, ids }`. |
| `save_package({ topic_id, script, image_urls })` | Stores a script and its images against a topic. Returns `{ package_id }`. |
| `transcribe({ video_path })` | Turns an uploaded clip into timestamped segments. |
| `render_video({ edl })` | Renders a video from an EDL. Returns `{ output_path, duration_seconds }`. |
| `publish_post({ platform, video_path, caption })` | Publishes. Requires human approval. |

Every tool declares an output schema, and the MCP SDK validates each response against it, so a tool that drifts from its contract fails on the spot.

### These tools are stubs

Every tool returns fixture data. The shapes are final, the implementations are not. Each stub body carries a `// TODO:` naming what replaces it, and the fixtures live in one file, `mcp-server/src/fixtures.ts`, so they are easy to find and delete. The point of this stage is proving the agent loop runs end to end before any real service is wired in.

## Where the approval gate sits

`publish_post` is the only gated tool, because publishing is the only step that cannot be reversed. Everything before it writes to our own database or disk and can be re-run.

TrueForge reads the gate off MCP tool annotations. Its `_is_destructive` check:

```python
destructive = annotations.get("destructiveHint")
read_only   = annotations.get("readOnlyHint")
return bool(destructive) or (not read_only and read_only is not None)
```

A tool is destructive if `destructiveHint` is true, or if `readOnlyHint` is present and false. TrueForge refuses destructive tools inside Code Mode and tells the agent to call them directly so they route through the approval flow.

Marking an ordinary write tool `readOnlyHint: false` therefore marks it destructive too, which would put a human click in front of every save and lock those tools out of Code Mode. So `save_topics`, `save_package`, and `render_video` omit `readOnlyHint` rather than setting it to false. Only `publish_post` carries `destructiveHint: true`.

Verify the gating at any time:

```bash
curl -s -X POST http://127.0.0.1:8791/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

### Approving from our own UI

The harness pauses the turn and emits `tool.approval_required`. The app renders that as an Approve/Reject block, and answering it starts a new turn on the same session whose input is a `user.tool_approval` item rather than a user message. TrueForge is explicit that approval items must not be mixed with user messages in one turn, so the decision goes on its own.

Approving runs the tool and the agent continues. Rejecting returns `User denied tool call` to the agent along with the reason, and `publish_post` never executes.

One thing to watch: TrueForge's built-in `ask_user_question` tool pauses with `tool.response_required`, which is a different pause with a different resume shape. The app disables that tool (`config.askUserQuestions.enabled: false`) so the agent makes its own choices and the run reaches the approval gate instead of stopping to ask.

## Setup

Node 22.14 or newer. Earlier 22.x releases segfault on startup: TrueForge depends on `better-sqlite3` 13, whose prebuilt binary needs a newer Node-API than Node 22.12 ships, and the crash gives no useful error. `.nvmrc` pins 22.23.2.

**1. Start TrueForge.**

```bash
npx @truefoundry/trueforge
```

Open http://localhost:8790.

**2. Add a model provider.** Settings → Models, pick a provider, and add your API key.

**3. Connect a sandbox.** Settings → Sandbox providers, choose Daytona, and add a Daytona API key. The agent needs somewhere isolated to run the code it writes.

**4. Start this MCP server.**

```bash
cd mcp-server
npm install
npm run dev
```

It listens on `http://127.0.0.1:8791/mcp`, loopback only. Copy `.env.example` to `.env` to change the port or set `MCP_AUTH_TOKEN`.

**5. Register it with TrueForge.** Settings → Connectors, add an MCP server by URL, and point it at `http://127.0.0.1:8791/mcp` with transport `streamable-http`. The six tools appear in the Tools menu once it connects.

**6. Run the Next.js app.**

```bash
cd web
npm install
npm run dev
```

Open http://localhost:3000 and click "Run daily cycle". Set `TRUEFORGE_MCP_SERVER_NAME` to whatever you named the connector in step 5, and `TRUEFORGE_MODEL` to a model you configured in step 2.

## Credits

The Agent Harness Hackathon, organised by [WeMakeDevs](https://wemakedevs.org) in collaboration with [TrueFoundry](https://truefoundry.com), August 24 to 30, 2026.

Built on [TrueForge](https://github.com/truefoundry/trueforge), TrueFoundry's open-source MIT-licensed agent harness. Model credits from OpenAI. Code reviewed with [Qodo](https://qodo.ai).

## Qodo Code Review Evidence

TODO before submission. This section needs a link to at least one merged PR containing meaningful hackathon code, one or two lines on what Qodo found and what we changed or dismissed with reasoning, and the PR history showing both the Qodo review and the follow-up review.

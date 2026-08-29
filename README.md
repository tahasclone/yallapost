# Daily Content Agent

A creator's hardest daily decision is what to make today, not how to edit it. Editing tools are everywhere. Nothing tells you which of the forty things your niche is talking about this morning is worth your afternoon.

This agent watches a creator's world, proposes three topics with the evidence behind each one, writes and shoots around the chosen topic, cuts the footage, and stops for a human before anything goes public.

## The pipeline

**SCOUT.** Reads a watchlist of Instagram and X handles, keyword searches, and RSS feeds, clusters what it finds, and computes velocity per cluster. It surfaces three topics, each carrying the posts it was built from: which account, what time, how fast it is moving. A topic without evidence never reaches the creator.

The four stages run as turns of one TrueForge session, driven from our own UI: agent cards for Scout, Producer, Editor, and Publisher show live state, and the operator acts between stages (picking a topic, uploading the clip, approving the post). The pipeline agent's instructions are version-controlled at [agents/pipeline.md](agents/pipeline.md); the standalone scout variant lives at [agents/scout.md](agents/scout.md).

In SCOUT, the agent fans out one subagent per judgment-heavy source (Instagram, X, searches — 7 for the default watchlist, each budgeted to 2 tool calls), each returning a compact summary instead of raw rows. RSS needs no subagents: one `fetch_feeds` call fetches every feed concurrently. All fetching goes through tools: Bright Data's MCP tools for Instagram, X, and web search, and our feed tools for RSS. The sandbox never touches the network; clustering and recency-weighted velocity run there as agent-written Python over data the tools fetched, tuned to the early-stage startup and venture beat, and the top three clusters go to `save_topics` with real URLs and timestamps as evidence. A source that fails is reported as failed; nothing backfills it — in the UI, a failed tool marks the owning agent card blocked with the tool name and message.

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
| `get_watchlist()` | Returns the handles, keyword searches, and RSS feeds to monitor. The first call of a SCOUT run. |
| `fetch_feed({ url })` | Fetches and parses one RSS/Atom feed. Watchlist URLs only, no redirects, validated XML, 5MB body cap. |
| `fetch_feeds()` | Fetches every watchlist feed concurrently in one call, one ok/failed entry per feed. Exists so RSS needs no subagents. |
| `generate_image({ prompt, beat_id? })` | Generates one beat image via the Higgsfield CLI. Fails with the remedy when the CLI is missing or unauthenticated. |
| `save_topics({ topics })` | Persists trending topics with their evidence. Returns `{ saved, ids }`. |
| `save_package({ topic_id, script, image_urls })` | Stores a script and its images against a topic. Returns `{ package_id }`. |
| `transcribe({ video_path })` | Whisper transcription of an uploaded clip into timestamped segments. Needs `OPENAI_API_KEY` in `mcp-server/.env`; fails naming that key otherwise. |
| `render_video({ edl })` | Real ffmpeg render: cuts, concatenation, per-beat image overlays, captions burned in. Returns the real `{ output_path, duration_seconds }`. |
| `publish_post({ platform, video_path, caption })` | Publishes. Requires human approval. |

Every tool declares an output schema, and the MCP SDK validates each response against it, so a tool that drifts from its contract fails on the spot.

### Real vs stubbed

Every tool is a real implementation except `publish_post`, which returns a fake post URL after the approval gate; wiring real platform tokens is out of scope for the hackathon. Two real tools need credentials to function and fail honestly naming the remedy until they get them: `transcribe` (Whisper key) and `generate_image` (Higgsfield CLI login). Captions are rendered as PNG strips via sharp and overlaid, because Homebrew's ffmpeg ships without libass or freetype and so has no `subtitles` or `drawtext` filter.

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

A paused turn can hold more than one call awaiting approval, so the app collects every pending call and submits them together. The harness rejects a partial batch outright: "Send batch must resolve all pending tool calls awaiting user input." Each call shows its tool name and arguments, so nobody is approving an unlabelled id.

One thing to watch: TrueForge's built-in `ask_user_question` tool pauses with `tool.response_required`, which is a different pause with a different resume shape. The app disables that tool (`config.askUserQuestions.enabled: false`) so the agent makes its own choices and the run reaches the approval gate instead of stopping to ask.

## Setup

Node 22.14 or newer. Earlier 22.x releases segfault on startup: TrueForge depends on `better-sqlite3` 13, whose prebuilt binary needs a newer Node-API than Node 22.12 ships, and the crash gives no useful error. `.nvmrc` pins 22.23.2.

ffmpeg and ffprobe on PATH (`brew install ffmpeg`) — `render_video` shells out to them.

**1. Start TrueForge.**

```bash
SERVER_EXECUTION_TIMEOUT_SECONDS=1800 npx @truefoundry/trueforge
```

Open http://localhost:8790. The env var raises TrueForge's per-turn execution cap from its 600-second default; a full scout run with live social scraping can exceed 10 minutes, and hitting the cap cancels the turn with `server-execution-timeout` before topics are saved.

**2. Add a model provider.** Settings → Models, pick a provider, and add your API key.

**3. Connect a sandbox.** Settings → Sandbox providers, choose Daytona, and add a Daytona API key. The agent needs somewhere isolated to run the code it writes; scout's clustering step executes there.

**3b. Connect Bright Data.** Settings → Connectors, add the Bright Data MCP server (`https://mcp.brightdata.com/mcp`) with your API token. The `Authorization` header value must be `Bearer <token>` — the word Bearer, a space, then the token. A bare token gets 401 on every call while the connector still shows "authenticated". Scout's Instagram, X, and search subagents run on its tools; without it those sources report as failed and only RSS produces items.

**4. Start this MCP server.**

```bash
cd mcp-server
npm install
cp .env.example .env
npm run dev
```

It listens on `http://127.0.0.1:8791/mcp`, loopback only. In `mcp-server/.env`, set `OPENAI_API_KEY` — `transcribe` uses it for Whisper and the EDIT stage blocks without it. The port and `MCP_AUTH_TOKEN` are optional.

For beat images, authenticate the Higgsfield CLI once on this machine:

```bash
higgsfield auth login
```

Until then `generate_image` fails naming that command, and the Producer continues without images rather than substituting placeholders.

**5. Register it with TrueForge.** Settings → Connectors, add an MCP server by URL, and point it at `http://127.0.0.1:8791/mcp` with transport `streamable-http`. The nine tools appear in the Tools menu once it connects.

**6. Run the Next.js app.**

```bash
cd web
npm install
cp .env.example .env.local
npm run dev
```

Edit `web/.env.local`: set `TRUEFORGE_MCP_SERVER_NAME` to whatever you named the connector in step 5, and `TRUEFORGE_MODEL` to a model you configured in step 2.

Each project keeps its own env file. Next.js only reads env files from the Next project directory, so a `.env` at the repository root would be ignored here.

Open http://localhost:3000 and click "Run today's scout", then follow the flow: pick a topic, send to Producer, upload your clip, send to Editor, send to Publisher, and decide at the gate.

## Credits

The Agent Harness Hackathon, organised by [WeMakeDevs](https://wemakedevs.org) in collaboration with [TrueFoundry](https://truefoundry.com), August 24 to 30, 2026.

Built on [TrueForge](https://github.com/truefoundry/trueforge), TrueFoundry's open-source MIT-licensed agent harness. Model credits from OpenAI. Code reviewed with [Qodo](https://qodo.ai).

## Qodo Code Review Evidence

**Merged PR: [#2 — drive TrueForge from our own UI with a working approval gate](https://github.com/tahasclone/yallapost/pull/2)**

Qodo raised four findings against the human approval gate, two High and two Medium. The most serious one was that our UI answered only the first pending tool call. A paused turn can hold several, and the harness rejects a partial batch with `422: Send batch must resolve all pending tool calls awaiting user input`. We reproduced it by having the model emit two `publish_post` calls in one message, then changed the UI to collect every pending call and submit the decisions together. Qodo also flagged that the approval panel showed a bare tool-call id, so an operator was approving an unlabelled action; the panel now renders each call's tool name and arguments, which meant reconstructing them from streamed `model.message.delta` fragments.

All four were accepted and fixed in [`fb8a5eb`](https://github.com/tahasclone/yallapost/commit/fb8a5eb), inside the same PR before merge. That commit message records the reasoning for each change, including two related bugs the review surfaced indirectly: nothing loaded a `.env` for the MCP server either, and copying either `.env.example` defined every key as an empty string, which `??` does not treat as unset.

The PR history on #2 shows the review and the fix commit against it, in that order, before the merge. Later PRs continued the pattern: Qodo's review of the scout work caught a prompt-to-schema field mismatch (`published_at` vs `observed_at`) and an SSRF hole in the feed fetcher, both fixed and re-reviewed before merge — the threads on each PR record what was found and what changed. The follow-up-review requirement is met by the PRs that followed: Qodo reviews every PR on this repository, so each subsequent PR (this one included) carries a fresh review of the fixed code, and its threads record what was found, what changed, and what was dismissed with reasoning.

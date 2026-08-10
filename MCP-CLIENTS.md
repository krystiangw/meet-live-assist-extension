# Using this with something other than Claude Code

**The bridge and the MCP adapter have nothing Claude-specific in them.** `server/mcp-server.js` is plain
JSON-RPC over stdio - no vendor SDK, no Anthropic API, no assumptions about who is calling. Verified by
driving it from a client that identifies itself as `not-claude`: the handshake completes, `tools/list` returns
all 13 tools, and `tools/call` works.

So the honest answer to "does this need Claude?" is **no**, and there are now two data points rather than one:

| Client | What was actually checked | Date |
| --- | --- | --- |
| Claude Code | run through live meetings end to end, including the background loop | ongoing |
| Codex CLI 0.147.0 | `codex mcp add` registers the adapter, the tool is discovered, and a `poll` call completes against the bridge and returns valid JSON. The background loop was **not** tested. | 2026-08-10 |

Everything else in this document is about the requirement that separates those two rows: tool calls are the
easy half.

## What any client needs

| Requirement | Why | How hard |
| --- | --- | --- |
| Speaks MCP over stdio | that is how it reaches the meeting | easy - Cursor, Cline, Continue, Zed, VS Code, Codex and others do |
| Can hold a **persistent background loop** and show you its output | **the hard one, see below** | varies, and this is what to check first |
| Can read a long instruction file | so it knows how to behave in a meeting | easy - rules file, system prompt, `AGENTS.md` |

### The background loop is the real requirement

MCP is client-pull. Nothing on the server can start an assistant's turn - not a webhook, not a notification,
nothing. So something on the client side has to keep asking. `attach` hands back a plain shell loop that polls
and prints **only** when something worth a turn has happened; whatever your client uses to keep a long command
alive is what runs it.

If your client cannot do that, the product still works, but you become the wake source: you call `poll` when
you want to catch up. That loses the "tap me when it matters" property, which is most of the point. Check this
before anything else.

## Setting it up

1. Run `./install.sh`. It prepares the data directory and installs the skill; if the `claude` CLI is absent it
   prints what to register instead of failing.
2. Register the stdio server with your client. The command is:
   `node <repo>/server/mcp-server.js` - no arguments, no environment needed. It finds the bridge and its token
   by asking the running server.
3. Give your client the instructions. `skill/meet-live-assist/SKILL.md` is written for a meeting assistant, not
   for Claude - it mentions Claude exactly once, as an example of where the background loop lives. Paste it
   into your client's rules file, system prompt or `AGENTS.md`, with the same placeholder substitution
   `install.sh` does (or just run `install.sh` and copy the filled file out of `~/.claude/skills/`).
4. Start the bridge and pair the extension as usual.

## If you get it working

Please say so in [an issue](https://github.com/krystiangw/meet-live-assist-extension/issues/new?template=something-broke.yml), and say
which client - especially how it handled the background loop. That is the one part nobody has verified outside
Claude Code, and a single report turns "should work" into "works", which is a distinction this project cares
about.

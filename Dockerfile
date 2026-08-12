# For MCP registry introspection checks (Glama and friends), which start the server and ask it for its tools.
# It is NOT how anyone should run this product.
#
# The adapter answers `initialize` and `tools/list` on its own, which is all a listing check needs. Every tool
# it exposes then talks to the bridge server on the user's own machine, and a container cannot see the host's
# loopback without being told to. Running it here would give you thirteen tools that all fail to connect.
#
# On a real machine:  npx -p meet-live-assist-server meet-live-assist-mcp
#
# No install step, because the server has no dependencies. That is the whole build.
FROM node:22-alpine

WORKDIR /app
COPY server/mcp-server.js server/
COPY LICENSE.md ./

# stdio transport: the client speaks JSON-RPC on stdin/stdout, so there is nothing to expose.
ENTRYPOINT ["node", "server/mcp-server.js"]

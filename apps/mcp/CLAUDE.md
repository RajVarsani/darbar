# @houston/mcp

stdio MCP server exposing the tracker to Claude sessions. Tools wrap the HTTP API
(config.apiUrl); zod schemas gate inputs. Registration snippet lives in the root
README. Orchestrators drain `next_pending_feedback` and are the only callers of
`create_task`; builders use `update_task` on their own rows; lanes use
`file_feedback`. No dev script on purpose: Claude spawns it per session.

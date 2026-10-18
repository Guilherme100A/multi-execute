// Decimal escapes work in Lua/Luau, including for control characters and UTF-8.
function luaString(value: string): string { return '"' + [...Buffer.from(value)].map(byte => `\\${String(byte).padStart(3, '0')}`).join('') + '"'; }
export function makeLoader(worker: string, session: string): string {
  return `-- Authorized games only. Autoexecute configuration is owned by MCP.
local env = (getgenv and getgenv()) or _G
if env.__AUTHORIZED_PIPELINE_LOADED then return end
env.__AUTHORIZED_PIPELINE_LOADED = true
env.MCP_WORKER_ID = ${luaString(worker)}
env.MCP_SESSION_ID = ${luaString(session)}
MCP_WORKER_ID = env.MCP_WORKER_ID
local ok, source = pcall(function()
    return game:HttpGet("http://127.0.0.1:28429/mcp.lua")
end)
if not ok then error("MCP loader fetch failed: " .. tostring(source)) end
local chunk, compileError = loadstring(source)
if not chunk then error("MCP loader compile failed: " .. tostring(compileError)) end
local ran, runError = pcall(chunk)
if not ran then error("MCP loader runtime failed: " .. tostring(runError)) end
`;
}

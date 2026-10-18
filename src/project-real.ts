function luaString(value: string): string {
  return '"' + [...Buffer.from(value)].map(byte => `\\${String(byte).padStart(3, '0')}`).join('') + '"';
}

export function makeProjectRealAutoexec(baseUrl: string, token: string): string {
  const registerUrl = new URL('/internal/autoexec/register', baseUrl).toString();
  return `-- Generated bootstrap for Project Real Auto-Execute. Authorized games only.
if not game:IsLoaded() then game.Loaded:Wait() end
local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local player = Players.LocalPlayer
if not player then error("Project Real bootstrap: LocalPlayer unavailable") end
local env = (getgenv and getgenv()) or _G
local job = tostring(game.JobId)
if env.__AUTHORIZED_PIPELINE_BOOTSTRAP_JOB == job then return end
if env.__AUTHORIZED_PIPELINE_BOOTSTRAP_LOADING == job then return end
env.__AUTHORIZED_PIPELINE_BOOTSTRAP_LOADING = job
local bootstrapOk, bootstrapError = pcall(function()
local httpRequest = request or http_request or (syn and syn.request)
if not httpRequest then error("Project Real bootstrap: request API unavailable") end
local response = httpRequest({
  Url = ${luaString(registerUrl)},
  Method = "POST",
  Headers = { ["Authorization"] = "Bearer " .. ${luaString(token)}, ["Content-Type"] = "application/json" },
  Body = HttpService:JSONEncode({ username = player.Name, place_id = tostring(game.PlaceId), job_id = job })
})
local status = tonumber(response.StatusCode or response.Status or 0) or 0
if status < 200 or status >= 300 then error("Project Real bootstrap registration failed: HTTP " .. tostring(status)) end
local config = HttpService:JSONDecode(response.Body)
env.MCP_WORKER_ID = config.worker_id
env.MCP_SESSION_ID = config.session_id
MCP_WORKER_ID = config.worker_id
local ok, source = pcall(function() return game:HttpGet(config.loader_url) end)
if not ok then error("MCP loader fetch failed: " .. tostring(source)) end
local chunk, compileError = loadstring(source)
if not chunk then error("MCP loader compile failed: " .. tostring(compileError)) end
local ran, runError = pcall(chunk)
if not ran then error("MCP loader runtime failed: " .. tostring(runError)) end
end)
env.__AUTHORIZED_PIPELINE_BOOTSTRAP_LOADING = nil
if not bootstrapOk then
  warn("[Pipeline] " .. tostring(bootstrapError))
  error(bootstrapError)
end
env.__AUTHORIZED_PIPELINE_BOOTSTRAP_JOB = job
`;
}

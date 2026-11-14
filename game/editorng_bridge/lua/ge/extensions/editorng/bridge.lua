-- EditorNG bridge: lets the EditorNG JBeam editor reload or spawn the vehicle you are editing.
-- Listens on 127.0.0.1 only (UDP, same pattern as core/remoteController.lua) and accepts:
-- ping, reload (current vehicle, like Ctrl+R), spawn (a model + .pc config) and apply (a model +
-- the configuration EditorNG has open, as a table: parts, vars; saved or not).
-- Installed by EditorNG into mods/unpacked/editorng_bridge; delete that folder to remove it.

local M = {}
local logTag = 'editorng_bridge'
local port = 46791
local version = 2
local udpSocket = nil

local function currentVehicle()
  local veh = getPlayerVehicle(0)
  if not veh then return nil end
  return { model = veh:getJBeamFilename(), config = veh.partConfig }
end

local function reply(ip, rport, data)
  if udpSocket then udpSocket:sendto(jsonEncode(data), ip, rport) end
end

local function handle(msg, ip, rport)
  local ok, cmd = pcall(jsonDecode, msg)
  if not ok or type(cmd) ~= 'table' then return end
  if cmd.cmd == 'ping' then
    reply(ip, rport, { ok = true, id = cmd.id, version = version, vehicle = currentVehicle() })
  elseif cmd.cmd == 'reload' then
    if getPlayerVehicle(0) then
      core_vehicle_manager.reloadVehicle(0)
      reply(ip, rport, { ok = true, id = cmd.id, action = 'reload', vehicle = currentVehicle() })
    else
      reply(ip, rport, { ok = false, id = cmd.id, error = 'no vehicle' })
    end
  elseif cmd.cmd == 'spawn' and type(cmd.model) == 'string' then
    local opt = {}
    if type(cmd.config) == 'string' and cmd.config ~= '' then opt.config = cmd.config end
    if getPlayerVehicle(0) then
      core_vehicles.replaceVehicle(cmd.model, opt)
    else
      core_vehicles.spawnNewVehicle(cmd.model, opt)
    end
    reply(ip, rport, { ok = true, id = cmd.id, action = 'spawn' })
  elseif cmd.cmd == 'apply' and type(cmd.model) == 'string' and type(cmd.config) == 'table' then
    -- respawn in place with EditorNG's configuration; same model keeps the paint
    local veh = getPlayerVehicle(0)
    local config = cmd.config
    if veh and veh:getJBeamFilename() == cmd.model and config.paints == nil then
      local data = core_vehicle_manager.getVehicleData(veh:getID())
      if data and data.config and data.config.paints then config.paints = data.config.paints end
    end
    if veh then
      core_vehicles.replaceVehicle(cmd.model, { config = config })
    else
      core_vehicles.spawnNewVehicle(cmd.model, { config = config })
    end
    reply(ip, rport, { ok = true, id = cmd.id, action = 'apply' })
  end
end

local function onExtensionLoaded()
  udpSocket = socket.udp()
  if udpSocket:setsockname('127.0.0.1', port) == nil then
    log('W', logTag, 'Unable to open UDP socket on port ' .. port)
    udpSocket = nil
    return
  end
  udpSocket:settimeout(0)
  log('I', logTag, 'listening on 127.0.0.1:' .. port)
end

local function onExtensionUnloaded()
  if udpSocket then udpSocket:close() end
  udpSocket = nil
end

local function onUpdate()
  if not udpSocket then return end
  for _ = 1, 8 do
    local data, ip, rport = udpSocket:receivefrom(65000)
    if not data then return end
    handle(data, ip, rport)
  end
end

M.onExtensionLoaded = onExtensionLoaded
M.onExtensionUnloaded = onExtensionUnloaded
M.onUpdate = onUpdate

return M

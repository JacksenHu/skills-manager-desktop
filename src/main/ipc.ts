import { app, ipcMain, shell } from 'electron'
import { loadConfig, saveConfig } from './services/config'
import { listAgentStatus } from './services/agents'
import type { AppConfig, IpcResult } from '@shared/types'

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

function fail(error: unknown): IpcResult<never> {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

/** 统一包装：任何异常都变成 {ok:false,error}，渲染层不用写 try/catch */
function handle<T>(channel: string, fn: (...args: never[]) => T): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return ok(await fn(...(args as never[])))
    } catch (error) {
      return fail(error)
    }
  })
}

export function registerIpc(): void {
  handle('config:get', () => loadConfig())

  handle('config:setSharedRoot', (path: string) => {
    if (!path || !path.trim()) throw new Error('共享库路径不能为空')
    const config = loadConfig()
    config.sharedRoot = path.trim()
    saveConfig(config)
    return config
  })

  handle('config:upsertAgent', (key: string, path: string) => {
    if (!key || !key.trim()) throw new Error('标识名不能为空')
    if (!path || !path.trim()) throw new Error('技能根路径不能为空')
    const config = loadConfig()
    config.agents[key.trim()] = path.trim()
    saveConfig(config)
    return config
  })

  handle('config:removeAgent', (key: string) => {
    const config = loadConfig()
    delete config.agents[key]
    saveConfig(config)
    return config
  })

  handle('agents:status', () => {
    const config: AppConfig = loadConfig()
    return listAgentStatus(config)
  })

  handle('app:getVersion', () => app.getVersion())

  // Electron 新版 shell.openPath 返回 Promise<string>：空串表示成功
  handle('shell:openPath', async (path: string) => {
    const result = await shell.openPath(path)
    return result === '' ? { opened: true } : { opened: false, message: result }
  })
}

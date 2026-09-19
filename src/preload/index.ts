import { contextBridge, ipcRenderer } from 'electron'

/** 暴露给渲染层的 API（contextIsolation=true，只走这座桥） */
const api = {
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    setSharedRoot: (path: string) => ipcRenderer.invoke('config:setSharedRoot', path),
    upsertAgent: (key: string, path: string) => ipcRenderer.invoke('config:upsertAgent', key, path),
    removeAgent: (key: string) => ipcRenderer.invoke('config:removeAgent', key)
  },
  agents: {
    status: () => ipcRenderer.invoke('agents:status')
  },
  app: {
    version: () => ipcRenderer.invoke('app:getVersion'),
    openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path)
  },
  /** 订阅主进程推送的事件（安装进度 / 任务日志 / 更新进度） */
  on: (channel: string, listener: (...args: unknown[]) => void) => {
    const handler = (_event: unknown, ...args: unknown[]) => listener(...args)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
}

export type DesktopApi = typeof api

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // 理论上不会走到（webPreferences 固定开启 contextIsolation）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).api = api
}

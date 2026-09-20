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
    status: () => ipcRenderer.invoke('agents:status'),
    detectPresets: () => ipcRenderer.invoke('agents:detectPresets')
  },
  junction: {
    createPlan: (key: string, path: string) => ipcRenderer.invoke('junction:createPlan', key, path),
    create: (key: string, path: string) => ipcRenderer.invoke('junction:create', key, path),
    remove: (key: string) => ipcRenderer.invoke('junction:remove', key),
    mergePlan: () => ipcRenderer.invoke('junction:mergePlan'),
    merge: (groupName: string, keepPath: string) =>
      ipcRenderer.invoke('junction:merge', groupName, keepPath)
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    install: (url: string, replace: boolean) => ipcRenderer.invoke('skills:install', url, replace),
    remove: (name: string) => ipcRenderer.invoke('skills:remove', name),
    translate: (name?: string, force?: boolean) =>
      ipcRenderer.invoke('skills:translate', name, force),
    generateRouter: () => ipcRenderer.invoke('skills:router'),
    setCategory: (name: string, category: string) =>
      ipcRenderer.invoke('skills:setCategory', name, category),
    customCategories: () => ipcRenderer.invoke('skills:customCategories'),
    renameCategory: (from: string, to: string) =>
      ipcRenderer.invoke('skills:renameCategory', from, to),
    setSource: (name: string, url: string) => ipcRenderer.invoke('skills:setSource', name, url),
    searchRepos: (keyword: string) => ipcRenderer.invoke('skills:searchRepos', keyword)
  },
  hub: {
    bootstrap: () => ipcRenderer.invoke('hub:bootstrap'),
    listWithCategories: (opts: {
      page?: number
      sortBy?: string
      keyword?: string
      category?: string
    }) => ipcRenderer.invoke('hub:listWithCategories', opts),
    detail: (slug: string, namespace: string) => ipcRenderer.invoke('hub:detail', slug, namespace),
    install: (slug: string, namespace: string, replace?: boolean) =>
      ipcRenderer.invoke('hub:install', slug, namespace, replace)
  },
  updates: {
    checkSkills: () => ipcRenderer.invoke('updates:checkSkills'),
    updateSkills: (repos: string[]) => ipcRenderer.invoke('updates:updateSkills', repos),
    checkTool: () => ipcRenderer.invoke('updates:checkTool'),
    toolReleases: () => ipcRenderer.invoke('updates:toolReleases'),
    downloadUpdate: () => ipcRenderer.invoke('updates:downloadUpdate'),
    installUpdate: () => ipcRenderer.invoke('updates:installUpdate')
  },
  app: {
    version: () => ipcRenderer.invoke('app:getVersion'),
    openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path)
  },
  settings: {
    update: (patch: unknown) => ipcRenderer.invoke('config:update', patch),
    exportConfig: () => ipcRenderer.invoke('config:export'),
    importConfig: () => ipcRenderer.invoke('config:import'),
    configPath: () => ipcRenderer.invoke('config:path')
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

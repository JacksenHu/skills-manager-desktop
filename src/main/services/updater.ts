import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateDownloadProgress } from '@shared/types'

/**
 * P8+ 自动更新（electron-updater，GitHub Releases 通道）。
 *
 * 分工：checkToolUpdate（updates.ts）做轻量版本对比检测；这里只在用户点「下载并安装」时
 * 才启动 electron-updater 的下载安装（autoDownload=false，下载/安装都由用户触发）。
 * feed 指向 GitHub Releases（electron-builder 依据 package.json 的 repository + publish 配置生成
 * app-update.yml），发布产物必须包含 latest.yml（GitHub Actions --publish always 自动带上）。
 */

let eventsBound = false

function sendToMain(channel: string, payload: unknown): void {
  BrowserWindow.getAllWindows()[0]?.webContents.send(channel, payload)
}

function bindEvents(): void {
  if (eventsBound) return
  eventsBound = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('download-progress', (p) => {
    const progress: UpdateDownloadProgress = {
      percent: Math.round(p.percent * 10) / 10,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond
    }
    sendToMain('update-progress', progress)
  })

  autoUpdater.on('update-downloaded', (info) => {
    sendToMain('update-downloaded', { version: info.version })
  })

  autoUpdater.on('error', (e) => {
    sendToMain('update-error', { message: e.message })
  })
}

/** 下载更新包（打包模式下才可用；进度走 update-progress 事件推送） */
export async function downloadUpdate(): Promise<{ started: boolean; version?: string }> {
  if (!app.isPackaged) {
    throw new Error('开发模式下没有更新通道（app-update.yml 随安装包分发），请打包后使用。')
  }
  bindEvents()
  const result = await autoUpdater.checkForUpdates()
  const version = result?.updateInfo.version
  if (version && version === app.getVersion()) {
    return { started: false, version } // 已是最新，无需下载
  }
  await autoUpdater.downloadUpdate()
  return { started: true, version }
}

/** 退出并安装已下载的更新包 */
export function installUpdate(): void {
  autoUpdater.quitAndInstall()
}

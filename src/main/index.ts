import { app, BrowserWindow, Menu, Tray, nativeImage, nativeTheme, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from './services/config'
import { registerIpc } from './ipc'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

function iconPath(): string {
  // dev：项目根 resources/；打包后：进程 resources 目录
  const devPath = join(app.getAppPath(), 'resources', 'icon.png')
  return existsSync(devPath) ? devPath : join(process.resourcesPath ?? '', 'icon.png')
}

function applyTheme(): void {
  // nativeTheme.themeSource 会同步影响渲染进程的 prefers-color-scheme
  nativeTheme.themeSource = loadConfig().ui?.theme ?? 'system'
}

/** 关闭行为：closeToTray=true（默认）时点关闭 = 隐藏到托盘，托盘菜单退出才真退出 */
function shouldCloseToTray(): boolean {
  return loadConfig().ui?.closeToTray !== false
}

function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(iconPath()))
  tray.setToolTip('技能共享库管理')

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: () => {
          mainWindow?.show()
          mainWindow?.focus()
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
  // 左键单击显示窗口
  tray.on('click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 940,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: '技能共享库管理',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1117' : '#f1f5f9',
    webPreferences: {
      // electron-vite 的 preload 产物是 out/preload/index.js（实测确认，非 .mjs）
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  // 关闭 → 最小化到托盘（可在设置里改为直接退出）
  mainWindow.on('close', (e) => {
    if (!isQuitting && shouldCloseToTray()) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  // 外部链接一律交给系统浏览器，不在应用里开新窗
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(() => {
    applyTheme()
    registerIpc()
    createWindow()
    createTray()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('before-quit', () => {
  isQuitting = true
})

app.on('window-all-closed', () => {
  // 托盘模式下窗口只是 hide，不触发本事件；真关闭到 0 个窗口即退出
  if (process.platform !== 'darwin') app.quit()
})

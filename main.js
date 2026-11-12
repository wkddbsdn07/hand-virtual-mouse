const { app, BrowserWindow, protocol, session, ipcMain, globalShortcut, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const nativeMouse = require('./native-mouse');

// 다른 창에 가려져도 인식 루프가 멈추지 않도록 창 가림 감지를 끈다
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const PRELOAD = path.join(__dirname, 'preload.js');
const PAUSE_SHORTCUT = 'Control+Alt+M';
const LIP_SHORTCUT = 'Control+Alt+L';
const MAX_TYPE_LENGTH = 500;
// 손 제스처로 보낼 수 있는 키 조합 (가상 키 코드)
const KEY_SHORTCUTS = {
  copy: [0x11, 0x43], // Ctrl+C
  paste: [0x11, 0x56], // Ctrl+V
  snapLeft: [0x5b, 0x25], // Win+← (왼쪽 절반, 오른쪽엔 스냅 도우미)
  snapRight: [0x5b, 0x27], // Win+→
  maximize: [0x5b, 0x26], // Win+↑
  minimize: [0x5b, 0x28], // Win+↓ (최대화 → 원래 크기 → 최소화)
  desktop: [0x5b, 0x44], // Win+D (바탕화면 보기 / 다시 하면 복원)
};

let mainWin = null;
let overlayWin = null;
const mouseState = { active: false, paused: false, buttonDown: false, dragging: false };

// file:// 대신 커스텀 스킴으로 앱 파일을 제공한다.
// (ES 모듈 import, WASM fetch, getUserMedia 모두 보안 컨텍스트에서 문제없이 동작하도록)
const SCHEME = 'app';
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

function registerAppProtocol() {
  protocol.handle(SCHEME, async (request) => {
    const { pathname } = new URL(request.url);
    const filePath = path.normalize(path.join(ROOT, decodeURIComponent(pathname)));
    if (!filePath.startsWith(ROOT + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      const data = await fs.readFile(filePath);
      const type = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
      // 교차 출처 격리: Whisper(onnxruntime)가 여러 스레드(SharedArrayBuffer)로 돌 수 있게 한다
      return new Response(data, {
        headers: {
          'content-type': type,
          'cross-origin-opener-policy': 'same-origin',
          'cross-origin-embedder-policy': 'require-corp',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    title: '손 가상 마우스',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  mainWin.loadURL(`${SCHEME}://local/renderer/index.html`);
  mainWin.on('closed', () => {
    mainWin = null;
    mouseState.active = false;
    syncMouseControl();
    overlayWin?.destroy();
    nativeMouse.stop();
  });
}

// 주 모니터 전체를 덮는 투명·클릭 통과 창. 가상 포인터만 그린다.
function createOverlay() {
  const { bounds } = screen.getPrimaryDisplay();
  overlayWin = new BrowserWindow({
    ...bounds,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  overlayWin.setIgnoreMouseEvents(true);
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.loadURL(`${SCHEME}://local/renderer/overlay.html`);
  overlayWin.on('closed', () => {
    overlayWin = null;
  });
}

function isControlling() {
  return mouseState.active && !mouseState.paused;
}

function syncMouseControl() {
  if (isControlling()) {
    nativeMouse.start();
    if (!overlayWin) createOverlay();
    overlayWin.showInactive();
  } else {
    if (mouseState.buttonDown) setButton(false);
    overlayWin?.hide();
  }
  mainWin?.webContents.send('mouse:paused', mouseState.paused);
}

function setButton(down) {
  mouseState.buttonDown = down;
  nativeMouse.setButton(down);
}

function toPoint(value) {
  const clamp = (v) => Math.min(1, Math.max(0, Number(v) || 0));
  return { x: clamp(value?.x), y: clamp(value?.y) };
}

function registerMouseIpc() {
  // 마우스 명령은 메인 창에서 온 것만 받는다
  const fromMain = (e) => e.sender === mainWin?.webContents;
  const canControl = (e) => fromMain(e) && isControlling() && !mouseState.dragging;

  ipcMain.on('mouse:active', (e, active) => {
    if (!fromMain(e)) return;
    mouseState.active = Boolean(active);
    syncMouseControl();
  });
  ipcMain.on('mouse:frame', (e, frame) => {
    if (fromMain(e) && isControlling()) overlayWin?.webContents.send('mouse:frame', frame);
  });
  ipcMain.on('mouse:move', (e, x, y) => {
    if (canControl(e)) nativeMouse.move(toPoint({ x, y }));
  });
  ipcMain.on('mouse:button', (e, down) => {
    if (canControl(e)) setButton(Boolean(down));
  });
  ipcMain.on('mouse:wheel', (e, delta) => {
    const value = Math.max(-1200, Math.min(1200, Math.trunc(Number(delta) || 0)));
    if (canControl(e) && value) nativeMouse.wheel(value);
  });
  ipcMain.on('mouse:shortcut', (e, name) => {
    if (canControl(e) && Object.hasOwn(KEY_SHORTCUTS, name)) nativeMouse.pressKeys(KEY_SHORTCUTS[name]);
  });
  ipcMain.on('mouse:drag', async (e, from, to) => {
    if (!canControl(e)) return;
    mouseState.dragging = true;
    try {
      await nativeMouse.drag(toPoint(from), toPoint(to));
    } finally {
      mouseState.dragging = false;
    }
  });

  // 가상 마우스가 다른 창을 누르면 이 앱이 포커스를 잃으므로 전역 단축키로 켜고 끈다
  globalShortcut.register(PAUSE_SHORTCUT, () => {
    mouseState.paused = !mouseState.paused;
    syncMouseControl();
  });
}

// 입모양·음성 입력: 지금 앞에 있는 창에 글자를 입력한다
function registerTypingIpc() {
  const fromMain = (e) => e.sender === mainWin?.webContents;
  const validText = (text) => typeof text === 'string' && text.length > 0 && text.length <= MAX_TYPE_LENGTH;

  ipcMain.on('input:type', (e, text) => {
    if (fromMain(e) && validText(text)) nativeMouse.typeText(text);
  });
  ipcMain.on('input:replace', (e, backspaces, text) => {
    const count = Math.max(0, Math.min(MAX_TYPE_LENGTH, Math.trunc(Number(backspaces) || 0)));
    if (!fromMain(e) || !validText(text)) return;
    for (let i = 0; i < count; i++) nativeMouse.pressKeys([0x08]); // Backspace
    nativeMouse.typeText(text);
  });
  ipcMain.on('overlay:caption', (e, lines, durationMs) => {
    if (fromMain(e)) overlayWin?.webContents.send('overlay:caption', lines, durationMs);
  });

  globalShortcut.register(LIP_SHORTCUT, () => mainWin?.webContents.send('lip:toggle'));
}

app.whenReady().then(() => {
  registerAppProtocol();

  // 웹캠·마이크(media) 권한만 허용
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });

  registerMouseIpc();
  registerTypingIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  nativeMouse.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

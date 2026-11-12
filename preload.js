const { contextBridge, ipcRenderer } = require('electron');

// 메인 창(손 인식 → 마우스 명령)과 오버레이 창(포인터 그리기)이 함께 쓰는 브리지
contextBridge.exposeInMainWorld('mouseBridge', {
  setActive: (active) => ipcRenderer.send('mouse:active', active),
  move: (x, y) => ipcRenderer.send('mouse:move', x, y),
  setButton: (down) => ipcRenderer.send('mouse:button', down),
  drag: (from, to) => ipcRenderer.send('mouse:drag', from, to),
  scroll: (delta) => ipcRenderer.send('mouse:wheel', delta),
  shortcut: (name) => ipcRenderer.send('mouse:shortcut', name),
  sendFrame: (frame) => ipcRenderer.send('mouse:frame', frame),
  typeText: (text) => ipcRenderer.send('input:type', text),
  replaceText: (backspaces, text) => ipcRenderer.send('input:replace', backspaces, text),
  sendCaption: (lines, durationMs) => ipcRenderer.send('overlay:caption', lines, durationMs),
  onLipToggle: (callback) => ipcRenderer.on('lip:toggle', () => callback()),
  onCaption: (callback) => ipcRenderer.on('overlay:caption', (_e, lines, durationMs) => callback(lines, durationMs)),
  onPaused: (callback) => ipcRenderer.on('mouse:paused', (_e, paused) => callback(paused)),
  onFrame: (callback) => ipcRenderer.on('mouse:frame', (_e, frame) => callback(frame)),
});

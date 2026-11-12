const { spawn } = require('node:child_process');

// user32의 SetCursorPos / mouse_event 를 호출하는 상주 PowerShell 프로세스.
// 네이티브 모듈 빌드 없이 Windows 마우스를 제어하기 위해 쓴다.
// stdin으로 한 줄씩 명령을 받는다:
//   "move x y" (주 모니터 기준 0~1 좌표), "down", "up", "wheel delta",
//   "keys vk1 vk2 ..." (순서대로 누르고 역순으로 뗀다),
//   "text base64" (UTF-8 문자열을 유니코드 키 입력으로 그대로 친다. 한글 IME를 거치지 않는다)
const SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NativeMouse {
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public InputUnion u; }
  [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int size);

  public static void TypeText(string text) {
    var inputs = new INPUT[text.Length * 2];
    for (int i = 0; i < text.Length; i++) {
      inputs[2 * i].type = 1;
      inputs[2 * i].u.ki.wScan = text[i];
      inputs[2 * i].u.ki.dwFlags = 0x0004;
      inputs[2 * i + 1].type = 1;
      inputs[2 * i + 1].u.ki.wScan = text[i];
      inputs[2 * i + 1].u.ki.dwFlags = 0x0004 | 0x0002;
    }
    SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@
$inv = [Globalization.CultureInfo]::InvariantCulture
# 방향키·Win 키 등은 확장 키 플래그가 있어야 숫자패드 키로 오인되지 않는다
$extendedKeys = @(0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5C)
function KeyFlags($vk) { if ($extendedKeys -contains $vk) { 0x0001 } else { 0 } }
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $parts = $line.Split(' ')
  switch ($parts[0]) {
    'move' {
      # SetCursorPos는 커서만 순간이동시켜 작업표시줄 등 일부 UI가 반응하지 않으므로
      # 실제 마우스 이동 입력(MOVE | ABSOLUTE, 주 모니터 0~65535 좌표)을 보낸다
      $x = [int]([double]::Parse($parts[1], $inv) * 65535)
      $y = [int]([double]::Parse($parts[2], $inv) * 65535)
      [NativeMouse]::mouse_event(0x8001, $x, $y, 0, [UIntPtr]::Zero)
    }
    'down' { [NativeMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero) }
    'up' { [NativeMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero) }
    'wheel' { [NativeMouse]::mouse_event(0x0800, 0, 0, [int]$parts[1], [UIntPtr]::Zero) }
    'keys' {
      $vks = @($parts[1..($parts.Length - 1)] | ForEach-Object { [byte]$_ })
      foreach ($vk in $vks) { [NativeMouse]::keybd_event($vk, 0, (KeyFlags $vk), [UIntPtr]::Zero) }
      [array]::Reverse($vks)
      foreach ($vk in $vks) { [NativeMouse]::keybd_event($vk, 0, ((KeyFlags $vk) -bor 0x0002), [UIntPtr]::Zero) }
    }
    'text' { [NativeMouse]::TypeText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1]))) }
  }
}
`;

let proc = null;

function start() {
  if (proc || process.platform !== 'win32') return;
  proc = spawn(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
    { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true },
  );
  proc.stderr.on('data', (data) => console.error('[native-mouse]', data.toString()));
  proc.stdin.on('error', () => {});
  proc.on('exit', () => {
    proc = null;
  });
}

function stop() {
  proc?.stdin.end();
  proc = null;
}

function send(line) {
  start();
  proc?.stdin.write(line + '\n');
}

function wheel(delta) {
  send(`wheel ${Math.trunc(delta)}`);
}

function pressKeys(vks) {
  send(`keys ${vks.join(' ')}`);
}

function typeText(text) {
  send(`text ${Buffer.from(text, 'utf8').toString('base64')}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function move({ x, y }) {
  send(`move ${x.toFixed(5)} ${y.toFixed(5)}`);
}

function setButton(down) {
  send(down ? 'down' : 'up');
}

// 끌어서 선택이 인식되도록 중간 지점을 거쳐 천천히 드래그한다
async function drag(from, to, steps = 12) {
  move(from);
  await sleep(30);
  setButton(true);
  await sleep(30);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    move({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    await sleep(15);
  }
  setButton(false);
}

module.exports = { start, stop, move, setButton, drag, wheel, pressKeys, typeText };

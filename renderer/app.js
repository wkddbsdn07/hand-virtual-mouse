import { FilesetResolver } from '@mediapipe/tasks-vision';
import * as mouse from './modes/mouse.js';
import * as lip from './lip/lip.js';

const WASM_URL = new URL('../node_modules/@mediapipe/tasks-vision/wasm', location.href).href;

const canvas = document.getElementById('output');
const ctx = canvas.getContext('2d');
const infoEl = document.getElementById('info');
const fpsEl = document.getElementById('fps');
const statusEl = document.getElementById('status');

let lastFrameAt = 0;
let fps = 0;

function showStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
  statusEl.hidden = false;
}

function hideStatus() {
  statusEl.hidden = true;
}

async function openCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  return stream.getVideoTracks()[0];
}

// 화면에 그려지는 <video> 대신 카메라 트랙에서 프레임을 직접 읽는다.
// 그래서 창을 최소화하거나 다른 창으로 가려도 인식이 멈추거나 끊기지 않는다.
async function frameLoop(track) {
  const reader = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 }).readable.getReader();
  for (;;) {
    const { value: frame, done } = await reader.read();
    if (done) break;
    try {
      processFrame(frame);
    } catch (err) {
      console.error(err);
    } finally {
      frame.close();
    }
  }
}

function processFrame(frame) {
  const now = performance.now();
  if (lastFrameAt) fps = fps * 0.9 + (1000 / (now - lastFrameAt)) * 0.1;
  lastFrameAt = now;

  if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
    canvas.width = frame.displayWidth;
    canvas.height = frame.displayHeight;
  }

  // 셀카처럼 보이도록 좌우 반전된 좌표계에서 영상과 랜드마크를 그린다
  ctx.save();
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
  const result = mouse.detect(frame, now);
  infoEl.textContent = mouse.draw(ctx, result);
  lip.process(ctx, frame, now, result, canvas.width / canvas.height);
  ctx.restore();

  fpsEl.textContent = `${fps.toFixed(1)} FPS`;
}

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.key === 'c' || e.key === 'C') mouse.calibrate();
  if (e.key === 'l' || e.key === 'L') lip.toggle();
});

async function main() {
  let track;
  try {
    showStatus('웹캠 연결 중...');
    track = await openCamera();
  } catch (err) {
    console.error(`${err.name}: ${err.message}`);
    showStatus(`웹캠을 열 수 없습니다.\n${err.name}: ${err.message}`, true);
    return;
  }

  try {
    showStatus('손 인식 모델 불러오는 중...');
    const vision = await FilesetResolver.forVisionTasks(WASM_URL);
    await mouse.load(vision);
    lip.init(vision);
  } catch (err) {
    console.error(err);
    showStatus(`손 인식 모델을 불러오지 못했습니다.\n${err.message ?? err}`, true);
    return;
  }

  hideStatus();
  mouse.activate();
  frameLoop(track);
}

main();

// 마이크 녹음, 목소리 감지(VAD), Whisper 받아쓰기
const SAMPLE_RATE = 16000;
const CHUNK_MS = (512 / SAMPLE_RATE) * 1000;
const KEEP_MS = 30000;
// 주변 소음보다 이 배수 이상 크면 목소리로 본다
const VOICE_RATIO = 3;
const MIN_VOICE_RMS = 0.008;
const VOICE_HANGOVER_MS = 300;
export const LANGUAGE = 'korean';

let stream = null;
let context = null;
let chunks = []; // { t: 끝 시각, samples, voiced }
let noise = 0.005;
let lastVoiceAt = -Infinity;
let level = 0;

let worker = null;
let nextId = 0;
const pending = new Map();
let onStatus = () => {};

export function setStatusListener(listener) {
  onStatus = listener;
}

export async function start() {
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    video: false,
  });
  context = new AudioContext({ sampleRate: SAMPLE_RATE });
  await context.audioWorklet.addModule(new URL('./recorder-worklet.js', import.meta.url));
  const source = context.createMediaStreamSource(stream);
  const recorder = new AudioWorkletNode(context, 'recorder');
  recorder.port.onmessage = (e) => onChunk(e.data);
  source.connect(recorder);
  // 그래프 끝(스피커)에 연결해야 처리가 돈다. 워클릿은 출력에 아무것도 쓰지 않으므로 소리는 나지 않는다.
  recorder.connect(context.destination);
  await context.resume();
  loadWhisper();
}

export function stop() {
  stream?.getTracks().forEach((track) => track.stop());
  context?.close();
  stream = null;
  context = null;
  chunks = [];
  lastVoiceAt = -Infinity;
  level = 0;
}

function onChunk(samples) {
  const t = performance.now();
  let sum = 0;
  for (const s of samples) sum += s * s;
  const rms = Math.sqrt(sum / samples.length);
  const voiced = rms > Math.max(noise * VOICE_RATIO, MIN_VOICE_RMS);
  // 목소리가 없을 때만 주변 소음 수준을 천천히 따라간다
  if (!voiced) noise = noise * 0.98 + rms * 0.02;
  else lastVoiceAt = t;
  level = rms;

  chunks.push({ t, samples, voiced });
  while (chunks.length && chunks[0].t < t - KEEP_MS) chunks.shift();
}

export function isVoiceActive(now) {
  return now - lastVoiceAt < VOICE_HANGOVER_MS;
}

export function getLevel() {
  return Math.min(1, level / (Math.max(noise * VOICE_RATIO, MIN_VOICE_RMS) * 2));
}

export function voicedDuration(start, end) {
  return chunks.filter((c) => c.voiced && c.t > start && c.t - CHUNK_MS < end).length * CHUNK_MS;
}

export function getAudio(start, end) {
  const selected = chunks.filter((c) => c.t > start && c.t - CHUNK_MS < end);
  const audio = new Float32Array(selected.length * 512);
  selected.forEach((c, i) => audio.set(c.samples, i * 512));
  return audio;
}

function loadWhisper() {
  if (worker) return;
  worker = new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
  const progress = new Map();
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') {
      // 서버가 파일 크기를 알려주지 않으면 진행률이 없으므로 그때는 %를 빼고 표시한다
      if (Number.isFinite(data.progress)) progress.set(data.file, data.progress);
      const values = [...progress.values()];
      const percent = values.length ? ` ${(values.reduce((a, b) => a + b, 0) / values.length).toFixed(0)}%` : '';
      onStatus(`음성 인식 모델(약 240MB) 내려받는 중…${percent} (처음 한 번만)`);
    } else if (data.type === 'ready') {
      onStatus(null);
    } else if (data.type === 'result') {
      pending.get(data.id)?.resolve(data.text);
      pending.delete(data.id);
    } else if (data.type === 'error') {
      console.error('Whisper 오류', data.message);
      if (data.id === undefined) onStatus(`음성 인식 모델을 불러오지 못했습니다: ${data.message}`);
      pending.get(data.id)?.reject(new Error(data.message));
      pending.delete(data.id);
    }
  };
  worker.postMessage({ type: 'load' });
}

export function transcribe(audio) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ type: 'transcribe', id, audio, language: LANGUAGE }, [audio.buffer]);
  });
}

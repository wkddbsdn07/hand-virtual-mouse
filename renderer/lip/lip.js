// 입모양 입력: 소리 내어 말하면 받아쓰면서 그때의 입모양을 학습하고,
// 소리 없이 입만 움직이면 학습한 입모양으로 문장을 알아맞혀 입력한다.
import * as hands from '../modes/hands.js';
import * as features from './features.js';
import * as speech from './speech.js';
import * as recognizer from './recognizer.js';

// 말이 끝났다고 보는 조용한 시간
const END_SILENCE_MS = 700;
const MIN_UTTERANCE_MS = 350;
const MAX_UTTERANCE_MS = 8000;
// 소리 있는 말로 볼 최소 목소리 길이
const MIN_VOICED_MS = 250;
// 다른 사람 목소리나 영상 소리를 받아쓰지 않도록, 이만큼은 내 입이 움직여야 한다
const MIN_MOUTH_ACTIVE_MS = 200;
// 입모양 인식에 필요한 최소 학습 샘플 수
const MIN_SAMPLES = 3;
// 입력 후 이 시간 안에 ✌(2) 또는 손가락 3개를 들면 그 후보로 바꾼다
const CORRECTION_MS = 6000;
const CORRECTION_HOLD_MS = 500;
// 입 움직임 감지: 평소 움직임보다 이 배수 이상 크면 말하는 중으로 본다
const MOTION_RATIO = 2.5;
const MIN_MOTION = 0.008;

const bridge = window.mouseBridge;
const ui = {
  panel: document.getElementById('lip-panel'),
  state: document.getElementById('lip-state'),
  status: document.getElementById('lip-status'),
  mouth: document.querySelector('#lip-mouth > div'),
  voice: document.querySelector('#lip-voice > div'),
  last: document.getElementById('lip-last'),
  toggle: document.getElementById('lip-toggle'),
  undo: document.getElementById('lip-undo'),
  clear: document.getElementById('lip-clear'),
};

let vision = null;
let enabled = false;
let starting = false;
let frames = []; // { t, f }
let motion = 0;
let baseline = 0.01;
let mouthActiveUntil = -Infinity;
let mouthActiveMs = 0;
let lastFrameAt = 0;
let segment = null;
let queue = Promise.resolve();
let lastTyped = null; // { text, candidates, frames, until, choice, choiceSince }
let modelStatus = null;

export function init(visionFileset) {
  vision = visionFileset;
  bridge?.onLipToggle(toggle);
  ui.toggle.addEventListener('click', toggle);
  ui.undo.addEventListener('click', undoLast);
  ui.clear.addEventListener('click', clearAll);
  speech.setStatusListener((text) => {
    modelStatus = text;
    render();
  });
  render();
}

export async function toggle() {
  if (starting) return;
  if (enabled) {
    enabled = false;
    speech.stop();
    segment = null;
    frames = [];
    render();
    return;
  }
  starting = true;
  modelStatus = '준비 중…';
  render();
  try {
    await Promise.all([features.load(vision), recognizer.init(), speech.start()]);
    enabled = true;
    if (modelStatus === '준비 중…') modelStatus = null;
  } catch (err) {
    console.error(err);
    modelStatus = `시작하지 못했습니다: ${err.message ?? err}`;
  }
  starting = false;
  render();
}

// 매 카메라 프레임마다 호출된다. ctx는 좌우 반전된 상태.
export function process(ctx, frame, now, handResult, aspect) {
  if (!enabled) return;
  const { features: f, landmarks } = features.extract(frame, now, aspect);
  if (landmarks) features.drawLips(ctx, landmarks, isMouthActive(now) ? '#ff5252' : '#ffffff');

  updateMotion(f, now);
  frames.push({ t: now, f });
  while (frames.length && frames[0].t < now - MAX_UTTERANCE_MS - 2000) frames.shift();

  updateSegment(now);
  updateCorrection(handResult, now, aspect);
  ui.mouth.style.width = `${Math.min(100, (motion / Math.max(baseline * MOTION_RATIO, MIN_MOTION)) * 50)}%`;
  ui.voice.style.width = `${speech.getLevel() * 100}%`;
}

function updateMotion(f, now) {
  const prev = frames.at(-1)?.f;
  const dt = now - lastFrameAt;
  lastFrameAt = now;
  if (!f || !prev) return;
  let sum = 0;
  for (let i = 0; i < f.length; i++) sum += Math.abs(f[i] - prev[i]);
  motion = motion * 0.7 + (sum / f.length) * 0.3;
  if (motion > Math.max(baseline * MOTION_RATIO, MIN_MOTION)) {
    mouthActiveUntil = now + 250;
    if (segment) mouthActiveMs += dt;
  } else {
    // 가만히 있을 때의 입 움직임(떨림) 수준을 천천히 배운다
    baseline = baseline * 0.98 + motion * 0.02;
  }
}

function isMouthActive(now) {
  return now < mouthActiveUntil;
}

// 입이 움직이거나 목소리가 나면 말 시작, 둘 다 멈춘 채 잠시 지나면 말 끝
function updateSegment(now) {
  const active = isMouthActive(now) || speech.isVoiceActive(now);
  if (!segment) {
    if (active) {
      segment = { start: now - 200, lastActive: now };
      mouthActiveMs = 0;
    }
    return;
  }
  if (active) segment.lastActive = now;
  if (now - segment.lastActive > END_SILENCE_MS || now - segment.start > MAX_UTTERANCE_MS) {
    const { start, lastActive } = segment;
    segment = null;
    finishUtterance(start, lastActive + 200, mouthActiveMs);
  }
}

function finishUtterance(start, end, mouthMs) {
  if (end - start < MIN_UTTERANCE_MS || mouthMs < MIN_MOUTH_ACTIVE_MS) return;
  const selected = frames.filter((x) => x.t >= start && x.t <= end);
  const seen = selected.filter((x) => x.f).map((x) => x.f);
  // 얼굴이 대부분 보였던 경우만 쓴다
  if (seen.length < selected.length * 0.7) return;

  if (speech.voicedDuration(start, end) >= MIN_VOICED_MS) {
    const audio = speech.getAudio(start - 200, end + 200);
    enqueue(() => handleVoiced(audio, seen));
  } else {
    enqueue(() => handleSilent(seen));
  }
}

// 결과가 말한 순서대로 입력되도록 차례로 처리한다
function enqueue(task) {
  queue = queue.then(task).catch((err) => console.error(err));
}

async function handleVoiced(audio, lipFrames) {
  showLast('🎤 받아쓰는 중…');
  const text = cleanTranscript(await speech.transcribe(audio));
  if (!text) {
    showLast('🎤 (알아듣지 못함)');
    return;
  }
  type(text);
  await recognizer.add(text, lipFrames, 'voice');
  lastTyped = null;
  showLast(`🎤 ${text}  — 입모양 학습됨`);
  render();
}

async function handleSilent(lipFrames) {
  if (recognizer.stats().samples < MIN_SAMPLES) {
    showLast('👄 아직 학습된 입모양이 부족합니다. 먼저 소리 내어 말해 주세요.');
    return;
  }
  const candidates = recognizer.recognize(lipFrames).slice(0, 3);
  if (!candidates.length) {
    showLast('👄 모르는 입모양입니다. 소리 내어 한 번 말해 주면 배웁니다.');
    return;
  }
  const text = candidates[0].text;
  type(text);
  lastTyped = { text, candidates, frames: lipFrames, until: performance.now() + CORRECTION_MS, choice: null };
  const others = candidates.slice(1).map((c, i) => `${i === 0 ? '✌' : '🤟'} ${c.text}`);
  showLast(`👄 ${text}${others.length ? `   (틀렸으면 ${others.join(' / ')})` : ''}`);
  bridge?.sendCaption(
    [`👄 ${text}`, ...candidates.slice(1).map((c, i) => `${i === 0 ? '✌ 손가락 2개' : '🤟 손가락 3개'} → ${c.text}`)],
    CORRECTION_MS,
  );
}

// 손가락 2개(검지·중지) 또는 3개(검지·중지·약지)를 잠깐 들고 있으면 해당 후보로 바꾸고, 그 입모양을 다시 학습한다
function updateCorrection(handResult, now, aspect) {
  if (!lastTyped || now > lastTyped.until) return;
  let choice = null;
  for (const landmarks of handResult.landmarks) {
    const [index, middle, ring, pinky] = hands.fingerStates(landmarks, aspect);
    const up = (f) => f === 'extended';
    if (up(index) && up(middle) && up(ring) && !up(pinky)) choice = 2;
    else if (up(index) && up(middle) && !up(ring) && !up(pinky)) choice = 1;
  }
  if (choice !== lastTyped.choice) {
    lastTyped.choice = choice;
    lastTyped.choiceSince = now;
    return;
  }
  const candidate = choice && lastTyped.candidates[choice];
  if (!candidate || now - lastTyped.choiceSince < CORRECTION_HOLD_MS) return;

  const { text: wrong, frames: lipFrames } = lastTyped;
  bridge?.replaceText(wrong.length + 1, `${candidate.text} `);
  lastTyped = null;
  enqueue(() => recognizer.add(candidate.text, lipFrames, 'correction'));
  showLast(`👄 ${candidate.text}  — 고쳐서 다시 학습함`);
  bridge?.sendCaption([`✔ ${candidate.text}`], 1500);
  render();
}

function type(text) {
  bridge?.typeText(`${text} `);
}

// Whisper가 소리가 없거나 짧을 때 흔히 지어내는 문구는 버린다
const HALLUCINATIONS = /시청해\s*주셔서|구독|좋아요와|자막|MBC|KBS|SBS|다음 영상|♪/;
function cleanTranscript(text) {
  const cleaned = text.replace(/\[[^\]]*\]|\([^)]*\)/g, '').trim();
  if (!cleaned || HALLUCINATIONS.test(cleaned)) return '';
  return cleaned;
}

async function undoLast() {
  await recognizer.init();
  const text = await recognizer.removeLast();
  showLast(text ? `마지막 학습 취소: ${text}` : '취소할 학습이 없습니다');
  render();
}

async function clearAll() {
  if (!confirm('학습한 입모양을 모두 지울까요? 되돌릴 수 없습니다.')) return;
  await recognizer.init();
  await recognizer.clear();
  showLast('학습 내용을 모두 지웠습니다');
  render();
}

function showLast(text) {
  ui.last.textContent = text;
}

function render() {
  ui.state.textContent = enabled ? '켜짐' : '꺼짐';
  ui.panel.classList.toggle('on', enabled);
  ui.toggle.textContent = enabled ? '끄기' : '켜기';
  let status = modelStatus;
  if (!status && enabled) {
    const { samples, phrases } = recognizer.stats();
    status = `학습한 문장 ${phrases}개 (샘플 ${samples}개) · 소리 내어 말하면 학습, 입만 움직이면 입모양으로 입력`;
  }
  ui.status.textContent = status ?? 'L 키 또는 Ctrl+Alt+L 로 켜기';
}

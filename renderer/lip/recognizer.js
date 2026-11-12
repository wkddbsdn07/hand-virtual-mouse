// 사용자의 "문장 ↔ 입모양" 샘플을 저장하고, 소리 없는 입모양을 가장 닮은 문장으로 알아맞힌다.
// 샘플은 이 컴퓨터의 IndexedDB에만 저장된다.
import { FEATURE_SIZE } from './features.js';

const DB_NAME = 'lip-reading';
const STORE = 'samples';
// 시간 축을 이만큼 줄여서 비교한다 (30fps → 15fps)
const DOWNSAMPLE = 2;
// 길이가 이 배수 이상 차이 나는 샘플과는 비교하지 않는다
const MAX_LENGTH_RATIO = 2.2;
// 같은 문장끼리의 평소 거리보다 이 배수 이상 멀면 "모르는 입모양"으로 본다
const REJECT_RATIO = 2;
// 같은 문장 샘플은 최근 것 몇 개만 비교에 쓴다
const MAX_SAMPLES_PER_TEXT = 8;

let db = null;
let samples = []; // { id, text, key, frames, length, source, createdAt, prepared }
let mean = null;
let std = null;
let typicalDistance = null;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function run(mode, action) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = action(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
  });
}

export async function init() {
  if (db) return;
  db = await openDb();
  samples = (await run('readonly', (store) => store.getAll())).map(withKey);
  rebuild();
}

// 띄어쓰기·문장부호가 달라도 같은 문장으로 묶는다
export function textKey(text) {
  return text.replace(/[\s.,!?~…'"·]/g, '').toLowerCase();
}

function withKey(sample) {
  return { ...sample, key: textKey(sample.text) };
}

export async function add(text, frames, source) {
  const sample = { text, frames: packFrames(frames), length: frames.length, source, createdAt: Date.now() };
  sample.id = await run('readwrite', (store) => store.add(sample));
  samples.push(withKey(sample));
  rebuild();
  return sample.id;
}

export async function removeLast() {
  const last = samples.at(-1);
  if (!last) return null;
  await run('readwrite', (store) => store.delete(last.id));
  samples.pop();
  rebuild();
  return last.text;
}

export async function clear() {
  await run('readwrite', (store) => store.clear());
  samples = [];
  rebuild();
}

export function stats() {
  return { samples: samples.length, phrases: new Set(samples.map((s) => s.key)).size };
}

function packFrames(frames) {
  const packed = new Float32Array(frames.length * FEATURE_SIZE);
  frames.forEach((f, i) => packed.set(f, i * FEATURE_SIZE));
  return packed;
}

// 특징마다 평균·표준편차로 정규화하고, 시간 축을 줄인 뒤 변화량(속도)을 덧붙인다
function prepare(packed, length) {
  const n = Math.floor(length / DOWNSAMPLE);
  const dim = FEATURE_SIZE * 2;
  const out = new Float32Array(n * dim);
  for (let i = 0; i < n; i++) {
    for (let d = 0; d < FEATURE_SIZE; d++) {
      let sum = 0;
      for (let k = 0; k < DOWNSAMPLE; k++) sum += packed[(i * DOWNSAMPLE + k) * FEATURE_SIZE + d];
      out[i * dim + d] = (sum / DOWNSAMPLE - mean[d]) / std[d];
    }
  }
  for (let i = 0; i < n; i++) {
    for (let d = 0; d < FEATURE_SIZE; d++) {
      const prev = out[Math.max(0, i - 1) * dim + d];
      const next = out[Math.min(n - 1, i + 1) * dim + d];
      out[i * dim + FEATURE_SIZE + d] = (next - prev) / 2;
    }
  }
  return { data: out, length: n, dim };
}

function rebuild() {
  if (!samples.length) {
    mean = std = typicalDistance = null;
    return;
  }
  mean = new Float32Array(FEATURE_SIZE);
  std = new Float32Array(FEATURE_SIZE);
  let count = 0;
  for (const s of samples) {
    for (let i = 0; i < s.length; i++) {
      for (let d = 0; d < FEATURE_SIZE; d++) mean[d] += s.frames[i * FEATURE_SIZE + d];
    }
    count += s.length;
  }
  mean.forEach((v, d) => (mean[d] = v / count));
  for (const s of samples) {
    for (let i = 0; i < s.length; i++) {
      for (let d = 0; d < FEATURE_SIZE; d++) std[d] += (s.frames[i * FEATURE_SIZE + d] - mean[d]) ** 2;
    }
  }
  std.forEach((v, d) => (std[d] = Math.max(Math.sqrt(v / count), 0.02)));

  for (const s of samples) s.prepared = prepare(s.frames, s.length);
  typicalDistance = estimateTypicalDistance();
}

// 같은 문장 샘플끼리 가장 가까운 거리들의 중앙값 = "같은 말이면 보통 이 정도로 닮는다"
function estimateTypicalDistance() {
  const distances = [];
  for (const group of groupByKey(samples).values()) {
    for (const a of group) {
      let best = Infinity;
      for (const b of group) if (a !== b) best = Math.min(best, dtw(a.prepared, b.prepared));
      if (Number.isFinite(best)) distances.push(best);
    }
  }
  if (!distances.length) return null;
  distances.sort((a, b) => a - b);
  return distances[Math.floor(distances.length / 2)];
}

function groupByKey(list) {
  const groups = new Map();
  for (const s of list) {
    if (!groups.has(s.key)) groups.set(s.key, []);
    groups.get(s.key).push(s);
  }
  for (const [key, group] of groups) groups.set(key, group.slice(-MAX_SAMPLES_PER_TEXT));
  return groups;
}

// 입모양 시퀀스와 가장 닮은 문장 후보를 거리순으로 돌려준다 (모르는 입모양이면 빈 배열)
export function recognize(frames) {
  if (!samples.length || frames.length < DOWNSAMPLE * 4) return [];
  const query = prepare(packFrames(frames), frames.length);
  const candidates = [];
  for (const group of groupByKey(samples).values()) {
    let best = Infinity;
    for (const s of group) {
      const ratio = Math.max(query.length, s.prepared.length) / Math.min(query.length, s.prepared.length);
      if (ratio <= MAX_LENGTH_RATIO) best = Math.min(best, dtw(query, s.prepared));
    }
    if (!Number.isFinite(best)) continue;
    // 자주 쓴 문장일수록 조금 더 우선한다 (사용자의 말버릇을 맥락으로 활용)
    const score = best / (1 + 0.1 * Math.log1p(group.length));
    candidates.push({ text: group.at(-1).text, score, distance: best });
  }
  candidates.sort((a, b) => a.score - b.score);
  if (candidates.length && typicalDistance && candidates[0].distance > typicalDistance * REJECT_RATIO) return [];
  return candidates;
}

// 동적 시간 정렬(DTW): 같은 말을 빠르거나 느리게 해도 입모양 흐름이 닮았으면 거리가 가깝게 나온다
function dtw(a, b) {
  const n = a.length;
  const m = b.length;
  const dim = a.dim;
  const band = Math.max(Math.ceil(Math.max(n, m) * 0.3), Math.abs(n - m) + 2);
  let prev = new Float32Array(m + 1).fill(Infinity);
  let cur = new Float32Array(m + 1);
  prev[0] = 0;
  for (let i = 1; i <= n; i++) {
    cur.fill(Infinity);
    const from = Math.max(1, i - band);
    const to = Math.min(m, i + band);
    for (let j = from; j <= to; j++) {
      let cost = 0;
      const ai = (i - 1) * dim;
      const bj = (j - 1) * dim;
      for (let d = 0; d < dim; d++) {
        const diff = a.data[ai + d] - b.data[bj + d];
        cost += diff * diff;
      }
      cur[j] = Math.sqrt(cost) + Math.min(prev[j], cur[j - 1], prev[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[m] / (n + m);
}

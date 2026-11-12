// MediaPipe 모델 파일(.task)을 models/ 폴더에 내려받는다. 이미 있으면 건너뛴다.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODELS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'models');

const MODELS = {
  'hand_landmarker.task':
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  'face_landmarker.task':
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
};

await mkdir(MODELS_DIR, { recursive: true });

for (const [file, url] of Object.entries(MODELS)) {
  const dest = path.join(MODELS_DIR, file);
  if (existsSync(dest)) {
    console.log(`[models] ${file} 이미 있음`);
    continue;
  }
  console.log(`[models] ${file} 다운로드 중...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${file} 다운로드 실패: HTTP ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

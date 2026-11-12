import { FaceLandmarker, DrawingUtils } from '@mediapipe/tasks-vision';

const MODEL_URL = new URL('../../models/face_landmarker.task', import.meta.url).href;

// 입·턱 모양과 관련된 블렌드셰이프만 쓴다 (0~1, 얼굴 방향·크기에 대해 이미 정규화돼 있음)
const BLENDSHAPES = [
  'jawOpen', 'jawForward', 'jawLeft', 'jawRight',
  'mouthClose', 'mouthFunnel', 'mouthPucker', 'mouthLeft', 'mouthRight',
  'mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight',
  'mouthDimpleLeft', 'mouthDimpleRight', 'mouthStretchLeft', 'mouthStretchRight',
  'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper',
  'mouthPressLeft', 'mouthPressRight', 'mouthLowerDownLeft', 'mouthLowerDownRight',
  'mouthUpperUpLeft', 'mouthUpperUpRight', 'cheekPuff',
];
// 블렌드셰이프 + 입술 안쪽 벌어짐 + 바깥 입술 높이 + 입 너비
export const FEATURE_SIZE = BLENDSHAPES.length + 3;

let landmarker = null;
let drawer = null;

export async function load(vision) {
  if (landmarker) return;
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
  });
  try {
    landmarker = await FaceLandmarker.createFromOptions(vision, options('GPU'));
  } catch (err) {
    console.warn('얼굴 인식 GPU 초기화 실패, CPU로 재시도', err);
    landmarker = await FaceLandmarker.createFromOptions(vision, options('CPU'));
  }
}

// 한 프레임의 입 모양 특징 벡터를 뽑는다. 얼굴이 안 보이면 features는 null
export function extract(frame, timestamp, aspect) {
  const result = landmarker.detectForVideo(frame, timestamp);
  const landmarks = result.faceLandmarks[0];
  const shapes = result.faceBlendshapes[0]?.categories;
  if (!landmarks || !shapes) return { features: null, landmarks: null };

  const scores = new Map(shapes.map((c) => [c.categoryName, c.score]));
  const distance = (a, b) => Math.hypot((landmarks[a].x - landmarks[b].x) * aspect, landmarks[a].y - landmarks[b].y);
  // 눈 사이 거리로 나눠 카메라와의 거리에 상관없게 만든다
  const eyes = distance(33, 263);

  const features = new Float32Array(FEATURE_SIZE);
  BLENDSHAPES.forEach((name, i) => {
    features[i] = scores.get(name) ?? 0;
  });
  const k = BLENDSHAPES.length;
  features[k] = distance(13, 14) / eyes;
  features[k + 1] = distance(0, 17) / eyes;
  features[k + 2] = distance(61, 291) / eyes;
  return { features, landmarks };
}

export function drawLips(ctx, landmarks, color) {
  drawer ??= new DrawingUtils(ctx);
  drawer.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_LIPS, { color, lineWidth: 2 });
}

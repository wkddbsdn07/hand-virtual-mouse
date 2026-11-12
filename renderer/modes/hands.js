import { HandLandmarker, DrawingUtils } from '@mediapipe/tasks-vision';

const MODEL_URL = new URL('../../models/hand_landmarker.task', import.meta.url).href;
export const HAND_COLORS = { 왼손: '#4fc3f7', 오른손: '#ffb74d' };

// 손가락별 랜드마크 인덱스 (MCP → 끝마디). 손바닥은 손(좌/우) 색으로 그린다.
const chain = (joints) => joints.slice(1).map((end, i) => ({ start: joints[i], end }));
const FINGERS = [
  { name: '엄지', color: '#ff5252', joints: [1, 2, 3, 4] },
  { name: '검지', color: '#ffeb3b', joints: [5, 6, 7, 8] },
  { name: '중지', color: '#69f0ae', joints: [9, 10, 11, 12] },
  { name: '약지', color: '#448aff', joints: [13, 14, 15, 16] },
  { name: '소지', color: '#e040fb', joints: [17, 18, 19, 20] },
].map((finger) => ({ ...finger, connections: chain(finger.joints) }));
const PALM_CONNECTIONS = [[0, 1], [0, 5], [5, 9], [9, 13], [13, 17], [0, 17]]
  .map(([start, end]) => ({ start, end }));

let landmarker = null;
let drawer = null;

export async function load(vision) {
  if (landmarker) return;
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    landmarker = await HandLandmarker.createFromOptions(vision, options('GPU'));
  } catch (err) {
    console.warn('GPU 초기화 실패, CPU로 재시도', err);
    landmarker = await HandLandmarker.createFromOptions(vision, options('CPU'));
  }
}

export function detect(video, timestamp) {
  return landmarker.detectForVideo(video, timestamp);
}

// ctx는 좌우 반전된 상태로 전달된다. HUD에 표시할 문자열을 반환한다.
export function draw(ctx, result) {
  drawer ??= new DrawingUtils(ctx);
  const { width, height } = ctx.canvas;
  const labels = [];

  result.landmarks.forEach((landmarks, i) => {
    const label = getHandLabel(result, i);
    const color = HAND_COLORS[label];
    labels.push(label);

    drawer.drawConnectors(landmarks, PALM_CONNECTIONS, { color, lineWidth: 4 });
    for (const finger of FINGERS) {
      drawer.drawConnectors(landmarks, finger.connections, { color: finger.color, lineWidth: 4 });
      drawer.drawLandmarks(finger.joints.map((j) => landmarks[j]), {
        color: '#ffffff', fillColor: finger.color, lineWidth: 1, radius: 4,
      });
    }
    drawer.drawLandmarks([landmarks[0]], { color: '#ffffff', fillColor: color, lineWidth: 1, radius: 4 });

    const wrist = landmarks[0];
    drawLabel(ctx, label, wrist.x * width, wrist.y * height + 30, color);
  });

  return labels.length ? `감지된 손: ${labels.join(', ')}` : '손이 보이지 않습니다';
}

// 엄지를 뺀 네 손가락(검지·중지·약지·소지)마다 'extended'(펴짐) | 'folded'(접힘) | null(애매함)
const FINGER_JOINTS = [[5, 6, 8], [9, 10, 12], [13, 14, 16], [17, 18, 20]]; // [뿌리, 둘째 마디, 끝]
export function fingerStates(landmarks, aspect) {
  const wrist = landmarks[0];
  const distance = (a, b) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);
  return FINGER_JOINTS.map(([base, middle, tip]) => {
    const tipDistance = distance(wrist, landmarks[tip]);
    if (tipDistance < distance(wrist, landmarks[base]) * 1.1) return 'folded';
    if (tipDistance > distance(wrist, landmarks[middle]) * 1.15) return 'extended';
    return null;
  });
}

export function getHandLabel(result, i) {
  // MediaPipe는 입력이 이미 좌우 반전된(셀카) 영상이라고 가정하므로,
  // 반전하지 않은 웹캠 원본에서는 좌/우 라벨이 반대로 나온다.
  const raw = result.handedness[i]?.[0]?.categoryName;
  return raw === 'Left' ? '오른손' : '왼손';
}

// 반전된 좌표계 안에서 글자만 정방향으로 그린다
function drawLabel(ctx, text, x, y, color) {
  ctx.save();
  ctx.scale(-1, 1);
  ctx.font = 'bold 22px "Segoe UI", "Malgun Gothic", sans-serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.strokeText(text, -x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, -x, y);
  ctx.restore();
}

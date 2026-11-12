import * as hands from './hands.js';

export { load, detect } from './hands.js';

// 카메라 화면(셀카 기준 정규화 좌표)에서 손바닥 중심이 이 영역 안을 움직이면 모니터 전체에 대응된다.
// 손을 높이 들지 않아도 되도록 기본 위치를 화면 아래쪽에 두고, C 키로 현재 손 위치에 맞춰 옮길 수 있다.
const AREA_SIZE = { width: 0.5, height: 0.4 };
const DEFAULT_AREA_CENTER = { x: 0.5, y: 0.65 };
const AREA_STORAGE_KEY = 'mouse.areaCenter';
// 엄지 끝–각 손가락 끝 거리 / 손바닥 길이(손목–중지 뿌리). 히스테리시스로 떨림 방지
const PINCH_ON = 0.25;
const PINCH_OFF = 0.4;
// 엄지가 다른 손가락을 스쳐 지나가며 잘못 인식되지 않도록 이 시간 동안 유지돼야 인정한다
const PINCH_CONFIRM_MS = 70;
// 꼬집는 동작 중에도 손이 조금 흔들리므로, 이만큼 이전 위치를 클릭 지점으로 쓴다
const LOOKBACK_MS = 200;
// 이보다 짧게 꼬집었다 떼면 클릭, 더 오래 쥐고 있으면 드래그
const CLICK_MS = 180;
// 복사/붙여넣기는 실수로 실행되지 않도록 이만큼 쥐고 있어야 실행된다
const SHORTCUT_HOLD_MS = 300;
// 손을 화면 높이만큼 움직였을 때의 휠 양(120 = 휠 한 칸). 음수로 바꾸면 스크롤 방향이 반대가 된다
const SCROLL_SPEED = 3000;
// 손이 이 시간보다 짧게 사라졌다 나타나면 같은 손으로 이어서 추적한다
const LOST_MS = 300;
// 손 모양(주먹/편 손) 판정이 이 시간 동안 유지돼야 인정한다
const POSE_CONFIRM_MS = 120;
// 창 잡아 밀기: 주먹을 쥔 채 손바닥 길이의 이 배수만큼 움직이면 그 방향으로 창을 보낸다
const THROW_DISTANCE = 1.8;
// 커튼 열기/닫기: 이 시간 안에 두 손 간격이 손바닥 길이의 CURTAIN_DISTANCE배 이상 변하고,
// 각 손도 CURTAIN_EACH배 이상 움직여야 한다 (한 손만 움직인 경우는 무시)
const CURTAIN_WINDOW_MS = 1000;
const CURTAIN_DISTANCE = 2.5;
const CURTAIN_EACH = 0.8;
// 창 제스처가 연달아 실행되지 않도록 쉬는 시간
const WINDOW_GESTURE_COOLDOWN_MS = 1200;

const THROWS = {
  left: { shortcut: 'snapLeft', label: '◀ 왼쪽 절반' },
  right: { shortcut: 'snapRight', label: '오른쪽 절반 ▶' },
  up: { shortcut: 'maximize', label: '▲ 최대화' },
  down: { shortcut: 'minimize', label: '▼ 작게' },
};

// 엄지와 맞닿는 손가락 → 동작
const GESTURES = {
  index: { tip: 8, label: '클릭' },
  middle: { tip: 12, label: '스크롤' },
  ring: { tip: 16, label: '복사', shortcut: 'copy' },
  pinky: { tip: 20, label: '붙여넣기', shortcut: 'paste' },
};
// 손가락을 굽혀도 거의 움직이지 않는 손바닥 랜드마크(손목, 각 손가락 뿌리)
const PALM = [0, 5, 9, 13, 17];

const bridge = window.mouseBridge;

const handStates = new Map(); // 라벨 → { fx, fy, x, y, history, gesture, pinched, seenAt, ... }
let state = { type: 'idle' };
let lastMove = null;
let paused = false;
let area = makeArea(loadAreaCenter());
let notice = null; // { text, until }
let toast = null; // 오버레이 가운데에 잠깐 띄우는 창 제스처 이름 { text, until }
let curtainHistory = [];
let cooldownUntil = 0;

bridge?.onPaused((value) => {
  paused = value;
  reset();
});

export function activate() {
  reset();
  bridge?.setActive(true);
}

// 지금 보이는 손(오른손 우선)의 위치가 모니터 한가운데가 되도록 인식 영역을 옮긴다
export function calibrate() {
  const now = performance.now();
  const hand = getHand('오른손', now) ?? getHand('왼손', now);
  if (!hand) {
    notice = { text: '손이 보이지 않아 위치를 맞추지 못했습니다', until: now + 2000 };
    return;
  }
  const center = { x: hand.rawX, y: hand.rawY };
  area = makeArea(center);
  try {
    localStorage.setItem(AREA_STORAGE_KEY, JSON.stringify(center));
  } catch {}
  reset();
  notice = { text: '지금 손 위치를 화면 중앙으로 맞췄습니다', until: now + 2000 };
}

function loadAreaCenter() {
  try {
    const saved = JSON.parse(localStorage.getItem(AREA_STORAGE_KEY));
    if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) return saved;
  } catch {}
  return DEFAULT_AREA_CENTER;
}

// 영역이 카메라 화면 밖으로 나가지 않게 중심을 제한한다
function makeArea(center) {
  const halfW = AREA_SIZE.width / 2;
  const halfH = AREA_SIZE.height / 2;
  const x = Math.min(1 - halfW, Math.max(halfW, center.x));
  const y = Math.min(1 - halfH, Math.max(halfH, center.y));
  return { left: x - halfW, right: x + halfW, top: y - halfH, bottom: y + halfH };
}

function reset() {
  handStates.clear();
  state = { type: 'idle' };
  lastMove = null;
}

// ctx는 좌우 반전된 상태로 전달된다. HUD에 표시할 문자열을 반환한다.
export function draw(ctx, result) {
  const { width, height } = ctx.canvas;
  hands.draw(ctx, result);
  drawActiveArea(ctx, width, height);

  if (!bridge) return '마우스 제어를 사용할 수 없습니다';
  if (paused) return '일시정지됨 — Ctrl+Alt+M 으로 재개';

  const now = performance.now();
  updateHands(result, now, width / height);
  step(now);
  sendFrame(now);
  if (notice && now < notice.until) return notice.text;
  return `${STATE_TEXT[state.type]} · C 위치 맞추기 · Ctrl+Alt+M 일시정지`;
}

const STATE_TEXT = {
  idle: '이동 중',
  pending: '꼬집기',
  drag: '드래그 중',
  rect: '사각형 선택 중',
  scroll: '스크롤 중',
  shortcut: '복사/붙여넣기',
  grab: '창 잡는 중 — 원하는 방향으로 미세요',
  waitRelease: '손을 펴세요',
};

function updateHands(result, now, aspect) {
  const seen = new Set();
  result.landmarks.forEach((landmarks, i) => {
    const label = hands.getHandLabel(result, i);
    if (seen.has(label)) return;
    seen.add(label);

    let s = handStates.get(label);
    if (!s || now - s.seenAt > LOST_MS) {
      s = { fx: new OneEuroFilter(), fy: new OneEuroFilter(), history: [], gesture: null, candidate: null };
      handStates.set(label, s);
    }
    s.seenAt = now;

    s.rawX = 1 - average(PALM.map((j) => landmarks[j].x));
    s.rawY = average(PALM.map((j) => landmarks[j].y));
    s.x = s.fx.filter(toUnit(s.rawX, area.left, area.right), now / 1000);
    s.y = s.fy.filter(toUnit(s.rawY, area.top, area.bottom), now / 1000);
    s.history.push({ t: now, x: s.x, y: s.y });
    while (s.history[0].t < now - 1000) s.history.shift();

    // 손 크기 기준으로 움직임을 재기 위한 값 (카메라와의 거리에 상관없이 같은 동작이 같은 크기가 된다)
    s.palm = distance(landmarks[0], landmarks[9], aspect);
    s.ux = s.rawX * aspect;

    s.fingers = hands.fingerStates(landmarks, aspect);
    s.rawPose = detectPose(s.fingers);
    if (s.rawPose !== s.poseCandidate) {
      s.poseCandidate = s.rawPose;
      s.poseSince = now;
    }
    if (now - s.poseSince >= POSE_CONFIRM_MS) s.pose = s.rawPose;

    updateGesture(s, landmarks, aspect, now);
    s.pinched = s.gesture === 'index';
  });
}

// 네 손가락이 모두 접혔으면 주먹, 모두 펴졌으면 편 손
function detectPose(fingers) {
  if (fingers.every((f) => f === 'folded')) return 'fist';
  if (fingers.every((f) => f === 'extended')) return 'open';
  return null;
}

function updateGesture(s, landmarks, aspect, now) {
  // 주먹을 쥘 때 엄지가 검지에 닿아도 클릭으로 인식하지 않는다
  if (s.rawPose === 'fist') {
    s.gesture = null;
    s.candidate = null;
    return;
  }
  const ratio = (key) => distance(landmarks[4], landmarks[GESTURES[key].tip], aspect) / s.palm;

  if (s.gesture) {
    if (ratio(s.gesture) < PINCH_OFF) return;
    s.gesture = null;
  }

  // 엄지에 가장 가까운 손가락이 일정 시간 유지되면 그 손가락의 꼬집기로 인정
  // 완전히 접힌 손가락은 꼬집기 대상에서 뺀다 (✌ 처럼 엄지로 약지·소지를 누르고 있는 경우)
  let closest = null;
  let best = PINCH_ON;
  Object.keys(GESTURES).forEach((key, i) => {
    if (s.fingers[i] === 'folded') return;
    const r = ratio(key);
    if (r < best) {
      best = r;
      closest = key;
    }
  });
  if (closest !== s.candidate) {
    s.candidate = closest;
    s.candidateSince = now;
  }
  if (closest && now - s.candidateSince >= PINCH_CONFIRM_MS) s.gesture = closest;
}

function getHand(label, now) {
  const s = handStates.get(label);
  return s && now - s.seenAt <= LOST_MS ? s : null;
}

// 엄지+검지: 짧게 → 클릭, 길게 → 드래그, 두 손 모두 → 놓을 때 사각형 드래그
// 엄지+중지: 쥔 채로 손을 위아래로 움직이면 스크롤 (페이지를 잡아 끄는 방향)
// 엄지+약지 / 엄지+소지: 잠깐 쥐고 있으면 Ctrl+C / Ctrl+V
// 주먹 쥐고 밀기: 지금 창을 왼쪽 절반 / 오른쪽 절반 / 최대화 / 작게
// 편 두 손 벌리기 / 모으기: 커튼을 열듯 화면 분할 / 커튼을 닫듯 바탕화면 보기
function step(now) {
  const left = getHand('왼손', now);
  const right = getHand('오른손', now);
  const present = [['왼손', left], ['오른손', right]].filter(([, s]) => s);
  const pinched = present.filter(([, s]) => s.pinched).map(([label]) => label);
  if (state.type !== 'idle') curtainHistory = [];

  switch (state.type) {
    case 'idle': {
      const gestured = present.find(([, s]) => s.gesture && !s.pinched);
      const fist = present.find(([, s]) => s.pose === 'fist');
      if (pinched.length === 2) {
        state = { type: 'rect' };
        step(now);
      } else if (pinched.length === 1) {
        const label = pinched[0];
        const hand = getHand(label, now);
        const anchor = positionAt(hand, now - LOOKBACK_MS);
        const offset = { x: anchor.x - hand.x, y: anchor.y - hand.y };
        state = { type: 'pending', label, since: now, anchor, offset };
        moveTo(anchor);
      } else if (gestured) {
        const [label, hand] = gestured;
        const at = lastMove ?? { x: hand.x, y: hand.y };
        state = hand.gesture === 'middle'
          ? { type: 'scroll', label, at, lastY: hand.y, wheel: 0 }
          : { type: 'shortcut', label, at, gesture: hand.gesture, since: now, fired: false };
      } else if (fist) {
        const [label, hand] = fist;
        const at = lastMove ?? { x: hand.x, y: hand.y };
        state = { type: 'grab', label, at, startX: hand.ux, startY: hand.rawY };
      } else if (!checkCurtain(now, left, right)) {
        const primary = right ?? left;
        if (primary) moveTo(primary);
      }
      break;
    }
    case 'pending': {
      // 클릭 판정 동안은 포인터를 고정해 둔다
      const hand = getHand(state.label, now);
      if (pinched.length === 2) {
        state = { type: 'rect' };
        step(now);
      } else if (!hand || hand.rawPose === 'fist') {
        // 꼬집은 게 아니라 주먹을 쥐는 중이었으면 클릭하지 않는다
        state = { type: 'idle' };
      } else if (!hand.pinched) {
        bridge.setButton(true);
        bridge.setButton(false);
        state = { type: 'idle' };
      } else if (now - state.since >= CLICK_MS) {
        bridge.setButton(true);
        state = { type: 'drag', label: state.label, offset: state.offset };
      }
      break;
    }
    case 'drag': {
      const hand = getHand(state.label, now);
      if (hand?.pinched) {
        moveTo(offsetBy(hand, state.offset));
      } else {
        bridge.setButton(false);
        state = { type: 'idle' };
      }
      break;
    }
    case 'rect': {
      if (pinched.length === 2) {
        state.from = { x: left.x, y: left.y };
        state.to = { x: right.x, y: right.y };
      } else {
        if (state.from) bridge.drag(state.from, state.to);
        state = { type: 'waitRelease' };
      }
      break;
    }
    case 'scroll': {
      const hand = getHand(state.label, now);
      if (hand?.gesture !== 'middle') {
        state = { type: 'waitRelease' };
        break;
      }
      state.wheel += (hand.y - state.lastY) * SCROLL_SPEED;
      state.lastY = hand.y;
      if (Math.abs(state.wheel) >= 15) {
        const delta = Math.trunc(state.wheel);
        bridge.scroll(delta);
        state.wheel -= delta;
      }
      break;
    }
    case 'shortcut': {
      const hand = getHand(state.label, now);
      if (hand?.gesture !== state.gesture) {
        state = { type: 'waitRelease' };
      } else if (!state.fired && now - state.since >= SHORTCUT_HOLD_MS) {
        bridge.shortcut(GESTURES[state.gesture].shortcut);
        state.fired = true;
      }
      break;
    }
    case 'grab': {
      const hand = getHand(state.label, now);
      if (hand?.rawPose !== 'fist' && hand?.pose !== 'fist') {
        state = { type: 'waitRelease' };
        break;
      }
      const dx = (hand.ux - state.startX) / hand.palm;
      const dy = (hand.rawY - state.startY) / hand.palm;
      if (Math.max(Math.abs(dx), Math.abs(dy)) >= THROW_DISTANCE) {
        const direction = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
        fireWindowGesture(THROWS[direction].shortcut, THROWS[direction].label, now);
        state = { type: 'waitRelease' };
      }
      break;
    }
    case 'waitRelease': {
      // 손가락을 펴는 도중 엄지가 다른 손가락을 스쳐 다른 동작이 실행되지 않도록 기다린다
      if (present.every(([, s]) => !s.gesture && s.rawPose !== 'fist')) state = { type: 'idle' };
      break;
    }
  }
}

// 편 두 손의 간격 변화를 지켜보다가 커튼을 열거나 닫는 동작이면 실행한다.
// 손 라벨(왼/오른)이 가끔 뒤바뀌어도 되도록 화면상 위치로 왼쪽·오른쪽 손을 정한다.
function checkCurtain(now, left, right) {
  if (!left || !right || left.pose !== 'open' || right.pose !== 'open' || now < cooldownUntil) {
    curtainHistory = [];
    return false;
  }
  const current = {
    t: now,
    l: Math.min(left.ux, right.ux),
    r: Math.max(left.ux, right.ux),
    palm: (left.palm + right.palm) / 2,
  };
  curtainHistory = curtainHistory.filter((past) => past.t >= now - CURTAIN_WINDOW_MS);
  curtainHistory.push(current);

  for (const past of curtainHistory) {
    const gapChange = (current.r - current.l - (past.r - past.l)) / current.palm;
    const leftMove = (current.l - past.l) / current.palm;
    const rightMove = (current.r - past.r) / current.palm;
    if (gapChange >= CURTAIN_DISTANCE && leftMove <= -CURTAIN_EACH && rightMove >= CURTAIN_EACH) {
      return fireWindowGesture('snapLeft', '커튼 열기 — 화면 분할', now);
    }
    if (gapChange <= -CURTAIN_DISTANCE && leftMove >= CURTAIN_EACH && rightMove <= -CURTAIN_EACH) {
      return fireWindowGesture('desktop', '커튼 닫기 — 바탕화면', now);
    }
  }
  return false;
}

function fireWindowGesture(shortcut, text, now) {
  bridge.shortcut(shortcut);
  toast = { text, until: now + 1200 };
  cooldownUntil = now + WINDOW_GESTURE_COOLDOWN_MS;
  curtainHistory = [];
  return true;
}

function moveTo(point) {
  if (lastMove && Math.abs(lastMove.x - point.x) < 5e-4 && Math.abs(lastMove.y - point.y) < 5e-4) return;
  lastMove = { x: point.x, y: point.y };
  bridge.move(point.x, point.y);
}

function positionAt(hand, time) {
  let found = hand.history[0];
  for (const entry of hand.history) {
    if (entry.t > time) break;
    found = entry;
  }
  return { x: found.x, y: found.y };
}

function offsetBy(point, offset) {
  return {
    x: Math.min(1, Math.max(0, point.x + offset.x)),
    y: Math.min(1, Math.max(0, point.y + offset.y)),
  };
}

// 오버레이에는 실제 커서가 있는 위치(고정·보정된 위치)를 보여준다
function displayOf(label, hand) {
  if (state.label !== label) return { ...hand, badge: null };
  switch (state.type) {
    case 'pending':
      return { ...state.anchor, badge: null };
    case 'drag':
      return { ...offsetBy(hand, state.offset), badge: null };
    case 'scroll':
      return { ...state.at, badge: GESTURES.middle.label };
    case 'shortcut':
      return { ...state.at, badge: GESTURES[state.gesture].label + (state.fired ? ' ✓' : '…') };
    case 'grab':
      return { ...state.at, badge: '✊ 창 잡기' };
    default:
      return { ...hand, badge: null };
  }
}

function sendFrame(now) {
  const pointers = [];
  for (const label of Object.keys(hands.HAND_COLORS)) {
    const s = getHand(label, now);
    if (!s) continue;
    const { x, y, badge } = displayOf(label, s);
    pointers.push({ x, y, badge, pinched: s.pinched, color: hands.HAND_COLORS[label] });
  }
  const rect = state.type === 'rect' && state.from ? { from: state.from, to: state.to } : null;
  bridge.sendFrame({ pointers, rect, toast: toast && now < toast.until ? toast.text : null });
}

function drawActiveArea(ctx, width, height) {
  const { left, right, top, bottom } = area;
  ctx.save();
  ctx.setLineDash([10, 8]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
  // ctx가 좌우 반전돼 있으므로 원본 좌표 기준 x = 1 - right
  ctx.strokeRect((1 - right) * width, top * height, (right - left) * width, (bottom - top) * height);
  ctx.restore();
}

function average(values) {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function toUnit(value, min, max) {
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

function distance(a, b, aspect) {
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y);
}

// One Euro Filter: 천천히 움직일 땐 떨림을 강하게 줄이고, 빠르게 움직일 땐 지연을 줄인다
class OneEuroFilter {
  constructor(minCutoff = 1.0, beta = 10, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.value = null;
    this.speed = 0;
    this.time = 0;
  }

  filter(value, time) {
    if (this.value === null) {
      this.value = value;
      this.time = time;
      return value;
    }
    const dt = Math.max(time - this.time, 1e-3);
    this.time = time;
    this.speed += smoothing(dt, this.dCutoff) * ((value - this.value) / dt - this.speed);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.speed);
    this.value += smoothing(dt, cutoff) * (value - this.value);
    return this.value;
  }
}

function smoothing(dt, cutoff) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

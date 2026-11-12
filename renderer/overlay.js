// 화면 전체를 덮는 투명·클릭 통과 창에 손별 가상 포인터와 선택 사각형을 그린다
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');

// 일반적인 화살표 커서 모양 (끝점이 원점)
const ARROW = [[0, 0], [0, 17], [4, 13], [7, 20], [10, 19], [7, 12], [12, 12]];
const ARROW_SCALE = 1.6;

let lastFrame = { pointers: [], rect: null };
let caption = null; // { lines, until }

function resize() {
  canvas.width = Math.round(innerWidth * devicePixelRatio);
  canvas.height = Math.round(innerHeight * devicePixelRatio);
  render(lastFrame);
}

function render(frame) {
  lastFrame = frame;
  const w = innerWidth;
  const h = innerHeight;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (frame.rect) {
    const x = Math.min(frame.rect.from.x, frame.rect.to.x) * w;
    const y = Math.min(frame.rect.from.y, frame.rect.to.y) * h;
    const rw = Math.abs(frame.rect.to.x - frame.rect.from.x) * w;
    const rh = Math.abs(frame.rect.to.y - frame.rect.from.y) * h;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.fillRect(x, y, rw, rh);
    ctx.setLineDash([12, 8]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.strokeRect(x, y, rw, rh);
    ctx.setLineDash([]);
  }

  for (const p of frame.pointers) drawPointer(p.x * w, p.y * h, p.color, p.pinched, p.badge);
  if (frame.toast) drawToast(frame.toast, w);
  if (caption && performance.now() < caption.until) drawCaption(caption.lines, w, h);
}

// 입모양 입력 결과와 고칠 수 있는 다른 후보를 화면 아래쪽에 보여준다
function drawCaption(lines, w, h) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const sizes = lines.map((_, i) => (i === 0 ? 28 : 18));
  const widths = lines.map((line, i) => {
    ctx.font = `${i === 0 ? 'bold ' : ''}${sizes[i]}px "Segoe UI", "Malgun Gothic", sans-serif`;
    return ctx.measureText(line).width;
  });
  const boxW = Math.max(...widths) + 48;
  const boxH = sizes.reduce((sum, s) => sum + s * 1.6, 0) + 16;
  const x = (w - boxW) / 2;
  let y = h - boxH - 120;
  ctx.fillStyle = 'rgba(20, 20, 20, 0.85)';
  ctx.beginPath();
  ctx.roundRect(x, y, boxW, boxH, 14);
  ctx.fill();
  y += 8;
  lines.forEach((line, i) => {
    ctx.font = `${i === 0 ? 'bold ' : ''}${sizes[i]}px "Segoe UI", "Malgun Gothic", sans-serif`;
    ctx.fillStyle = i === 0 ? '#ffffff' : '#c4c7c5';
    ctx.fillText(line, w / 2, y + (sizes[i] * 1.6) / 2);
    y += sizes[i] * 1.6;
  });
  ctx.textAlign = 'start';
}

// 창 제스처가 실행되면 화면 위쪽 가운데에 무엇을 했는지 잠깐 보여준다
function drawToast(text, w) {
  ctx.font = 'bold 26px "Segoe UI", "Malgun Gothic", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const boxW = ctx.measureText(text).width + 48;
  const boxH = 56;
  const x = (w - boxW) / 2;
  const y = 48;
  ctx.fillStyle = 'rgba(20, 20, 20, 0.8)';
  ctx.beginPath();
  ctx.roundRect(x, y, boxW, boxH, 14);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, w / 2, y + boxH / 2);
  ctx.textAlign = 'start';
}

function drawPointer(x, y, color, pinched, badge) {
  if (pinched) {
    ctx.beginPath();
    ctx.arc(x, y, 18, 0, Math.PI * 2);
    ctx.fillStyle = color + '55';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = color;
    ctx.stroke();
  }

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(ARROW_SCALE, ARROW_SCALE);
  ctx.beginPath();
  ARROW.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1.5 / ARROW_SCALE;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.restore();

  // 스크롤·복사·붙여넣기 중일 때 포인터 옆에 표시
  if (badge) {
    ctx.font = 'bold 18px "Segoe UI", "Malgun Gothic", sans-serif';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.strokeText(badge, x + 24, y + 28);
    ctx.fillStyle = color;
    ctx.fillText(badge, x + 24, y + 28);
  }
}

window.addEventListener('resize', resize);
window.mouseBridge.onFrame(render);
window.mouseBridge.onCaption((lines, durationMs) => {
  caption = { lines, until: performance.now() + durationMs };
  render(lastFrame);
});
resize();

// 纸边自动检测：灰度 → Otsu 二值化 → 最大连通域 → 取凸域四角
// 适用于「浅色纸张 + 深色桌面」这类常见拍摄场景，识别不到时由调用方回退到默认框

function toGray(data, len) {
  const gray = new Uint8Array(len);
  for (let i = 0, p = 0; i < len; i++, p += 4) {
    gray[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
  }
  return gray;
}

function otsu(gray, len) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < len; i++) hist[gray[i]] += 1;

  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];

  let sumB = 0;
  let wB = 0;
  let max = -1;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = len - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > max) {
      max = between;
      threshold = t;
    }
  }
  return threshold;
}

// 返回像素数最多的连通域的像素下标列表
function largestComponent(mask, w, h) {
  const total = w * h;
  const visited = new Uint8Array(total);
  const stack = new Int32Array(total);
  let best = null;
  let bestCount = 0;

  for (let i = 0; i < total; i++) {
    if (!mask[i] || visited[i]) continue;
    let sp = 0;
    stack[sp++] = i;
    visited[i] = 1;
    const pts = [];

    while (sp) {
      const p = stack[--sp];
      pts.push(p);
      const x = p % w;
      const y = (p - x) / w;
      if (x > 0 && mask[p - 1] && !visited[p - 1]) {
        visited[p - 1] = 1;
        stack[sp++] = p - 1;
      }
      if (x < w - 1 && mask[p + 1] && !visited[p + 1]) {
        visited[p + 1] = 1;
        stack[sp++] = p + 1;
      }
      if (y > 0 && mask[p - w] && !visited[p - w]) {
        visited[p - w] = 1;
        stack[sp++] = p - w;
      }
      if (y < h - 1 && mask[p + w] && !visited[p + w]) {
        visited[p + w] = 1;
        stack[sp++] = p + w;
      }
    }

    if (pts.length > bestCount) {
      bestCount = pts.length;
      best = pts;
    }
  }

  return best;
}

function quadArea(q) {
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * @param {Uint8ClampedArray} data RGBA
 * @param {number} w
 * @param {number} h
 * @returns {Array<{x:number,y:number}>|null} 顺序为左上、右上、右下、左下
 */
function detectQuad(data, w, h) {
  const len = w * h;
  if (len < 1024) return null;

  const gray = toGray(data, len);
  const threshold = otsu(gray, len);

  // 纸张通常比背景亮，取亮区；同时排除几乎全亮/全暗的极端情况
  const mask = new Uint8Array(len);
  let bright = 0;
  for (let i = 0; i < len; i++) {
    if (gray[i] > threshold) {
      mask[i] = 1;
      bright += 1;
    }
  }
  const brightRatio = bright / len;
  if (brightRatio < 0.15 || brightRatio > 0.97) return null;

  const pts = largestComponent(mask, w, h);
  if (!pts || pts.length < len * 0.12) return null;

  let tl = null;
  let tr = null;
  let br = null;
  let bl = null;
  let minSum = Infinity;
  let maxDiff = -Infinity;
  let maxSum = -Infinity;
  let minDiff = Infinity;

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const x = p % w;
    const y = (p - x) / w;
    const sum = x + y;
    const diff = x - y;
    if (sum < minSum) {
      minSum = sum;
      tl = { x, y };
    }
    if (diff > maxDiff) {
      maxDiff = diff;
      tr = { x, y };
    }
    if (sum > maxSum) {
      maxSum = sum;
      br = { x, y };
    }
    if (diff < minDiff) {
      minDiff = diff;
      bl = { x, y };
    }
  }

  if (!tl || !tr || !br || !bl) return null;

  const quad = [tl, tr, br, bl];

  // 尺寸校验：四条边都要足够长，面积占比要合理，避免把整张背景当成纸
  const minSide = Math.min(w, h) * 0.12;
  for (let i = 0; i < 4; i++) {
    if (dist(quad[i], quad[(i + 1) % 4]) < minSide) return null;
  }
  const ratio = quadArea(quad) / len;
  if (ratio < 0.06 || ratio > 0.985) return null;

  // 略微向外扩张，避免边缘被裁掉
  const cx = (tl.x + tr.x + br.x + bl.x) / 4;
  const cy = (tl.y + tr.y + br.y + bl.y) / 4;
  const k = 1.015;
  return quad.map((p) => ({
    x: Math.min(Math.max(cx + (p.x - cx) * k, 0), w - 1),
    y: Math.min(Math.max(cy + (p.y - cy) * k, 0), h - 1)
  }));
}

module.exports = { detectQuad };

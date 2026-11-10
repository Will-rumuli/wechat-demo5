/**
 * 透视矫正：求解四点单应性矩阵 + 双线性重采样
 */

const EPS = 1e-8;

/**
 * 求解 8 参数单应性矩阵，使 src 四点映射到 dst 四点
 * @param {Array<{x:number,y:number}>} src 源四点
 * @param {Array<{x:number,y:number}>} dst 目标四点
 * @returns {number[]} [h0..h7]，h8 固定为 1
 */
function solveHomography(src, dst) {
  const a = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const u = dst[i].x;
    const v = dst[i].y;
    a.push([x, y, 1, 0, 0, 0, -x * u, -y * u, u]);
    a.push([0, 0, 0, x, y, 1, -x * v, -y * v, v]);
  }

  // 高斯消元（列主元）
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let row = col + 1; row < 8; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < EPS) return [1, 0, 0, 0, 1, 0, 0, 0];
    if (pivot !== col) {
      const tmp = a[pivot];
      a[pivot] = a[col];
      a[col] = tmp;
    }
    const pv = a[col][col];
    for (let k = col; k <= 8; k++) a[col][k] /= pv;
    for (let row = 0; row < 8; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      if (!factor) continue;
      for (let k = col; k <= 8; k++) a[row][k] -= factor * a[col][k];
    }
  }

  const h = new Array(8);
  for (let i = 0; i < 8; i++) h[i] = a[i][8];
  return h;
}

/**
 * 根据源四点估算矫正后的输出尺寸
 * @param {Array<{x:number,y:number}>} quad 源四点（顺序：左上、右上、右下、左下）
 * @param {number} maxSide 长边上限
 */
function quadSize(quad, maxSide) {
  const dist = (p, q) => Math.sqrt((p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y));
  let w = (dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / 2;
  let h = (dist(quad[0], quad[3]) + dist(quad[1], quad[2])) / 2;
  w = Math.max(w, 1);
  h = Math.max(h, 1);
  const longSide = Math.max(w, h);
  if (longSide > maxSide) {
    const ratio = maxSide / longSide;
    w *= ratio;
    h *= ratio;
  }
  return {
    width: Math.max(1, Math.round(w)),
    height: Math.max(1, Math.round(h))
  };
}

/**
 * 将源像素按四点透视矫正到目标矩形
 * @param {Uint8ClampedArray} src 源像素 RGBA
 * @param {number} srcW
 * @param {number} srcH
 * @param {Array<{x:number,y:number}>} quad 源四点（左上、右上、右下、左下）
 * @param {number} outW
 * @param {number} outH
 * @returns {Uint8ClampedArray} 矫正后的 RGBA 像素
 */
function warp(src, srcW, srcH, quad, outW, outH) {
  const full = [
    { x: 0, y: 0 },
    { x: outW - 1, y: 0 },
    { x: outW - 1, y: outH - 1 },
    { x: 0, y: outH - 1 }
  ];
  // 反向映射：目标坐标 -> 源坐标
  const h = solveHomography(full, quad);
  const out = new Uint8ClampedArray(outW * outH * 4);
  const maxX = srcW - 1;
  const maxY = srcH - 1;

  for (let y = 0; y < outH; y++) {
    const yc = y + 0.5;
    const baseY = y * outW * 4;
    for (let x = 0; x < outW; x++) {
      const xc = x + 0.5;
      let den = h[6] * xc + h[7] * yc + 1;
      if (Math.abs(den) < EPS) den = EPS;
      let sx = (h[0] * xc + h[1] * yc + h[2]) / den;
      let sy = (h[3] * xc + h[4] * yc + h[5]) / den;

      if (!isFinite(sx) || !isFinite(sy)) {
        sx = 0;
        sy = 0;
      }
      if (sx < 0) sx = 0;
      else if (sx > maxX) sx = maxX;
      if (sy < 0) sy = 0;
      else if (sy > maxY) sy = maxY;

      const x0 = sx | 0;
      const y0 = sy | 0;
      const x1 = x0 < maxX ? x0 + 1 : x0;
      const y1 = y0 < maxY ? y0 + 1 : y0;
      const fx = sx - x0;
      const fy = sy - y0;

      const p00 = (y0 * srcW + x0) * 4;
      const p10 = (y0 * srcW + x1) * 4;
      const p01 = (y1 * srcW + x0) * 4;
      const p11 = (y1 * srcW + x1) * 4;

      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const o = baseY + x * 4;
      out[o] = src[p00] * w00 + src[p10] * w10 + src[p01] * w01 + src[p11] * w11;
      out[o + 1] = src[p00 + 1] * w00 + src[p10 + 1] * w10 + src[p01 + 1] * w01 + src[p11 + 1] * w11;
      out[o + 2] = src[p00 + 2] * w00 + src[p10 + 2] * w10 + src[p01 + 2] * w01 + src[p11 + 2] * w11;
      out[o + 3] = 255;
    }
  }
  return out;
}

module.exports = {
  solveHomography,
  quadSize,
  warp
};

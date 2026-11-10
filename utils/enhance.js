/**
 * 本地图像增强
 * original 原色 / enhance 增强 / bw 黑白文档
 * 全部在内存像素上处理，不上传任何图片
 */

/** 按亮度分位数做对比度拉伸（原地修改 RGBA） */
function stretch(data, lowPct, highPct) {
  const count = data.length >> 2;
  if (!count) return;

  const hist = new Uint32Array(256);
  for (let p = 0; p < data.length; p += 4) {
    hist[(data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8]++;
  }

  const lowCount = (count * lowPct) / 100;
  const highCount = (count * highPct) / 100;

  let acc = 0;
  let lo = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= lowCount) {
      lo = v;
      break;
    }
  }
  acc = 0;
  let hi = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= highCount) {
      hi = v;
      break;
    }
  }
  if (hi - lo < 8) {
    lo = 0;
    hi = 255;
  }

  const scale = 255 / (hi - lo);
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    if (v <= lo) lut[v] = 0;
    else if (v >= hi) lut[v] = 255;
    else lut[v] = (v - lo) * scale;
  }

  for (let p = 0; p < data.length; p += 4) {
    data[p] = lut[data[p]];
    data[p + 1] = lut[data[p + 1]];
    data[p + 2] = lut[data[p + 2]];
  }
}

/** 增强：对比度拉伸 + 轻微提饱和，适合票据、书本、白板 */
function enhanceMode(data) {
  stretch(data, 1.5, 99.2);
  for (let p = 0; p < data.length; p += 4) {
    const avg = (data[p] + data[p + 1] + data[p + 2]) / 3;
    data[p] = avg + (data[p] - avg) * 1.08;
    data[p + 1] = avg + (data[p + 1] - avg) * 1.08;
    data[p + 2] = avg + (data[p + 2] - avg) * 1.08;
  }
}

/** 黑白文档：灰度 + 局部均值归一化（消除阴影、台灯不均）+ 全局拉伸 */
function documentMode(data, w, h) {
  const n = w * h;
  if (!n) return;

  const gray = new Uint8ClampedArray(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  }

  // 积分图用于 O(1) 求局部均值
  const w1 = w + 1;
  const integral = new Int32Array(w1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    const curOff = (y + 1) * w1;
    const prevOff = y * w1;
    const grayOff = y * w;
    for (let x = 0; x < w; x++) {
      rowSum += gray[grayOff + x];
      integral[curOff + x + 1] = integral[prevOff + x + 1] + rowSum;
    }
  }

  const radius = Math.max(8, Math.round(Math.min(w, h) / 20));
  const norm = new Uint8ClampedArray(n);
  for (let y = 0; y < h; y++) {
    const y0 = y - radius < 0 ? 0 : y - radius;
    const y1 = y + radius + 1 > h ? h : y + radius + 1;
    const rowA = y0 * w1;
    const rowB = y1 * w1;
    const grayOff = y * w;
    const normOff = y * w;
    for (let x = 0; x < w; x++) {
      const x0 = x - radius < 0 ? 0 : x - radius;
      const x1 = x + radius + 1 > w ? w : x + radius + 1;
      const area = (x1 - x0) * (y1 - y0);
      const sum =
        integral[rowB + x1] - integral[rowA + x1] - integral[rowB + x0] + integral[rowA + x0];
      const mean = sum / area;
      norm[normOff + x] = (gray[grayOff + x] * 255) / (mean + 4);
    }
  }

  // 归一化后再做一次全局拉伸，纸白更白、字更黑
  const tmp = new Uint8ClampedArray(n * 4);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    tmp[p] = norm[i];
    tmp[p + 1] = norm[i];
    tmp[p + 2] = norm[i];
    tmp[p + 3] = 255;
  }
  stretch(tmp, 4, 96);

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const v = tmp[p];
    data[p] = v;
    data[p + 1] = v;
    data[p + 2] = v;
    data[p + 3] = 255;
  }
}

/**
 * 按模式处理像素（原地修改）
 * @param {Uint8ClampedArray} data
 * @param {number} w
 * @param {number} h
 * @param {string} mode original | enhance | bw
 */
function applyFilter(data, w, h, mode) {
  if (mode === 'bw') documentMode(data, w, h);
  else if (mode === 'enhance') enhanceMode(data);
  return data;
}

module.exports = {
  applyFilter
};

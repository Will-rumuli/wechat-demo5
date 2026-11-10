const perspective = require('../../utils/perspective');
const enhance = require('../../utils/enhance');
const detect = require('../../utils/detect');

// 源图送入内存前的长边上限，避免超大图占满内存
const MAX_SRC = 2000;
// 输出长边上限，兼顾清晰度与处理速度
const MAX_OUT = 1600;
// 单张图最多同时框选多少个区域
const MAX_BOXES = 6;

const FILTERS = [
  { key: 'original', label: '原色', css: 'none' },
  { key: 'enhance', label: '增强', css: 'brightness(1.05) contrast(1.15) saturate(1.06)' },
  { key: 'bw', label: '黑白文档', css: 'grayscale(1) contrast(1.45) brightness(1.06)' }
];

const CSS_FILTER = FILTERS.reduce((map, item) => {
  map[item.key] = item.css;
  return map;
}, {});

let boxSeq = 0;
function nextId() {
  boxSeq += 1;
  return `box_${Date.now().toString(36)}_${boxSeq}`;
}

Page({
  data: {
    step: 'crop',
    imgPath: '',
    rect: { left: 0, top: 0, w: 0, h: 0 },
    boxes: [],
    hitBoxes: [],
    filters: FILTERS,
    filter: 'enhance',
    cssFilter: CSS_FILTER.enhance,
    busy: false,
    previews: [],
    pageInfo: '',
    doneText: '完成'
  },

  onLoad() {
    const win = wx.getWindowInfo();
    this.dpr = win.pixelRatio || 2;
    this.queue = [];
    this.qi = 0;
    this.targetId = '';
    this.pendingQuads = null;
    this.boxes = [];
    this.activeId = '';
    this.dragCorner = -1;
    this.canvases = {};

    const ec = this.getOpenerEventChannel && this.getOpenerEventChannel();
    this.ec = ec;
    if (ec && ec.on) {
      ec.on('init', (payload) => {
        this.queue = (payload && payload.images) || [];
        this.qi = 0;
        this.targetId = (payload && payload.targetId) || '';
        this.pendingQuads = (payload && payload.quads) || null;
        this.loadCurrent();
      });
    }
  },

  loadCurrent() {
    const path = this.queue[this.qi];
    if (!path) {
      this.finish();
      return;
    }
    const total = this.queue.length;
    this.setData({
      step: 'crop',
      previews: [],
      pageInfo: `${this.qi + 1} / ${total}`
    });

    wx.getImageInfo({
      src: path,
      success: (res) => {
        // 相机照片可能带 EXIF 旋转，展示时按旋转后的宽高适配
        const rotated =
          res.orientation === 'left' ||
          res.orientation === 'right' ||
          res.orientation === 'left-mirrored' ||
          res.orientation === 'right-mirrored';
        this.srcPath = res.path;
        this.imgW = rotated ? res.height : res.width;
        this.imgH = rotated ? res.width : res.height;
        this.autoPending = true;
        this.setData({ imgPath: res.path }, () => this.layout());
      },
      fail: () => {
        wx.showToast({ title: '图片读取失败', icon: 'none' });
        setTimeout(() => {
          if (this.qi + 1 < this.queue.length) {
            this.qi += 1;
            this.loadCurrent();
          } else {
            this.finish();
          }
        }, 800);
      }
    });
  },

  layout() {
    wx.createSelectorQuery()
      .in(this)
      .select('#stage')
      .boundingClientRect((rect) => {
        if (!rect || !rect.width || !this.imgW) return;
        const pad = 12;
        const scale = Math.min(
          (rect.width - pad * 2) / this.imgW,
          (rect.height - pad * 2) / this.imgH
        );
        const w = this.imgW * scale;
        const h = this.imgH * scale;
        this.stageW = rect.width;
        this.stageH = rect.height;
        this.rect = {
          left: (rect.width - w) / 2,
          top: (rect.height - h) / 2,
          w,
          h
        };
        this.setData({ rect: this.rect });
        this.initBoxes();
        if (this.autoPending) {
          this.autoPending = false;
          this.autoDetect();
        }
      })
      .exec();
  },

  initBoxes() {
    const r = this.rect;
    if (this.pendingQuads && this.pendingQuads.length) {
      this.autoPending = false;
      this.boxes = this.pendingQuads.map((quad) => ({
        id: nextId(),
        quad: quad.map((p) => ({
          x: r.left + p.x * r.w,
          y: r.top + p.y * r.h
        }))
      }));
      this.pendingQuads = null;
    } else {
      this.boxes = [{ id: nextId(), quad: this.makeQuad(0.06) }];
    }
    this.activeId = this.boxes[0].id;
    this.syncBoxes();
  },

  makeQuad(inset) {
    const { left, top, w, h } = this.rect;
    const ix = Math.max(w * inset, 2);
    const iy = Math.max(h * inset, 2);
    return [
      { x: left + ix, y: top + iy },
      { x: left + w - ix, y: top + iy },
      { x: left + w - ix, y: top + h - iy },
      { x: left + ix, y: top + h - iy }
    ];
  },

  // 把四边形整体限制在图片范围内
  clampQuad(quad) {
    const r = this.rect;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < 4; i++) {
      if (quad[i].x < minX) minX = quad[i].x;
      if (quad[i].x > maxX) maxX = quad[i].x;
      if (quad[i].y < minY) minY = quad[i].y;
      if (quad[i].y > maxY) maxY = quad[i].y;
    }
    let dx = 0;
    let dy = 0;
    if (minX < r.left) dx = r.left - minX;
    if (maxX + dx > r.left + r.w) dx = r.left + r.w - maxX;
    if (minY < r.top) dy = r.top - minY;
    if (maxY + dy > r.top + r.h) dy = r.top + r.h - maxY;
    return quad.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  },

  getBox(id) {
    for (let i = 0; i < this.boxes.length; i++) {
      if (this.boxes[i].id === id) return this.boxes[i];
    }
    return null;
  },

  selectBox(id) {
    if (this.activeId === id) return;
    this.activeId = id;
    this.syncBoxes();
  },

  syncBoxes() {
    const activeId = this.activeId;
    const stageW = this.stageW || 360;
    const stageH = this.stageH || 480;

    const boxes = this.boxes.map((box) => {
      const quad = box.quad;
      const lines = [];
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < 4; i++) {
        const a = quad[i];
        const b = quad[(i + 1) % 4];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        lines.push({
          idx: i,
          x: a.x,
          y: a.y,
          w: Math.sqrt(dx * dx + dy * dy),
          rot: (Math.atan2(dy, dx) * 180) / Math.PI
        });
        if (a.x < minX) minX = a.x;
        if (a.x > maxX) maxX = a.x;
        if (a.y < minY) minY = a.y;
        if (a.y > maxY) maxY = a.y;
      }
      return {
        id: box.id,
        active: box.id === activeId,
        quad: quad.map((p, i) => ({ idx: i, x: p.x, y: p.y })),
        lines,
        hitLeft: minX,
        hitTop: minY,
        hitW: Math.max(maxX - minX, 1),
        hitH: Math.max(maxY - minY, 1),
        delLeft: Math.min(Math.max((minX + maxX) / 2, 26), stageW - 26),
        delTop: Math.min(Math.max(minY - 26, 26), stageH - 26)
      };
    });

    this.setData({
      boxes,
      hitBoxes: boxes
        .map((box) => ({
          id: box.id,
          active: box.active,
          hitLeft: box.hitLeft,
          hitTop: box.hitTop,
          hitW: box.hitW,
          hitH: box.hitH
        }))
        // 面积大的先渲染，面积小的后渲染置于上层，避免小框被大框的命中区遮挡
        .sort((a, b) => b.hitW * b.hitH - a.hitW * a.hitH),
      doneText: this.boxes.length > 1 ? `完成（${this.boxes.length} 张）` : '完成'
    });
  },

  onAddBox() {
    if (this.boxes.length >= MAX_BOXES) {
      wx.showToast({ title: `最多 ${MAX_BOXES} 个框`, icon: 'none' });
      return;
    }
    const offset = this.boxes.length * 20;
    const quad = this.clampQuad(
      this.makeQuad(0.06).map((p) => ({ x: p.x + offset, y: p.y + offset }))
    );
    const id = nextId();
    this.boxes.push({ id, quad });
    this.activeId = id;
    this.syncBoxes();
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light' });
  },

  onDeleteBox(e) {
    const id = e.currentTarget.dataset.box;
    if (this.boxes.length <= 1) {
      wx.showToast({ title: '至少保留一个框', icon: 'none' });
      return;
    }
    this.boxes = this.boxes.filter((box) => box.id !== id);
    if (this.activeId === id) {
      this.activeId = this.boxes[this.boxes.length - 1].id;
    }
    this.syncBoxes();
  },

  onCornerStart(e) {
    const ds = e.currentTarget.dataset;
    this.selectBox(ds.box);
    this.dragBoxId = ds.box;
    this.dragCorner = Number(ds.i);
  },

  onCornerMove(e) {
    if (this.dragCorner < 0) return;
    const touch = e.touches && e.touches[0];
    if (!touch) return;
    const box = this.getBox(this.dragBoxId);
    if (!box) return;

    const r = this.rect;
    let x = touch.clientX;
    let y = touch.clientY;
    if (x < r.left) x = r.left;
    else if (x > r.left + r.w) x = r.left + r.w;
    if (y < r.top) y = r.top;
    else if (y > r.top + r.h) y = r.top + r.h;
    box.quad[this.dragCorner] = {
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10
    };
    this.syncBoxes();
  },

  onCornerEnd() {
    this.dragCorner = -1;
  },

  // 点击框内区域：选中该框
  onBoxTap(e) {
    this.selectBox(e.currentTarget.dataset.box);
  },

  // 本地自动识别纸边；识别失败时保持当前框不动
  async autoDetect() {
    if (!this.imgW || !this.boxes.length) return false;
    try {
      const probe = await this.getCanvas('#probe');
      const longSide = Math.max(this.imgW, this.imgH);
      const scale = Math.min(1, 480 / longSide);
      const dw = Math.max(1, Math.round(this.imgW * scale));
      const dh = Math.max(1, Math.round(this.imgH * scale));

      probe.width = dw;
      probe.height = dh;
      const ctx = probe.getContext('2d');
      const img = probe.createImage();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('图片解码失败'));
        img.src = this.srcPath;
      });
      ctx.drawImage(img, 0, 0, dw, dh);
      const pixels = ctx.getImageData(0, 0, dw, dh).data;

      const quad = detect.detectQuad(pixels, dw, dh);
      if (!quad) return false;

      const r = this.rect;
      const box = this.getBox(this.activeId) || this.boxes[0];
      box.quad = quad.map((p) => ({
        x: r.left + (p.x / dw) * r.w,
        y: r.top + (p.y / dh) * r.h
      }));
      this.activeId = box.id;
      this.syncBoxes();
      return true;
    } catch (e) {
      return false;
    }
  },

  async onAuto() {
    if (this.data.busy) return;
    const ok = await this.autoDetect();
    wx.showToast({
      title: ok ? '已识别纸边' : '未识别到纸边，请手动调角',
      icon: 'none'
    });
  },

  onReset() {
    this.boxes = [{ id: nextId(), quad: this.makeQuad(0.06) }];
    this.activeId = this.boxes[0].id;
    this.syncBoxes();
    wx.showToast({ title: '已重置选框', icon: 'none' });
  },

  async onRotate() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    wx.showLoading({ title: '旋转中', mask: true });

    try {
      const work = await this.getCanvas('#work');
      const longSide = Math.max(this.imgW, this.imgH);
      const scale = longSide > MAX_SRC ? MAX_SRC / longSide : 1;
      const sw = Math.max(1, Math.round(this.imgW * scale));
      const sh = Math.max(1, Math.round(this.imgH * scale));

      const img = work.createImage();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('图片解码失败'));
        img.src = this.srcPath;
      });

      work.width = sh;
      work.height = sw;
      const ctx = work.getContext('2d');
      ctx.translate(sh / 2, sw / 2);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(img, -sw / 2, -sh / 2, sw, sh);

      const tempPath = await new Promise((resolve, reject) => {
        wx.canvasToTempFilePath(
          {
            canvas: work,
            x: 0,
            y: 0,
            width: sh,
            height: sw,
            destWidth: sh,
            destHeight: sw,
            fileType: 'jpg',
            quality: 0.95,
            success: (res) => resolve(res.tempFilePath),
            fail: reject
          },
          this
        );
      });

      this.srcPath = tempPath;
      this.imgW = sh;
      this.imgH = sw;
      this.queue[this.qi] = tempPath;
      this.autoPending = true;
      this.setData({ imgPath: tempPath, busy: false }, () => this.layout());
      wx.hideLoading();
    } catch (e) {
      wx.hideLoading();
      this.setData({ busy: false });
      wx.showToast({ title: '旋转失败', icon: 'none' });
    }
  },

  onFilter(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.filter || this.data.busy) return;
    this.setData({ filter: key, cssFilter: CSS_FILTER[key] });

    if (this.data.step === 'preview' && this.src) {
      this.setData({ busy: true });
      wx.showLoading({ title: '应用滤镜', mask: true });
      setTimeout(async () => {
        try {
          const previews = await this.renderAll();
          this.setData({ previews });
        } catch (err) {
          wx.showToast({ title: '滤镜应用失败', icon: 'none' });
        }
        wx.hideLoading();
        this.setData({ busy: false });
      }, 40);
    }
  },

  onBackToCrop() {
    this.src = null;
    this.srcQuads = null;
    this.setData({ step: 'crop', previews: [] });
  },

  getCanvas(selector) {
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery()
        .in(this)
        .select(selector)
        .fields({ node: true, size: true })
        .exec((res) => {
          const item = res && res[0];
          if (!item || !item.node) reject(new Error('canvas not ready'));
          else resolve(item.node);
        });
    });
  },

  exportCanvas(canvas, w, h) {
    return new Promise((resolve, reject) => {
      wx.canvasToTempFilePath(
        {
          canvas,
          x: 0,
          y: 0,
          width: w,
          height: h,
          destWidth: w,
          destHeight: h,
          fileType: 'jpg',
          quality: 0.92,
          success: (res) => resolve(res.tempFilePath),
          fail: reject
        },
        this
      );
    });
  },

  // 按当前滤镜渲染所有框，返回临时图片列表
  async renderAll() {
    const work = this.canvases.work;
    const src = this.src;
    const results = [];

    for (let i = 0; i < this.srcQuads.length; i++) {
      const quad = this.srcQuads[i];
      const size = perspective.quadSize(quad, MAX_OUT);
      const pixels = perspective.warp(src.data, src.w, src.h, quad, size.width, size.height);
      enhance.applyFilter(pixels, size.width, size.height, this.data.filter);

      work.width = size.width;
      work.height = size.height;
      const ctx = work.getContext('2d');
      const imageData = ctx.createImageData(size.width, size.height);
      imageData.data.set(pixels);
      ctx.putImageData(imageData, 0, 0);

      const path = await this.exportCanvas(work, size.width, size.height);
      results.push({ path, w: size.width, h: size.height });
    }
    return results;
  },

  async onProcess() {
    if (this.data.busy || !this.rect.w || !this.boxes.length) return;
    this.setData({ busy: true });
    wx.showLoading({ title: '处理中', mask: true });

    try {
      const work = await this.getCanvas('#work');
      this.canvases.work = work;

      const longSide = Math.max(this.imgW, this.imgH);
      const scale = longSide > MAX_SRC ? MAX_SRC / longSide : 1;
      const sw = Math.max(1, Math.round(this.imgW * scale));
      const sh = Math.max(1, Math.round(this.imgH * scale));

      work.width = sw;
      work.height = sh;
      const ctx = work.getContext('2d');

      const img = work.createImage();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('图片解码失败'));
        img.src = this.srcPath;
      });
      ctx.drawImage(img, 0, 0, sw, sh);
      this.src = { data: ctx.getImageData(0, 0, sw, sh).data, w: sw, h: sh };

      const r = this.rect;
      this.srcQuads = this.boxes.map((box) =>
        box.quad.map((p) => ({
          x: ((p.x - r.left) / r.w) * sw,
          y: ((p.y - r.top) / r.h) * sh
        }))
      );

      const previews = await this.renderAll();
      this.setData({ step: 'preview', previews, busy: false });
      wx.hideLoading();
    } catch (e) {
      wx.hideLoading();
      this.setData({ busy: false });
      wx.showModal({
        title: '处理失败',
        content: (e && (e.errMsg || e.message)) || '图片处理异常，请重试',
        showCancel: false
      });
    }
  },

  async onConfirm() {
    if (this.data.busy || !this.data.previews.length) return;
    this.setData({ busy: true });
    wx.showLoading({ title: '保存中', mask: true });

    try {
      const fs = wx.getFileSystemManager();
      const dir = `${wx.env.USER_DATA_PATH}/scan_pages`;
      try {
        fs.accessSync(dir);
      } catch (err) {
        fs.mkdirSync(dir, true);
      }

      const stamp = Date.now();
      let srcPath = this.srcPath;
      try {
        const cachedSrc = `${dir}/src_${stamp}.jpg`;
        fs.copyFileSync(this.srcPath, cachedSrc);
        srcPath = cachedSrc;
      } catch (err) {
        // 源图缓存失败不影响本次结果，仅影响下次重新裁剪
      }

      this.data.previews.forEach((item, index) => {
        const outPath = `${dir}/page_${stamp}_${index}.jpg`;
        fs.copyFileSync(item.path, outPath);
        const isTarget = index === 0 && this.targetId;
        if (this.ec && this.ec.emit) {
          this.ec.emit('onDone', {
            id: isTarget ? this.targetId : `p${stamp}_${index}`,
            targetId: isTarget ? this.targetId : '',
            src: srcPath,
            out: outPath,
            w: item.w,
            h: item.h,
            filter: this.data.filter,
            quad: this.srcQuads[index]
              ? this.srcQuads[index].map((p) => ({
                  x: p.x / this.src.w,
                  y: p.y / this.src.h
                }))
              : null
          });
        }
      });

      wx.hideLoading();
      this.src = null;
      this.srcQuads = null;
      this.canvases = {};

      if (this.qi + 1 < this.queue.length) {
        this.qi += 1;
        this.setData({ busy: false, step: 'crop', previews: [] });
        this.loadCurrent();
      } else {
        this.setData({ busy: false });
        this.finish();
      }
    } catch (e) {
      wx.hideLoading();
      this.setData({ busy: false });
      wx.showModal({
        title: '保存失败',
        content: (e && (e.errMsg || e.message)) || '请重试',
        showCancel: false
      });
    }
  },

  finish() {
    wx.navigateBack({
      fail: () => {
        wx.reLaunch({ url: '/pages/index/index' });
      }
    });
  }
});

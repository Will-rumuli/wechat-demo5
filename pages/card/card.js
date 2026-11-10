const perspective = require('../../utils/perspective');
const detect = require('../../utils/detect');

// 送入内存前源图长边上限
const MAX_SRC = 1600;
// 单张证件矫正后的宽度
const CARD_W = 1000;
// A4 150dpi 画布
const A4_W = 1240;
const A4_H = 1754;
// 证件在 A4 上的绘制宽度
const DRAW_W = 900;
// 上下两张之间的间距
const GAP = 120;

const PRESETS = [
  { key: 'idcard', label: '身份证', ratio: 85.6 / 54, front: '人像面', back: '国徽面' },
  { key: 'bank', label: '银行卡', ratio: 85.6 / 54, front: '正面', back: '背面' },
  { key: 'passport', label: '护照', ratio: 125 / 88, front: '资料页', back: '备注页' },
  { key: 'driver', label: '驾驶证', ratio: 88 / 60, front: '正页', back: '副页' },
  { key: 'vehicle', label: '行驶证', ratio: 88 / 60, front: '正本', back: '副本' }
];

Page({
  data: {
    presets: PRESETS.map((item) => ({ key: item.key, label: item.label })),
    presetIndex: 0,
    slots: [
      { key: 'front', label: PRESETS[0].front, path: '' },
      { key: 'back', label: PRESETS[0].back, path: '' }
    ],
    readyCount: 0,
    busy: false,
    adjVisible: false,
    adjPath: '',
    adjRect: { left: 0, top: 0, w: 0, h: 0 },
    adjDots: [],
    adjLines: []
  },

  onLoad() {
    this.ec = this.getOpenerEventChannel && this.getOpenerEventChannel();
    if (!this.ec || !this.ec.emit) this.ec = null;
    this.adj = null;
    this.adjDrag = -1;
    this.adjDisplay = null;
    this.adjStage = null;
  },

  onPickPreset(e) {
    if (this.data.busy) return;
    const presetIndex = Number(e.currentTarget.dataset.index);
    if (presetIndex === this.data.presetIndex) return;
    const preset = PRESETS[presetIndex];
    this.setData({
      presetIndex,
      slots: [
        { key: 'front', label: preset.front, path: '' },
        { key: 'back', label: preset.back, path: '' }
      ],
      readyCount: 0
    });
  },

  onPickSlot(e) {
    if (this.data.busy) return;
    const index = Number(e.currentTarget.dataset.index);
    const slot = this.data.slots[index];
    if (!slot) return;

    const items = ['拍照', '从相册选择'];
    if (slot.path) items.push('移除重拍');

    wx.showActionSheet({
      itemList: items,
      success: (res) => {
        if (res.tapIndex === 2) {
          this.setSlot(index, '');
          return;
        }
        this.pickImage(index, res.tapIndex === 0 ? 'camera' : 'album');
      }
    });
  },

  pickImage(index, source) {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: [source],
      sizeType: ['original'],
      success: (res) => {
        const file = (res.tempFiles || [])[0];
        if (file && file.tempFilePath) this.processImage(index, file.tempFilePath);
      },
      fail: (err) => {
        const msg = (err && err.errMsg) || '';
        if (msg.indexOf('cancel') >= 0) return;
        wx.showModal({
          title: '无法选择图片',
          content: '请检查相机/相册权限；若提示 errno 112，请在公众平台「用户隐私保护指引」中声明对应权限。',
          showCancel: false
        });
      }
    });
  },

  getCanvas(selector) {
    return new Promise((resolve, reject) => {
      let tries = 0;
      const query = () => {
        wx.createSelectorQuery()
          .in(this)
          .select(selector)
          .fields({ node: true, size: true })
          .exec((res) => {
            const item = res && res[0];
            if (item && item.node) {
              resolve(item.node);
              return;
            }
            tries += 1;
            if (tries >= 6) {
              reject(new Error('canvas not ready'));
              return;
            }
            setTimeout(query, 50);
          });
      };
      query();
    });
  },

  imageSize(path) {
    return new Promise((resolve, reject) => {
      wx.getImageInfo({
        src: path,
        success: (res) => resolve({ width: res.width, height: res.height }),
        fail: reject
      });
    });
  },

  loadImage(canvas, path) {
    return new Promise((resolve, reject) => {
      const img = canvas.createImage();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片解码失败'));
      img.src = path;
    });
  },

  exportCanvas(canvas, w, h, quality) {
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
          quality: quality || 0.92,
          success: (res) => resolve(res.tempFilePath),
          fail: reject
        },
        this
      );
    });
  },

  // 读取图片像素并自动识别证件边缘，然后进入手动调整四角的界面
  async processImage(index, path) {
    if (this.data.busy) return;
    this.setData({ busy: true });
    wx.showLoading({ title: '识别证件边缘', mask: true });

    try {
      const canvas = await this.getCanvas('#cv');

      const info = await this.imageSize(path);
      const scale = Math.min(1, MAX_SRC / Math.max(info.width, info.height));
      const sw = Math.max(1, Math.round(info.width * scale));
      const sh = Math.max(1, Math.round(info.height * scale));

      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext('2d');
      const img = await this.loadImage(canvas, path);
      ctx.drawImage(img, 0, 0, sw, sh);
      const srcData = ctx.getImageData(0, 0, sw, sh).data;
      // 把画布内容导出一份用于展示，保证界面看到的像素与后面矫正用的像素完全一致
      const srcPath = await this.exportCanvas(canvas, sw, sh, 0.9);

      let quad = null;
      try {
        quad = detect.detectQuad(srcData, sw, sh);
      } catch (e) {
        quad = null;
      }

      this.adj = { index, srcPath, sw, sh, srcData, quad: null };

      wx.hideLoading();
      this.setData({ busy: false, adjVisible: true, adjPath: srcPath }, () => {
        this.layoutAdjust(!!quad, quad);
      });
    } catch (e) {
      wx.hideLoading();
      this.setData({ busy: false });
      wx.showModal({
        title: '处理失败',
        content: (e && (e.errMsg || e.message)) || '请重新拍摄',
        showCancel: false
      });
    }
  },

  // 量取调整区域的尺寸，开启后重试几次避免布局未完成
  measureAdjStage(tries) {
    return new Promise((resolve) => {
      const attempt = (left) => {
        wx.createSelectorQuery()
          .in(this)
          .select('#adjStage')
          .boundingClientRect((rect) => {
            if (rect && rect.width && rect.height) {
              resolve(rect);
              return;
            }
            if (left <= 0) {
              resolve(null);
              return;
            }
            setTimeout(() => attempt(left - 1), 60);
          })
          .exec();
      };
      attempt(tries == null ? 6 : tries);
    });
  },

  // 按目标比例生成一个居中的默认框（自动识别失败时的兜底）
  defaultQuad(rect, ratio) {
    const m = 0.05;
    let w = rect.w * (1 - m * 2);
    let h = w / ratio;
    if (h > rect.h * (1 - m * 2)) {
      h = rect.h * (1 - m * 2);
      w = h * ratio;
    }
    const left = rect.left + (rect.w - w) / 2;
    const top = rect.top + (rect.h - h) / 2;
    return [
      { x: left, y: top },
      { x: left + w, y: top },
      { x: left + w, y: top + h },
      { x: left, y: top + h }
    ];
  },

  async layoutAdjust(hasQuad, quad) {
    const a = this.adj;
    if (!a) return;
    const preset = PRESETS[this.data.presetIndex];

    const stage = await this.measureAdjStage();
    if (!stage || !this.adj) return;

    const pad = 18;
    const scale = Math.min(
      (stage.width - pad * 2) / a.sw,
      (stage.height - pad * 2) / a.sh
    );
    const w = a.sw * scale;
    const h = a.sh * scale;
    const rect = { left: (stage.width - w) / 2, top: (stage.height - h) / 2, w, h };

    this.adjStage = { left: stage.left, top: stage.top, width: stage.width, height: stage.height };
    this.adjDisplay = rect;

    if (hasQuad && quad) {
      // 源像素坐标 → 展示坐标
      a.quad = quad.map((p) => ({
        x: rect.left + (p.x / a.sw) * w,
        y: rect.top + (p.y / a.sh) * h
      }));
    } else {
      a.quad = this.defaultQuad(rect, preset.ratio);
      wx.showToast({ title: '没识别到边线，请拖动四角', icon: 'none' });
    }

    this.setData({ adjRect: rect }, () => this.syncAdjust());
  },

  syncAdjust() {
    const a = this.adj;
    if (!a || !a.quad) return;
    const q = a.quad;
    const lines = [];
    for (let i = 0; i < 4; i++) {
      const p = q[i];
      const n = q[(i + 1) % 4];
      const dx = n.x - p.x;
      const dy = n.y - p.y;
      lines.push({
        idx: i,
        x: p.x,
        y: p.y,
        w: Math.sqrt(dx * dx + dy * dy),
        rot: (Math.atan2(dy, dx) * 180) / Math.PI
      });
    }
    this.setData({
      adjLines: lines,
      adjDots: q.map((p, i) => ({ idx: i, x: p.x, y: p.y }))
    });
  },

  onAdjStart(e) {
    this.adjDrag = Number(e.currentTarget.dataset.i);
  },

  onAdjMove(e) {
    const a = this.adj;
    const d = this.adjDisplay;
    const st = this.adjStage;
    if (!a || !d || !st || this.adjDrag < 0) return;
    const touch = e.touches && e.touches[0];
    if (!touch) return;

    let x = touch.clientX - st.left;
    let y = touch.clientY - st.top;
    if (x < d.left) x = d.left;
    else if (x > d.left + d.w) x = d.left + d.w;
    if (y < d.top) y = d.top;
    else if (y > d.top + d.h) y = d.top + d.h;

    a.quad[this.adjDrag] = {
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10
    };
    this.syncAdjust();
  },

  onAdjEnd() {
    this.adjDrag = -1;
  },

  onAdjRedetect() {
    const a = this.adj;
    const d = this.adjDisplay;
    if (!a || !d) return;
    let quad = null;
    try {
      quad = detect.detectQuad(a.srcData, a.sw, a.sh);
    } catch (e) {
      quad = null;
    }
    if (!quad) {
      wx.showToast({ title: '没识别到边线，请手动拖动', icon: 'none' });
      return;
    }
    a.quad = quad.map((p) => ({
      x: d.left + (p.x / a.sw) * d.w,
      y: d.top + (p.y / a.sh) * d.h
    }));
    this.syncAdjust();
    wx.showToast({ title: '已重新识别', icon: 'none' });
  },

  onAdjCancel() {
    this.adj = null;
    this.adjDrag = -1;
    this.adjDisplay = null;
    this.setData({ adjVisible: false, adjPath: '', adjLines: [], adjDots: [] });
  },

  async onAdjConfirm() {
    const a = this.adj;
    const d = this.adjDisplay;
    if (!a || !d || this.data.busy) return;
    this.setData({ busy: true });
    wx.showLoading({ title: '矫正中', mask: true });

    try {
      const preset = PRESETS[this.data.presetIndex];
      const outW = CARD_W;
      const outH = Math.round(CARD_W / preset.ratio);

      const quad = a.quad.map((p) => ({
        x: Math.min(Math.max(((p.x - d.left) / d.w) * a.sw, 0), a.sw - 1),
        y: Math.min(Math.max(((p.y - d.top) / d.h) * a.sh, 0), a.sh - 1)
      }));

      const pixels = perspective.warp(a.srcData, a.sw, a.sh, quad, outW, outH);

      const canvas = await this.getCanvas('#cv');
      canvas.width = outW;
      canvas.height = outH;
      const outCtx = canvas.getContext('2d');
      const imageData = outCtx.createImageData(outW, outH);
      imageData.data.set(pixels);
      outCtx.putImageData(imageData, 0, 0);

      const tempPath = await this.exportCanvas(canvas, outW, outH, 0.92);
      this.setSlot(a.index, tempPath);

      this.adj = null;
      this.adjDrag = -1;
      this.adjDisplay = null;
      this.setData({ adjVisible: false, adjPath: '', adjLines: [], adjDots: [], busy: false });
      wx.hideLoading();
    } catch (e) {
      wx.hideLoading();
      this.setData({ busy: false });
      wx.showModal({
        title: '处理失败',
        content: (e && (e.errMsg || e.message)) || '请重试',
        showCancel: false
      });
    }
  },

  noop() {},

  setSlot(index, path) {
    const slots = this.data.slots.map((slot, i) => {
      if (i !== index) return slot;
      return { key: slot.key, label: slot.label, path };
    });
    const readyCount = slots.filter((slot) => !!slot.path).length;
    this.setData({ slots, readyCount });
  },

  async onCompose() {
    if (this.data.busy) return;
    const slots = this.data.slots.filter((slot) => !!slot.path);
    if (!slots.length) {
      wx.showToast({ title: '请先拍至少一张', icon: 'none' });
      return;
    }

    this.setData({ busy: true });
    wx.showLoading({ title: '合成 A4 页面', mask: true });

    try {
      const preset = PRESETS[this.data.presetIndex];
      const canvas = await this.getCanvas('#cv');
      canvas.width = A4_W;
      canvas.height = A4_H;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, A4_W, A4_H);

      const drawW = DRAW_W;
      const drawH = Math.round(DRAW_W / preset.ratio);
      // 只拍一张时就单张居中，两张都拍时上下排在同一页
      const totalH = drawH * slots.length + GAP * (slots.length - 1);
      let y = Math.round((A4_H - totalH) / 2);
      const x = Math.round((A4_W - drawW) / 2);

      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        const img = await this.loadImage(canvas, slot.path);

        ctx.fillStyle = '#8a97a8';
        ctx.font = '30px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(preset.label + ' · ' + slot.label, A4_W / 2, y - 26);

        ctx.drawImage(img, x, y, drawW, drawH);
        ctx.strokeStyle = '#e2e8f2';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, drawW, drawH);

        y += drawH + GAP;
      }

      const tempPath = await this.exportCanvas(canvas, A4_W, A4_H, 0.92);
      const out = this.persist(tempPath);

      wx.hideLoading();
      this.setData({ busy: false });

      if (this.ec) this.ec.emit('onCard', { out, w: A4_W, h: A4_H });
      wx.navigateBack();
    } catch (e) {
      wx.hideLoading();
      this.setData({ busy: false });
      wx.showModal({
        title: '合成失败',
        content: (e && (e.errMsg || e.message)) || '请重试',
        showCancel: false
      });
    }
  },

  // 把临时文件落到用户数据目录，避免被系统清理
  persist(tempPath) {
    const fs = wx.getFileSystemManager();
    const dir = `${wx.env.USER_DATA_PATH}/scan_pages`;
    try {
      fs.accessSync(dir);
    } catch (e) {
      fs.mkdirSync(dir, true);
    }
    const path = `${dir}/card_${Date.now()}.jpg`;
    fs.copyFileSync(tempPath, path);
    return path;
  }
});

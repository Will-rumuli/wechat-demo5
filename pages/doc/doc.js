const { buildPdf } = require('../../utils/pdf');
const store = require('../../utils/store');

const MAX_PAGES = store.MAX_PAGES;

const FILTER_LABEL = {
  original: '原色',
  enhance: '增强',
  bw: '黑白文档'
};

const QUALITY = {
  high: { longSide: 0, quality: 1 },
  normal: { longSide: 1400, quality: 0.72 },
  low: { longSide: 1000, quality: 0.55 }
};

Page({
  data: {
    docId: '',
    docName: '',
    pages: [],
    editing: false,
    selectedCount: 0,
    dragging: false,
    dragIndex: -1,
    ghost: null,
    exporting: false,
    lastPdf: '',
    showExport: false,
    opt: {
      size: 'a4',
      quality: 'high',
      pageNo: true,
      fileName: ''
    }
  },

  onLoad(options) {
    const id = (options && options.id) || '';
    const doc = id ? store.getDoc(id) : null;
    if (!doc) {
      wx.showToast({ title: '扫描册不存在', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 600);
      return;
    }
    this.docId = doc.id;
    this.setData({ docId: doc.id, docName: doc.name, pages: doc.pages });
    wx.setNavigationBarTitle({ title: doc.name });
  },

  // 页数据落盘（去掉仅用于多选态的 checked 字段）
  savePages() {
    const pages = this.data.pages.map((page) => {
      const copy = Object.assign({}, page);
      delete copy.checked;
      return copy;
    });
    store.setPages(this.docId, pages);
  },

  onRename() {
    wx.showModal({
      title: '重命名扫描册',
      editable: true,
      placeholderText: '输入名称',
      content: this.data.docName,
      success: (res) => {
        if (!res.confirm) return;
        const name = (res.content || '').trim();
        if (!name) {
          wx.showToast({ title: '名称不能为空', icon: 'none' });
          return;
        }
        store.renameDoc(this.docId, name);
        this.setData({ docName: name });
        wx.setNavigationBarTitle({ title: name });
      }
    });
  },

  onAdd() {
    if (this.data.pages.length >= MAX_PAGES) {
      wx.showToast({ title: `最多 ${MAX_PAGES} 页`, icon: 'none' });
      return;
    }
    wx.showActionSheet({
      itemList: ['拍照扫描', '从相册选择', '证件扫描（正反面）'],
      success: (res) => {
        if (res.tapIndex === 2) this.openCard();
        else this.pickImages(res.tapIndex === 0 ? 'camera' : 'album');
      }
    });
  },

  onCamera() {
    this.pickImages('camera');
  },

  onAlbum() {
    this.pickImages('album');
  },

  pickImages(source) {
    const remain = MAX_PAGES - this.data.pages.length;
    if (remain <= 0) {
      wx.showToast({ title: `最多 ${MAX_PAGES} 页`, icon: 'none' });
      return;
    }

    wx.chooseMedia({
      count: source === 'camera' ? 1 : Math.min(9, remain),
      mediaType: ['image'],
      sourceType: [source],
      sizeType: ['original'],
      success: (res) => {
        const images = (res.tempFiles || []).map((file) => file.tempFilePath);
        if (images.length) this.openCrop(images);
      },
      fail: (err) => {
        const msg = (err && err.errMsg) || '';
        if (msg.indexOf('cancel') >= 0) return;
        wx.showModal({
          title: '无法选择图片',
          content:
            '请检查相机/相册权限是否开启；若提示 errno 112，请在微信公众平台「用户隐私保护指引」中声明「选中的照片或视频信息」。',
          showCancel: false
        });
      }
    });
  },

  openCrop(images, targetId, quads) {
    wx.navigateTo({
      url: '/pages/crop/crop',
      events: {
        onDone: (payload) => this.appendPage(payload)
      },
      success: (res) => {
        res.eventChannel.emit('init', {
          images,
          targetId: targetId || '',
          quads: quads || null
        });
      }
    });
  },

  openCard() {
    if (this.data.pages.length >= MAX_PAGES) {
      wx.showToast({ title: `最多 ${MAX_PAGES} 页`, icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: '/pages/card/card',
      events: {
        onCard: (payload) => this.appendCard(payload)
      }
    });
  },

  appendCard(payload) {
    if (!payload || !payload.out) return;
    const item = {
      id: 'card_' + Date.now().toString(36),
      src: payload.out,
      out: payload.out,
      w: payload.w,
      h: payload.h,
      filter: 'original',
      filterLabel: '证件',
      quad: null
    };
    const list = this.data.pages.concat(item);
    this.setData({ pages: list, lastPdf: '' });
    this.savePages();
  },

  appendPage(payload) {
    if (!payload || !payload.out) return;
    const list = this.data.pages.map((page) => Object.assign({}, page));
    const item = {
      id: payload.id,
      src: payload.src,
      out: payload.out,
      w: payload.w,
      h: payload.h,
      filter: payload.filter,
      filterLabel: FILTER_LABEL[payload.filter] || '原色',
      quad: payload.quad || null
    };

    if (payload.targetId) {
      const index = list.findIndex((page) => page.id === payload.targetId);
      if (index >= 0) {
        item.id = payload.targetId;
        list[index] = item;
      } else {
        list.push(item);
      }
    } else {
      list.push(item);
    }

    this.setData({ pages: list, lastPdf: '' });
    this.savePages();
  },

  onTapPage(e) {
    if (this.justDragged) return;
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.pages[index];
    if (!item) return;

    if (this.data.editing) {
      this.toggleSelect(index);
      return;
    }

    wx.showActionSheet({
      itemList: ['预览大图', '重新裁剪', '设为册封面', '保存到相册', '删除'],
      success: (res) => {
        if (res.tapIndex === 0) {
          wx.previewImage({
            urls: this.data.pages.map((page) => page.out),
            current: item.out
          });
        } else if (res.tapIndex === 1) {
          this.openCrop([item.src || item.out], item.id, item.quad ? [item.quad] : null);
        } else if (res.tapIndex === 2) {
          store.setCover(this.docId, item.out);
          wx.showToast({ title: '已设为封面', icon: 'success' });
        } else if (res.tapIndex === 3) {
          this.saveImage(item.out);
        } else if (res.tapIndex === 4) {
          this.deleteAt(index);
        }
      }
    });
  },

  deleteAt(index) {
    const list = this.data.pages.slice();
    const removed = list.splice(index, 1);
    this.setData({ pages: list, selectedCount: this.countChecked(list), lastPdf: '' });
    this.savePages();
    store.removeFiles(removed);
  },

  saveImage(filePath) {
    wx.saveImageToPhotosAlbum({
      filePath,
      success: () => {
        wx.showToast({ title: '已保存到相册', icon: 'success' });
      },
      fail: (err) => {
        const msg = (err && err.errMsg) || '';
        if (msg.indexOf('auth deny') >= 0 || msg.indexOf('authorize') >= 0) {
          wx.showModal({
            title: '需要相册权限',
            content: '请在右上角「···」-「设置」中允许保存到相册后重试。',
            showCancel: false
          });
        } else if (msg.indexOf('112') >= 0) {
          wx.showModal({
            title: '隐私声明未生效',
            content: '请在微信公众平台「用户隐私保护指引」中声明「相册（仅写入）权限」。',
            showCancel: false
          });
        } else if (msg.indexOf('cancel') < 0) {
          wx.showToast({ title: '保存失败', icon: 'none' });
        }
      }
    });
  },

  // ===== 多选管理 =====

  countChecked(list) {
    return (list || this.data.pages).filter((page) => page.checked).length;
  },

  toggleSelect(index) {
    const list = this.data.pages.slice();
    const item = Object.assign({}, list[index]);
    item.checked = !item.checked;
    list[index] = item;
    this.setData({ pages: list, selectedCount: this.countChecked(list) });
  },

  onManage() {
    this.setData({ editing: true, selectedCount: this.countChecked() });
  },

  onExitManage() {
    const list = this.data.pages.map((page) => {
      const copy = Object.assign({}, page);
      delete copy.checked;
      return copy;
    });
    this.setData({ pages: list, editing: false, selectedCount: 0 });
  },

  onSelectAll() {
    const all = this.data.selectedCount < this.data.pages.length;
    const list = this.data.pages.map((page) => {
      const copy = Object.assign({}, page);
      copy.checked = all;
      return copy;
    });
    this.setData({ pages: list, selectedCount: all ? list.length : 0 });
  },

  onDeleteSelected() {
    const count = this.data.selectedCount;
    if (!count) {
      wx.showToast({ title: '请先选择页面', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '删除所选页面',
      content: `确定删除 ${count} 页吗？删除后不可恢复。`,
      confirmText: '删除',
      confirmColor: '#d93f3f',
      success: (res) => {
        if (!res.confirm) return;
        const removed = [];
        const list = [];
        this.data.pages.forEach((page) => {
          if (page.checked) {
            removed.push(page);
            return;
          }
          const copy = Object.assign({}, page);
          delete copy.checked;
          list.push(copy);
        });
        this.setData({ pages: list, editing: false, selectedCount: 0, lastPdf: '' });
        this.savePages();
        store.removeFiles(removed);
      }
    });
  },

  // ===== 长按拖拽排序 =====

  measureCards() {
    return new Promise((resolve) => {
      wx.createSelectorQuery()
        .in(this)
        .selectAll('.page-card')
        .boundingClientRect((rects) => resolve(rects || []))
        .exec();
    });
  },

  async onDragStart(e) {
    if (this.data.editing || this.data.exporting || !this.data.pages.length) return;
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.pages[index];
    if (!item) return;

    this.pendingDrag = true;
    const rects = await this.measureCards();
    if (!rects.length || !this.pendingDrag || !rects[index]) return;

    if (this.ghostTimer) {
      clearTimeout(this.ghostTimer);
      this.ghostTimer = null;
    }
    const touch = e.touches && e.touches[0];
    this.cardRects = rects;
    this.dragIndex = index;
    this.dragging = true;
    this.orderChanged = false;
    this.setData({
      dragging: true,
      dragIndex: index,
      ghost: {
        x: touch ? touch.clientX : rects[index].left + rects[index].width / 2,
        y: touch ? touch.clientY : rects[index].top + rects[index].height / 2,
        w: rects[index].width,
        h: rects[index].height,
        src: item.out
      }
    });
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light' });
  },

  onDragMove(e) {
    if (!this.dragging) return;
    const touch = e.touches && e.touches[0];
    if (!touch) return;

    const rects = this.cardRects || [];
    let target = this.dragIndex;
    let best = Infinity;
    for (let i = 0; i < rects.length; i++) {
      const rect = rects[i];
      const dx = touch.clientX - (rect.left + rect.width / 2);
      const dy = touch.clientY - (rect.top + rect.height / 2);
      const dist = dx * dx + dy * dy;
      if (dist < best) {
        best = dist;
        target = i;
      }
    }

    const ghost = Object.assign({}, this.data.ghost, {
      x: touch.clientX,
      y: touch.clientY
    });

    if (target !== this.dragIndex && rects.length) {
      const limit = Math.max(rects[0].width, rects[0].height) * 0.9;
      if (Math.sqrt(best) < limit) {
        const list = this.data.pages.slice();
        const moved = list.splice(this.dragIndex, 1)[0];
        list.splice(target, 0, moved);
        this.dragIndex = target;
        this.orderChanged = true;
        this.setData({ pages: list, dragIndex: target, ghost });
        return;
      }
    }

    this.setData({ ghost });
  },

  onDragEnd() {
    this.pendingDrag = false;
    if (!this.dragging) return;
    this.dragging = false;
    this.justDragged = true;
    if (this.orderChanged) {
      this.setData({ dragging: false, lastPdf: '' });
      this.savePages();
    } else {
      this.setData({ dragging: false });
    }
    this.ghostTimer = setTimeout(() => {
      this.ghostTimer = null;
      this.justDragged = false;
      this.setData({ dragIndex: -1, ghost: null });
    }, 120);
  },

  // ===== 导出 =====

  onExport() {
    if (this.data.exporting) return;
    if (!this.data.pages.length) {
      wx.showToast({ title: '请先添加页面', icon: 'none' });
      return;
    }
    this.setData({
      showExport: true,
      'opt.fileName': this.data.opt.fileName || this.data.docName
    });
  },

  onCloseExport() {
    this.setData({ showExport: false });
  },

  onPickSize(e) {
    this.setData({ 'opt.size': e.currentTarget.dataset.key });
  },

  onPickQuality(e) {
    this.setData({ 'opt.quality': e.currentTarget.dataset.key });
  },

  onTogglePageNo(e) {
    this.setData({ 'opt.pageNo': !!e.detail.value });
  },

  onFileName(e) {
    this.setData({ 'opt.fileName': e.detail.value });
  },

  noop() {},

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

  // 按清晰度重编码；高清直接沿用原图
  async packPages(pages, quality) {
    const conf = QUALITY[quality] || QUALITY.high;
    if (!conf.longSide) return pages.map((page) => page.out);

    const canvas = await this.getCanvas('#packer');
    const files = [];

    for (let i = 0; i < pages.length; i++) {
      const size = await this.imageSize(pages[i].out);
      const longSide = Math.max(size.width, size.height) || 1;
      const scale = longSide > conf.longSide ? conf.longSide / longSide : 1;
      const w = Math.max(1, Math.round(size.width * scale));
      const h = Math.max(1, Math.round(size.height * scale));

      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      const img = canvas.createImage();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('图片解码失败'));
        img.src = pages[i].out;
      });
      ctx.drawImage(img, 0, 0, w, h);

      const path = await new Promise((resolve, reject) => {
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
            quality: conf.quality,
            success: (res) => resolve(res.tempFilePath),
            fail: reject
          },
          this
        );
      });
      files.push(path);
    }
    return files;
  },

  async onStartExport() {
    if (this.data.exporting) return;
    const opt = this.data.opt;
    const pages = this.data.pages;
    const rawName = (opt.fileName || this.data.docName || '扫描册').trim();
    const safeName = rawName.replace(/[\\/:*?"<>|]/g, '_') || '扫描册';

    this.setData({ showExport: false, exporting: true });
    wx.showLoading({ title: '生成 PDF', mask: true });

    try {
      const files = await this.packPages(pages, opt.quality);
      const fs = wx.getFileSystemManager();
      const items = files.map((path) => ({ bytes: new Uint8Array(fs.readFileSync(path)) }));
      const pdf = buildPdf(items, { pageSize: opt.size, pageNo: opt.pageNo });

      const dir = `${wx.env.USER_DATA_PATH}/pdf`;
      try {
        fs.accessSync(dir);
      } catch (e) {
        fs.mkdirSync(dir, true);
      }
      const path = `${dir}/${safeName}_${Date.now()}.pdf`;
      fs.writeFileSync(path, pdf.buffer);

      wx.hideLoading();
      this.setData({ exporting: false, lastPdf: path });
      wx.openDocument({
        filePath: path,
        fileType: 'pdf',
        showMenu: true,
        fail: () => {
          wx.showToast({ title: '打开失败，可点「发送」转发', icon: 'none' });
        }
      });
    } catch (e) {
      wx.hideLoading();
      this.setData({ exporting: false });
      wx.showModal({
        title: '生成失败',
        content: (e && (e.errMsg || e.message)) || '请重试',
        showCancel: false
      });
    }
  },

  onOpenLast() {
    if (!this.data.lastPdf) return;
    wx.openDocument({
      filePath: this.data.lastPdf,
      fileType: 'pdf',
      showMenu: true
    });
  },

  onSharePdf() {
    if (!this.data.lastPdf) return;
    const name = (this.data.opt.fileName || this.data.docName || '扫描件').trim();
    wx.showModal({
      title: '发送前确认',
      content: '文件里可能包含证件等敏感信息，发送后对方可保存或转发。确认发送？',
      confirmText: '确认发送',
      success: (res) => {
        if (!res.confirm) return;
        wx.shareFileMessage({
          filePath: this.data.lastPdf,
          fileName: `${name}.pdf`,
          fail: (err) => {
            const msg = (err && err.errMsg) || '';
            if (msg.indexOf('cancel') >= 0) return;
            wx.showToast({ title: '当前环境不支持发送文件', icon: 'none' });
          }
        });
      }
    });
  }
});

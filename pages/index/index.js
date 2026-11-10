const store = require('../../utils/store');

function pad2(num) {
  return num < 10 ? '0' + num : '' + num;
}

function formatTime(ts) {
  const date = new Date(ts || Date.now());
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const hm = pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  if (sameDay) return '今天 ' + hm;
  const day =
    (date.getFullYear() === now.getFullYear() ? '' : date.getFullYear() + '-') +
    pad2(date.getMonth() + 1) +
    '-' +
    pad2(date.getDate());
  return day + ' ' + hm;
}

function monthOf(ts) {
  const date = new Date(ts || Date.now());
  return {
    key: date.getFullYear() + '-' + pad2(date.getMonth() + 1),
    label: date.getFullYear() + '年' + (date.getMonth() + 1) + '月'
  };
}

Page({
  data: {
    docs: [],
    groups: [],
    keyword: ''
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    this.allDocs = store
      .listDocs()
      .map((doc) => {
        const ts = doc.updatedAt || doc.createdAt;
        const month = monthOf(ts);
        return {
          id: doc.id,
          name: doc.name,
          count: doc.pages.length,
          cover: doc.cover || (doc.pages.length ? doc.pages[0].out : ''),
          timeText: formatTime(ts),
          updatedAt: ts,
          month: month.key,
          monthLabel: month.label,
          searchKey: doc.name.toLowerCase()
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);

    this.applyFilter(this.data.keyword);
  },

  applyFilter(keyword) {
    const kw = (keyword || '').trim().toLowerCase();
    const list = kw ? this.allDocs.filter((doc) => doc.searchKey.indexOf(kw) >= 0) : this.allDocs;

    const groups = [];
    const map = {};
    list.forEach((doc) => {
      let group = map[doc.month];
      if (!group) {
        group = { month: doc.month, label: doc.monthLabel, docs: [] };
        map[doc.month] = group;
        groups.push(group);
      }
      group.docs.push(doc);
    });

    this.setData({ docs: this.allDocs, groups, keyword: keyword || '' });
  },

  onSearch(e) {
    this.applyFilter(e.detail.value);
  },

  onClearSearch() {
    this.applyFilter('');
  },

  onCreate() {
    const doc = store.createDoc();
    wx.navigateTo({ url: '/pages/doc/doc?id=' + doc.id });
  },

  onOpen(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/doc/doc?id=' + id });
  },

  onMore(e) {
    const id = e.currentTarget.dataset.id;
    wx.showActionSheet({
      itemList: ['重命名', '删除'],
      success: (res) => {
        if (res.tapIndex === 0) this.renameDoc(id);
        else if (res.tapIndex === 1) this.removeDoc(id);
      }
    });
  },

  renameDoc(id) {
    const doc = store.getDoc(id);
    if (!doc) return;
    wx.showModal({
      title: '重命名扫描册',
      editable: true,
      placeholderText: '输入名称',
      content: doc.name,
      success: (res) => {
        if (!res.confirm) return;
        const name = (res.content || '').trim();
        if (!name) {
          wx.showToast({ title: '名称不能为空', icon: 'none' });
          return;
        }
        store.renameDoc(id, name);
        this.refresh();
      }
    });
  },

  removeDoc(id) {
    wx.showModal({
      title: '删除扫描册',
      content: '删除后该册已扫描的页面会一并移除，确定吗？',
      confirmText: '删除',
      confirmColor: '#d93f3f',
      success: (res) => {
        if (!res.confirm) return;
        store.removeDoc(id);
        this.refresh();
      }
    });
  }
});

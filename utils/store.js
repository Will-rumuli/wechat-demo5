/**
 * 扫描册存储
 * 结构：scan_docs_v1 = [{ id, name, createdAt, updatedAt, cover, pages: [] }]
 * 兼容旧版单册数据 scan_pages_v1（首次读取时自动迁移为一册）
 */

const DOCS_KEY = 'scan_docs_v1';
const LEGACY_KEY = 'scan_pages_v1';

const MAX_PAGES = 60;

function genId() {
  return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function readDocs() {
  try {
    const val = wx.getStorageSync(DOCS_KEY);
    return Array.isArray(val) ? val : null;
  } catch (e) {
    return null;
  }
}

function writeDocs(docs) {
  try {
    wx.setStorageSync(DOCS_KEY, docs);
    return true;
  } catch (e) {
    return false;
  }
}

function exists(path) {
  if (!path) return false;
  try {
    wx.getFileSystemManager().accessSync(path);
    return true;
  } catch (e) {
    return false;
  }
}

function prunePages(pages) {
  if (!Array.isArray(pages)) return [];
  return pages.filter((page) => page && page.out && exists(page.out));
}

// 旧版单册数据迁移
function migrate() {
  let legacy = [];
  try {
    const val = wx.getStorageSync(LEGACY_KEY);
    if (Array.isArray(val)) legacy = val;
  } catch (e) {
    legacy = [];
  }

  const docs = [];
  if (legacy.length) {
    docs.push({
      id: genId(),
      name: '我的扫描册',
      createdAt: legacy[0].createdAt || Date.now(),
      updatedAt: Date.now(),
      pages: legacy
    });
  }

  writeDocs(docs);
  try {
    wx.removeStorageSync(LEGACY_KEY);
  } catch (e) {
    // 忽略清理异常
  }
  return docs;
}

function listDocs() {
  let docs = readDocs();
  if (!docs) docs = migrate();

  let changed = false;
  const result = [];
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    if (!doc || !doc.id) {
      changed = true;
      continue;
    }
    const pages = prunePages(doc.pages);
    if (pages.length !== (doc.pages ? doc.pages.length : 0)) changed = true;
    const cover = doc.cover && exists(doc.cover) ? doc.cover : '';
    if (!!doc.cover !== !!cover) changed = true;
    result.push({
      id: doc.id,
      name: doc.name || '未命名扫描册',
      createdAt: doc.createdAt || Date.now(),
      updatedAt: doc.updatedAt || doc.createdAt || Date.now(),
      cover,
      pages
    });
  }

  if (changed) writeDocs(result);
  return result;
}

function getDoc(id) {
  const docs = listDocs();
  for (let i = 0; i < docs.length; i++) {
    if (docs[i].id === id) return docs[i];
  }
  return null;
}

function createDoc(name) {
  const docs = listDocs();
  const doc = {
    id: genId(),
    name: name || `扫描册 ${docs.length + 1}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    cover: '',
    pages: []
  };
  docs.unshift(doc);
  writeDocs(docs);
  return doc;
}

function saveDoc(doc) {
  if (!doc || !doc.id) return null;
  const docs = listDocs();
  const next = {
    id: doc.id,
    name: doc.name || '未命名扫描册',
    createdAt: doc.createdAt || Date.now(),
    updatedAt: Date.now(),
    cover: doc.cover && exists(doc.cover) ? doc.cover : '',
    pages: prunePages(doc.pages)
  };
  let found = false;
  for (let i = 0; i < docs.length; i++) {
    if (docs[i].id === doc.id) {
      docs[i] = next;
      found = true;
      break;
    }
  }
  if (!found) docs.unshift(next);
  writeDocs(docs);
  return next;
}

function setPages(id, pages) {
  const doc = getDoc(id);
  if (!doc) return null;
  doc.pages = pages || [];
  return saveDoc(doc);
}

function renameDoc(id, name) {
  const doc = getDoc(id);
  if (!doc) return null;
  doc.name = name;
  return saveDoc(doc);
}

function setCover(id, path) {
  const doc = getDoc(id);
  if (!doc) return null;
  doc.cover = path || '';
  return saveDoc(doc);
}

function removeFiles(pages) {
  if (!Array.isArray(pages)) return;
  const fs = wx.getFileSystemManager();
  pages.forEach((page) => {
    [page && page.out, page && page.src].forEach((path) => {
      if (!path) return;
      try {
        fs.unlinkSync(path);
      } catch (e) {
        // 文件不存在时忽略
      }
    });
  });
}

function removeDoc(id) {
  const docs = listDocs();
  const keep = [];
  for (let i = 0; i < docs.length; i++) {
    if (docs[i].id === id) {
      removeFiles(docs[i].pages);
      if (docs[i].cover) removeFiles([{ out: docs[i].cover }]);
    } else {
      keep.push(docs[i]);
    }
  }
  writeDocs(keep);
  return keep;
}

module.exports = {
  MAX_PAGES,
  listDocs,
  getDoc,
  createDoc,
  saveDoc,
  setPages,
  renameDoc,
  setCover,
  removeDoc,
  removeFiles
};

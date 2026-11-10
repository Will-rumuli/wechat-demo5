/**
 * 最小 PDF 生成器
 * 每页嵌入一张 JPEG（DCTDecode 直通，不做二次编码）
 * 支持 A4 等比居中 / 原始比例自适应，可选底部页码
 */

const A4_W = 595.28;
const A4_H = 841.89;
const MARGIN = 22;
const FONT_SIZE = 9;
const NUMBER_BAND = 22;

function ascii(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

function pad10(num) {
  let s = String(num);
  while (s.length < 10) s = '0' + s;
  return s;
}

function fixed(num) {
  return (Math.round(num * 100) / 100).toFixed(2);
}

// Helvetica 字宽近似（千分之一 em），只用于页码居中
function textWidth(text) {
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch >= '0' && ch <= '9') w += 556;
    else if (ch === ' ') w += 278;
    else if (ch === '/') w += 278;
    else w += 500;
  }
  return (w / 1000) * FONT_SIZE;
}

/**
 * 从 JPEG 字节流解析宽高
 * @param {Uint8Array} bytes
 */
function parseJpegSize(bytes) {
  let i = 2;
  while (i < bytes.length - 8) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof) {
      return {
        height: (bytes[i + 5] << 8) | bytes[i + 6],
        width: (bytes[i + 7] << 8) | bytes[i + 8]
      };
    }
    i += 2 + len;
  }
  return { width: 1240, height: 1754 };
}

/**
 * 生成 PDF 字节流
 * @param {Array<{bytes: Uint8Array}>} items 每页图片
 * @param {{pageSize?: 'a4'|'fit', pageNo?: boolean}} options
 * @returns {Uint8Array}
 */
function buildPdf(items, options) {
  const opts = options || {};
  const fit = opts.pageSize === 'fit';
  const pageNo = !!opts.pageNo;

  const chunks = [];
  let length = 0;
  const offsets = [];

  const push = (u8) => {
    chunks.push(u8);
    length += u8.length;
  };
  const str = (s) => push(ascii(s));
  const beginObj = (num) => {
    offsets[num] = length;
    str(num + ' 0 obj\n');
  };
  const endObj = () => str('endobj\n');

  str('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const count = items.length;

  // 对象编号：1 目录、2 页面树、3 字体（可选），之后每页 3 个对象
  let cursor = 3;
  const fontNum = pageNo ? cursor++ : 0;
  const pageObjs = [];
  for (let i = 0; i < count; i++) {
    pageObjs.push({ page: cursor, content: cursor + 1, image: cursor + 2 });
    cursor += 3;
  }
  const total = cursor - 1;

  const kids = pageObjs.map((obj) => obj.page + ' 0 R');

  beginObj(1);
  str('<< /Type /Catalog /Pages 2 0 R >>\n');
  endObj();

  beginObj(2);
  str('<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + count + ' >>\n');
  endObj();

  if (pageNo) {
    beginObj(fontNum);
    str('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\n');
    endObj();
  }

  for (let i = 0; i < count; i++) {
    const bytes = items[i].bytes;
    const size = parseJpegSize(bytes);
    const nums = pageObjs[i];

    let pageW;
    let pageH;
    let drawX;
    let drawY;
    let drawW;
    let drawH;

    if (fit) {
      pageW = A4_W;
      const ratio = size.height / (size.width || 1);
      const contentH = Math.round(A4_W * ratio * 100) / 100;
      const band = pageNo ? NUMBER_BAND : 0;
      pageH = contentH + band;
      drawX = 0;
      drawY = band;
      drawW = pageW;
      drawH = contentH;
    } else {
      pageW = A4_W;
      pageH = A4_H;
      const availW = pageW - MARGIN * 2;
      const availH = pageH - MARGIN * 2;
      const scale = Math.min(availW / size.width, availH / size.height);
      drawW = size.width * scale;
      drawH = size.height * scale;
      drawX = (pageW - drawW) / 2;
      drawY = (pageH - drawH) / 2;
    }

    let content =
      'q\n' +
      fixed(drawW) +
      ' 0 0 ' +
      fixed(drawH) +
      ' ' +
      fixed(drawX) +
      ' ' +
      fixed(drawY) +
      ' cm\n/Im0 Do\nQ';

    if (pageNo) {
      const text = i + 1 + ' / ' + count;
      const tw = textWidth(text);
      const tx = (pageW - tw) / 2;
      const ty = fit ? 7 : 9;
      content +=
        '\nBT\n/F1 ' +
        FONT_SIZE +
        ' Tf\n0.35 0.35 0.35 rg\n1 0 0 1 ' +
        fixed(tx) +
        ' ' +
        fixed(ty) +
        ' Tm\n(' +
        text +
        ') Tj\nET';
    }

    const fontRes = pageNo ? ' /Font << /F1 ' + fontNum + ' 0 R >>' : '';
    const procSet = pageNo ? '[/PDF /ImageC /Text]' : '[/PDF /ImageC]';

    beginObj(nums.page);
    str(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' +
        fixed(pageW) +
        ' ' +
        fixed(pageH) +
        '] /Resources << /XObject << /Im0 ' +
        nums.image +
        ' 0 R >>' +
        fontRes +
        ' /ProcSet ' +
        procSet +
        ' >> /Contents ' +
        nums.content +
        ' 0 R >>\n'
    );
    endObj();

    beginObj(nums.content);
    str('<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream\n');
    endObj();

    beginObj(nums.image);
    str(
      '<< /Type /XObject /Subtype /Image /Width ' +
        size.width +
        ' /Height ' +
        size.height +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' +
        bytes.length +
        ' >>\nstream\n'
    );
    push(bytes);
    str('\nendstream\n');
    endObj();
  }

  const xrefPos = length;
  str('xref\n0 ' + (total + 1) + '\n');
  str('0000000000 65535 f \n');
  for (let n = 1; n <= total; n++) {
    str(pad10(offsets[n] || 0) + ' 00000 n \n');
  }
  str('trailer\n<< /Size ' + (total + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF');

  let outLen = 0;
  for (let i = 0; i < chunks.length; i++) outLen += chunks[i].length;
  const out = new Uint8Array(outLen);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    out.set(chunks[i], offset);
    offset += chunks[i].length;
  }
  return out;
}

module.exports = {
  buildPdf,
  parseJpegSize
};

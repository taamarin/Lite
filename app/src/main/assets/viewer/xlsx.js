/*
 * Issue #37. Given bytes, SheetJS reads a text file as Latin-1 unless it starts with a UTF-8
 * byte order mark, and a CSV saved as UTF-8 seldom has one, so Флаг came out as Ð¤Ð»Ð°Ð³. A file
 * that is valid UTF-8 goes in already decoded. Anything else goes in as bytes, as it always did:
 * every binary workbook, a UTF-16 file, which SheetJS knows by its mark, and a Latin-1 one.
 *
 * Strict, and both halves of that matter. Decoded leniently, a Latin-1 file reaches SheetJS with
 * its accents turned to U+FFFD, and an .xlsx reaches it as text, which it never finished reading.
 * SheetJS's own codepage: 65001 was no better: it read "Café,Zürich" as "Caf鬚𲩣h".
 *
 * dense has SheetJS keep a sheet's cells in an array for each row rather than in one object keyed
 * by address, and sheet_to_html writes the same table from either. Read in a fresh page in
 * Chromium 151 on a Mac, a workbook of 100,000 rows by ten columns took 1.6 to 1.9 s this way
 * and 2.1 to 2.8 s the other; at 10,000 rows the two were level.
 */
function readWorkbook(bytes) {
  var text = null;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (e) {
    // Not UTF-8
  }
  return text === null
    ? XLSX.read(bytes, { type: "array", cellDates: true, dense: true })
    : XLSX.read(text, { type: "string", cellDates: true, dense: true });
}

/*
 * A large sheet is drawn a piece at a time.
 *
 * Drawn whole, a sheet is one table, and the WebView lays out every cell of it before it shows
 * any. In Chromium 151 on a Mac a sheet of 100,000 rows by ten columns took 17 s to appear, and a
 * minute with the processor slowed four times, about a mid-range phone, with the page frozen all
 * the while. Nor can rows go into that one table a few at a time: each addition has the whole
 * table laid out again, which took seconds once it was 20,000 rows long.
 *
 * So a sheet's rows are cut into pieces of about PIECE_CELLS cells, and each piece is a table of
 * its own. The first is drawn at once. Each of the others stands as an empty block of about its
 * height until the reader scrolls to within a screen of it, so the page is as long as the sheet
 * from the start. Tables laid out apart would size their columns apart, so every piece takes the
 * same widths through its <col> elements: the widths the first piece took by itself, widened when
 * a later piece needs more. A merged range is never cut. A sheet that fits in one piece is one
 * table with no widths set, as every sheet was before.
 */
var PIECE_CELLS = 5000;

/* Rows in a piece, whatever the width of the sheet */
var PIECE_ROWS_MIN = 20;
var PIECE_ROWS_MAX = 500;

/* [range]'s rows in pieces of about PIECE_CELLS cells, none of them ending inside a merged range */
function cutSheet(ws, range) {
  if (!range) return [{ s: 0, e: -1 }];
  var cols = range.e.c - range.s.c + 1;
  var step = Math.max(PIECE_ROWS_MIN, Math.min(PIECE_ROWS_MAX, Math.floor(PIECE_CELLS / cols)));
  var tall = (ws["!merges"] || [])
    .filter(function (m) { return m.e.r > m.s.r; })
    .sort(function (a, b) { return a.s.r - b.s.r; });
  var pieces = [];
  var next = 0;
  for (var r = range.s.r; r <= range.e.r; ) {
    var end = Math.min(r + step - 1, range.e.r);
    // Ranges beginning above this piece ended inside the pieces before it
    while (next < tall.length && tall[next].s.r < r) next++;
    for (var i = next; i < tall.length && tall[i].s.r <= end; i++) {
      if (tall[i].e.r > end) end = Math.min(tall[i].e.r, range.e.r);
    }
    pieces.push({ s: r, e: end });
    r = end + 1;
  }
  return pieces;
}

function Sheet(ws) {
  this.ws = ws;
  this.range = ws["!ref"] ? XLSX.utils.decode_range(ws["!ref"]) : null;
  this.cols = this.range ? this.range.e.c - this.range.s.c + 1 : 0;
  this.pieces = cutSheet(ws, this.range);
  /* Each column's width in CSS px, once the first piece has been laid out; null where unknown */
  this.widths = null;
  /* The width of a piece whose columns are all at those widths */
  this.width = 0;
}

/* The rows from [s] to [e] as sheet_to_html writes them, without the table around them */
Sheet.prototype.rowsHtml = function (s, e) {
  if (e < s) return "";
  var ws = this.ws;
  var ref = ws["!ref"];
  ws["!ref"] = XLSX.utils.encode_range({ s: { r: s, c: this.range.s.c }, e: { r: e, c: this.range.e.c } });
  var html;
  try {
    // An empty header and footer: the defaults are a whole HTML document's, title and all
    html = XLSX.utils.sheet_to_html(ws, { editable: false, header: "", footer: "" });
  } finally {
    ws["!ref"] = ref;
  }
  return html.replace(/^<table[^>]*>/, "").replace(/<\/table>$/, "");
};

/*
 * Piece [k]'s table, made the first time it is asked for, on the page or not: the search reads
 * the pieces it has not been shown yet off the page, and the same table goes onto the page later,
 * so what is searched is what is shown.
 */
Sheet.prototype.table = function (k) {
  var piece = this.pieces[k];
  if (piece.table) return piece.table;
  var t = document.createElement("table");
  t.className = k === 0 ? "vw-top" : "vw-more";
  var cols = "";
  if (this.pieces.length > 1) {
    cols = "<colgroup>";
    for (var c = 0; c < this.cols; c++) cols += '<col style="width: var(--vw-col-' + c + ')">';
    cols += "</colgroup>";
  }
  t.innerHTML = cols + this.rowsHtml(piece.s, piece.e);
  vwDisarmLinks(t);
  this.addImages(t, piece);
  piece.table = t;
  return t;
};

/*
 * The width of each column of [table] as laid out, from a cell that spans that column alone;
 * null for a column every cell of which spans others too. Rows are walked only until every
 * column has one, which is the first row of nearly every sheet.
 */
function columnWidths(table, cols) {
  var widths = [];
  for (var c = 0; c < cols; c++) widths.push(null);
  var found = 0;
  /* How many rows below this one each column is still covered by a cell from above */
  var covered = [];
  var rows = table.rows;
  for (var r = 0; r < rows.length && found < cols; r++) {
    var cells = rows[r].cells;
    var col = 0;
    for (var i = 0; i < cells.length; i++) {
      while (covered[col] > 0) col++;
      var cell = cells[i];
      if (cell.colSpan === 1 && col < cols && widths[col] === null) {
        widths[col] = cell.getBoundingClientRect().width;
        found++;
      }
      if (cell.rowSpan > 1) {
        for (var j = 0; j < cell.colSpan; j++) covered[col + j] = cell.rowSpan;
      }
      col += cell.colSpan;
    }
    for (var k = 0; k < covered.length; k++) if (covered[k] > 0) covered[k]--;
  }
  return widths;
}

/*
 * The pictures of a workbook, for SheetJS reads none: a list for each sheet, in the order of the
 * workbook's sheets, of { row, col, src, w, h } where row and col are the cell a picture is
 * anchored at, src a blob URL and w, h its size in CSS px where the file states one. Whatever
 * cannot be read is left out, and a workbook that is not a zip, or whose pictures cannot be
 * read at all, has none.
 */
function kids(node, name) {
  var out = [];
  for (var n = node.firstElementChild; n; n = n.nextElementSibling) {
    if (n.localName === name) out.push(n);
  }
  return out;
}

function parseXml(text) {
  return new DOMParser().parseFromString(text, "application/xml");
}

function resolvePath(base, target) {
  if (target.charAt(0) === "/") return target.slice(1);
  var parts = base.split("/");
  parts.pop();
  target.split("/").forEach(function (p) {
    if (p === "..") parts.pop();
    else if (p !== ".") parts.push(p);
  });
  return parts.join("/");
}

function relsOf(zip, part) {
  var slash = part.lastIndexOf("/");
  var f = zip.file(part.slice(0, slash + 1) + "_rels/" + part.slice(slash + 1) + ".rels");
  if (!f) return Promise.resolve({});
  return f.async("string").then(function (xml) {
    var map = {};
    Array.prototype.forEach.call(parseXml(xml).getElementsByTagName("Relationship"), function (r) {
      map[r.getAttribute("Id")] = { type: r.getAttribute("Type") || "", path: resolvePath(part, r.getAttribute("Target") || "") };
    });
    return map;
  });
}

var IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp", svg: "image/svg+xml" };

function drawingImages(zip, drawing, urls) {
  var f = zip.file(drawing);
  if (!f) return Promise.resolve([]);
  return Promise.all([f.async("string"), relsOf(zip, drawing)]).then(function (res) {
    var doc = parseXml(res[0]);
    var rels = res[1];
    var jobs = [];
    Array.prototype.forEach.call(doc.documentElement.children, function (anchor) {
      var blip = anchor.getElementsByTagName("*");
      var embed = null;
      for (var i = 0; i < blip.length && !embed; i++) {
        if (blip[i].localName === "blip") {
          embed = blip[i].getAttribute("r:embed") ||
            blip[i].getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "embed");
        }
      }
      var rel = embed && rels[embed];
      if (!rel) return;
      var from = kids(anchor, "from")[0];
      var row = 0;
      var col = 0;
      if (from) {
        var c = kids(from, "col")[0];
        var r = kids(from, "row")[0];
        col = c ? parseInt(c.textContent, 10) || 0 : 0;
        row = r ? parseInt(r.textContent, 10) || 0 : 0;
      }
      var ext = kids(anchor, "ext")[0];
      var w = ext ? Math.round((parseInt(ext.getAttribute("cx"), 10) || 0) / 9525) : 0;
      var h = ext ? Math.round((parseInt(ext.getAttribute("cy"), 10) || 0) / 9525) : 0;
      jobs.push(
        urlFor(zip, rel.path, urls).then(function (src) {
          return src ? { row: row, col: col, src: src, w: w, h: h } : null;
        })
      );
    });
    return Promise.all(jobs);
  });
}

function urlFor(zip, path, urls) {
  if (urls[path]) return urls[path];
  var f = zip.file(path);
  var type = IMAGE_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()];
  urls[path] = f && type
    ? f.async("uint8array").then(function (data) {
        return URL.createObjectURL(new Blob([data], { type: type }));
      })
    : Promise.resolve(null);
  return urls[path];
}

function workbookImages(bytes, names) {
  var none = names.map(function () { return []; });
  if (!window.JSZip || bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return Promise.resolve(none);
  return JSZip.loadAsync(bytes).then(function (zip) {
    var book = zip.file("xl/workbook.xml");
    if (!book) return none;
    var urls = {};
    return Promise.all([book.async("string"), relsOf(zip, "xl/workbook.xml")]).then(function (res) {
      var sheetEls = Array.prototype.filter.call(parseXml(res[0]).getElementsByTagName("*"), function (e) {
        return e.localName === "sheet";
      });
      return Promise.all(
        names.map(function (name) {
          var el = sheetEls.filter(function (e) { return e.getAttribute("name") === name; })[0];
          var id = el && (el.getAttribute("r:id") ||
            el.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id"));
          var rel = id && res[1][id];
          if (!rel) return [];
          return relsOf(zip, rel.path).then(function (sr) {
            var drawings = Object.keys(sr).filter(function (k) { return /\/drawing$/.test(sr[k].type); });
            return Promise.all(drawings.map(function (k) { return drawingImages(zip, sr[k].path, urls); })).then(function (lists) {
              return [].concat.apply([], lists).filter(Boolean);
            });
          });
        })
      );
    });
  }).catch(function () { return none; });
}

/* Each picture goes into the cell it is anchored at; one whose cell is not drawn is put below the rows */
Sheet.prototype.addImages = function (t, piece) {
  var imgs = this.images || [];
  var lastPiece = piece === this.pieces[this.pieces.length - 1];
  imgs.forEach(function (im) {
    var inPiece = im.row >= piece.s && im.row <= piece.e;
    var cell = inPiece ? t.querySelector("#sjs-" + XLSX.utils.encode_cell({ r: im.row, c: im.col })) : null;
    if (!cell && !(lastPiece && im.row > piece.e) && !(inPiece && !cell)) return;
    var img = document.createElement("img");
    img.className = "vw-pic";
    img.src = im.src;
    img.alt = "";
    if (im.w > 0) img.style.width = im.w + "px";
    if (cell) {
      cell.appendChild(img);
    } else {
      var row = t.insertRow(-1);
      var td = row.insertCell(-1);
      td.colSpan = Math.max(1, t.rows[0] ? t.rows[0].cells.length : 1);
      td.appendChild(img);
    }
  });
};

vwFetchDoc("buffer")
  .then(function (buf) {
    var bytes = new Uint8Array(buf);
    var wb = readWorkbook(bytes);
    return workbookImages(bytes, wb.SheetNames).then(function (images) { return { wb: wb, images: images }; });
  })
  .then(function (loaded) {
    var wb = loaded.wb;
    if (!wb.SheetNames.length) throw new Error("The workbook has no sheets");
    var tabs = document.getElementById("tabs");
    var sheetDiv = document.getElementById("sheet");
    var sheets = wb.SheetNames.map(function (sn, i) {
      var sheet = new Sheet(wb.Sheets[sn]);
      sheet.images = loaded.images[i];
      return sheet;
    });
    var current = 0;

    /* Every column of the sheet on the page at the widths its pieces share */
    function applyWidths(sheet) {
      for (var c = 0; c < sheet.cols; c++) {
        if (sheet.widths[c] !== null) sheetDiv.style.setProperty("--vw-col-" + c, sheet.widths[c] + "px");
      }
    }

    /* A piece just put on the page that needs a column wider than the rest have: widen them all */
    function widen(sheet, table) {
      if (!sheet.widths || table.getBoundingClientRect().width <= sheet.width + 0.5) return;
      var more = columnWidths(table, sheet.cols);
      for (var c = 0; c < sheet.cols; c++) {
        if (more[c] !== null && (sheet.widths[c] === null || more[c] > sheet.widths[c])) {
          sheet.widths[c] = more[c];
        }
      }
      applyWidths(sheet);
      sheet.width = table.getBoundingClientRect().width;
    }

    /* Piece [k] of the sheet on the page, put there in place of the block standing for it */
    function place(k) {
      var sheet = sheets[current];
      var piece = sheet.pieces[k];
      var t = sheet.table(k);
      if (t.parentNode === sheetDiv) return t;
      if (piece.stand && piece.stand.parentNode === sheetDiv) {
        if (watcher) watcher.unobserve(piece.stand);
        sheetDiv.replaceChild(t, piece.stand);
        widen(sheet, t);
      }
      return t;
    }

    /*
     * Below Chromium 105 the app searches with Chromium's own find, which reads only what is on
     * the page (searchesInPage in WebViewFloor.kt), and an engine that old has no Highlight API,
     * which is how the page knows. There every piece goes onto the page, one at a time once the
     * first is up, so that search reaches every row, as it did when a sheet was drawn whole.
     */
    var fillAll = !(window.CSS && CSS.highlights);

    /* How many times a sheet has been shown, so a fill for one shown before stops */
    var shows = 0;

    function fill(idx, run) {
      var pieces = sheets[idx].pieces;
      var k = 1;
      (function next() {
        if (run !== shows) return;
        while (k < pieces.length && pieces[k].table && pieces[k].table.parentNode === sheetDiv) k++;
        if (k >= pieces.length) return;
        place(k++);
        setTimeout(next, 0);
      })();
    }

    /* A screen's height either side of the screen: a piece is drawn before it scrolls into view */
    var watcher = window.IntersectionObserver
      ? new IntersectionObserver(function (entries) {
          for (var i = 0; i < entries.length; i++) {
            if (entries[i].isIntersecting) place(entries[i].target.vwPiece);
          }
        }, { rootMargin: "100% 0px" })
      : null;

    function show(idx) {
      current = idx;
      shows++;
      var sheet = sheets[idx];
      if (watcher) watcher.disconnect();
      sheetDiv.textContent = "";
      sheetDiv.removeAttribute("style");
      var top = sheet.table(0);
      sheetDiv.appendChild(top);
      if (sheet.pieces.length > 1) {
        if (!sheet.widths) {
          sheet.widths = columnWidths(top, sheet.cols);
          applyWidths(sheet);
          sheet.width = top.getBoundingClientRect().width;
        } else {
          applyWidths(sheet);
        }
        var first = sheet.pieces[0];
        var rowHeight = top.getBoundingClientRect().height / (first.e - first.s + 1);
        for (var k = 1; k < sheet.pieces.length; k++) {
          var piece = sheet.pieces[k];
          var stand = document.createElement("div");
          stand.className = "vw-later";
          stand.style.height = Math.max(1, Math.round((piece.e - piece.s + 1) * rowHeight)) + "px";
          stand.vwPiece = k;
          piece.stand = stand;
          sheetDiv.appendChild(stand);
          if (watcher) watcher.observe(stand);
          else place(k);
        }
        if (fillAll) fill(idx, shows);
      }
      var btns = tabs.querySelectorAll("button");
      for (var i = 0; i < btns.length; i++) btns[i].className = i === idx ? "active" : "";
    }

    wb.SheetNames.forEach(function (sn, idx) {
      var b = document.createElement("button");
      b.textContent = sn;
      b.onclick = function () { show(idx); };
      tabs.appendChild(b);
    });
    if (wb.SheetNames.length > 1) tabs.style.display = "";
    show(0);

    /*
     * Find reaches every row of every sheet, not only those drawn: see find.js. Each piece of
     * each sheet is a part of its own, read off the page until it is put there.
     */
    var parts = [];
    sheets.forEach(function (sheet, s) {
      sheet.pieces.forEach(function (piece, k) {
        piece.part = parts.length;
        parts.push({ sheet: s, piece: k });
      });
    });
    window.vwFindParts = {
      count: function () { return parts.length; },
      root: function (i) { return sheets[parts[i].sheet].table(parts[i].piece); },
      show: function (i) {
        if (parts[i].sheet !== current) show(parts[i].sheet);
        return place(parts[i].piece);
      },
      shown: function () { return sheets[current].pieces[0].part; },
      drawn: function (i) {
        var t = sheets[parts[i].sheet].pieces[parts[i].piece].table;
        return !!t && t.parentNode === sheetDiv;
      }
    };
    vwStatusDone();
  })
  .catch(function (e) { vwError("Could not open this spreadsheet", String(e)); });

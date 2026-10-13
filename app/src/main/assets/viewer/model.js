"use strict";

/*
 * model.html: a 3D model, drawn with WebGL.
 *
 * Written for Gander rather than built on a library. three.js is the obvious one, and for
 * this it would be some six hundred kilobytes carried to draw one kind of file, where the
 * whole of what an STL needs is here: triangles into a buffer, one light, and a camera that
 * turns about the model. WebGL 1, which every WebView Gander runs on has, and nothing in
 * the script newer than the Chromium 58 that Android 8 shipped with, so this page has no
 * floor of its own.
 *
 * The triangles go to the graphics card in pieces as the file is read (see model-stl.js)
 * and are not kept on the page as well. That makes the card the only copy, and a card can
 * be taken away: Android is free to reclaim a WebView's graphics context, most often while
 * the app is in the background. When that happens the file is simply read again.
 *
 * Z is up, as it is in every slicer and in the CAD programs STL files come out of, and the
 * model opens seen from the front right and a little above. One finger turns it freely, the
 * way the finger goes, and a flick carries it on. Two pinch to zoom, twist to roll it round
 * and move it, all about the point between them, and a double tap puts it back.
 */

/* Where the camera starts: turned this far round from the front, and this far up. */
var VW_MODEL_YAW = 30 * Math.PI / 180;
var VW_MODEL_PITCH = 22 * Math.PI / 180;

/*
 * The camera's distance from the model, in the model's own radius. Far enough that the
 * perspective is gentle, like a long lens rather than a wide one. Zoom narrows the lens
 * rather than moving the camera in, so the camera never ends up inside the model and the
 * depth range stays tight however far it zooms.
 */
var VW_MODEL_DISTANCE = 4;

/* How much room is left round the model when it is fitted to the screen. */
var VW_MODEL_MARGIN = 1.12;

var VW_MODEL_ZOOM_MIN = 0.25;
var VW_MODEL_ZOOM_MAX = 100;

/* Screen widths a drag across the narrower side of the screen turns the model through. */
var VW_MODEL_TURN = 3.6;

/*
 * The model's colour: a warm clay, light enough to show the shading on every face and
 * nobody's filament in particular.
 */
var VW_MODEL_CLAY = [0xE3, 0xC5, 0xA2];

/*
 * Triangles to a buffer. One buffer can hold any number, but a model arrives a piece at a
 * time and each piece is handed to the card as soon as it fills, so this is also the most
 * the page holds itself at once: three megabytes, reused.
 */
var VW_MODEL_CHUNK = 65536;

/* Bytes the card holds for each triangle: three corners, each three floats and a normal. */
var VW_MODEL_TRIANGLE_BYTES = 48;

/*
 * How many triangles a phone is asked to hold, for each gigabyte it has. A phone's
 * graphics memory is its ordinary memory, and a model too large for it takes the
 * whole app down with it rather than failing on its own, so there has to be a line.
 * This one lets a phone give a model about a twentieth of its memory: 24 MB a gigabyte,
 * two million triangles, a 100 MB binary STL, on a 4 GB phone.
 *
 * navigator.deviceMemory is the phone's memory rounded down to a power of two and no
 * more than 8, which is what the browser engine is willing to say, and it is taken as 4
 * where it says nothing.
 */
var VW_MODEL_TRIANGLES_PER_GB = 500000;

/*
 * The most pixels the canvas is drawn at. A phone's screen can be four and a half million,
 * and at four samples a pixel for smooth edges that is a lot of memory for detail that
 * nobody sees at arm's length; past this the canvas is drawn a little smaller and scaled.
 */
var VW_MODEL_MAX_PIXELS = 2600000;

/* A tap, and two of them close enough together to be a double tap. */
var VW_MODEL_TAP_MS = 300;
var VW_MODEL_TAP_SLOP = 10;
var VW_MODEL_DOUBLE_MS = 350;
var VW_MODEL_DOUBLE_SLOP = 40;

/*
 * A flick. How fast the finger was going over its last VW_MODEL_FLICK_MS before it lifted
 * carries the model on, losing about two thirds of that speed every VW_MODEL_COAST_MS, until
 * it is too slow to see. A finger that stopped before it lifted carries nothing on, and the
 * next touch catches the model. Speeds are in CSS pixels a millisecond; the least that counts
 * is Android's own least fling, 50 dp a second.
 */
var VW_MODEL_FLICK_MS = 80;
var VW_MODEL_FLICK_MIN = 0.05;
var VW_MODEL_FLICK_MAX = 4;
var VW_MODEL_COAST_MS = 350;
var VW_MODEL_COAST_STOP = 0.01;

var VW_MODEL_VERTEX = [
  "attribute vec3 aPos;",
  "attribute vec3 aNormal;",
  "uniform mat4 uModelView;",
  "uniform mat4 uProjection;",
  "uniform mat3 uNormal;",
  "varying vec3 vNormal;",
  "varying vec3 vPos;",
  "void main() {",
  "  vec4 p = uModelView * vec4(aPos, 1.0);",
  "  vPos = p.xyz;",
  "  vNormal = uNormal * aNormal;",
  "  gl_Position = uProjection * p;",
  "}"
].join("\n");

/*
 * Lit from the camera's side: a key light high on the left, a weaker fill low on the right,
 * a little light from above and less from below for the faces turned away from both, and a
 * small highlight so the surface reads as a solid thing rather than a cut-out. The lights
 * move with the camera, so whichever way the model is turned the side facing the reader
 * is lit. The light from above and below never quite reaches nothing, so no face is black.
 *
 * A face turned away is lit as if it faced the camera. The normal comes from the order of
 * a face's corners, and STL files often list some faces' corners the wrong way round; drawn
 * as they are, those faces would come out black.
 *
 * The colour is squared going in and square-rooted coming out, a cheap stand-in for doing
 * the light in linear space, which is what keeps a lit face from looking washed out.
 */
var VW_MODEL_FRAGMENT = [
  "precision mediump float;",
  "uniform vec3 uColour;",
  "varying vec3 vNormal;",
  "varying vec3 vPos;",
  "void main() {",
  "  vec3 n = normalize(vNormal);",
  "  vec3 v = normalize(-vPos);",
  "  if (dot(n, v) < 0.0) n = -n;",
  "  vec3 key = normalize(vec3(-0.45, 0.6, 0.66));",
  "  vec3 fill = normalize(vec3(0.7, -0.25, 0.5));",
  "  vec3 h = normalize(key + v);",
  "  float light = mix(0.04, 0.16, 0.5 + 0.5 * n.y)",
  "    + 0.86 * max(dot(n, key), 0.0)",
  "    + 0.24 * max(dot(n, fill), 0.0);",
  "  float shine = 0.16 * pow(max(dot(n, h), 0.0), 32.0);",
  "  gl_FragColor = vec4(sqrt(max(uColour * light + shine, 0.0)), 1.0);",
  "}"
].join("\n");

var vwModelCanvas = document.getElementById("model");
var vwModelSizeLine = document.getElementById("size");

var vwModelGl = null;
var vwModelProgram = null;
var vwModelMesh = null;
var vwModelGround = [0, 0, 0];

/* Each read of the file has a number, so one overtaken by a lost context can tell. */
var vwModelRun = 0;

var vwModelView = vwModelStartView();

/* The tangent of half the screen's height at zoom 1, fitted to the model and the screen. */
var vwModelFit = 1;

var vwModelCss = { w: 1, h: 1 };
var vwModelDrawQueued = false;

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

function vwModelFail(title, detail) {
  vwModelCanvas.setAttribute("data-state", "failed");
  vwError(title, detail);
}

/* An error that carries the title the card should have. */
function vwModelProblem(title, detail) {
  var e = new Error(detail);
  e.title = title;
  return e;
}

function vwModelCount(n) {
  if (n >= 1000000) return Math.round(n / 100000) / 10 + " million";
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function vwModelMaxTriangles() {
  var gb = navigator.deviceMemory;
  if (!(gb > 0)) gb = 4;
  return Math.round(Math.min(gb, 8) * VW_MODEL_TRIANGLES_PER_GB);
}

function vwModelTooLarge(triangles, most) {
  return vwModelProblem(
    "This model is too large to show",
    "Office Lite draws up to " + vwModelCount(most) + " triangles on a phone with this much " +
    "memory, and this model has " + (triangles > 0 ? vwModelCount(triangles) : "more") + "."
  );
}

function vwModelStart() {
  var run = ++vwModelRun;
  vwModelCanvas.setAttribute("data-state", "loading");
  try {
    vwModelProgram = vwModelLink(vwModelGl);
  } catch (e) {
    if (!vwModelGl.isContextLost()) vwModelFail("Could not show this model", String(e.message || e));
    return;
  }
  vwModelRead(run)
    .then(function (mesh) {
      if (run !== vwModelRun) return;
      vwModelMesh = mesh;
      vwModelDescribe(mesh);
      vwModelResize();
      vwModelDraw();
      vwModelCanvas.setAttribute("data-triangles", String(mesh.triangles));
      vwModelCanvas.setAttribute("data-state", "drawn");
      vwStatusDone();
    })
    .catch(function (e) {
      // A read overtaken by a lost context says nothing: the restore reads the file again
      if (run !== vwModelRun) return;
      vwModelFail(e.title || "Could not show this model", String(e.message || e));
    });
}

/*
 * Reads the file and hands its triangles to the card, answering the finished mesh.
 *
 * The card's opening line waits before it appears, as on every page (see .vw-wait in
 * app.css), but a file big enough to take a while shows it at once and says how far it
 * has got. The stream is left every tenth of a second so that line can be drawn.
 */
function vwModelRead(run) {
  var gl = vwModelGl;
  var most = vwModelMaxTriangles();
  var card = document.getElementById("vw-status");
  var total = vwModelFileLength();
  return fetch(vwDocUrl()).then(function (r) {
    if (!r.ok) throw new Error("Could not read the file (HTTP " + r.status + ")");
    var showing = total >= VW_BUSY_BYTES && card;
    if (showing) {
      card.classList.remove("vw-wait");
      // Up again after a lost context, when the model has gone from the screen meanwhile
      card.style.display = "";
    }

    var mesh = vwModelBuilder(gl, most);
    var stl = vwStlReader(
      total,
      function (start) {
        if (start.triangles > most) throw vwModelTooLarge(start.triangles, most);
      },
      mesh.add
    );
    var got = 0;
    return vwModelStream(r, function (bytes) {
      if (run !== vwModelRun) throw new Error("superseded");
      stl.push(bytes);
      got += bytes.length;
      if (showing) card.textContent = "Opening model\u2026 " + Math.floor(100 * got / total) + "%";
    }).then(function () {
      stl.end();
      mesh.finish();
      if (!mesh.triangles) {
        throw vwModelProblem("This model is empty", "There are no triangles in it to draw.");
      }
      return mesh;
    }).then(null, function (e) {
      mesh.free();
      if (e && e.tooMany) throw vwModelTooLarge(0, most);
      throw e;
    });
  });
}

/*
 * The file's length in bytes, or -1 when its provider would not say.
 *
 * From the URL, where ViewerActivity puts it, and never from the response's Content-Length,
 * which in a WebView is not the app's to set. The WebView adds one of its own, made from
 * what the stream has to hand when it starts: for a file on the phone that doubles the
 * app's, "50000084, 50000084", and for a file coming out of a zip through a pipe it is 0,
 * with the whole model behind it. Both were seen on the emulator. Read from there, the
 * zipped model would open as an empty one.
 */
function vwModelFileLength() {
  // Never 0, for the reason ViewerActivity gives for not sending it
  var n = parseInt(vwParams.get("length"), 10);
  return n > 0 ? n : -1;
}

/*
 * The most the reader is handed at once. The stream's pieces are whatever size the browser
 * picks, and the same 1.2 MB file came in anywhere from eighteen pieces to one. The page can
 * step aside for a frame only between two handings, so a file that came whole would be read
 * with the card frozen; cut to this, a frame is never more than a slice away.
 */
var VW_MODEL_SLICE = 256 * 1024;

/* Feeds [onBytes] the body of [r] a slice at a time, as it arrives. */
function vwModelStream(r, onBytes) {
  var since = Date.now();

  // A frame for the card, and the timeout after it
  function breathe() {
    return new Promise(function (resolve) {
      requestAnimationFrame(function () { setTimeout(resolve, 0); });
    }).then(function () { since = Date.now(); });
  }

  // [bytes] from [at] on, stepping aside once a tenth of a second has gone by
  function feed(bytes, at) {
    while (at < bytes.length) {
      var end = Math.min(at + VW_MODEL_SLICE, bytes.length);
      onBytes(bytes.subarray(at, end));
      at = end;
      if (Date.now() - since >= 100) {
        return breathe().then(function () { return feed(bytes, at); });
      }
    }
    return null;
  }

  // A WebView too old for the Streams API has to take the body whole
  if (!r.body || !r.body.getReader) {
    return r.arrayBuffer().then(function (buffer) { return feed(new Uint8Array(buffer), 0); });
  }
  var reader = r.body.getReader();
  function next() {
    return reader.read().then(function (piece) {
      if (piece.done) return null;
      return Promise.resolve(feed(piece.value, 0)).then(next);
    });
  }
  return next().then(null, function (e) {
    try { reader.cancel(); } catch (ignored) { /* already closed */ }
    throw e;
  });
}

/*
 * Collects triangles into buffers on the card: each corner's position as three floats,
 * then its face's normal as three signed bytes and one spare, sixteen bytes a corner.
 * A face with no area is dropped, since it would draw nothing, and so is one with a
 * corner out of range, a NaN or an infinity or a number no model holds, since it would
 * draw something wrong.
 */
function vwModelBuilder(gl, most) {
  var staging = new ArrayBuffer(VW_MODEL_CHUNK * VW_MODEL_TRIANGLE_BYTES);
  var f = new Float32Array(staging);
  var b = new Int8Array(staging);
  var held = 0;
  var chunks = [];
  var minX = Infinity, minY = Infinity, minZ = Infinity;
  var maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  var mesh = { chunks: chunks, triangles: 0, min: null, max: null };

  function flush() {
    if (!held) return;
    var buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(staging, 0, held * VW_MODEL_TRIANGLE_BYTES),
      gl.STATIC_DRAW);
    chunks.push({ buffer: buffer, corners: held * 3 });
    held = 0;
  }

  function corner(o, x, y, z, nx, ny, nz) {
    f[o] = x;
    f[o + 1] = y;
    f[o + 2] = z;
    var n = (o + 3) * 4;
    b[n] = nx;
    b[n + 1] = ny;
    b[n + 2] = nz;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  mesh.add = function (ax, ay, az, bx, by, bz, cx, cy, cz) {
    var ux = bx - ax, uy = by - ay, uz = bz - az;
    var vx = cx - ax, vy = cy - ay, vz = cz - az;
    var nx = uy * vz - uz * vy;
    var ny = uz * vx - ux * vz;
    var nz = ux * vy - uy * vx;
    var len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    // Both tests fail for NaN, which is what an infinite corner makes too. The ceiling
    // drops a face some 10^18 across or more: no model is that big, a corner past about
    // 10^38 would not fit the float the card keeps it in, and one face that size would
    // shrink every real one beside it to nothing.
    if (!(len > 0) || !(len < 1e36)) return;
    if (mesh.triangles >= most) {
      var e = new Error("too many");
      e.tooMany = true;
      throw e;
    }
    var k = 127 / len;
    nx = Math.round(nx * k);
    ny = Math.round(ny * k);
    nz = Math.round(nz * k);
    var o = held * 12;
    corner(o, ax, ay, az, nx, ny, nz);
    corner(o + 4, bx, by, bz, nx, ny, nz);
    corner(o + 8, cx, cy, cz, nx, ny, nz);
    mesh.triangles++;
    if (++held === VW_MODEL_CHUNK) flush();
  };

  mesh.finish = function () {
    flush();
    staging = f = b = null;
    // WebGL keeps one error of each kind until asked, so every one is asked for
    var outOfMemory = false;
    for (var i = 0, err; i < 8 && (err = gl.getError()) !== gl.NO_ERROR; i++) {
      if (err === gl.OUT_OF_MEMORY) outOfMemory = true;
    }
    if (outOfMemory) {
      throw vwModelProblem("This model is too large to show",
        "The phone ran out of graphics memory while reading it.");
    }
    mesh.min = [minX, minY, minZ];
    mesh.max = [maxX, maxY, maxZ];
  };

  mesh.free = function () {
    staging = f = b = null;
    if (gl.isContextLost()) return;
    for (var i = 0; i < chunks.length; i++) gl.deleteBuffer(chunks[i].buffer);
    chunks.length = 0;
  };

  return mesh;
}

// ---------------------------------------------------------------------------
// Size
// ---------------------------------------------------------------------------

/*
 * A length for the line under the model: whole millimetres from a hundred up, one decimal
 * place from ten, two below that, and two significant figures under one.
 */
function vwModelMillimetres(v) {
  if (v >= 100) return String(Math.round(v));
  if (v >= 10) return String(Math.round(v * 10) / 10);
  if (v >= 1) return String(Math.round(v * 100) / 100);
  return String(Number(v.toPrecision(2)));
}

/*
 * The model's size, along X, Y and Z, which is width, depth and height to a slicer.
 *
 * An STL has no units, and millimetres is what every slicer takes its numbers to be, so
 * that is what they are called here. A model drawn in inches will read small, exactly as
 * it will in the slicer.
 */
function vwModelDescribe(mesh) {
  var sizes = [0, 1, 2].map(function (i) { return vwModelMillimetres(mesh.max[i] - mesh.min[i]); });
  vwModelSizeLine.textContent = sizes.join(" \u00d7 ") + " mm";
  vwModelCanvas.setAttribute("aria-label",
    "3D model, " + sizes.join(" by ") + " millimetres, " + vwModelCount(mesh.triangles) +
    (mesh.triangles === 1 ? " triangle" : " triangles"));
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function vwModelShader(gl, type, source) {
  var shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    throw new Error("The graphics driver refused a shader: " + gl.getShaderInfoLog(shader));
  }
  return shader;
}

function vwModelLink(gl) {
  var program = gl.createProgram();
  gl.attachShader(program, vwModelShader(gl, gl.VERTEX_SHADER, VW_MODEL_VERTEX));
  gl.attachShader(program, vwModelShader(gl, gl.FRAGMENT_SHADER, VW_MODEL_FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error("The graphics driver refused a program: " + gl.getProgramInfoLog(program));
  }
  return {
    program: program,
    pos: gl.getAttribLocation(program, "aPos"),
    normal: gl.getAttribLocation(program, "aNormal"),
    modelView: gl.getUniformLocation(program, "uModelView"),
    projection: gl.getUniformLocation(program, "uProjection"),
    normalMatrix: gl.getUniformLocation(program, "uNormal"),
    colour: gl.getUniformLocation(program, "uColour")
  };
}

function vwModelQueue() {
  if (vwModelDrawQueued) return;
  vwModelDrawQueued = true;
  requestAnimationFrame(vwModelDraw);
}

/* The model's centre and radius, which the view works in: the model is one unit across. */
function vwModelFrame(mesh) {
  var c = [0, 1, 2].map(function (i) { return (mesh.min[i] + mesh.max[i]) / 2; });
  var h = [0, 1, 2].map(function (i) { return (mesh.max[i] - mesh.min[i]) / 2; });
  var r = Math.sqrt(h[0] * h[0] + h[1] * h[1] + h[2] * h[2]);
  return { centre: c, half: h, radius: r > 0 ? r : 1 };
}

/*
 * The view a model opens with, and a double tap goes back to. The camera's way of facing is
 * kept as the three directions that are right, up and back from it, in the model's terms,
 * rather than as angles round and up. Angles have to be measured from somewhere, which is
 * what put a stop at the top and turned every sideways move about the model's Z, whichever
 * way it was being looked at. See vwModelTurn.
 */
function vwModelStartView() {
  var cp = Math.cos(VW_MODEL_PITCH), sp = Math.sin(VW_MODEL_PITCH);
  var cy = Math.cos(VW_MODEL_YAW), sy = Math.sin(VW_MODEL_YAW);
  return {
    right: [cy, sy, 0],
    up: [-sy * sp, cy * sp, cp],
    back: [cp * sy, -cp * cy, sp],
    zoom: 1,
    target: [0, 0, 0]
  };
}

/* Where the camera is, and which ways are right, up and forward from it. */
function vwModelCamera(view) {
  var t = view.target, back = view.back;
  return {
    eye: [t[0] + back[0] * VW_MODEL_DISTANCE, t[1] + back[1] * VW_MODEL_DISTANCE,
      t[2] + back[2] * VW_MODEL_DISTANCE],
    back: back,
    right: view.right,
    up: view.up
  };
}

/* A point in the model's unit space, in the camera's own terms: x right, y up, z back. */
function vwModelToCamera(cam, p) {
  var d = [p[0] - cam.eye[0], p[1] - cam.eye[1], p[2] - cam.eye[2]];
  return [
    d[0] * cam.right[0] + d[1] * cam.right[1] + d[2] * cam.right[2],
    d[0] * cam.up[0] + d[1] * cam.up[1] + d[2] * cam.up[2],
    d[0] * cam.back[0] + d[1] * cam.back[1] + d[2] * cam.back[2]
  ];
}

/*
 * How wide a lens fits the model on this screen, from where the camera starts: the
 * tightest one that has every corner of the model's box inside it with the margin round.
 * Worked out from the starting view and kept, rather than again as the model turns, so
 * that turning it does not also zoom it. Only a new screen shape changes it.
 *
 * The line giving the model's size is kept clear of: the height it takes at the foot of
 * the screen is taken off at the top as well, so the model stays in the middle. Measured
 * rather than assumed, since the line grows with the phone's font size. Seen on the
 * emulator, where a phone turned on its side put the line across the bottom of the model.
 */
function vwModelFitLens() {
  var mesh = vwModelMesh;
  if (!mesh) return;
  var frame = vwModelFrame(mesh);
  var cam = vwModelCamera(vwModelStartView());
  var aspect = vwModelCss.w / vwModelCss.h;
  var line = vwModelSizeLine.getBoundingClientRect();
  var band = line.height > 0 ? vwModelCss.h - line.top + 8 : 0;
  var tall = Math.max(0.5, (vwModelCss.h - 2 * band) / vwModelCss.h);
  var need = 0;
  for (var i = 0; i < 8; i++) {
    var p = [
      (i & 1 ? 1 : -1) * frame.half[0] / frame.radius,
      (i & 2 ? 1 : -1) * frame.half[1] / frame.radius,
      (i & 4 ? 1 : -1) * frame.half[2] / frame.radius
    ];
    var q = vwModelToCamera(cam, p);
    var depth = -q[2];
    need = Math.max(need, Math.abs(q[0]) / depth / aspect, Math.abs(q[1]) / depth / tall);
  }
  vwModelFit = need * VW_MODEL_MARGIN;
}

function vwModelResize() {
  var w = Math.max(1, vwModelCanvas.clientWidth);
  var h = Math.max(1, vwModelCanvas.clientHeight);
  var scale = Math.min(window.devicePixelRatio || 1, Math.sqrt(VW_MODEL_MAX_PIXELS / (w * h)));
  vwModelCss = { w: w, h: h };
  vwModelCanvas.width = Math.max(1, Math.round(w * scale));
  vwModelCanvas.height = Math.max(1, Math.round(h * scale));
  vwModelFitLens();
}

function vwModelDraw() {
  vwModelDrawQueued = false;
  if (vwModelCoast) vwModelCoasting();
  var gl = vwModelGl;
  var mesh = vwModelMesh;
  var p = vwModelProgram;
  if (!gl || !mesh || !p || gl.isContextLost()) return;

  var w = vwModelCanvas.width, h = vwModelCanvas.height;
  gl.viewport(0, 0, w, h);
  gl.clearColor(vwModelGround[0], vwModelGround[1], vwModelGround[2], 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);

  var frame = vwModelFrame(mesh);
  var cam = vwModelCamera(vwModelView);
  var lens = vwModelFit / vwModelView.zoom;
  // The whole model lies within one unit of its centre, and the camera looks at a point
  // no further than that from it, so this is the model's whole depth and no more
  var far = Math.sqrt(cam.eye[0] * cam.eye[0] + cam.eye[1] * cam.eye[1] + cam.eye[2] * cam.eye[2]);
  var near = Math.max(far - 1.01, 0.01);
  far += 1.01;

  var s = 1 / frame.radius;
  var r = cam.right, u = cam.up, k = cam.back;
  var e = [
    -(r[0] * cam.eye[0] + r[1] * cam.eye[1] + r[2] * cam.eye[2]),
    -(u[0] * cam.eye[0] + u[1] * cam.eye[1] + u[2] * cam.eye[2]),
    -(k[0] * cam.eye[0] + k[1] * cam.eye[1] + k[2] * cam.eye[2])
  ];
  // The camera's view of a point in the file's own coordinates: centred, scaled to a unit,
  // then turned and moved into the camera's terms. Column-major, as WebGL takes it.
  var c = frame.centre;
  var modelView = new Float32Array([
    r[0] * s, u[0] * s, k[0] * s, 0,
    r[1] * s, u[1] * s, k[1] * s, 0,
    r[2] * s, u[2] * s, k[2] * s, 0,
    e[0] - s * (r[0] * c[0] + r[1] * c[1] + r[2] * c[2]),
    e[1] - s * (u[0] * c[0] + u[1] * c[1] + u[2] * c[2]),
    e[2] - s * (k[0] * c[0] + k[1] * c[1] + k[2] * c[2]),
    1
  ]);
  var normal = new Float32Array([r[0], u[0], k[0], r[1], u[1], k[1], r[2], u[2], k[2]]);
  var aspect = w / h;
  var projection = new Float32Array([
    1 / (lens * aspect), 0, 0, 0,
    0, 1 / lens, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, 2 * far * near / (near - far), 0
  ]);

  gl.useProgram(p.program);
  gl.uniformMatrix4fv(p.modelView, false, modelView);
  gl.uniformMatrix4fv(p.projection, false, projection);
  gl.uniformMatrix3fv(p.normalMatrix, false, normal);
  gl.uniform3f(p.colour,
    Math.pow(VW_MODEL_CLAY[0] / 255, 2), Math.pow(VW_MODEL_CLAY[1] / 255, 2),
    Math.pow(VW_MODEL_CLAY[2] / 255, 2));
  gl.enableVertexAttribArray(p.pos);
  gl.enableVertexAttribArray(p.normal);
  for (var i = 0; i < mesh.chunks.length; i++) {
    var chunk = mesh.chunks[i];
    gl.bindBuffer(gl.ARRAY_BUFFER, chunk.buffer);
    gl.vertexAttribPointer(p.pos, 3, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(p.normal, 3, gl.BYTE, true, 16, 12);
    gl.drawArrays(gl.TRIANGLES, 0, chunk.corners);
  }
}

// ---------------------------------------------------------------------------
// Moving it
// ---------------------------------------------------------------------------

function vwModelReset() {
  vwModelCoast = null;
  vwModelView = vwModelStartView();
  vwModelQueue();
}

function vwModelDot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function vwModelCross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function vwModelUnit(p) {
  var n = Math.sqrt(vwModelDot(p, p));
  return [p[0] / n, p[1] / n, p[2] / n];
}

/*
 * [p] turned about the line [k] through an angle whose cosine is [c] and sine [s]. Rodrigues:
 * the part along the line stays, and the part across it turns.
 */
function vwModelRotated(p, k, c, s) {
  var along = vwModelDot(k, p), kp = vwModelCross(k, p);
  return [0, 1, 2].map(function (i) { return p[i] * c + kp[i] * s + k[i] * along * (1 - c); });
}

/*
 * Turns the camera [a] radians about [k], a line through the point it looks at, given in the
 * model's terms. The model turns the other way on the screen, and stays where the file put it.
 */
function vwModelSpin(k, a) {
  var v = vwModelView;
  var c = Math.cos(a), s = Math.sin(a);
  // Squared up again every move, so that thousands of small turns never add up to a skew
  var back = vwModelUnit(vwModelRotated(v.back, k, c, s));
  var right = vwModelRotated(v.right, k, c, s);
  var lean = vwModelDot(right, back);
  right = vwModelUnit([0, 1, 2].map(function (i) { return right[i] - lean * back[i]; }));
  v.back = back;
  v.right = right;
  v.up = vwModelCross(back, right);
}

/*
 * Turns the model the way a finger moved, [dx, dy] CSS pixels with down positive: about the
 * line across the screen at right angles to the move, so the side under the finger goes with
 * it, from any angle and as far as the finger goes.
 */
function vwModelTurn(dx, dy) {
  var d = Math.sqrt(dx * dx + dy * dy);
  if (!(d > 0)) return;
  var v = vwModelView;
  vwModelSpin([0, 1, 2].map(function (i) { return (dy * v.right[i] + dx * v.up[i]) / d; }),
    -d * vwModelRadiansPerPixel());
}

/*
 * Rolls the model [a] radians clockwise on the screen, the way two fingers twisted, keeping
 * the point under ([x], [y]) where it is: the camera rolls the other way about the line it
 * looks along, and the point it looks at moves to hold that one still.
 */
function vwModelTwistAt(x, y, a) {
  var units = vwModelUnitsPerPixel(vwModelView.zoom);
  var ox = (x - vwModelCss.w / 2) * units, oy = (vwModelCss.h / 2 - y) * units;
  var right = vwModelView.right, up = vwModelView.up;
  vwModelSpin(vwModelView.back, a);
  var now = vwModelView;
  vwModelMoveBy([0, 1, 2].map(function (i) {
    return (right[i] - now.right[i]) * ox + (up[i] - now.up[i]) * oy;
  }));
}

/* How far a finger turns the model, in radians per CSS pixel. */
function vwModelRadiansPerPixel() {
  return VW_MODEL_TURN / Math.max(1, Math.min(vwModelCss.w, vwModelCss.h));
}

/* How far the point the camera looks at is, in the model's units, per CSS pixel. */
function vwModelUnitsPerPixel(zoom) {
  return 2 * VW_MODEL_DISTANCE * (vwModelFit / zoom) / vwModelCss.h;
}

/* Moves the point the camera looks at by [d], never so far that the model leaves the screen. */
function vwModelMoveBy(d) {
  var t = vwModelView.target;
  for (var i = 0; i < 3; i++) t[i] += d[i];
  var len = Math.sqrt(t[0] * t[0] + t[1] * t[1] + t[2] * t[2]);
  if (len > 1) for (var j = 0; j < 3; j++) t[j] /= len;
}

/* Moves the point the camera looks at [x] to its right and [y] up. */
function vwModelShift(x, y) {
  var v = vwModelView;
  vwModelMoveBy([0, 1, 2].map(function (i) { return v.right[i] * x + v.up[i] * y; }));
}

/* Moves the model with a finger: [dx, dy] CSS pixels, down the screen positive. */
function vwModelPan(dx, dy) {
  var units = vwModelUnitsPerPixel(vwModelView.zoom);
  vwModelShift(-dx * units, dy * units);
}

/* Zooms by [factor], keeping the point under ([x], [y]) where it is. */
function vwModelZoomAt(x, y, factor) {
  var from = vwModelView.zoom;
  var to = Math.max(VW_MODEL_ZOOM_MIN, Math.min(VW_MODEL_ZOOM_MAX, from * factor));
  if (to === from) return;
  var drift = vwModelUnitsPerPixel(from) - vwModelUnitsPerPixel(to);
  vwModelView.zoom = to;
  vwModelShift((x - vwModelCss.w / 2) * drift, (vwModelCss.h / 2 - y) * drift);
}

/*
 * Every finger on the model, by pointer id, where it was last seen. One turns the model, and
 * two pinch, twist and move it. A mouse turns it with the left button and moves it with the
 * right or with Shift, which is for testing on a computer as much as anything.
 */
var vwModelFingers = {};
var vwModelFingerCount = 0;
var vwModelPress = null;
var vwModelLastTap = null;

/* A flick still carrying the model on: its speed, and when it last moved it. */
var vwModelCoast = null;

/* Where a turning finger has been lately: its last VW_MODEL_FLICK_MS, and the point before. */
function vwModelTrail(trail, t, x, y) {
  trail.push({ t: t, x: x, y: y });
  while (trail.length > 2 && t - trail[1].t > VW_MODEL_FLICK_MS) trail.shift();
}

/* Carries the model on after a finger lifted at [t], the way its [trail] was going. */
function vwModelFling(trail, t) {
  var first = trail[0], last = trail[trail.length - 1];
  if (t - last.t > VW_MODEL_FLICK_MS || !(last.t > first.t)) return;
  var vx = (last.x - first.x) / (last.t - first.t);
  var vy = (last.y - first.y) / (last.t - first.t);
  var speed = Math.sqrt(vx * vx + vy * vy);
  if (!(speed > VW_MODEL_FLICK_MIN)) return;
  // Android's Remove animations setting, which reaches the page as reduced motion
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  var cap = Math.min(1, VW_MODEL_FLICK_MAX / speed);
  vwModelCoast = { vx: vx * cap, vy: vy * cap, t: t };
  vwModelQueue();
}

/*
 * One frame of a flick, taken by vwModelDraw before it draws: as far as the speed carries the
 * model since the last, then slower, and another frame asked for until it stops.
 */
function vwModelCoasting() {
  var c = vwModelCoast;
  if (!vwModelMesh) {
    vwModelCoast = null;
    return;
  }
  var now = performance.now();
  // A frame held back by a busy phone, or by the page being out of sight, counts as a short one
  var dt = Math.max(0, Math.min(now - c.t, 50));
  var keep = Math.exp(-dt / VW_MODEL_COAST_MS);
  // The distance a speed covers while falling away like that: v * T * (1 - e^(-dt / T))
  var travel = VW_MODEL_COAST_MS * (1 - keep);
  vwModelTurn(c.vx * travel, c.vy * travel);
  c.vx *= keep;
  c.vy *= keep;
  c.t = now;
  if (Math.sqrt(c.vx * c.vx + c.vy * c.vy) < VW_MODEL_COAST_STOP) vwModelCoast = null;
  else vwModelQueue();
}

function vwModelOtherFinger(id) {
  for (var key in vwModelFingers) {
    if (key !== String(id)) return vwModelFingers[key];
  }
  return null;
}

function vwModelDown(e) {
  // A touch catches a model still turning from a flick
  vwModelCoast = null;
  // Nothing to move until there is a model, and nothing yet to measure a move against
  if (!vwModelMesh) return;
  if (e.pointerType === "mouse" && e.button !== 0 && e.button !== 2) return;
  if (vwModelFingers[e.pointerId]) return;
  try { vwModelCanvas.setPointerCapture(e.pointerId); } catch (ignored) { /* touch has it */ }
  vwModelFingers[e.pointerId] = {
    x: e.clientX,
    y: e.clientY,
    pans: e.pointerType === "mouse" && (e.button === 2 || e.shiftKey),
    trail: [{ t: e.timeStamp, x: e.clientX, y: e.clientY }]
  };
  vwModelFingerCount++;
  vwModelPress = vwModelFingerCount === 1
    ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, moved: false }
    : null;
  e.preventDefault();
}

function vwModelMove(e) {
  var finger = vwModelFingers[e.pointerId];
  if (!finger) return;
  var x = e.clientX, y = e.clientY;
  var press = vwModelPress;
  if (press && (Math.abs(x - press.x) > VW_MODEL_TAP_SLOP ||
      Math.abs(y - press.y) > VW_MODEL_TAP_SLOP)) {
    press.moved = true;
  }
  if (vwModelFingerCount === 1) {
    if (finger.pans) vwModelPan(x - finger.x, y - finger.y);
    else {
      vwModelTurn(x - finger.x, y - finger.y);
      vwModelTrail(finger.trail, e.timeStamp, x, y);
    }
  } else {
    var other = vwModelOtherFinger(e.pointerId);
    if (other) {
      // The line from the other finger to this one, before this move and after it
      var bx = finger.x - other.x, by = finger.y - other.y;
      var ax = x - other.x, ay = y - other.y;
      var before = Math.sqrt(bx * bx + by * by), after = Math.sqrt(ax * ax + ay * ay);
      var mx = (x + other.x) / 2, my = (y + other.y) / 2;
      vwModelPan(mx - (finger.x + other.x) / 2, my - (finger.y + other.y) / 2);
      if (before > 0 && after > 0) {
        vwModelZoomAt(mx, my, after / before);
        // How far that line turned, the short way round
        vwModelTwistAt(mx, my, Math.atan2(bx * ay - by * ax, bx * ax + by * ay));
      }
    }
  }
  finger.x = x;
  finger.y = y;
  vwModelQueue();
  e.preventDefault();
}

function vwModelUp(e) {
  var finger = vwModelFingers[e.pointerId];
  if (!finger) return;
  delete vwModelFingers[e.pointerId];
  vwModelFingerCount--;
  var press = vwModelPress;
  // The finger that went down alone, lifted rather than taken away
  var lifted = e.type === "pointerup" && press && press.id === e.pointerId;
  if (lifted && !press.moved && e.timeStamp - press.t < VW_MODEL_TAP_MS) {
    var last = vwModelLastTap;
    if (last && e.timeStamp - last.t < VW_MODEL_DOUBLE_MS &&
        Math.abs(e.clientX - last.x) < VW_MODEL_DOUBLE_SLOP &&
        Math.abs(e.clientY - last.y) < VW_MODEL_DOUBLE_SLOP) {
      vwModelLastTap = null;
      vwModelReset();
    } else {
      vwModelLastTap = { t: e.timeStamp, x: e.clientX, y: e.clientY };
    }
  }
  // Only a finger that turned the model alone, from the moment it went down
  if (lifted && press.moved && !finger.pans) vwModelFling(finger.trail, e.timeStamp);
  if (vwModelFingerCount === 0) vwModelPress = null;
}

function vwModelWheel(e) {
  e.preventDefault();
  if (!vwModelMesh) return;
  var dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  vwModelZoomAt(e.clientX, e.clientY, Math.exp(-dy * 0.002));
  vwModelQueue();
}

// ---------------------------------------------------------------------------

function vwModelGroundColour() {
  var m = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g);
  return m ? [Number(m[0]) / 255, Number(m[1]) / 255, Number(m[2]) / 255] : [0, 0, 0];
}

(function () {
  vwModelGround = vwModelGroundColour();
  var attributes = { alpha: false, antialias: true, depth: true, preserveDrawingBuffer: false };
  vwModelGl = vwModelCanvas.getContext("webgl", attributes) ||
    vwModelCanvas.getContext("experimental-webgl", attributes);
  if (!vwModelGl) {
    vwModelFail(
      "3D models cannot be shown on this phone",
      "Office Lite draws them with WebGL, and Android System WebView has turned WebGL off on " +
      "this phone, which it does when the phone's graphics driver is known to misbehave. " +
      "An update to Android System WebView can turn it back on."
    );
    return;
  }

  vwModelCanvas.addEventListener("pointerdown", vwModelDown);
  vwModelCanvas.addEventListener("pointermove", vwModelMove);
  vwModelCanvas.addEventListener("pointerup", vwModelUp);
  vwModelCanvas.addEventListener("pointercancel", vwModelUp);
  vwModelCanvas.addEventListener("wheel", vwModelWheel, { passive: false });
  vwModelCanvas.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  addEventListener("resize", function () {
    if (!vwModelMesh) return;
    vwModelResize();
    vwModelQueue();
  });

  vwModelCanvas.addEventListener("webglcontextlost", function (e) {
    // Asked for back, which is what preventDefault says, and the read in hand abandoned
    e.preventDefault();
    vwModelRun++;
    vwModelMesh = null;
    vwModelProgram = null;
    vwModelCanvas.setAttribute("data-state", "lost");
  });
  // The buffers went with the context, and nothing else holds the triangles, so the file
  // is read again. The view is kept: the reader comes back to the model as they left it.
  vwModelCanvas.addEventListener("webglcontextrestored", vwModelStart);

  vwModelStart();
})();

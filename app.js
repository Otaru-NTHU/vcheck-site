// V皮座談｜電腦檢測頁
// 量測：三個角色的測試舞台 + 臉部追蹤，同時運作時的畫面幀率與追蹤幀率。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

// ---------------------------------------------------------------- 設定
const CONFIG = {
  VERSION: '0.2',
  MODEL_URL: './models/sample.vrm',
  WASM_DIR: './vendor/mediapipe/wasm',
  // 臉部追蹤模型：先找網站內的檔案，沒有再向 Google 下載
  FACE_MODEL_URLS: [
    './models/face_landmarker.task',
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  ],
  // 填入網址後，結果會自動以 JSON POST 回傳（例如 Google Apps Script 的網址）。留空則只顯示。
  REPORT_URL: '',
  WARMUP_MS: 1500,
  MEASURE_MS: 5000,
  // 由低到高測。前一級太差就不再往上測。
  LEVELS: [
    { id: 'low', label: '低畫質', w: 960, h: 540, shadows: false },
    { id: 'mid', label: '中畫質', w: 1280, h: 720, shadows: false },
    { id: 'high', label: '高畫質', w: 1920, h: 1080, shadows: true },
  ],
  // 分級門檻（暫定，待真機資料校正）
  TIER: {
    S: { level: 'high', fps: 50, lowFps: 30, track: 20 },
    A: { level: 'mid', fps: 30, lowFps: 20, track: 20 },
    B: { level: 'low', fps: 30, lowFps: 15, track: 15 },
  },
  // 頭部方向的正負號，真機測試若方向相反改這裡（1 或 -1）
  HEAD_SIGN: { pitch: 1, yaw: -1, roll: -1 },
};

const TIER_TEXT = {
  S: { name: '極佳', advice: '這台電腦可以用最高畫質順暢參與節目。' },
  A: { name: '佳', advice: '這台電腦可以順暢參與節目，我們會為您使用中等畫質。' },
  B: { name: '普通', advice: '這台電腦可以參與節目，我們會為您使用輕量畫質。開播時請關閉其他程式。' },
  C: {
    name: '有風險',
    advice: '這台電腦跑節目畫面可能會卡。可以改用另一台電腦，或由我們為您開啟「聲音驅動模式」，一樣能參與。',
  },
};

// ---------------------------------------------------------------- 小工具
const $ = (id) => document.getElementById(id);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const remap = (v, a, b) => clamp01((v - a) / (b - a));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function show(id) {
  for (const s of ['s-intro', 's-run', 's-result', 's-try', 's-error']) $(s).hidden = s !== id;
}
function setRun(title, pct, sub = '') {
  $('run-title').textContent = title;
  $('run-bar').style.width = `${Math.round(pct * 100)}%`;
  $('run-sub').textContent = sub;
}
async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  const old = btn.textContent;
  btn.textContent = '已複製';
  setTimeout(() => (btn.textContent = old), 1600);
}

// ---------------------------------------------------------------- 狀態
const state = {
  cameraOK: false,
  cameraInfo: '',
  micOK: false,
  micPeak: 0,
  micLevel: 0,
  delegate: '',
  trackerOK: false,
  trackerError: '',
  avatars: [],
  mode: 'idle', // idle | bench | try
  lipByVolume: false,
  hiddenDuringTest: false,
  results: {},
  tier: 'C',
};
const video = $('cam');
let landmarker = null;
let analyser = null;
let analyserBuf = null;

// ---------------------------------------------------------------- 舞台
const canvas = $('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b1733);
scene.fog = new THREE.Fog(0x1b1733, 6, 14);

const camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 50);
const WIDE = { pos: new THREE.Vector3(0, 1.3, 4.3), look: new THREE.Vector3(0, 1.05, 0) };
const camGoal = { pos: WIDE.pos.clone(), look: WIDE.look.clone() };
const camLook = WIDE.look.clone();
camera.position.copy(WIDE.pos);
camera.lookAt(camLook);

scene.add(new THREE.HemisphereLight(0xcfd8ff, 0x2a2140, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(2, 4, 3);
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -3;
sun.shadow.camera.right = 3;
sun.shadow.camera.top = 3;
sun.shadow.camera.bottom = -1;
scene.add(sun);

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(4, 64),
  new THREE.MeshStandardMaterial({ color: 0x3a3170, roughness: 0.85 }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// 幾個漂浮的幾何體，當作「超現實背景」的替身，也讓畫面有東西在動
const floaters = [];
{
  const geos = [new THREE.IcosahedronGeometry(0.35, 0), new THREE.TorusGeometry(0.3, 0.09, 12, 32), new THREE.OctahedronGeometry(0.3, 0)];
  const cols = [0x8f7bff, 0xff8fb1, 0x6fd3ff, 0xffd36f];
  for (let i = 0; i < 14; i++) {
    const m = new THREE.Mesh(geos[i % geos.length], new THREE.MeshStandardMaterial({ color: cols[i % cols.length], roughness: 0.4, metalness: 0.2 }));
    const a = (i / 14) * Math.PI * 2;
    m.position.set(Math.cos(a) * (2.6 + (i % 3) * 0.5), 0.8 + (i % 5) * 0.5, -1.5 - Math.abs(Math.sin(a)) * 2.5);
    m.userData.phase = i * 1.7;
    m.castShadow = true;
    scene.add(m);
    floaters.push(m);
  }
}

function applyLevel(level) {
  renderer.setSize(level.w, level.h, false);
  camera.aspect = level.w / level.h;
  camera.updateProjectionMatrix();
  sun.castShadow = level.shadows;
}
applyLevel(CONFIG.LEVELS[1]);

// ---------------------------------------------------------------- 角色
const SEATS = [
  { x: -0.95, ry: 0.4 },
  { x: 0, ry: 0 },
  { x: 0.95, ry: -0.4 },
];

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下載失敗 ${res.status}: ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) return await res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(got / total);
  }
  const out = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out.buffer;
}

function buildAvatar(vrm, seat) {
  VRMUtils.removeUnnecessaryVertices(vrm.scene);
  VRMUtils.combineSkeletons(vrm.scene);
  VRMUtils.rotateVRM0(vrm);
  vrm.scene.traverse((o) => {
    o.frustumCulled = false;
    if (o.isMesh) o.castShadow = true;
  });
  const holder = new THREE.Group();
  holder.position.x = seat.x;
  holder.rotation.y = seat.ry;
  holder.add(vrm.scene);
  scene.add(holder);

  // VRM 0.x 的模型被轉了 180 度，X 與 Z 軸的旋轉方向要反過來
  const s = vrm.meta?.metaVersion === '0' ? -1 : 1;
  const bone = (n) => vrm.humanoid.getNormalizedBoneNode(n);
  const la = bone('leftUpperArm');
  const ra = bone('rightUpperArm');
  if (la) la.rotation.z = -1.25 * s;
  if (ra) ra.rotation.z = 1.25 * s;
  const lf = bone('leftLowerArm');
  const rf = bone('rightLowerArm');
  if (lf) lf.rotation.y = -0.25 * s;
  if (rf) rf.rotation.y = 0.25 * s;

  // VRoid 臉上的細部形狀（Fcl_*），直接依名稱尾端查找
  const fcl = {};
  let fclCount = 0;
  vrm.scene.traverse((o) => {
    if (!o.isMesh || !o.morphTargetDictionary) return;
    for (const [name, index] of Object.entries(o.morphTargetDictionary)) {
      const m = name.match(/Fcl_[A-Za-z0-9_]+$/);
      if (!m) continue;
      if (!fcl[m[0]]) fclCount++;
      (fcl[m[0]] ||= []).push({ mesh: o, index });
    }
  });
  return {
    vrm,
    s,
    fcl,
    fclCount,
    bones: { head: bone('head'), neck: bone('neck'), chest: bone('chest') || bone('spine'), spine: bone('spine') },
    headQ: new THREE.Quaternion(),
    face: { blinkL: 0, blinkR: 0, aa: 0, oh: 0, ou: 0, smile: 0, browUp: 0, browDown: 0 },
  };
}

async function loadAvatars(onProgress) {
  const buf = await fetchWithProgress(CONFIG.MODEL_URL, (p) => onProgress(p * 0.6));
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  for (let i = 0; i < SEATS.length; i++) {
    const gltf = await loader.parseAsync(buf.slice(0), '');
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('模型不是有效的 VRM');
    state.avatars.push(buildAvatar(vrm, SEATS[i]));
    onProgress(0.6 + (0.4 * (i + 1)) / SEATS.length);
    await sleep(0);
  }
}

// ---------------------------------------------------------------- 鏡頭、麥克風、追蹤
async function openMedia() {
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
      audio: true,
    });
  } catch (e1) {
    // 其中一個裝置不行時，分開再試一次
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 } } });
    } catch {}
    try {
      const a = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (stream) a.getAudioTracks().forEach((t) => stream.addTrack(t));
      else stream = a;
    } catch {}
  }
  if (!stream) return;
  const vt = stream.getVideoTracks()[0];
  const at = stream.getAudioTracks()[0];
  if (vt) {
    video.srcObject = new MediaStream([vt]);
    await video.play().catch(() => {});
    const st = vt.getSettings();
    state.cameraOK = true;
    state.cameraInfo = `${st.width || '?'}x${st.height || '?'}@${Math.round(st.frameRate || 0)}`;
    video.classList.add('on');
  }
  if (at) {
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      await ac.resume().catch(() => {});
      const src = ac.createMediaStreamSource(new MediaStream([at]));
      analyser = ac.createAnalyser();
      analyser.fftSize = 512;
      analyserBuf = new Float32Array(analyser.fftSize);
      src.connect(analyser);
      state.micOK = true;
    } catch {}
  }
}

function readMic() {
  if (!analyser) return 0;
  analyser.getFloatTimeDomainData(analyserBuf);
  let sum = 0;
  for (let i = 0; i < analyserBuf.length; i++) sum += analyserBuf[i] * analyserBuf[i];
  const rms = Math.sqrt(sum / analyserBuf.length);
  const level = clamp01(rms * 6);
  state.micLevel += (level - state.micLevel) * 0.4;
  state.micPeak = Math.max(state.micPeak, level);
  $('mic-bar').style.width = `${Math.round(state.micLevel * 100)}%`;
  return state.micLevel;
}

async function initTracker() {
  const fileset = await FilesetResolver.forVisionTasks(CONFIG.WASM_DIR);
  let modelBuf = null;
  for (const url of CONFIG.FACE_MODEL_URLS) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > 100000) {
        modelBuf = buf;
        break;
      }
    } catch {}
  }
  if (!modelBuf) throw new Error('臉部追蹤模型下載失敗');
  const make = (delegate) =>
    FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: modelBuf, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });
  try {
    landmarker = await make('GPU');
    state.delegate = 'GPU';
  } catch (e) {
    landmarker = await make('CPU');
    state.delegate = 'CPU';
  }
  state.trackerOK = true;
}

// 追蹤統計（每個量測區間重設）
const track = { count: 0, ms: 0, faces: 0, lastVideoTime: -1, newFrame: false };
const hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
if (hasRVFC) {
  const onFrame = () => {
    track.newFrame = true;
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);
}
const latest = { has: false, shapes: {}, pitch: 0, yaw: 0, roll: 0 };
const _m = new THREE.Matrix4();
const _e = new THREE.Euler();

function runTracking() {
  if (!landmarker || !state.cameraOK || video.readyState < 2) return;
  // 只在鏡頭送來新畫面時才追蹤，避免同一張畫面重複運算
  if (hasRVFC) {
    if (!track.newFrame) return;
    track.newFrame = false;
  } else {
    if (video.currentTime === track.lastVideoTime) return;
    track.lastVideoTime = video.currentTime;
  }
  const t0 = performance.now();
  let res;
  try {
    res = landmarker.detectForVideo(video, t0);
  } catch (e) {
    state.trackerError = String(e?.message || e);
    return;
  }
  track.ms += performance.now() - t0;
  track.count++;
  const cats = res.faceBlendshapes?.[0]?.categories;
  const mat = res.facialTransformationMatrixes?.[0]?.data;
  latest.has = Boolean(cats && mat);
  if (!latest.has) return;
  track.faces++;
  for (const c of cats) latest.shapes[c.categoryName] = c.score;
  _m.fromArray(mat);
  _e.setFromRotationMatrix(_m, 'YXZ');
  latest.pitch = _e.x;
  latest.yaw = _e.y;
  latest.roll = _e.z;
}

// ---------------------------------------------------------------- 把臉套到角色上
const _q = new THREE.Quaternion();
const _eh = new THREE.Euler(0, 0, 0, 'YXZ');
function setFcl(av, name, v) {
  const list = av.fcl[name];
  if (!list) return false;
  for (const { mesh, index } of list) mesh.morphTargetInfluences[index] = v;
  return true;
}

function driveAvatar(av, t, dt, mic) {
  const k = 1 - Math.pow(0.001, dt * 4); // 平滑係數
  const f = av.face;
  const sh = latest.shapes;
  const sign = CONFIG.HEAD_SIGN;
  if (latest.has) {
    // 鏡像：使用者的左眼對應角色的右眼
    const tgt = {
      blinkL: remap(sh.eyeBlinkRight || 0, 0.15, 0.6),
      blinkR: remap(sh.eyeBlinkLeft || 0, 0.15, 0.6),
      aa: remap(sh.jawOpen || 0, 0.05, 0.55),
      oh: remap(sh.mouthFunnel || 0, 0.15, 0.7),
      ou: remap(sh.mouthPucker || 0, 0.35, 0.9),
      smile: remap(((sh.mouthSmileLeft || 0) + (sh.mouthSmileRight || 0)) / 2, 0.2, 0.8),
      browUp: remap(sh.browInnerUp || 0, 0.15, 0.7),
      browDown: remap(((sh.browDownLeft || 0) + (sh.browDownRight || 0)) / 2, 0.2, 0.7),
    };
    for (const key in tgt) f[key] += (tgt[key] - f[key]) * Math.min(1, k * 2);
    _eh.set(latest.pitch * sign.pitch * av.s, latest.yaw * sign.yaw, latest.roll * sign.roll * av.s);
    _q.setFromEuler(_eh);
    av.headQ.slerp(_q, k);
  } else {
    // 追蹤失效：回到待機，自動眨眼
    const blink = Math.sin(t * 0.9 + av.s) > 0.985 ? 1 : 0;
    f.blinkL += (blink - f.blinkL) * 0.5;
    f.blinkR = f.blinkL;
    for (const key of ['aa', 'oh', 'ou', 'smile', 'browUp', 'browDown']) f[key] *= 0.85;
    av.headQ.slerp(_q.identity(), k * 0.5);
  }
  if (state.lipByVolume || !latest.has) {
    const v = remap(mic, 0.08, 0.5);
    f.aa += (v - f.aa) * 0.5;
    f.oh *= 0.5;
    f.ou *= 0.5;
  }

  // 頭與脖子分攤旋轉，上半身跟著一點點
  const b = av.bones;
  if (b.head) b.head.quaternion.identity().slerp(av.headQ, 0.6);
  if (b.neck) b.neck.quaternion.identity().slerp(av.headQ, 0.4);
  if (b.spine) b.spine.quaternion.identity().slerp(av.headQ, 0.15);
  if (b.chest) b.chest.rotation.x = Math.sin(t * 1.4 + av.s) * 0.015 * av.s; // 呼吸

  const em = av.vrm.expressionManager;
  if (em) {
    em.setValue('blinkLeft', f.blinkL);
    em.setValue('blinkRight', f.blinkR);
    em.setValue('aa', f.aa);
    em.setValue('oh', f.oh);
    em.setValue('ou', f.ou);
  }
  av.vrm.update(dt);
  // 細部形狀要在 vrm.update 之後寫入，避免被標準表情覆蓋
  setFcl(av, 'Fcl_MTH_Fun', f.smile * 0.8);
  setFcl(av, 'Fcl_BRW_Surprised', f.browUp);
  setFcl(av, 'Fcl_BRW_Angry', f.browDown);
}

// ---------------------------------------------------------------- 主迴圈與量測
const clock = new THREE.Clock();
const frames = { on: false, deltas: [], last: 0 };

function tick(now) {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.1);
  const t = clock.elapsedTime;
  if (frames.on) {
    if (frames.last) frames.deltas.push(now - frames.last);
    frames.last = now;
  }
  const mic = readMic();
  if (state.mode !== 'idle') runTracking();
  const driven = state.mode === 'try' ? [state.avatars[1]] : state.avatars;
  for (const av of state.avatars) {
    if (driven.includes(av)) driveAvatar(av, t, dt, mic);
    else {
      const saved = latest.has;
      latest.has = false;
      driveAvatar(av, t, dt, 0);
      latest.has = saved;
    }
  }
  for (const m of floaters) {
    m.rotation.x = t * 0.3 + m.userData.phase;
    m.rotation.y = t * 0.4 + m.userData.phase;
    m.position.y += Math.sin(t * 0.8 + m.userData.phase) * 0.0015;
  }
  camera.position.lerp(camGoal.pos, 0.06);
  camLook.lerp(camGoal.look, 0.06);
  if (state.mode === 'bench') camera.position.x = Math.sin(t * 0.4) * 0.35; // 緩慢漂移
  camera.lookAt(camLook);
  renderer.render(scene, camera);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.mode === 'bench') state.hiddenDuringTest = true;
});

function percentile(arr, p) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(a.length * p))];
}

async function measure(level, onProgress) {
  applyLevel(level);
  const total = CONFIG.WARMUP_MS + CONFIG.MEASURE_MS;
  const start = performance.now();
  const until = async (ms) => {
    while (performance.now() - start < ms) {
      onProgress((performance.now() - start) / total);
      await sleep(100);
    }
  };
  await until(CONFIG.WARMUP_MS);
  frames.deltas = [];
  frames.last = 0;
  frames.on = true;
  track.count = 0;
  track.ms = 0;
  track.faces = 0;
  const t0 = performance.now();
  await until(total);
  frames.on = false;
  const secs = (performance.now() - t0) / 1000;
  const sum = frames.deltas.reduce((a, b) => a + b, 0);
  const p95 = percentile(frames.deltas, 0.95);
  return {
    fps: frames.deltas.length ? (frames.deltas.length / sum) * 1000 : 0,
    lowFps: p95 ? 1000 / p95 : 0,
    track: track.count / secs,
    trackMs: track.count ? track.ms / track.count : 0,
    faceRate: track.count ? track.faces / track.count : 0,
  };
}

function judge(results) {
  const tracked = state.cameraOK && state.trackerOK;
  const pass = (key) => {
    const rule = CONFIG.TIER[key];
    const r = results[rule.level];
    if (!r) return false;
    return r.fps >= rule.fps && r.lowFps >= rule.lowFps && (!tracked || r.track >= rule.track);
  };
  if (pass('S')) return 'S';
  if (pass('A')) return 'A';
  if (pass('B')) return 'B';
  return 'C';
}

function gpuName() {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  } catch {
    return '未知';
  }
}

function buildReport() {
  const r = state.results;
  const line = (lv) => {
    const x = r[lv.id];
    return x ? `${lv.label} ${lv.w}x${lv.h}：${x.fps.toFixed(0)} 幀（最低 ${x.lowFps.toFixed(0)}）` : `${lv.label}：未測`;
  };
  const any = r.low || r.mid || r.high || {};
  const data = {
    version: CONFIG.VERSION,
    name: $('name').value.trim(),
    tier: state.tier,
    tierName: TIER_TEXT[state.tier].name,
    results: r,
    camera: state.cameraOK ? state.cameraInfo : null,
    mic: state.micOK,
    micPeak: Number(state.micPeak.toFixed(2)),
    tracker: state.trackerOK ? state.delegate : null,
    trackerError: state.trackerError,
    fclShapes: state.avatars[0]?.fclCount || 0,
    gpu: gpuName(),
    cores: navigator.hardwareConcurrency || null,
    memoryGB: navigator.deviceMemory || null,
    screen: `${screen.width}x${screen.height}@${window.devicePixelRatio}`,
    ua: navigator.userAgent,
    hiddenDuringTest: state.hiddenDuringTest,
    time: new Date().toISOString(),
  };
  const text = [
    `【V皮座談 電腦檢測 v${CONFIG.VERSION}】`,
    `姓名：${data.name || '（未填）'}`,
    `等級：${data.tierName}（初步）`,
    ...CONFIG.LEVELS.map(line),
    state.cameraOK && state.trackerOK
      ? `臉部追蹤：每秒 ${(any.track || 0).toFixed(0)} 次，每次 ${(any.trackMs || 0).toFixed(1)} 毫秒（${state.delegate}），偵測到臉 ${Math.round((any.faceRate || 0) * 100)}%`
      : `臉部追蹤：未測（${state.cameraOK ? '追蹤模組載入失敗' : '沒有鏡頭'}）`,
    `鏡頭：${state.cameraOK ? state.cameraInfo : '無法使用'}　麥克風：${state.micOK ? `可用（音量峰值 ${data.micPeak}）` : '無法使用'}`,
    `顯示卡：${data.gpu}`,
    `核心 ${data.cores ?? '?'}　記憶體 ${data.memoryGB ?? '?'}GB　螢幕 ${data.screen}`,
    `瀏覽器：${data.ua}`,
    `時間：${new Date().toLocaleString('zh-TW')}`,
  ].join('\n');
  return { data, text };
}

// ---------------------------------------------------------------- 流程
async function run() {
  show('s-run');
  setRun('請允許使用鏡頭與麥克風', 0.02, '瀏覽器會跳出詢問視窗，請按「允許」。');
  await openMedia();

  setRun('載入測試舞台…', 0.05);
  await loadAvatars((p) => setRun('載入測試舞台…', 0.05 + p * 0.2));
  state.mode = 'bench';

  if (state.cameraOK) {
    setRun('載入臉部追蹤…', 0.27);
    try {
      await initTracker();
    } catch (e) {
      state.trackerError = String(e?.message || e);
    }
  }

  const span = 0.7 / CONFIG.LEVELS.length;
  for (let i = 0; i < CONFIG.LEVELS.length; i++) {
    const lv = CONFIG.LEVELS[i];
    const base = 0.3 + span * i;
    const r = await measure(lv, (p) => setRun(`測試中（${i + 1}/${CONFIG.LEVELS.length}）`, base + span * Math.min(1, p), '請看著鏡頭，可以隨意動動頭、說說話。'));
    state.results[lv.id] = r;
    if (r.fps < 25) break; // 這一級已經吃力，不必再往上測
  }

  state.mode = 'idle';
  state.tier = judge(state.results);
  const best = { S: 'high', A: 'mid', B: 'low', C: 'low' }[state.tier];
  applyLevel(CONFIG.LEVELS.find((l) => l.id === best));

  const { data, text } = buildReport();
  $('tier-name').textContent = TIER_TEXT[state.tier].name;
  $('tier-name').dataset.tier = state.tier;
  $('tier-advice').textContent = TIER_TEXT[state.tier].advice;
  $('result-text').value = text;
  const warns = [];
  if (!state.cameraOK) warns.push('沒有偵測到可用的鏡頭，所以沒有測臉部追蹤。請確認鏡頭已接上並允許使用後，重新整理再測一次。');
  else if (!state.trackerOK) warns.push('臉部追蹤模組沒有載入成功，可能是網路擋住了。請把結果照樣回報給我們。');
  if (!state.micOK) warns.push('沒有偵測到可用的麥克風。');
  if (state.hiddenDuringTest) warns.push('測試途中您切換到別的分頁，數字可能偏低，建議重新整理再測一次。');
  $('result-warn').hidden = warns.length === 0;
  $('result-warn').textContent = warns.join(' ');
  $('btn-try').hidden = !(state.cameraOK && state.trackerOK);
  show('s-result');

  if (CONFIG.REPORT_URL) {
    fetch(CONFIG.REPORT_URL, { method: 'POST', mode: 'no-cors', body: JSON.stringify(data) }).catch(() => {});
  }
}

function enterTry() {
  state.mode = 'try';
  const head = state.avatars[1].bones.head;
  const p = new THREE.Vector3();
  if (head) head.getWorldPosition(p);
  else p.set(0, 1.4, 0);
  camGoal.pos.set(0, p.y + 0.03, 1.25);
  camGoal.look.set(0, p.y + 0.02, 0);
  show('s-try');
}
function leaveTry() {
  state.mode = 'idle';
  camGoal.pos.copy(WIDE.pos);
  camGoal.look.copy(WIDE.look);
  show('s-result');
}

function fail(e) {
  console.error(e);
  state.mode = 'idle';
  $('error-msg').textContent = '很抱歉，檢測途中發生問題。請把下面這段訊息複製給我們，這本身也是有用的資訊。';
  $('error-text').value = [
    `【V皮座談 電腦檢測 v${CONFIG.VERSION}｜錯誤】`,
    `姓名：${$('name').value.trim() || '（未填）'}`,
    `訊息：${e?.message || e}`,
    `顯示卡：${gpuName()}`,
    `瀏覽器：${navigator.userAgent}`,
  ].join('\n');
  show('s-error');
}

// ---------------------------------------------------------------- 啟動
$('ver').textContent = `檢測頁 v${CONFIG.VERSION}`;
{
  const warns = [];
  if (/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)) warns.push('這個檢測要在您開播時會用的電腦上進行，請不要用手機或平板。');
  if (!navigator.mediaDevices?.getUserMedia) warns.push('這個瀏覽器無法使用鏡頭，請改用 Chrome。');
  if (warns.length) {
    $('intro-warn').hidden = false;
    $('intro-warn').textContent = warns.join(' ');
  }
}
$('btn-start').addEventListener('click', () => run().catch(fail));
$('btn-copy').addEventListener('click', (e) => copyText($('result-text').value, e.currentTarget));
$('btn-copy-err').addEventListener('click', (e) => copyText($('error-text').value, e.currentTarget));
$('btn-reload').addEventListener('click', () => location.reload());
$('btn-try').addEventListener('click', enterTry);
$('btn-back').addEventListener('click', leaveTry);
$('btn-lip').addEventListener('click', (e) => {
  state.lipByVolume = !state.lipByVolume;
  e.currentTarget.textContent = state.lipByVolume ? '嘴型：依音量' : '嘴型：依臉部';
});
window.addEventListener('error', (e) => {
  if (state.mode === 'bench') fail(e.error || e.message);
});
requestAnimationFrame(tick);
// 供自動化測試讀取
window.__vcheck = { state, CONFIG };

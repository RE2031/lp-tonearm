import { HandLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

/* ───────── 기하 ───────── */
const W = 1000, H = 700;
const C = { x: 350, y: 360 };          // LP 중심
const R = 270;                          // LP 반지름
const P = { x: 890, y: 110 };          // 톤암 회전축
const D = Math.hypot(C.x - P.x, C.y - P.y);
const L = D * 0.9;                      // 암 길이
const A0 = Math.atan2(C.y - P.y, C.x - P.x);
const T_REST = 0.85, T_MIN = 0.05, T_MAX = 0.95;   // 암 각도(θ) 범위
const GRAB_R = 135;
const BOXES = [                                    // 오른쪽 아래 버튼 상자 (두 번 집기)
  { id: "restart", x: 840, y: 375, w: 145, h: 140, icon: "↺", label: "처음으로" },
  { id: "next", x: 840, y: 530, w: 145, h: 140, icon: "⏭", label: "다음 곡" },
];
const boxAt = (p) => BOXES.find((b) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) || null;

const needlePos = (t) => ({ x: P.x + L * Math.cos(A0 - t), y: P.y + L * Math.sin(A0 - t) });
const onRecordAt = (t) => {
  const n = needlePos(t), r = Math.hypot(n.x - C.x, n.y - C.y);
  return r < R * 1.05;                            // 라벨 위(중심부)~판 바로 바깥까지 포함
};
const R_OUT = R * 0.95, R_IN = R * 0.42;       // R_IN 안쪽(중심부) = 처음부터, 바깥쪽 구간 = 위치 비례
const SNAP = 0.10;                               // 바깥 가장자리 10% 구간 = 0:00 자석
const progressForRadius = (r) => {
  if (r < R_IN) return 0;                         // 중심부 → 처음부터
  const q = (R_OUT - r) / (R_OUT - R_IN);         // 바깥 0 ~ 안쪽 1
  return q <= SNAP ? 0 : clamp((q - SNAP) / (1 - SNAP), 0, 0.98);
};
const progressAt = (t) => {
  const n = needlePos(t), r = Math.hypot(n.x - C.x, n.y - C.y);
  return progressForRadius(r);
};
const inStartZone = (t) => progressAt(t) === 0;
const thetaForProgress = (p) => {
  const r = R_OUT - (SNAP + p * (1 - SNAP)) * (R_OUT - R_IN);
  return Math.acos(clamp((D * D + L * L - r * r) / (2 * D * L), -1, 1));
};
const fmt = (sec) => {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), r = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
};
const normAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ───────── 상태 ───────── */
const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d");
const dpr = Math.min(window.devicePixelRatio || 1, 2);
canvas.width = W * dpr; canvas.height = H * dpr;
ctx.scale(dpr, dpr);
const statusEl = document.getElementById("status");

let theta = T_REST, grabbed = false, armed = true, onRecord = false, lift = 0;
let spin = 0, angle = 0, playing = false;
let prevDown = false, tap = null, lastTap = 0;
let pendingSeek = null, lastSeekAt = 0, lastTapBox = null;
let lastStartPlaybackAt = 0;
const flashAt = {};
const ripples = [];
const mouse = { x: 0, y: 0, down: false };
const hand = { x: 0, y: 0, thumb: null, index: null, down: false, visible: false, last: 0 };
const setStatus = (s) => (statusEl.textContent = s);

/* ───────── 곡 목록 / YouTube ───────── */
const DEFAULT_SONGS = [
  { id: "dQw4w9WgXcQ", title: "Rick Astley — Never Gonna Give You Up" },
  { id: "9bZkp7q19f0", title: "PSY — GANGNAM STYLE" },
  { id: "kJQP7kiw5Fk", title: "Luis Fonsi — Despacito" },
  { id: "5qap5aO4i9A", title: "Lofi Girl — beats to relax/study to 📚 (라이브)" },
];
let songs = DEFAULT_SONGS, results = [];
try {
  const j = JSON.parse(localStorage.getItem("yt_songs"));
  if (Array.isArray(j) && j.length) {
    songs = j.map(s => s.id === "jfKfPfyJRdk" ? { id: "5qap5aO4i9A", title: "Lofi Girl — beats to relax/study to 📚 (라이브)" } : s);
  }
} catch {}
const saveSongs = () => { try { localStorage.setItem("yt_songs", JSON.stringify(songs)); } catch {} };

let current = songs[0], labelImg = new Image(), ytReady = false, player = null;
labelImg.src = `https://i.ytimg.com/vi/${current.id}/hqdefault.jpg`;

const songsEl = document.getElementById("songs");
const nowEl = document.getElementById("now");
nowEl.textContent = current.title;
const thumb = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

const isTopic = (name) => /- Topic$/.test(name || "");
const resultsEl = document.getElementById("results");
const resultsHead = document.getElementById("results-head");

function renderSongs() {
  songsEl.innerHTML = "";
  songs.forEach((sg, idx) => {
    const li = document.createElement("li");
    if (current && current.id === sg.id) li.className = "on";
    li.innerHTML = `<img src="${thumb(sg.id)}" alt=""><span></span><button title="삭제">✕</button>`;
    li.querySelector("span").textContent = `${idx + 1}. ${sg.topic === false ? "⚠ " : ""}${sg.title}`;
    if (sg.topic === false) li.title = "Topic 영상이 아니라 광고가 나올 수 있어요";
    li.onclick = () => { unlockAudio(); selectSong(sg); };
    li.querySelector("button").onclick = (e) => {
      e.stopPropagation();
      songs = songs.filter((x) => x.id !== sg.id);
      saveSongs(); renderSongs(); renderResults();
    };
    songsEl.appendChild(li);
  });
  document.getElementById("pl-count").textContent = songs.length;
}

function renderResults() {
  resultsEl.innerHTML = ""; resultsHead.hidden = !results.length;
  results.forEach((r) => {
    const has = songs.some((x) => x.id === r.id);
    const li = document.createElement("li");
    li.innerHTML = `<img src="${thumb(r.id)}" alt=""><span></span><button>${has ? "✓" : "＋"}</button>`;
    li.querySelector("span").textContent = r.title;
    li.onclick = () => { unlockAudio(); if (!has) addSong(r); };
    resultsEl.appendChild(li);
  });
}

function addSong(item) {
  if (!songs.some((x) => x.id === item.id)) songs = [...songs, item];   // 뒤에 추가 = 재생 순서
  saveSongs(); renderSongs(); renderResults();
  setStatus(`플레이리스트에 추가: ${item.title} (총 ${songs.length}곡)`);
}

const getDur = () => (ytReady && player && player.getDuration ? player.getDuration() || 0 : 0);

function selectSong(s) {
  current = s;
  if (onRecord) { pendingSeek = null; lastSeekAt = performance.now(); }
  nowEl.textContent = s.title;
  labelImg = new Image();
  labelImg.src = thumb(s.id);
  renderSongs();
  if (!ytReady || !player) return;
  if (onRecord) {
    if (player.loadVideoById) player.loadVideoById(s.id);
  } else {
    if (player.cueVideoById) player.cueVideoById(s.id);
    setStatus("곡을 골랐어요. 핀을 LP 위에 올려보세요.");
  }
}

/* ───────── 브라우저 오디오 언락 ───────── */
let audioUnlocked = false;
function unlockAudio() {
  if (audioUnlocked || !ytReady || !player) return;
  try {
    // 사용자 제스처 이벤트 내에서 playVideo를 호출하여 iframe의 자동재생 제한을 해제
    player.playVideo();
    if (!onRecord) {
      player.pauseVideo();
    }
    audioUnlocked = true;
  } catch (err) {}
}

window.addEventListener("pointerdown", unlockAudio, { passive: true });
window.addEventListener("touchstart", unlockAudio, { passive: true });

function initPlayer() {
  if (player) return;
  player = new YT.Player("yt", {
    host: "https://www.youtube.com",
    videoId: current.id,
    width: "100%", height: "100%",
    playerVars: {
      playsinline: 1,
      rel: 0,
      controls: 0,
      disablekb: 1,
      fs: 0,
      iv_load_policy: 3,
      modestbranding: 1,
      origin: window.location.origin,
      enablejsapi: 1
    },
    events: {
      onReady: () => {
        ytReady = true;
        try {
          const iframe = player.getIframe();
          if (iframe) {
            iframe.tabIndex = -1;
            iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
            iframe.setAttribute("allow", "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share");
          }
        } catch (e) {}
        if (current && player.cueVideoById) {
          player.cueVideoById(current.id);
        }
      },
      onStateChange: (e) => {
        playing = e.data === YT.PlayerState.PLAYING || e.data === YT.PlayerState.BUFFERING;
        if (e.data === YT.PlayerState.PLAYING) audioUnlocked = true;
        // LP 밖에서 재생/정지를 바꾸려는 시도를 되돌림
        if (e.data === YT.PlayerState.PAUSED && onRecord && !grabbed) player.playVideo();
        if (e.data === YT.PlayerState.PLAYING && !onRecord && !grabbed) player.pauseVideo();
        if (e.data === YT.PlayerState.PLAYING && pendingSeek !== null) {
          const dur = getDur();
          if (dur > 0) { player.seekTo(Math.min(pendingSeek * dur, dur - 2), true); lastSeekAt = performance.now(); }
          pendingSeek = null;
        }
        if (e.data === YT.PlayerState.ENDED) { onRecord = false; setStatus("곡이 끝났어요. 핀이 제자리로 돌아갑니다."); }
        updatePlayButton();
      },
      onError: (e) => {
        onRecord = false;
        let msg = "이 영상은 재생할 수 없어요 (퍼가기 제한). 다른 곡을 골라보세요.";
        if (e.data === 150 || e.data === 101) msg = "퍼가기가 제한된 음원/영상입니다. 다른 곡을 선택해 주세요.";
        else if (e.data === 2) msg = "유효하지 않은 영상 링크입니다.";
        setStatus(msg);
        updatePlayButton();
      },
    },
  });
}

if (window.YT && window.YT.Player) {
  initPlayer();
} else {
  window.onYouTubeIframeAPIReady = initPlayer;
  if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(s);
  }
}

function startPlayback(p) {
  if (!current) selectSong(songs[0]);
  if (!ytReady || !player) { setStatus("플레이어 로딩 중… 잠시 후 다시 올려주세요."); onRecord = false; return; }
  lastStartPlaybackAt = performance.now();
  const dur = getDur();
  const vData = player.getVideoData ? player.getVideoData() : null;
  const same = vData && vData.video_id === current.id;
  if (same && (dur > 0 || p === 0)) {
    player.seekTo(p === 0 ? 0 : Math.min(p * dur, dur - 2), true);
    lastSeekAt = performance.now();
    pendingSeek = null;
    player.playVideo();
    setStatus(p === 0 ? "♪ 처음부터 재생 — 핀을 집어 올리면 멈춰요." : `♪ ${fmt(p * dur)} 부터 재생 — 핀을 집어 올리면 멈춰요.`);
  } else {
    pendingSeek = p > 0 ? p : null;
    if (same) {
      player.playVideo();
    } else {
      const targetSec = p === 0 ? 0 : (dur > 0 ? Math.min(p * dur, dur - 2) : 0);
      player.loadVideoById({ videoId: current.id, startSeconds: targetSec });
    }
    setStatus("♪ 재생 중 — 핀을 집어 올리면 멈춰요.");
  }
}

/* 곡 추가 / 검색 */
const keyEl = document.getElementById("api-key");
try { keyEl.value = localStorage.getItem("yt_key") || ""; } catch {}
keyEl.onchange = () => { try { localStorage.setItem("yt_key", keyEl.value.trim()); } catch {} };

document.getElementById("add-form").onsubmit = async (e) => {
  e.preventDefault();
  unlockAudio();
  const input = document.getElementById("add-input");
  const text = input.value.trim();
  if (!text) return;
  const ids = [...new Set([...text.matchAll(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/g)].map((m) => m[1]))];
  if (!ids.length && /^[\w-]{11}$/.test(text)) ids.push(text);
  if (ids.length) {                                   // 링크(여러 개 가능) → 플레이리스트에 추가
    const items = await Promise.all(ids.map(async (id) => {
      let title = id, topic;
      try {
        const o = await (await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`)).json();
        title = o.title; topic = isTopic(o.author_name);
      } catch {}
      return { id, title, topic };
    }));
    items.forEach((it) => { if (!songs.some((x) => x.id === it.id)) songs = [...songs, it]; });
    saveSongs(); renderSongs(); renderResults();
    selectSong(songs.find((x) => x.id === items[0].id));
    setStatus(`${items.length}곡을 플레이리스트에 추가했어요 (총 ${songs.length}곡)` + (items.some((x) => x.topic === false) ? " — ⚠ Topic 영상이 아닌 곡은 광고가 나올 수 있어요." : ""));
  } else if (keyEl.value.trim()) {                    // 검색 → 결과 목록 (＋ 로 담기)
    try {
      const u = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&videoCategoryId=10&maxResults=50&q=${encodeURIComponent(text + " topic")}&key=${keyEl.value.trim()}`;
      const j = await (await fetch(u)).json();
      if (j.error) throw new Error(j.error.message);
      const div = document.createElement("div");
      results = j.items.filter((i) => isTopic(i.snippet.channelTitle)).slice(0, 12)
        .map((i) => { div.innerHTML = i.snippet.title; return { id: i.id.videoId, title: div.textContent, topic: true }; });
      renderResults();
      setStatus(results.length ? "Topic(광고 적은 음원) 결과만 보여줘요. ＋ 를 눌러 담으세요." : "Topic 채널 결과가 없어요. 아티스트명+곡명으로 다시 검색해 보세요.");
    } catch (err) { setStatus("검색 실패: " + err.message); }
  } else {
    setStatus("검색하려면 API 키가 필요해요. 유튜브 링크를 붙여넣으면 바로 추가됩니다 (여러 개도 가능).");
  }
  input.value = "";
};

/* ───────── 재생 / 정지 버튼 ───────── */
const togglePlayBtn = document.getElementById("toggle-play-btn");

function updatePlayButton() {
  if (!togglePlayBtn) return;
  if (onRecord && playing) {
    togglePlayBtn.textContent = "⏸ 톤암 내리기 (정지)";
    togglePlayBtn.classList.remove("primary");
    togglePlayBtn.classList.add("secondary");
  } else {
    togglePlayBtn.textContent = "▶ 톤암 올려서 재생";
    togglePlayBtn.classList.add("primary");
    togglePlayBtn.classList.remove("secondary");
  }
}

function togglePlay(forcePlay = false) {
  unlockAudio();
  if (onRecord && !forcePlay) {
    onRecord = false;
    if (ytReady && player) player.pauseVideo();
    setStatus("톤암을 내렸어요 (정지).");
  } else {
    onRecord = true;
    theta = thetaForProgress(0);
    startPlayback(0);
  }
  updatePlayButton();
}

if (togglePlayBtn) {
  togglePlayBtn.onclick = () => togglePlay();
}

/* ───────── 손 인식 (웹캠) & 안내 모달 ───────── */
const video = document.getElementById("cam");
const camBtn = document.getElementById("cam-btn");
let landmarker = null, lastVideoTime = -1;

const modalOverlay = document.getElementById("cam-modal");
const modalTitle = document.getElementById("cam-modal-title");
const modalBody = document.getElementById("cam-modal-body");
const modalPlayBtn = document.getElementById("modal-play-btn");
const modalCloseBtn = document.getElementById("modal-close-btn");

function showModal(title, htmlContent, showPlay = true) {
  if (!modalOverlay) return;
  modalTitle.textContent = title;
  modalBody.innerHTML = htmlContent;
  if (modalPlayBtn) modalPlayBtn.hidden = !showPlay;
  modalOverlay.hidden = false;
}
function closeModal() {
  if (modalOverlay) modalOverlay.hidden = true;
}
if (modalCloseBtn) modalCloseBtn.onclick = closeModal;
if (modalPlayBtn) {
  modalPlayBtn.onclick = () => {
    closeModal();
    togglePlay(true);
  };
}
if (modalOverlay) {
  modalOverlay.onclick = (e) => {
    if (e.target === modalOverlay) closeModal();
  };
}

const isInApp = /KAKAOTALK|Instagram|NAVER|Line|FB_IAB|FB4A|FBAN/i.test(navigator.userAgent);

camBtn.onclick = async () => {
  unlockAudio();

  // 브라우저 미지원 체크
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showModal(
      "📷 카메라 미지원 브라우저",
      `<p>현재 브라우저에서는 웹캠/카메라 기능을 지원하지 않습니다.</p>` +
      (isInApp
        ? `<p><strong>카카오톡 / 인앱 브라우저</strong>에서는 카메라 접근이 기본 차단되어 있습니다.<br>우측 상단 메뉴에서 <strong>'다른 브라우저로 열기 (Safari / Chrome)'</strong>를 선택해 주세요.</p>`
        : `<p>최신 버전의 <strong>Chrome, Edge, Safari</strong> 브라우저를 이용해 주세요.</p>`) +
      `<p>마우스로도 LP판이나 톤암을 움직여 모든 기능을 즐기실 수 있습니다.</p>`
    );
    return;
  }

  camBtn.disabled = true;
  camBtn.textContent = "카메라 요청 중…";

  let stream = null;
  try {
    // 3단계 호환성 폴백: 전면(user) -> 기본 해상도 -> 모든 비디오 장치
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }
      });
    } catch (e1) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 } }
        });
      } catch (e2) {
        stream = await navigator.mediaDevices.getUserMedia({ video: true });
      }
    }

    video.parentElement.hidden = false;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();

    camBtn.textContent = "AI 모델 로딩 중…";
    const fileset = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task", delegate },
      runningMode: "VIDEO", numHands: 1,
    });
    try { landmarker = await HandLandmarker.createFromOptions(fileset, opts("GPU")); }
    catch { landmarker = await HandLandmarker.createFromOptions(fileset, opts("CPU")); }

    camBtn.disabled = false;
    camBtn.textContent = "📷 카메라 켜짐 (제스처 사용 중)";
    setStatus("손을 보여주세요. 엄지+검지를 맞대어(핀치) 핀 끝을 집고, LP 위에서 놓으세요.");
  } catch (err) {
    if (stream) {
      try { stream.getTracks().forEach((t) => t.stop()); } catch {}
    }
    video.parentElement.hidden = true;
    camBtn.disabled = false;
    camBtn.textContent = "📷 카메라 켜기";

    let title = "카메라를 켤 수 없습니다";
    let body = "";

    if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
      title = "카메라를 감지하지 못했습니다";
      body = `<p>브라우저에서 사용 가능한 카메라(웹캠)를 찾을 수 없습니다.</p>` +
             `<ul>` +
             `<li><strong>카메라 연결:</strong> 외장 웹캠이 컴퓨터 USB 포트에 정상 연결되어 있는지 확인해 주세요.</li>` +
             `<li><strong>Windows 카메라 권한:</strong> <strong>Windows 설정 > 개인 정보 및 보안 > 카메라</strong>에서 <strong>'앱의 카메라 액세스'</strong> 및 <strong>'데스크톱 앱의 카메라 액세스'</strong>가 [켬]으로 되어 있는지 확인해 주세요.</li>` +
             `<li><strong>노트북/스마트폰:</strong> 카메라가 내장된 노트북이나 스마트폰에서 접속하시면 바로 손 제스처를 사용하실 수 있습니다.</li>` +
             `</ul>` +
             `<p>마우스나 터치로도 LP판이나 톤암을 클릭하여 즉시 음악을 들으실 수 있습니다.</p>`;
    } else if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
      title = "카메라 권한이 차단되었습니다";
      body = `<p>브라우저에서 카메라 권한이 차단되어 있습니다.</p>` +
             `<p>주소창 왼쪽의 <strong>자물쇠 아이콘(또는 사이트 설정)</strong>을 눌러 카메라 권한을 <strong>'허용'</strong>으로 변경한 뒤 페이지를 새로고침해 주세요.</p>`;
    } else if (err.name === "NotReadableError" || err.name === "TrackStartError") {
      title = "카메라가 다른 프로그램에서 사용 중입니다";
      body = `<p>Zoom, Discord, OBS, 카카오톡 또는 기본 카메라 앱에서 카메라를 이미 사용하고 있을 수 있습니다.</p>` +
             `<p>해당 프로그램을 완전히 종료한 후 다시 <strong>📷 카메라 켜기</strong>를 눌러주세요.</p>`;
    } else {
      body = `<p>카메라 연결 중 오류가 발생했습니다: <strong>${err.name}: ${err.message}</strong></p>` +
             `<p>마우스나 터치로도 LP판과 톤암을 자유롭게 조작하실 수 있습니다.</p>`;
    }

    showModal(title, body);
    setStatus("카메라 오류: " + (err.name === "NotFoundError" ? "카메라 장치 인식 실패" : err.message));
  }
};

const toCanvas = (lm) => ({
  x: clamp(((1 - lm.x) - 0.5) * 1.3 + 0.5, 0, 1) * W,   // 거울 모드 + 이동 범위 확대
  y: clamp((lm.y - 0.5) * 1.3 + 0.5, 0, 1) * H,
});

function detectHand(now) {
  if (!landmarker || video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  const res = landmarker.detectForVideo(video, now);
  if (!res.landmarks.length) { if (now - hand.last > 300) { hand.visible = false; hand.down = false; } return; }
  const lm = res.landmarks[0];
  const t = toCanvas(lm[4]), i = toCanvas(lm[8]);
  const size = Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y) || 1;
  const ratio = Math.hypot(lm[4].x - lm[8].x, lm[4].y - lm[8].y) / size;
  hand.down = hand.down ? ratio < 0.48 : ratio < 0.35;    // 히스테리시스 (핀치 인식 감도 개선)
  const px = (t.x + i.x) / 2, py = (t.y + i.y) / 2;
  const k = hand.visible ? 0.55 : 1;
  hand.x += (px - hand.x) * k; hand.y += (py - hand.y) * k;
  hand.thumb = t; hand.index = i; hand.visible = true; hand.last = now;
}

/* ───────── 마우스 / 터치 조작 (카메라 없이 테스트) ───────── */
const toLocal = (e) => {
  const r = canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
};
canvas.addEventListener("pointerdown", (e) => {
  unlockAudio();
  Object.assign(mouse, toLocal(e), { down: true });
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => Object.assign(mouse, toLocal(e)));
canvas.addEventListener("pointerup", (e) => {
  const loc = toLocal(e);
  const wasGrabbed = grabbed;
  mouse.down = false;

  if (!hand.visible && wasGrabbed) {
    grabbed = false;
    if (onRecordAt(theta)) {
      onRecord = true;
      startPlayback(progressAt(theta));
    } else {
      setStatus("LP 위가 아니에요. 핀이 제자리로 돌아갑니다.");
    }
    updatePlayButton();
  } else if (!hand.visible && !wasGrabbed) {
    // LP판을 직접 클릭한 경우: 해당 위치로 톤암 이동 및 재생 시작
    const r = Math.hypot(loc.x - C.x, loc.y - C.y);
    if (r <= R) {
      const p = progressForRadius(r);
      theta = thetaForProgress(p);
      onRecord = true;
      startPlayback(p);
      updatePlayButton();
    } else {
      // 톤암 핀 근처를 클릭한 경우: 정지 및 제자리 복귀
      const n = needlePos(theta);
      if (onRecord && Math.hypot(loc.x - n.x, loc.y - n.y) < GRAB_R) {
        onRecord = false;
        if (ytReady && player) player.pauseVideo();
        setStatus("톤암을 제자리로 돌려놓았습니다.");
        updatePlayButton();
      }
    }
  }
});
canvas.addEventListener("pointercancel", () => (mouse.down = false));

/* 유튜브 창 잠금: 광고가 나올 때만 클릭 가능 */
const ytWrap = document.querySelector(".yt-wrap"), adBtn = document.getElementById("ad-btn");
let unlockUntil = 0, ytUnlocked = false, lastAdCheck = 0, adAuto = false;
const setUnlocked = (on) => {
  ytUnlocked = on;
  ytWrap.classList.toggle("unlocked", on);
  adBtn.textContent = on ? "🔓 광고 건너뛰기 가능 (잠시 후 자동 잠금)" : "🔒 잠김 — 광고가 나오면 눌러서 잠금 해제";
};
adBtn.onclick = () => { unlockAudio(); unlockUntil = performance.now() + 15000; };
const ytShield = document.getElementById("yt-shield");
ytShield.onclick = () => {
  unlockAudio();
  if (onRecord && !playing && ytReady && player) {
    player.playVideo();
  }
};

function updateLock(now) {
  if (ytReady && player && player.getVideoData && now - lastAdCheck > 500) {
    lastAdCheck = now;
    try { adAuto = playing && !!current && !!player.getVideoData().video_id && player.getVideoData().video_id !== current.id; } catch { adAuto = false; }
  }
  const on = adAuto || now < unlockUntil;
  if (on !== ytUnlocked) setUnlocked(on);
}

function nextSong() {
  if (songs.length < 2) { setStatus("플레이리스트에 곡이 하나뿐이에요. 곡을 더 추가해 주세요."); return; }
  const i = current ? songs.findIndex((x) => x.id === current.id) : -1;
  selectSong(songs[(i + 1) % songs.length]);
  setStatus("⏭ 다음 곡: " + current.title);
}
function restartSong() {
  if (!onRecord || !ytReady) { setStatus("핀이 LP 위에 있을 때 쓸 수 있어요."); return; }
  player.seekTo(0, true); player.playVideo();
  pendingSeek = null; lastSeekAt = performance.now();
  setStatus("↺ 처음부터 다시 재생");
}
function onTap(now, tp) {
  ripples.push({ x: tp.x, y: tp.y, t: now });
  if (lastTapBox === tp.id && now - lastTap < 700) {
    lastTap = 0; lastTapBox = null; flashAt[tp.id] = now;
    if (tp.id === "next") nextSong(); else restartSong();
  } else { lastTap = now; lastTapBox = tp.id; }
}

/* ───────── 업데이트 ───────── */
function update(dt, now) {
  detectHand(now);
  updateLock(now);
  const inp = hand.visible ? hand : mouse;
  const n = needlePos(theta);
  const near = Math.hypot(inp.x - n.x, inp.y - n.y) < GRAB_R;

  if (!inp.down) armed = true;
  if (inp.down && armed && !grabbed && near && !boxAt(inp)) {
    grabbed = true; armed = false;
    if (!current) selectSong(songs[0]);
    if (onRecord) { onRecord = false; if (ytReady && player) player.pauseVideo(); }
    setStatus("핀을 잡았어요. 중심 쪽 끝까지 가서 놓으면 처음부터, 바깥쪽에 놓으면 그 위치부터 재생돼요.");
    updatePlayButton();
  }

  // hand(카메라)로 놓았을 때의 처리 (마우스는 pointerup에서 즉시 처리)
  if (grabbed && !inp.down && hand.visible) {
    grabbed = false;
    if (onRecordAt(theta)) { onRecord = true; startPlayback(progressAt(theta)); }
    else setStatus("LP 위가 아니에요. 핀이 제자리로 돌아갑니다.");
    updatePlayButton();
  }

  // 마우스 커서 동적 변경 (조작 가능한 영역 안내)
  if (!hand.visible) {
    if (grabbed) canvas.style.cursor = "grabbing";
    else if (near) canvas.style.cursor = "grab";
    else if (Math.hypot(inp.x - C.x, inp.y - C.y) <= R || boxAt(inp)) canvas.style.cursor = "pointer";
    else canvas.style.cursor = "default";
  }

  // 브라우저 자동재생 차단 감지 (1.5초 이상 지났는데 아직 playing이 아닐 때 사용자 안내)
  if (onRecord && !playing && now - lastStartPlaybackAt > 1500 && now - lastStartPlaybackAt < 12000) {
    setStatus("소리를 재생하려면 화면 아무 곳이나 한 번 클릭해 주세요 🔊");
  }

  // 오른쪽 아래 상자에서 더블 핀치
  if (inp.down && !prevDown) {
    const b = !grabbed && boxAt(inp);
    tap = b ? { t: now, x: inp.x, y: inp.y, id: b.id } : null;
  }
  if (tap && (grabbed || now - tap.t > 350 || Math.hypot(inp.x - tap.x, inp.y - tap.y) > 70)) tap = null;
  if (!inp.down && prevDown && tap) { onTap(now, tap); tap = null; }
  prevDown = inp.down;

  if (grabbed) {
    const a = Math.atan2(inp.y - P.y, inp.x - P.x);
    const target = clamp(normAngle(A0 - a), T_MIN, T_MAX);
    theta += (target - theta) * Math.min(1, dt * 20);
  } else {
    let target = onRecord ? theta : T_REST;
    if (onRecord && pendingSeek === null && now - lastSeekAt > 1200 && ytReady && player) {
      const dur = getDur();
      if (dur > 0 && player.getCurrentTime) target = thetaForProgress(clamp(player.getCurrentTime() / dur, 0, 1));
    }
    theta += (target - theta) * Math.min(1, dt * 6);
  }
  lift += ((grabbed ? 1 : 0) - lift) * Math.min(1, dt * 12);

  const wantSpin = onRecord && playing ? 3.5 : 0;   // rad/s ≈ 33rpm
  spin += (wantSpin - spin) * Math.min(1, dt * 1.5);
  angle += spin * dt;
}

/* ───────── 렌더 ───────── */
function drawRecord() {
  ctx.save(); ctx.translate(C.x, C.y);
  // 턴테이블 플래터
  ctx.fillStyle = "#0d0d0e"; ctx.beginPath(); ctx.arc(0, 0, R + 16, 0, 7); ctx.fill();
  ctx.fillStyle = "#2b2b2e"; ctx.beginPath(); ctx.arc(0, 0, R + 6, 0, 7); ctx.fill();
  // 비닐
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
  g.addColorStop(0, "#1c1c1f"); g.addColorStop(1, "#08080a");
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, R, 0, 7); ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,.04)"; ctx.lineWidth = 1;
  for (let r = R * 0.4; r < R * 0.97; r += 3.5) { ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.stroke(); }
  if (ctx.createConicGradient) {                       // 고정된 빛 반사
    const cg = ctx.createConicGradient(-0.6, 0, 0);
    [[0, 0], [.07, .13], [.14, 0], [.5, 0], [.57, .13], [.64, 0], [1, 0]].forEach(([o, a]) => cg.addColorStop(o, `rgba(255,255,255,${a})`));
    ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(0, 0, R * 0.97, 0, 7); ctx.fill();
  }
  // 드롭 존 표시
  if (grabbed) {
    const hot = onRecordAt(theta);
    const bw = SNAP * (R_OUT - R_IN);              // 바깥 가장자리 0:00 띠
    ctx.lineWidth = bw; ctx.strokeStyle = "rgba(226,103,59,.22)";
    ctx.beginPath(); ctx.arc(0, 0, R_OUT - bw / 2, 0, 7); ctx.stroke();
    ctx.setLineDash([8, 8]); ctx.lineWidth = 2;
    ctx.strokeStyle = hot ? "rgba(226,103,59,.95)" : "rgba(226,103,59,.35)";
    [0.95, 0.42].forEach((k) => { ctx.beginPath(); ctx.arc(0, 0, R * k, 0, 7); ctx.stroke(); });
    ctx.setLineDash([]);
  }
  // 회전하는 라벨
  ctx.rotate(angle);
  ctx.save(); ctx.beginPath(); ctx.arc(0, 0, R * 0.32, 0, 7); ctx.clip();
  if (labelImg && labelImg.complete && labelImg.naturalWidth) {
    const s = R * 0.64; ctx.drawImage(labelImg, -s * 0.89, -s / 2, s * 1.78, s);  // 16:9 → 중앙 크롭 느낌
  } else { ctx.fillStyle = "#c9573a"; ctx.fillRect(-R, -R, R * 2, R * 2); }
  ctx.restore();
  ctx.fillStyle = "rgba(0,0,0,.25)"; ctx.beginPath(); ctx.arc(R * 0.2, 0, 4, 0, 7); ctx.fill();
  ctx.fillStyle = "#ddd"; ctx.beginPath(); ctx.arc(0, 0, 6, 0, 7); ctx.fill();
  ctx.restore();
}

function drawArm() {
  const n = needlePos(theta), a = A0 - theta, ux = Math.cos(a), uy = Math.sin(a);
  const off = 6 + lift * 18;
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(0,0,0,.35)"; ctx.lineWidth = 9;                       // 그림자
  ctx.beginPath(); ctx.moveTo(P.x + off, P.y + off); ctx.lineTo(n.x + off, n.y + off); ctx.stroke();
  ctx.strokeStyle = "#8d8d92"; ctx.lineWidth = 12;                              // 카운터웨이트
  ctx.beginPath(); ctx.moveTo(P.x - ux * 20, P.y - uy * 20); ctx.lineTo(P.x - ux * 70, P.y - uy * 70); ctx.stroke();
  const g = ctx.createLinearGradient(P.x, P.y, n.x, n.y);                        // 암
  g.addColorStop(0, "#f2f2f4"); g.addColorStop(1, "#b5b5ba");
  ctx.strokeStyle = g; ctx.lineWidth = 7;
  ctx.beginPath(); ctx.moveTo(P.x, P.y); ctx.lineTo(n.x, n.y); ctx.stroke();
  ctx.fillStyle = "#3a3a3e"; ctx.beginPath(); ctx.arc(P.x, P.y, 30, 0, 7); ctx.fill();  // 베이스
  ctx.fillStyle = "#d4d4d8"; ctx.beginPath(); ctx.arc(P.x, P.y, 16, 0, 7); ctx.fill();
  // 헤드셸
  ctx.save(); ctx.translate(n.x, n.y); ctx.rotate(a);
  const sc = 1 + lift * 0.12; ctx.scale(sc, sc);
  ctx.fillStyle = "#1f1f22"; ctx.beginPath(); ctx.roundRect(-46, -11, 56, 22, 5); ctx.fill();
  ctx.fillStyle = "#e2673b"; ctx.fillRect(-46, -11, 8, 22);
  ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(0, 0, 2.5, 0, 7); ctx.fill();  // 바늘 끝
  ctx.restore();
  // 잡을 수 있음 표시
  const inp = hand.visible ? hand : mouse;
  if (!grabbed && Math.hypot(inp.x - n.x, inp.y - n.y) < GRAB_R) {
    ctx.strokeStyle = "rgba(226,103,59,.8)"; ctx.lineWidth = 3; ctx.setLineDash([6, 6]);
    ctx.beginPath(); ctx.arc(n.x, n.y, 44, 0, 7); ctx.stroke(); ctx.setLineDash([]);
  }
}

function drawHand() {
  if (!hand.visible || !hand.thumb) return;
  const c = hand.down ? "#e2673b" : "#ffffff";
  ctx.strokeStyle = c; ctx.fillStyle = c; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(hand.thumb.x, hand.thumb.y); ctx.lineTo(hand.index.x, hand.index.y); ctx.stroke();
  [hand.thumb, hand.index].forEach((p) => { ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, 7); ctx.fill(); });
  ctx.globalAlpha = 0.6; ctx.beginPath(); ctx.arc(hand.x, hand.y, hand.down ? 14 : 22, 0, 7); ctx.stroke(); ctx.globalAlpha = 1;
}

function drawTime() {
  if (!grabbed && !onRecord) return;
  const dur = getDur();
  let txt, hot = false;
  if (grabbed) {
    hot = onRecordAt(theta);
    txt = !hot ? "LP 위에 올려보세요" : inStartZone(theta) ? "↺ 처음부터 재생" : dur > 0 ? `${fmt(progressAt(theta) * dur)} / ${fmt(dur)}` : "LIVE";
  } else txt = dur > 0 && player && player.getCurrentTime ? `${fmt(player.getCurrentTime())} / ${fmt(dur)}` : "LIVE";
  const n = needlePos(theta);
  ctx.font = "600 22px system-ui, sans-serif";
  const w = ctx.measureText(txt).width + 28, x = clamp(n.x - 14, w / 2 + 8, W - w / 2 - 8), y = Math.min(n.y + 56, H - 26);
  ctx.fillStyle = hot ? "rgba(226,103,59,.92)" : "rgba(0,0,0,.72)";
  ctx.beginPath(); ctx.roundRect(x - w / 2, y - 18, w, 36, 18); ctx.fill();
  ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(txt, x, y + 1);
}

function drawBoxes() {
  const now = performance.now(), inp = hand.visible ? hand : mouse, over = grabbed ? null : boxAt(inp);
  for (const b of BOXES) {
    const flash = clamp(1 - (now - (flashAt[b.id] || -1e9)) / 400, 0, 1), hover = over === b;
    ctx.fillStyle = flash > 0 ? `rgba(226,103,59,${0.5 + 0.4 * flash})` : hover ? "rgba(226,103,59,.4)" : "rgba(0,0,0,.4)";
    ctx.beginPath(); ctx.roundRect(b.x, b.y, b.w, b.h, 18); ctx.fill();
    ctx.strokeStyle = hover ? "#e2673b" : "rgba(255,255,255,.45)"; ctx.lineWidth = 3; ctx.setLineDash([10, 8]);
    ctx.stroke(); ctx.setLineDash([]);
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = "48px system-ui, sans-serif"; ctx.fillText(b.icon, cx, cy - 22);
    ctx.font = "700 22px system-ui, sans-serif"; ctx.fillText(b.label, cx, cy + 24);
    ctx.font = "13px system-ui, sans-serif"; ctx.fillStyle = "rgba(255,255,255,.7)"; ctx.fillText("두 번 집기", cx, cy + 48);
  }
}

function drawRipples() {
  const now = performance.now();
  for (let i = ripples.length - 1; i >= 0; i--) {
    const k = (now - ripples[i].t) / 500;
    if (k >= 1) { ripples.splice(i, 1); continue; }
    ctx.strokeStyle = `rgba(255,255,255,${0.7 * (1 - k)})`; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(ripples[i].x, ripples[i].y, 16 + k * 50, 0, 7); ctx.stroke();
  }
}

function render() {
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#4a3220"); bg.addColorStop(1, "#2a1b11");
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  drawRecord(); drawBoxes(); drawArm(); drawHand(); drawTime(); drawRipples();
}

let prev = performance.now();
function loop(now) {
  update(Math.min((now - prev) / 1000, 0.05), now); prev = now;
  render(); requestAnimationFrame(loop);
}
renderSongs();
requestAnimationFrame(loop);

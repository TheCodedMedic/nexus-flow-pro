const CHAR_DELAY_MS = 50;

// Reference image state — supports multiple references, all attached to every prompt.
const MAX_REF_IMAGES = 8;
let refImages = []; // [{ base64, name }]

const promptsEl        = document.getElementById("prompts");
const waitMinEl        = document.getElementById("waitMin");
const waitMaxEl        = document.getElementById("waitMax");
const statusEl         = document.getElementById("status");
const appEl            = document.getElementById("app");
const versionTagEl     = document.getElementById("versionTag");
const txtUploadEl      = document.getElementById("txtUpload");
const runBtn           = document.getElementById("run");
const continueBtn      = document.getElementById("continueBtn");
const stopBtn          = document.getElementById("stop");
const redownloadBtn    = document.getElementById("redownloadBtn");
const connBar          = document.getElementById("connBar");
const connDot          = document.getElementById("connDot");
const connMsg          = document.getElementById("connMsg");
const connLink         = document.getElementById("connLink");
const agentBar         = document.getElementById("agentBar");
const agentMsg         = document.getElementById("agentMsg");
const agentBadge       = document.getElementById("agentBadge");
const helpDialog       = document.getElementById("helpDialog");
const helpOpen         = document.getElementById("helpOpen");
const helpClose        = document.getElementById("helpClose");
const helpBodyEl       = document.getElementById("helpBody");
const listSection      = document.getElementById("listSection");
const promptListEl     = document.getElementById("promptList");
const listCountEl      = document.getElementById("listCount");
const downloadFolderEl = document.getElementById("downloadFolder");
const namingModeEl     = document.getElementById("namingMode");
const upscaleToggleEl  = document.getElementById("upscaleToggle");
const parallelCountEl  = document.getElementById("parallelCount");
const langSelectEl     = document.getElementById("langSelect");
const openDlSettings   = document.getElementById("openDlSettings");

// ─────────────────────────────────────────────
// Version from manifest
const { version } = chrome.runtime.getManifest();
if (versionTagEl) versionTagEl.textContent = `v${version}`;

function randomIntInclusive(min, max) {
  const a = Math.ceil(min);
  const b = Math.floor(max);
  return a + Math.floor(Math.random() * (b - a + 1));
}

// ─────────────────────────────────────────────
// TXT file upload
// ─────────────────────────────────────────────
if (txtUploadEl) {
  txtUploadEl.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target.result || "";
      // Each non-empty line becomes a prompt
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
      promptsEl.value = lines.join("\n");
      rebuildList();
      persist();
    };
    reader.readAsText(file);
    txtUploadEl.value = ""; // reset so same file can be re-uploaded
  });
}

// ─────────────────────────────────────────────
// Reference image upload
// ─────────────────────────────────────────────
const refImageUploadEl  = document.getElementById("refImageUpload");
const refImageClearEl   = document.getElementById("refImageClear");
const refImageListEl    = document.getElementById("refImageList");
const loadRefsBtn       = document.getElementById("loadRefsBtn");
const hardRefreshBtn    = document.getElementById("hardRefreshBtn");

function persistRefImages() {
  chrome.storage.local.set({ nexusRefImages: refImages });
}

// Render the reference images as a thumbnail gallery. The upload button is left
// untouched (always "Upload character reference") so more can always be added.
// Each thumbnail carries an ✕ badge in its top-right corner to remove just that one.
function renderRefImages() {
  if (!refImageListEl) return;

  // The "Load references" button is only usable when there are images to load.
  if (loadRefsBtn) loadRefsBtn.disabled = refImages.length === 0 || isRunning;

  if (!refImages.length) {
    refImageListEl.style.display = "none";
    refImageListEl.innerHTML     = "";
    if (refImageClearEl) refImageClearEl.style.display = "none";
    return;
  }

  refImageListEl.style.display = "flex";
  if (refImageClearEl) refImageClearEl.style.display = "inline-flex";

  refImageListEl.innerHTML = "";
  refImages.forEach((ref, idx) => {
    const item = document.createElement("div");
    item.className = "ref-image-item";
    item.title = ref.name || `Reference ${idx + 1}`;

    const img = document.createElement("img");
    img.src = ref.base64;
    img.alt = ref.name || `Reference ${idx + 1}`;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ref-image-remove";
    remove.title = "Remove this reference";
    remove.setAttribute("aria-label", "Remove this reference");
    remove.textContent = "✕";
    remove.addEventListener("click", () => {
      refImages.splice(idx, 1);
      persistRefImages();
      renderRefImages();
    });

    item.appendChild(img);
    item.appendChild(remove);
    refImageListEl.appendChild(item);
  });
}

if (refImageUploadEl) {
  refImageUploadEl.addEventListener("change", (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    const remaining = MAX_REF_IMAGES - refImages.length;
    if (remaining <= 0) {
      setStatus(`Maximum of ${MAX_REF_IMAGES} reference images reached.`);
      refImageUploadEl.value = "";
      return;
    }

    const toAdd = files.slice(0, remaining);
    const startLen = refImages.length;
    let pending = toAdd.length;
    toAdd.forEach((file, i) => {
      const slot = startLen + i;
      refImages[slot] = null; // reserve slot to preserve selection order
      const reader = new FileReader();
      reader.onload = (ev) => {
        refImages[slot] = { base64: ev.target.result, name: file.name };
        if (--pending === 0) {
          refImages = refImages.filter(Boolean);
          persistRefImages();
          renderRefImages();
        }
      };
      reader.readAsDataURL(file);
    });

    if (files.length > remaining) {
      setStatus(`Added ${remaining} — max ${MAX_REF_IMAGES} reference images.`);
    }
    refImageUploadEl.value = "";
  });
}

if (refImageClearEl) {
  refImageClearEl.addEventListener("click", () => {
    refImages = [];
    chrome.storage.local.remove("nexusRefImages");
    refImageUploadEl.value = "";
    renderRefImages();
  });
}

// ─────────────────────────────────────────────
// i18n strings
// ─────────────────────────────────────────────
const LANGS = {
  en: {
    promptQueueLabel:  "Prompt queue",
    promptQueueHint:   "One prompt per line · list updates as you type",
    queueTitle:        "Queue",
    promptCount:       (n) => `${n} prompt${n === 1 ? "" : "s"}`,
    delayFrom:         "Random delay from",
    delayTo:           "To",
    delaySec:          "sec",
    downloadFolderLabel: "Download folder",
    autoDownload:      "Auto-save",
    checkPage:         "Check page",
    runQueue:          "Start Generation",
    stop:              "Stop",
    statusPending:     "Pending",
    statusGenerating:  "Generating…",
    statusDone:        "Done ✓",
    statusFailed:      "Failed ✗",
    statusStopped:     "Skipped",
    helpTitle:         "Getting Started",
    helpClose:         "Got it",
    helpDelayTitle:    "Random delay",
    helpDelayBody:     "After each generation, Nexus Flow Pro waits a random number of seconds within your set range before starting the next prompt.",
    helpBody: `
      <p class="lede">① Go to your Google Flow project:<br/>
        <a class="path-link" href="https://flow.google.com/project/" target="_blank">
          https://flow.google.com/project/
        </a>
      </p>
      <p class="lede">② Enter your prompts below — one per line. Your queue updates as you type.</p>
      <p class="lede">③ Click <strong>Run queue</strong>. Nexus Flow Pro generates each image one at a time and downloads it automatically.</p>`,
    placeholder: "A red bicycle on a rainy street\nA watercolor fox in a forest\nNeon alley at dusk, cinematic",
    msgStarting:    (n)   => `Starting ${n} prompt(s)…`,
    msgSubmitting:  (i,n) => `Submitting prompt ${i} of ${n}…`,
    msgWaiting:     (i)   => `Prompt ${i} submitted — waiting for generation…`,
    msgDownloading: (i)   => `Prompt ${i} done ✓ — downloading image…`,
    msgDone:        (i)   => `Next prompt in ${i}s…`,
    msgAllDone:     (n)   => `✓ All ${n} prompt(s) generated.`,
    msgPartDone:    (c,n) => `Done: ${c} of ${n} generated.`,
    msgStopped:     "Stopped.",
    msgChecking:    "Checking…",
    msgConnected:   (h)   => `Connected: ${h}`,
    msgNoTab:       "No active tab.",
    msgNotReady:    "Content script not ready. Open a Flow project tab and refresh.",
    msgTimeout:     (i)   => `Prompt ${i} timed out.`,
    msgError:       (i,e) => `Error on prompt ${i}: ${e}`,
    msgAddPrompt:   "Add at least one prompt.",
    msgOpenProject: "Please open a Flow project page first (URL must contain /project/).",
  },
  vi: {
    promptQueueLabel:  "Hàng đợi prompt",
    promptQueueHint:   "Mỗi dòng một prompt · danh sách cập nhật khi bạn gõ",
    queueTitle:        "Hàng đợi",
    promptCount:       (n) => `${n} prompt`,
    delayFrom:         "Độ trễ ngẫu nhiên từ",
    delayTo:           "đến",
    delaySec:          "giây",
    downloadFolderLabel: "Thư mục tải xuống",
    autoDownload:      "Tự động lưu",
    checkPage:         "Kiểm tra trang",
    runQueue:          "Chạy hàng đợi",
    stop:              "Dừng",
    statusPending:     "Chờ",
    statusGenerating:  "Đang tạo…",
    statusDone:        "Hoàn thành ✓",
    statusFailed:      "Lỗi ✗",
    statusStopped:     "Đã bỏ qua",
    helpTitle:         "Hướng dẫn sử dụng",
    helpClose:         "Đã hiểu",
    helpDelayTitle:    "Độ trễ ngẫu nhiên",
    helpDelayBody:     "Sau mỗi lần tạo ảnh, Nexus Flow Pro chờ một khoảng thời gian ngẫu nhiên trong phạm vi bạn đặt trước khi bắt đầu prompt tiếp theo.",
    helpBody: `
      <p class="lede">① Truy cập dự án Google Flow của bạn:<br/>
        <a class="path-link" href="https://flow.google.com/project/" target="_blank">
          https://flow.google.com/project/
        </a>
      </p>
      <p class="lede">② Nhập prompt bên dưới — mỗi dòng một cái. Danh sách cập nhật ngay khi bạn gõ.</p>
      <p class="lede">③ Nhấn <strong>Chạy hàng đợi</strong>. Nexus Flow Pro tạo từng ảnh một và tự động tải xuống.</p>`,
    placeholder: "Xe đạp đỏ trên phố mưa\nCáo màu nước trong rừng\nHẻm neon lúc hoàng hôn",
    msgStarting:    (n)   => `Đang bắt đầu ${n} prompt…`,
    msgSubmitting:  (i,n) => `Đang gửi prompt ${i}/${n}…`,
    msgWaiting:     (i)   => `Đã gửi prompt ${i} — đang chờ tạo ảnh…`,
    msgDownloading: (i)   => `Prompt ${i} xong ✓ — đang tải xuống…`,
    msgDone:        (i)   => `Prompt tiếp theo sau ${i} giây…`,
    msgAllDone:     (n)   => `✓ Đã hoàn thành ${n} prompt.`,
    msgPartDone:    (c,n) => `Xong: ${c}/${n} prompt.`,
    msgStopped:     "Đã dừng.",
    msgChecking:    "Đang kiểm tra…",
    msgConnected:   (h)   => `Đã kết nối: ${h}`,
    msgNoTab:       "Không có tab nào đang mở.",
    msgNotReady:    "Chưa sẵn sàng. Mở trang dự án Flow và làm mới.",
    msgTimeout:     (i)   => `Prompt ${i} hết thời gian chờ.`,
    msgError:       (i,e) => `Lỗi prompt ${i}: ${e}`,
    msgAddPrompt:   "Hãy thêm ít nhất một prompt.",
    msgOpenProject: "Vui lòng mở trang dự án Flow trước (URL phải chứa /project/).",
  },
  zh: {
    promptQueueLabel:  "提示词队列",
    promptQueueHint:   "每行一个提示词 · 输入即更新",
    queueTitle:        "队列",
    promptCount:       (n) => `${n} 个提示词`,
    delayFrom:         "随机延迟从",
    delayTo:           "到",
    delaySec:          "秒",
    downloadFolderLabel: "下载文件夹",
    autoDownload:      "自动保存",
    checkPage:         "检查页面",
    runQueue:          "运行队列",
    stop:              "停止",
    statusPending:     "等待中",
    statusGenerating:  "生成中…",
    statusDone:        "完成 ✓",
    statusFailed:      "失败 ✗",
    statusStopped:     "已跳过",
    helpTitle:         "使用指南",
    helpClose:         "明白了",
    helpDelayTitle:    "随机延迟",
    helpDelayBody:     "每次生成完成后，Nexus Flow Pro 会在您设定的范围内随机等待一段时间，然后开始下一个提示词。",
    helpBody: `
      <p class="lede">① 前往您的 Google Flow 项目：<br/>
        <a class="path-link" href="https://flow.google.com/project/" target="_blank">
          https://flow.google.com/project/
        </a>
      </p>
      <p class="lede">② 在下方输入提示词 — 每行一个，列表即时更新。</p>
      <p class="lede">③ 点击<strong>运行队列</strong>。Nexus Flow Pro 逐一生成图像并自动下载。</p>`,
    placeholder: "雨中的红色自行车\n森林里的水彩狐狸\n黄昏时的霓虹小巷",
    msgStarting:    (n)   => `开始处理 ${n} 个提示词…`,
    msgSubmitting:  (i,n) => `正在提交第 ${i}/${n} 个提示词…`,
    msgWaiting:     (i)   => `第 ${i} 个已提交 — 等待生成…`,
    msgDownloading: (i)   => `第 ${i} 个完成 ✓ — 正在下载…`,
    msgDone:        (i)   => `${i} 秒后开始下一个…`,
    msgAllDone:     (n)   => `✓ 全部 ${n} 个提示词已完成。`,
    msgPartDone:    (c,n) => `完成：${c}/${n} 个。`,
    msgStopped:     "已停止。",
    msgChecking:    "检查中…",
    msgConnected:   (h)   => `已连接：${h}`,
    msgNoTab:       "没有活动标签页。",
    msgNotReady:    "内容脚本未就绪。请打开 Flow 项目页面并刷新。",
    msgTimeout:     (i)   => `第 ${i} 个提示词超时。`,
    msgError:       (i,e) => `第 ${i} 个出错：${e}`,
    msgAddPrompt:   "请至少添加一个提示词。",
    msgOpenProject: "请先打开 Flow 项目页面（URL 需包含 /project/）。",
  },
  ko: {
    promptQueueLabel:  "프롬프트 큐",
    promptQueueHint:   "한 줄에 하나씩 · 입력하면 목록이 즉시 업데이트됩니다",
    queueTitle:        "큐",
    promptCount:       (n) => `${n}개 프롬프트`,
    delayFrom:         "무작위 지연",
    delayTo:           "~",
    delaySec:          "초",
    downloadFolderLabel: "다운로드 폴더",
    autoDownload:      "자동 저장",
    checkPage:         "페이지 확인",
    runQueue:          "큐 실행",
    stop:              "정지",
    statusPending:     "대기 중",
    statusGenerating:  "생성 중…",
    statusDone:        "완료 ✓",
    statusFailed:      "실패 ✗",
    statusStopped:     "건너뜀",
    helpTitle:         "시작하기",
    helpClose:         "확인",
    helpDelayTitle:    "무작위 지연",
    helpDelayBody:     "각 생성 완료 후 Nexus Flow Pro는 설정한 범위 내에서 무작위 시간 동안 대기한 후 다음 프롬프트를 시작합니다.",
    helpBody: `
      <p class="lede">① Google Flow 프로젝트로 이동하세요:<br/>
        <a class="path-link" href="https://flow.google.com/project/" target="_blank">
          https://flow.google.com/project/
        </a>
      </p>
      <p class="lede">② 아래에 프롬프트를 입력하세요 — 한 줄에 하나씩. 입력하는 즉시 목록이 업데이트됩니다.</p>
      <p class="lede">③ <strong>큐 실행</strong>을 클릭하세요. Nexus Flow Pro가 이미지를 하나씩 생성하고 자동으로 다운로드합니다.</p>`,
    placeholder: "빗속의 빨간 자전거\n숲 속의 수채화 여우\n황혼의 네온 골목",
    msgStarting:    (n)   => `${n}개 프롬프트 시작 중…`,
    msgSubmitting:  (i,n) => `${n}개 중 ${i}번째 제출 중…`,
    msgWaiting:     (i)   => `${i}번째 제출됨 — 생성 대기 중…`,
    msgDownloading: (i)   => `${i}번째 완료 ✓ — 다운로드 중…`,
    msgDone:        (i)   => `${i}초 후 다음 프롬프트…`,
    msgAllDone:     (n)   => `✓ ${n}개 프롬프트 모두 완료.`,
    msgPartDone:    (c,n) => `완료: ${n}개 중 ${c}개.`,
    msgStopped:     "정지됨.",
    msgChecking:    "확인 중…",
    msgConnected:   (h)   => `연결됨: ${h}`,
    msgNoTab:       "활성 탭이 없습니다.",
    msgNotReady:    "준비되지 않았습니다. Flow 프로젝트 탭을 열고 새로고침하세요.",
    msgTimeout:     (i)   => `${i}번째 프롬프트 시간 초과.`,
    msgError:       (i,e) => `${i}번째 오류: ${e}`,
    msgAddPrompt:   "프롬프트를 하나 이상 추가하세요.",
    msgOpenProject: "먼저 Flow 프로젝트 페이지를 여세요 (URL에 /project/ 포함).",
  },
  es: {
    promptQueueLabel:  "Cola de prompts",
    promptQueueHint:   "Un prompt por línea · la lista se actualiza al escribir",
    queueTitle:        "Cola",
    promptCount:       (n) => `${n} prompt${n === 1 ? "" : "s"}`,
    delayFrom:         "Demora aleatoria de",
    delayTo:           "a",
    delaySec:          "seg",
    downloadFolderLabel: "Carpeta de descarga",
    autoDownload:      "Guardado auto",
    checkPage:         "Verificar página",
    runQueue:          "Ejecutar cola",
    stop:              "Detener",
    statusPending:     "Pendiente",
    statusGenerating:  "Generando…",
    statusDone:        "Listo ✓",
    statusFailed:      "Error ✗",
    statusStopped:     "Omitido",
    helpTitle:         "Cómo empezar",
    helpClose:         "Entendido",
    helpDelayTitle:    "Demora aleatoria",
    helpDelayBody:     "Tras cada generación, Nexus Flow Pro espera un tiempo aleatorio dentro del rango configurado antes de iniciar el siguiente prompt.",
    helpBody: `
      <p class="lede">① Ve a tu proyecto de Google Flow:<br/>
        <a class="path-link" href="https://flow.google.com/project/" target="_blank">
          https://flow.google.com/project/
        </a>
      </p>
      <p class="lede">② Escribe tus prompts abajo — uno por línea. La cola se actualiza al instante.</p>
      <p class="lede">③ Haz clic en <strong>Ejecutar cola</strong>. Nexus Flow Pro genera cada imagen una a una y la descarga automáticamente.</p>`,
    placeholder: "Una bicicleta roja en una calle lluviosa\nUn zorro en acuarela en el bosque\nCallejón neón al atardecer",
    msgStarting:    (n)   => `Iniciando ${n} prompt(s)…`,
    msgSubmitting:  (i,n) => `Enviando prompt ${i} de ${n}…`,
    msgWaiting:     (i)   => `Prompt ${i} enviado — esperando generación…`,
    msgDownloading: (i)   => `Prompt ${i} listo ✓ — descargando…`,
    msgDone:        (i)   => `Siguiente en ${i}s…`,
    msgAllDone:     (n)   => `✓ ${n} prompt(s) generados.`,
    msgPartDone:    (c,n) => `Hecho: ${c} de ${n}.`,
    msgStopped:     "Detenido.",
    msgChecking:    "Verificando…",
    msgConnected:   (h)   => `Conectado: ${h}`,
    msgNoTab:       "No hay pestaña activa.",
    msgNotReady:    "Script no listo. Abre la página del proyecto Flow y recarga.",
    msgTimeout:     (i)   => `Prompt ${i} superó el tiempo límite.`,
    msgError:       (i,e) => `Error en prompt ${i}: ${e}`,
    msgAddPrompt:   "Añade al menos un prompt.",
    msgOpenProject: "Abre primero una página de proyecto Flow (URL debe contener /project/).",
  },
  ja: {
    promptQueueLabel:  "プロンプトキュー",
    promptQueueHint:   "1行に1つ · 入力するとリストが更新されます",
    queueTitle:        "キュー",
    promptCount:       (n) => `${n}件`,
    delayFrom:         "ランダム遅延",
    delayTo:           "〜",
    delaySec:          "秒",
    downloadFolderLabel: "ダウンロードフォルダ",
    autoDownload:      "自動保存",
    checkPage:         "ページ確認",
    runQueue:          "キュー実行",
    stop:              "停止",
    statusPending:     "待機中",
    statusGenerating:  "生成中…",
    statusDone:        "完了 ✓",
    statusFailed:      "失敗 ✗",
    statusStopped:     "スキップ",
    helpTitle:         "はじめかた",
    helpClose:         "わかった",
    helpDelayTitle:    "ランダム遅延",
    helpDelayBody:     "各生成が完了した後、Nexus Flow Proは設定した範囲内でランダムな秒数を待ってから次のプロンプトを開始します。",
    helpBody: `
      <p class="lede">① Google Flowプロジェクトへ移動:<br/>
        <a class="path-link" href="https://flow.google.com/project/" target="_blank">
          https://flow.google.com/project/
        </a>
      </p>
      <p class="lede">② プロンプトを1行ずつ入力。キューはリアルタイムで更新されます。</p>
      <p class="lede">③ <strong>キュー実行</strong>をクリック。Nexus Flow Proが1枚ずつ画像を生成・自動ダウンロードします。</p>`,
    placeholder: "雨の日の赤い自転車\n森の中の水彩画の狐\n夕暮れのネオン路地",
    msgStarting:    (n)   => `${n}件のプロンプトを開始…`,
    msgSubmitting:  (i,n) => `プロンプト ${i}/${n} を送信中…`,
    msgWaiting:     (i)   => `プロンプト ${i} 送信済 — 生成を待機中…`,
    msgDownloading: (i)   => `プロンプト ${i} 完了 ✓ — ダウンロード中…`,
    msgDone:        (i)   => `次のプロンプトまで ${i} 秒…`,
    msgAllDone:     (n)   => `✓ ${n}件すべて完了。`,
    msgPartDone:    (c,n) => `完了: ${n}件中${c}件。`,
    msgStopped:     "停止しました。",
    msgChecking:    "確認中…",
    msgConnected:   (h)   => `接続済み: ${h}`,
    msgNoTab:       "アクティブなタブがありません。",
    msgNotReady:    "準備ができていません。Flowプロジェクトを開いて更新してください。",
    msgTimeout:     (i)   => `プロンプト ${i} がタイムアウトしました。`,
    msgError:       (i,e) => `プロンプト ${i} エラー: ${e}`,
    msgAddPrompt:   "プロンプトを1つ以上入力してください。",
    msgOpenProject: "先にFlowプロジェクトページを開いてください（URLに /project/ が必要）。",
  },
};

// ─────────────────────────────────────────────
// Language / i18n
// ─────────────────────────────────────────────
let currentLang = "en";

function t(key, ...args) {
  const s = LANGS[currentLang]?.[key] ?? LANGS.en[key];
  return typeof s === "function" ? s(...args) : (s ?? key);
}

function applyLanguage() {
  const L = LANGS[currentLang] || LANGS.en;

  // Static data-i18n elements
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.getAttribute("data-i18n");
    const val = L[key];
    if (val && typeof val === "string") el.textContent = val;
  });

  // Help body (HTML)
  if (helpBodyEl) helpBodyEl.innerHTML = L.helpBody || LANGS.en.helpBody;

  // Rebuild list count label
  rebuildList();
}

if (langSelectEl) {
  langSelectEl.addEventListener("change", () => {
    currentLang = langSelectEl.value;
    applyLanguage();
    chrome.storage.local.set({ nexusLang: currentLang });
  });
}

// ─────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function randomWait(minMs, maxMs) {
  return minMs + Math.floor(Math.random() * Math.max(1, maxMs - minMs + 1));
}

function setStatus(text) { statusEl.textContent = text; }

let flowTabId     = null; // locked-in tab ID during generation
let resumeFromIdx = null; // index to resume from after a stop/failure

function setInputsDisabled(disabled) {
  promptsEl.disabled        = disabled;
  namingModeEl.disabled     = disabled;
  downloadFolderEl.disabled = disabled;
  waitMinEl.disabled        = disabled;
  waitMaxEl.disabled        = disabled;
  txtUploadEl.disabled      = disabled;
  if (parallelCountEl) parallelCountEl.disabled = disabled;
  const opacity = disabled ? "0.45" : "";
  [promptsEl, namingModeEl, downloadFolderEl, waitMinEl, waitMaxEl, txtUploadEl, parallelCountEl]
    .forEach(el => el && (el.style.opacity = opacity));
  const uploadLabel = document.querySelector(".btn-txt-upload");
  if (uploadLabel) uploadLabel.style.opacity = opacity;
}

function showContinue(fromIndex) {
  resumeFromIdx = fromIndex;
  continueBtn.style.display = "";
  continueBtn.textContent   = `▶ Continue from #${fromIndex + 1}`;
  runBtn.disabled = true; // keep Start Generation disabled
}

function hideContinue() {
  resumeFromIdx = null;
  continueBtn.style.display = "none";
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToFlowTab(message) {
  if (!chrome.runtime?.id) {
    setStatus("Sidepanel is stale — close it and reopen from the Nexus Flow Pro icon.");
    return null;
  }
  const tabId = flowTabId || (await getActiveTab())?.id;
  if (!tabId) { setStatus(t("msgNoTab")); return null; }

  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    // Attempt automatic injection of content script into the tab
    if (chrome.scripting) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["selectors.js", "content.js"]
        });
        await sleep(300);
        const res = await chrome.tabs.sendMessage(tabId, message);
        checkConnection();
        return res;
      } catch (e2) {
        const msg = String(e2?.message || e2);
        if (msg.includes("context invalidated")) {
          setStatus("Sidepanel is stale — close it and reopen from the Nexus Flow Pro icon.");
        } else {
          setStatus("Content script not ready. Hard-refresh the Flow tab (Cmd+Shift+R), then retry.");
        }
        return null;
      }
    }
    return null;
  }
}

// ─────────────────────────────────────────────
// Help dialog
// ─────────────────────────────────────────────
if (helpOpen  && helpDialog?.showModal) helpOpen.addEventListener("click",  () => helpDialog.showModal());
if (helpClose && helpDialog?.close)     helpClose.addEventListener("click", () => helpDialog.close());

// ─────────────────────────────────────────────
// Auto-download settings link
// ─────────────────────────────────────────────
openDlSettings?.addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://settings/downloads" });
});

// ─────────────────────────────────────────────
// html escape
// ─────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─────────────────────────────────────────────
// Prompt list
// ─────────────────────────────────────────────
let promptStatuses = [];
let isRunning = false;

function statusLabel(s) {
  return t("status" + s.charAt(0).toUpperCase() + s.slice(1));
}

function parsePrompts() {
  return promptsEl.value.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
}

function rebuildList() {
  const lines = parsePrompts();
  if (!lines.length) { listSection.style.display = "none"; return; }

  const prev = promptStatuses;
  promptStatuses = lines.map((text, i) => ({
    text,
    status: (prev[i] && prev[i].text === text) ? prev[i].status : "pending",
  }));

  renderList();
  listSection.style.display = "";
  const n = lines.length;
  listCountEl.textContent = t("promptCount", n);
}

function renderList() {
  promptListEl.innerHTML = "";
  promptStatuses.forEach((item, i) => {
    const row = document.createElement("div");
    row.className = "prompt-item" + statusClass(item.status);
    row.id = `pr-${i}`;
    row.innerHTML =
      `<span class="prompt-num">${i + 1}</span>` +
      `<span class="prompt-text" title="${escHtml(item.text)}">${escHtml(item.text)}</span>` +
      `<span class="prompt-status s-${item.status}">${statusLabel(item.status)}</span>` +
      `<button type="button" class="prompt-retry" data-idx="${i}" title="Regenerate this image and replace the saved file">↻ Retry</button>`;
    promptListEl.appendChild(row);
  });
}

function statusClass(s) {
  return s === "generating" ? " is-running"
       : s === "done"       ? " is-done"
       : s === "failed"     ? " is-failed"
       : s === "stopped"    ? " is-stopped" : "";
}

function updateStatus(index, status) {
  if (index < 0 || index >= promptStatuses.length) return;
  promptStatuses[index].status = status;
  const row = document.getElementById(`pr-${index}`);
  if (!row) return;
  row.className = "prompt-item" + statusClass(status);
  const badge = row.querySelector(".prompt-status");
  if (badge) { badge.className = `prompt-status s-${status}`; badge.textContent = statusLabel(status); }
  if (status === "generating") row.scrollIntoView({ block: "nearest" });
}

promptsEl.addEventListener("input", () => {
  if (!isRunning) {
    rebuildList();
    hideContinue();        // clear resume state when prompts change
    clearRedownloadConfirm(); // a pending re-download no longer matches the new prompts
    runBtn.disabled = !connBar.classList.contains("is-connected") || agentModeOn;
  }
});

// ─────────────────────────────────────────────
// Per-prompt Retry — regenerate one image and replace its saved file
// ─────────────────────────────────────────────
promptListEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".prompt-retry");
  if (!btn) return;
  if (isRunning) { setStatus("Wait for the current run to finish before retrying."); return; }
  const idx = Number(btn.dataset.idx);
  if (!Number.isNaN(idx)) retryPrompt(idx);
});

async function retryPrompt(index) {
  if (isRunning) return;
  const item = promptStatuses[index];
  if (!item) return;

  const tab = await getActiveTab();
  if (!tab?.id || !FLOW_PROJECT_RE.test(tab.url || "")) { setStatus(t("msgOpenProject")); return; }
  flowTabId = tab.id;

  const prevStatus = item.status;
  isRunning = true;
  setInputsDisabled(true);
  runBtn.disabled = true;
  appEl.classList.add("is-running");
  updateStatus(index, "generating");
  setStatus(`Retrying prompt ${index + 1}…`);

  try {
    const begin = await sendToFlowTab({ type: "FLOW_PIPELINE_BEGIN" });
    if (!begin || begin.error) { setStatus(begin?.error || t("msgNotReady")); updateStatus(index, prevStatus); return; }

    const sub = await sendToFlowTab({
      type: "FLOW_SUBMIT_ONE",
      prompt: stripTimestamp(item.text),
      charDelayMs: CHAR_DELAY_MS,
      refImages: refImages.map(r => r.base64),
      isFirstPrompt: false,
    });
    if (!isRunning) { updateStatus(index, prevStatus); return; }
    if (!sub || sub.error) { setStatus(sub?.error || "Retry submit failed."); updateStatus(index, "failed"); return; }

    setStatus(`Prompt ${index + 1} regenerating — waiting…`);
    const c = await sendToFlowTab({ type: "FLOW_COLLECT_NEXT", timeoutMs: 180000 });

    if (c?.done && c.url) {
      setStatus(`Replacing image for prompt ${index + 1}…`);
      await downloadGeneratedImages([c.url], index, item.text);   // same index → same filename → overwrite
      updateStatus(index, "done");
      setStatus(`✓ Prompt ${index + 1} regenerated and replaced.`);
    } else if (c?.stopped || !isRunning) {
      updateStatus(index, prevStatus);                            // leave the old image in place
      setStatus("Retry stopped.");
    } else {
      updateStatus(index, "failed");
      setStatus(`Retry of prompt ${index + 1} failed — old image kept.`);
    }
  } finally {
    await sendToFlowTab({ type: "FLOW_PIPELINE_END" });
    isRunning = false;
    flowTabId = null;
    setInputsDisabled(false);
    runBtn.disabled = false;
    appEl.classList.remove("is-running");
  }
}

// ─────────────────────────────────────────────
// Re-download: re-name & re-save every already-generated image, in prompt order.
// Two-phase: (1) scan & show the counts for review, (2) confirm to actually save.
// ─────────────────────────────────────────────
const redownloadConfirmEl    = document.getElementById("redownloadConfirm");
const redownloadConfirmMsgEl = document.getElementById("redownloadConfirmMsg");
const redownloadSaveBtn      = document.getElementById("redownloadConfirmSave");
const redownloadCancelBtn    = document.getElementById("redownloadConfirmCancel");

let pendingRedownload = null;   // { ordered, lines, skip, T, P } awaiting confirmation

function clearRedownloadConfirm() {
  pendingRedownload = null;
  if (redownloadConfirmEl) redownloadConfirmEl.style.display = "none";
}

// Phase 1 — scan the page, compute the mapping, and show counts for review.
async function scanForRedownload() {
  if (isRunning) return;
  clearRedownloadConfirm();

  const lines = parsePrompts();
  if (!lines.length) { setStatus("Paste your full prompt list (with timestamps) first."); return; }

  const tab = await getActiveTab();
  if (!tab?.id || !FLOW_PROJECT_RE.test(tab.url || "")) { setStatus(t("msgOpenProject")); return; }
  flowTabId = tab.id;

  isRunning = true;
  setInputsDisabled(true);
  runBtn.disabled = true;
  if (redownloadBtn) redownloadBtn.disabled = true;
  appEl.classList.add("is-running");
  setStatus("Scanning every image on the page…");

  let result = null;
  try {
    const res = await sendToFlowTab({
      type: "FLOW_COLLECT_ALL_IMAGES",
      excludeReference: true,
      excludePattern: "reference",
      refNames: (refImages || []).map(r => r.name).filter(Boolean)
    });
    if (!isRunning) return;
    if (!res || res.error || !Array.isArray(res.srcs)) {
      setStatus(res?.error || "Couldn't read the images from the page.");
      return;
    }
    const srcs = res.srcs;            // grid order, top→bottom = newest→oldest
    const T = srcs.length, P = lines.length;
    if (T < P) {
      setStatus(`Found only ${T} images but you pasted ${P} prompts — can't map. Check the page.`);
      return;
    }
    const skip = T - P;
    // Newest P tiles are the story images (references are older). Reverse → oldest→newest.
    const ordered = srcs.slice(0, P).reverse();   // ordered[i] ↔ lines[i]
    result = { ordered, lines, skip, T, P };
  } finally {
    isRunning = false;
    flowTabId = null;
    setInputsDisabled(false);
    runBtn.disabled = false;
    if (redownloadBtn) redownloadBtn.disabled = false;
    appEl.classList.remove("is-running");
  }

  if (!result) return;               // an error/status was already shown

  pendingRedownload = result;

  // Preview the mapping in the queue list.
  promptStatuses = result.lines.map(text => ({ text, status: "pending" }));
  renderList();
  listSection.style.display = "";
  listCountEl.textContent = t("promptCount", result.P);

  if (redownloadConfirmMsgEl) {
    redownloadConfirmMsgEl.textContent =
      `Found ${result.T} images and ${result.P} prompts. I'll skip the ${result.skip} oldest ` +
      `(your references) and save ${result.P} images, overwriting the folder. Looks right?`;
  }
  if (redownloadConfirmEl) redownloadConfirmEl.style.display = "";
  setStatus(`Review the counts below, then click “Save ${result.P} images”.`);
}

// Phase 2 — actually save, using the reviewed mapping.
async function runRedownloadSave() {
  if (isRunning || !pendingRedownload) return;
  const { ordered, lines, skip, P } = pendingRedownload;

  const tab = await getActiveTab();
  if (!tab?.id || !FLOW_PROJECT_RE.test(tab.url || "")) { setStatus(t("msgOpenProject")); return; }
  flowTabId = tab.id;

  if (redownloadConfirmEl) redownloadConfirmEl.style.display = "none";
  isRunning = true;
  setInputsDisabled(true);
  runBtn.disabled = true;
  if (redownloadBtn) redownloadBtn.disabled = true;
  appEl.classList.add("is-running");
  setStatus(`Saving ${P} images…`);

  try {
    let saved = 0;
    for (let i = 0; i < P; i++) {
      if (!isRunning) break;
      updateStatus(i, "generating");
      // mode "timestamp" → MM-SS-prompt-text.jpg; never upscale (use the existing tile)
      await downloadGeneratedImages([ordered[i]], i, lines[i], "timestamp", true);
      updateStatus(i, "done");
      saved++;
      if (saved % 5 === 0 || saved === P) setStatus(`Re-saving… ${saved}/${P}`);
    }
    setStatus(isRunning
      ? `✓ Re-saved ${saved} image(s) as MM-SS-prompt.jpg (skipped ${skip} references).`
      : `Stopped — re-saved ${saved}/${P}.`);
  } finally {
    pendingRedownload = null;
    isRunning = false;
    flowTabId = null;
    setInputsDisabled(false);
    runBtn.disabled = false;
    if (redownloadBtn) redownloadBtn.disabled = false;
    appEl.classList.remove("is-running");
  }
}

if (redownloadBtn)    redownloadBtn.addEventListener("click", scanForRedownload);
if (redownloadSaveBtn)   redownloadSaveBtn.addEventListener("click", runRedownloadSave);
if (redownloadCancelBtn) redownloadCancelBtn.addEventListener("click", () => {
  clearRedownloadConfirm();
  setStatus("Re-download cancelled.");
});

// ─────────────────────────────────────────────
// Countdown
// ─────────────────────────────────────────────
async function countdown(seconds) {
  for (let s = seconds; s > 0 && isRunning; s--) {
    setStatus(t("msgDone", s));
    await sleep(1000);
  }
}

// ─────────────────────────────────────────────
// Folder picker (File System Access API)
// ─────────────────────────────────────────────
let dirHandle = null;

const chooseFolderBtn = document.getElementById("chooseFolderBtn");
const folderNameEl    = document.getElementById("folderName");

if (chooseFolderBtn) {
  chooseFolderBtn.addEventListener("click", async () => {
    try {
      dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
      folderNameEl.textContent = dirHandle.name;
      chooseFolderBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg> ${dirHandle.name}`;
      chooseFolderBtn.classList.add("folder-chosen");
    } catch (e) {
      if (e.name !== "AbortError") console.warn("[Nexus Flow] Folder picker:", e);
    }
  });
}

// ─────────────────────────────────────────────
// Timestamp helpers
// ─────────────────────────────────────────────
function extractTimestamp(line) {
  const m = line.match(/^\[(\d{1,2}[:.]\d{2}(?:[:.]\d{2})?)\]/);
  return m ? m[1] : null;
}

function stripTimestamp(line) {
  return line.replace(/^\[\d{1,2}[:.]\d{2}(?:[:.]\d{2})?\]\s*[-–—]?\s*/, "").trim();
}

function timestampToSafeName(ts) {
  return ts.replace(/[:.]/g, "-");
}

// ─────────────────────────────────────────────
// Download
// ─────────────────────────────────────────────
function safePromptName(text) {
  return text
    .slice(0, 30)
    .replace(/:/g, "-")
    .replace(/\s+/g, "_")
    .replace(/[^\w_\-]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 25);
}

function base64ToBlob(dataUrl) {
  const parts = dataUrl.split(",");
  const mime  = parts[0].match(/:(.*?);/)[1];
  const bytes = atob(parts[1]);
  const buf   = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

async function downloadGeneratedImages(newUrls, serialNum, rawPromptText, modeOverride, noUpscale) {
  const upscale   = noUpscale ? false : upscaleToggleEl?.checked;
  const ts        = extractTimestamp(rawPromptText);
  const cleanText = stripTimestamp(rawPromptText);
  const name      = safePromptName(cleanText);
  // serialNum is the zero-based prompt index, so the first prompt is 000, then 001, …
  const serial    = String(serialNum).padStart(3, "0");
  const mode      = modeOverride || (namingModeEl ? namingModeEl.value : "serial");

  let origin = FLOW_BASE;
  try {
    const activeUrl = (await getActiveTab())?.url;
    if (activeUrl) origin = new URL(activeUrl).origin;
  } catch { /* fall back to FLOW_BASE */ }

  for (let j = 0; j < newUrls.length; j++) {
    let url = newUrls[j];
    if (!url.startsWith("http") && !url.startsWith("blob:")) url = origin + url;

    if (upscale) {
      // Click through Flow's UI to trigger the 2K download (lands in system Downloads folder)
      const res = await sendToFlowTab({ type: "NEXUS_UPSCALE_2K", url });
      if (!res?.ok) {
        console.warn("[Nexus Flow] 2K upscale failed:", res?.error, "— falling back to 1K");
        // Fall through to regular download below
      } else {
        continue; // 2K download triggered successfully
      }
    }

    const suffix  = newUrls.length > 1 ? `-${j + 1}` : "";
    let baseName;
    if (mode === "timestamp" && ts) {
      baseName = `${timestampToSafeName(ts)}-${name}`;
    } else if (mode === "serial") {
      baseName = `${serial}-${name}`;
    } else {
      baseName = name;
    }
    const filename = `${baseName}${suffix}.jpg`;

    try {
      if (dirHandle) {
        const res = await sendToFlowTab({ type: "NEXUS_FETCH_IMAGE", url });
        if (res?.base64) {
          const blob       = base64ToBlob(res.base64);
          const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
          const writable   = await fileHandle.createWritable();
          await writable.write(blob);
          await writable.close();
        } else {
          console.warn("[Nexus Flow] Image fetch failed:", res?.error);
        }
      } else {
        const folder = (downloadFolderEl.value || "nexus-flow").replace(/[/\\]+$/, "");
        // overwrite so a Retry replaces the existing file instead of making "name (1).jpg"
        await chrome.downloads.download({ url, filename: `${folder}/${filename}`, saveAs: false, conflictAction: "overwrite" });
      }
    } catch (e) {
      console.warn("[Nexus Flow] Download failed:", e);
    }
  }
}

// ─────────────────────────────────────────────
// Auto connection check
// ─────────────────────────────────────────────
const FLOW_BASE    = "https://flow.google.com";
const FLOW_PROJECT = "https://flow.google.com/project/";
// Regex to match both the current flow.google.com domain and the legacy
// labs.google/fx/.../tools/flow/... paths (including localized variants like
// /fx/fr/tools/flow/... or /fx/zh-TW/tools/flow/...), in case some accounts
// still get redirected through the old host.
// Anchored to the scheme+host on purpose: an unanchored test also matches an unrelated
// site that merely mentions the URL, e.g. https://evil.example/?u=flow.google.com/project/
const FLOW_PROJECT_RE = /^https:\/\/(?:flow\.google\.com\/project\/|labs\.google\/fx(?:\/[a-z]{2,}(?:-[a-zA-Z]{2,})?)?\/tools\/flow\/project\/)/;
const FLOW_BASE_RE    = /^https:\/\/(?:flow\.google\.com(?:\/|$)|labs\.google\/fx(?:\/[a-z]{2,}(?:-[a-zA-Z]{2,})?)?\/tools\/flow)/;

let agentModeOn = false;

async function checkAgentMode() {
  const res = await sendToFlowTab({ type: "FLOW_GET_AGENT_MODE" });
  if (!res?.found) { agentBar.style.display = "none"; return; }

  agentModeOn = res.isOn;
  agentBar.style.display = "";

  if (res.isOn) {
    agentBar.className = "agent-bar is-on";
    agentMsg.textContent = "Turn off Agent mode to start generation";
    agentBadge.textContent = "ON";
    agentBadge.className = "agent-badge is-on";
    if (!isRunning) runBtn.disabled = true;
  } else {
    agentBar.className = "agent-bar is-off";
    agentMsg.textContent = "Agent mode";
    agentBadge.textContent = "OFF";
    agentBadge.className = "agent-badge is-off";
    if (!isRunning) runBtn.disabled = false;
  }
}

function setConnected() {
  connBar.className = "conn-bar is-connected";
  connMsg.textContent = "Connected to Google Flow project";
  connLink.style.display = "none";
  if (!isRunning) runBtn.disabled = false;
  checkAgentMode();
}

function setOpenProject() {
  connBar.className = "conn-bar is-warn";
  connMsg.textContent = "Open a project to continue";
  connLink.style.display = "none";
  agentBar.style.display = "none";
  if (!isRunning) runBtn.disabled = true;
}

function setGoToFlow() {
  connBar.className = "conn-bar is-off";
  connMsg.textContent = "Not on Google Flow";
  connLink.style.display = "";
  connLink.textContent = "Go to Google Flow →";
  connLink.href = FLOW_BASE;
  agentBar.style.display = "none";
  if (!isRunning) runBtn.disabled = true;
}

// URL looks right, but the content script isn't responding — needs a tab refresh.
function setNeedsRefresh() {
  connBar.className = "conn-bar is-warn";
  connMsg.textContent = "On project — hard-refresh the tab (Cmd+Shift+R)";
  connLink.style.display = "none";
  agentBar.style.display = "none";
  if (!isRunning) runBtn.disabled = true;
}

// Ping the content script directly without mutating the status bar.
async function pingContentScript(tabId) {
  if (!chrome.runtime?.id || !tabId) return false;
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "FLOW_BATCH_PING" });
    return res?.ok === true;
  } catch {
    return false;
  }
}

async function checkConnection() {
  const tab = await getActiveTab();
  const url = tab?.url || "";
  if (FLOW_PROJECT_RE.test(url)) {
    let alive = await pingContentScript(tab.id);
    if (!alive && chrome.scripting && tab?.id) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["selectors.js", "content.js"]
        });
        await sleep(250);
        alive = await pingContentScript(tab.id);
      } catch (err) {
        console.warn("[Nexus Flow] Auto-inject script failed:", err);
      }
    }
    if (alive) setConnected();
    else setNeedsRefresh();
  } else if (FLOW_BASE_RE.test(url)) {
    // On labs.google/fx/.../tools/flow but no project open
    setOpenProject();
  } else {
    // Completely different URL
    setGoToFlow();
  }
}

// Check on load
checkConnection();

// Poll agent mode every 3 seconds when connected
setInterval(() => { if (connBar.classList.contains("is-connected")) checkAgentMode(); }, 3000);


// Re-check whenever the active tab URL changes
chrome.tabs.onActivated.addListener(() => checkConnection());
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id === tabId) checkConnection();
    });
  }
});

// ─────────────────────────────────────────────
// Run queue
// ─────────────────────────────────────────────
async function startQueue(startIndex = 0) {
  const lines = parsePrompts();
  if (!lines.length) { setStatus(t("msgAddPrompt")); return; }

  let waitMinMs = Math.round(Number(waitMinEl.value) * 1000) || 1500;
  let waitMaxMs = Math.round(Number(waitMaxEl.value) * 1000) || 3000;
  if (waitMaxMs < waitMinMs) [waitMinMs, waitMaxMs] = [waitMaxMs, waitMinMs];

  const rawWindow = parseInt(parallelCountEl?.value, 10);
  const WINDOW = (!Number.isNaN(rawWindow) && rawWindow >= 1) ? Math.min(rawWindow, 10) : 5;

  // Lock in the Flow tab ID
  const activeTab = await getActiveTab();
  if (!activeTab?.id) { setStatus(t("msgNoTab")); return; }
  flowTabId = activeTab.id;

  // On fresh start reset all statuses; on continue keep existing
  if (startIndex === 0) {
    promptStatuses = lines.map(text => ({ text, status: "pending" }));
  } else {
    for (let j = startIndex; j < lines.length; j++) {
      if (promptStatuses[j]) promptStatuses[j].status = "pending";
    }
  }
  renderList();
  listSection.style.display = "";

  isRunning = true;
  runBtn.disabled = true;
  hideContinue();
  setInputsDisabled(true);
  appEl.classList.add("is-running");
  let completed = 0;
  const total = lines.length;
  setStatus(t("msgStarting", total));

  // Snapshot existing images and start continuous finish-order scanner
  const begin = await sendToFlowTab({ type: "FLOW_PIPELINE_BEGIN" });
  if (isRunning && (!begin || begin.error)) {
    setStatus(begin?.error || t("msgNotReady"));
    isRunning = false;
  }

  let submitIdx  = startIndex;          // next prompt to submit
  let inFlight   = [];                  // jobIndexes submitted but not yet collected
  let collectedCount = 0;               // collections completed
  const submitFailed = new Set();       // prompts whose submit errored
  const totalToProcess = total - startIndex;

  try {
    while (isRunning && (collectedCount + submitFailed.size) < totalToProcess) {
      // ── Phase 1: Submit prompts until WINDOW slots are full ──
      while (isRunning && submitIdx < total && inFlight.length < WINDOW) {
        const curIdx = submitIdx;
        updateStatus(curIdx, "generating");
        setStatus(t("msgSubmitting", curIdx + 1, total));

        const res = await sendToFlowTab({
          type: "FLOW_SUBMIT_ONE",
          prompt: stripTimestamp(lines[curIdx]),
          charDelayMs: 30,
          refImages: (refImages || []).map(r => r.base64),
          isFirstPrompt: curIdx === 0,
          jobIndex: curIdx,
        });

        if (!isRunning) break;

        if (!res || res.error) {
          updateStatus(curIdx, "failed");
          submitFailed.add(curIdx);
          setStatus(res?.error || `Prompt ${curIdx + 1} submit failed.`);
          if (res?.error && /prompt field|prompt text/i.test(res.error)) {
            for (let j = curIdx + 1; j < total; j++) updateStatus(j, "stopped");
            isRunning = false;
            break;
          }
        } else {
          inFlight.push(curIdx);
        }
        submitIdx++;

        // Brief delay between concurrent submissions to let Flow settle
        if (isRunning && submitIdx < total && inFlight.length < WINDOW) {
          const pauseMs = randomIntInclusive(Math.max(1000, waitMinMs), Math.max(1500, waitMaxMs));
          await sleep(pauseMs);
        }
      }

      if (!isRunning) break;
      if (!inFlight.length) break;

      // ── Phase 2: Collect whichever generation finishes next ──
      setStatus(t("msgWaiting", collectedCount + 1));
      const c = await sendToFlowTab({ type: "FLOW_COLLECT_NEXT", timeoutMs: 180000 });
      if (!isRunning) break;

      // Match directly to the exact jobIndex identified by its tile in Flow!
      let idx = (typeof c?.jobIndex === "number") ? c.jobIndex : null;
      if (idx === null || !inFlight.includes(idx)) idx = inFlight[0];
      inFlight = inFlight.filter(j => j !== idx);

      if (c?.done && c.url) {
        setStatus(t("msgDownloading", idx + 1));
        // Directly save using this prompt's exact index, name, and timestamp!
        await downloadGeneratedImages([c.url], idx, lines[idx]);
        updateStatus(idx, "done");
        completed++;
        setStatus(`✓ Prompt ${idx + 1}/${total} finished. (${completed} total done, ${inFlight.length} in flight)`);
      } else if (c?.stopped || !isRunning) {
        break;
      } else {
        // Failed or timed out — only mark this exact prompt as failed!
        updateStatus(idx, "failed");
        submitFailed.add(idx);
        setStatus(`Prompt ${idx + 1} failed.`);
      }
      collectedCount++;
    }

    if (completed === (total - startIndex)) {
      setStatus(`🎉 All ${completed} prompt(s) generated and downloaded!`);
    } else if (!isRunning) {
      setStatus(`Stopped — completed ${completed}/${total} images.`);
    } else {
      setStatus(`Finished — completed ${completed}/${total} images.`);
    }
  } catch (err) {
    setStatus(`Queue error: ${err.message || err}`);
  } finally {
    // Stop the content script's background scanner
    await sendToFlowTab({ type: "FLOW_PIPELINE_END" });

    if (!isRunning) {
      for (let j = startIndex; j < total; j++) {
        if (promptStatuses[j] && promptStatuses[j].status !== "done" && promptStatuses[j].status !== "failed") {
          updateStatus(j, "stopped");
        }
      }
    }

    isRunning = false;
    flowTabId = null;
    setInputsDisabled(false);
    runBtn.disabled = false;
    appEl.classList.remove("is-running");

    const failedCount  = promptStatuses.filter(p => p.status === "failed").length;
    const stoppedCount = promptStatuses.filter(p => p.status === "stopped").length;

    if (stoppedCount > 0) {
      const firstStopped = promptStatuses.findIndex(p => p.status === "stopped");
      showContinue(firstStopped);
      runBtn.disabled = true;
      setStatus(`Stopped — ${completed} done, ${stoppedCount} skipped.`);
    } else {
      hideContinue();
      runBtn.disabled = false;
      if (failedCount > 0) {
        setStatus(`Done — ${completed} succeeded, ${failedCount} failed.`);
      } else {
        setStatus(t("msgAllDone", completed));
      }
    }
  }
}

runBtn.addEventListener("click", () => startQueue(0));

// ─────────────────────────────────────────────
// Load references to project (separate from generation)
// ─────────────────────────────────────────────
if (loadRefsBtn) {
  loadRefsBtn.addEventListener("click", async () => {
    if (isRunning || loadRefsBtn.disabled || loadRefsBtn.classList.contains("is-busy")) return;
    if (!refImages.length) { setStatus("Upload reference images first."); return; }

    isRunning = true;                 // lets Stop abort the load and disables Run
    loadRefsBtn.classList.add("is-busy");
    loadRefsBtn.disabled = true;
    runBtn.disabled = true;
    setInputsDisabled(true);
    appEl.classList.add("is-running");

    const tab = await getActiveTab();
    if (!tab?.id || !FLOW_PROJECT_RE.test(tab.url || "")) {
      isRunning = false;
      flowTabId = null;
      loadRefsBtn.classList.remove("is-busy");
      setInputsDisabled(false);
      appEl.classList.remove("is-running");
      runBtn.disabled = false;
      loadRefsBtn.disabled = refImages.length === 0;
      setStatus(t("msgOpenProject"));
      return;
    }
    flowTabId = tab.id;

    setStatus(`Loading ${refImages.length} reference(s) into the project…`);

    const res = await sendToFlowTab({
      type: "FLOW_LOAD_REFERENCES",
      charDelayMs: CHAR_DELAY_MS,
      refImages: refImages.map(r => r.base64),
    });

    isRunning = false;
    flowTabId = null;
    loadRefsBtn.classList.remove("is-busy");
    setInputsDisabled(false);
    appEl.classList.remove("is-running");
    runBtn.disabled = false;
    loadRefsBtn.disabled = refImages.length === 0;

    if (!res || res.error) { setStatus(res?.error || "Load failed — open your Flow project tab and try again."); return; }
    const parts = [];
    if (res.loaded) parts.push(`${res.loaded} uploaded`);
    if (res.failed) parts.push(`${res.failed} failed`);
    const summary = parts.join(", ") || "nothing to do";
    if (res.stopped) setStatus(`Stopped — ${summary}.`);
    else setStatus(`✓ ${summary}. Now click “Hard refresh”, confirm the assets, then Start Generation.`);
  });
}

// ─────────────────────────────────────────────
// Hard refresh the Flow tab (so newly uploaded assets become searchable)
// ─────────────────────────────────────────────
if (hardRefreshBtn) {
  hardRefreshBtn.addEventListener("click", async () => {
    const tab = await getActiveTab();
    if (!tab?.id) { setStatus(t("msgNoTab")); return; }
    try {
      await chrome.tabs.reload(tab.id, { bypassCache: true });
      setStatus("Flow tab hard-refreshed. Confirm the assets appear, then Start Generation.");
    } catch (e) {
      setStatus("Couldn't refresh automatically — refresh the Flow tab manually (Cmd+Shift+R).");
    }
  });
}

// ─────────────────────────────────────────────
// Continue
// ─────────────────────────────────────────────
continueBtn.addEventListener("click", () => {
  if (resumeFromIdx !== null) startQueue(resumeFromIdx);
});

// ─────────────────────────────────────────────
// Stop
// ─────────────────────────────────────────────
stopBtn.addEventListener("click", async () => {
  isRunning = false;
  // Send the stop to the locked Flow tab BEFORE clearing it, so the content script
  // aborts its current operation (the abort flag is checked throughout long loops).
  await sendToFlowTab({ type: "FLOW_BATCH_STOP" });
  flowTabId = null;
  setStatus(t("msgStopped"));
  setInputsDisabled(false);
  appEl.classList.remove("is-running");
  if (loadRefsBtn) { loadRefsBtn.classList.remove("is-busy"); loadRefsBtn.disabled = refImages.length === 0; }
  // runBtn stays disabled — Continue button is shown by the loop
});

// ─────────────────────────────────────────────
// Persist / restore
// ─────────────────────────────────────────────
// On launch — restore only settings (delay, folder, language)
// Prompts always start fresh every session
chrome.storage.local.get(
  ["flowBatchWaitMin", "flowBatchWaitMax", "nexusLang", "nexusNaming", "nexusUpscale", "nexusRefImages", "nexusRefImage", "nexusRefImageName", "nexusParallelCount"],
  (r) => {
    if (r.flowBatchWaitMin != null) waitMinEl.value = String(r.flowBatchWaitMin);
    if (r.flowBatchWaitMax != null) waitMaxEl.value = String(r.flowBatchWaitMax);
    if (r.nexusParallelCount != null && parallelCountEl) parallelCountEl.value = String(r.nexusParallelCount);
    downloadFolderEl.value = "nexus-flow";
    if (r.nexusNaming && namingModeEl) namingModeEl.value = r.nexusNaming;
    if (r.nexusUpscale != null && upscaleToggleEl) upscaleToggleEl.checked = !!r.nexusUpscale;
    if (r.nexusLang && langSelectEl) {
      currentLang = r.nexusLang;
      langSelectEl.value = currentLang;
    }
    if (Array.isArray(r.nexusRefImages) && r.nexusRefImages.length) {
      refImages = r.nexusRefImages.filter(x => x && x.base64);
      renderRefImages();
    } else if (r.nexusRefImage) {
      // Migrate the legacy single-reference storage into the new array format.
      refImages = [{ base64: r.nexusRefImage, name: r.nexusRefImageName || "reference.png" }];
      persistRefImages();
      chrome.storage.local.remove(["nexusRefImage", "nexusRefImageName"]);
      renderRefImages();
    }
    applyLanguage();
  }
);

// Persist only settings, never prompts
function persist() {
  chrome.storage.local.set({
    flowBatchWaitMin:    waitMinEl.value,
    flowBatchWaitMax:    waitMaxEl.value,
    nexusNaming:         namingModeEl ? namingModeEl.value : "serial",
    nexusUpscale:        upscaleToggleEl ? upscaleToggleEl.checked : false,
    nexusParallelCount:  parallelCountEl ? parallelCountEl.value : "5",
  });
}
waitMinEl.addEventListener("change", persist);
waitMaxEl.addEventListener("change", persist);
if (parallelCountEl) parallelCountEl.addEventListener("change", persist);
downloadFolderEl.addEventListener("change", persist);
if (namingModeEl) namingModeEl.addEventListener("change", persist);
if (upscaleToggleEl) upscaleToggleEl.addEventListener("change", persist);

// ─────────────────────────────────────────────
// Bulk Serial Downloader (Oldest to Newest)
// ─────────────────────────────────────────────
const serialStartNumEl     = document.getElementById("serialStartNum");
const serialPrefixEl       = document.getElementById("serialPrefix");
const serialPadDigitsEl    = document.getElementById("serialPadDigits");
const serialExcludeRefEl   = document.getElementById("serialExcludeRef");
const serialExcludePatEl   = document.getElementById("serialExcludePat");
const serialExcludePatWrap = document.getElementById("serialExcludePatWrap");
const serialScanBtn        = document.getElementById("serialScanBtn");
const serialDownloadBtn    = document.getElementById("serialDownloadBtn");
const serialStopBtn        = document.getElementById("serialStopBtn");
const serialScanInfoEl     = document.getElementById("serialScanInfo");
const serialCountBadgeEl   = document.getElementById("serialCountBadge");
const serialRangeBadgeEl   = document.getElementById("serialRangeBadge");
const serialStatusEl       = document.getElementById("serialStatus");

let serialScannedImages  = [];
let serialExcludedCount  = 0;
let isSerialDownloading  = false;

function setSerialStatus(msg) {
  if (!serialStatusEl) return;
  if (!msg) {
    serialStatusEl.style.display = "none";
    serialStatusEl.textContent = "";
  } else {
    serialStatusEl.style.display = "block";
    serialStatusEl.textContent = msg;
  }
}

function updateSerialRangeDisplay() {
  if (!serialScanInfoEl) return;
  const total = serialScannedImages.length;
  if (total === 0) {
    serialScanInfoEl.style.display = "none";
    return;
  }
  const start = parseInt(serialStartNumEl?.value, 10) || 1;
  const end = start + total - 1;
  const pad = parseInt(serialPadDigitsEl?.value, 10) || 3;
  const startStr = String(start).padStart(pad, "0");
  const endStr = String(end).padStart(pad, "0");

  if (serialCountBadgeEl) {
    let text = `${total} image${total === 1 ? "" : "s"} found`;
    if (serialExcludedCount > 0) {
      text += ` (${serialExcludedCount} ref${serialExcludedCount === 1 ? "" : "s"} excluded)`;
    }
    serialCountBadgeEl.textContent = text;
  }
  if (serialRangeBadgeEl) {
    serialRangeBadgeEl.textContent = `Numbering: #${startStr} → #${endStr} (oldest → newest)`;
  }
  serialScanInfoEl.style.display = "block";
}

if (serialStartNumEl)    serialStartNumEl.addEventListener("input", updateSerialRangeDisplay);
if (serialPadDigitsEl)   serialPadDigitsEl.addEventListener("input", updateSerialRangeDisplay);
if (serialPrefixEl)      serialPrefixEl.addEventListener("input", updateSerialRangeDisplay);

if (serialExcludeRefEl) {
  serialExcludeRefEl.addEventListener("change", () => {
    if (serialExcludePatWrap) {
      serialExcludePatWrap.style.opacity = serialExcludeRefEl.checked ? "1" : "0.4";
      serialExcludePatWrap.style.pointerEvents = serialExcludeRefEl.checked ? "" : "none";
    }
    if (serialScannedImages.length > 0) {
      scanProjectForSerialDownload();
    }
  });
}

if (serialExcludePatEl) {
  serialExcludePatEl.addEventListener("change", () => {
    if (serialScannedImages.length > 0) {
      scanProjectForSerialDownload();
    }
  });
}

async function scanProjectForSerialDownload() {
  if (isSerialDownloading) return;
  const tab = await getActiveTab();
  if (!tab?.id || !FLOW_PROJECT_RE.test(tab.url || "")) {
    setSerialStatus("Please open a Flow project tab first.");
    return;
  }

  setSerialStatus("Scanning project for images (filtering out references)...");
  if (serialScanBtn) serialScanBtn.disabled = true;
  if (serialDownloadBtn) serialDownloadBtn.disabled = true;

  try {
    const excludeRef = serialExcludeRefEl ? serialExcludeRefEl.checked : true;
    const excludePat = serialExcludePatEl ? serialExcludePatEl.value.trim() : "reference";
    const refNames = (refImages || []).map(r => r.name).filter(Boolean);

    const res = await sendToFlowTab({
      type: "FLOW_COLLECT_ALL_IMAGES",
      excludeReference: excludeRef,
      excludePattern: excludePat,
      refNames
    });

    if (!res?.ok || !Array.isArray(res.srcs)) {
      setSerialStatus(`Scan failed: ${res?.error || "Could not collect images from tab."}`);
      return;
    }

    serialExcludedCount = res.excludedCount || 0;

    // Google Flow's grid renders newest images at the top and oldest at the bottom.
    // Reversing gives the exact OLDEST to NEWEST order:
    serialScannedImages = [...res.srcs].reverse();

    if (serialScannedImages.length === 0) {
      if (serialExcludedCount > 0) {
        setSerialStatus(`Found only reference image(s) (${serialExcludedCount} excluded). No generated images.`);
      } else {
        setSerialStatus("No images found in this project.");
      }
      if (serialScanInfoEl) serialScanInfoEl.style.display = "none";
      return;
    }

    updateSerialRangeDisplay();
    if (serialDownloadBtn) serialDownloadBtn.disabled = false;
    let statusMsg = `Found ${serialScannedImages.length} image(s). Ready to download!`;
    if (serialExcludedCount > 0) {
      statusMsg = `Found ${serialScannedImages.length} image(s) (${serialExcludedCount} reference excluded). Ready to download!`;
    }
    setSerialStatus(statusMsg);
  } catch (err) {
    setSerialStatus(`Scan error: ${err.message || err}`);
  } finally {
    if (serialScanBtn) serialScanBtn.disabled = false;
  }
}

async function downloadSingleImage(url, filename) {
  let origin = FLOW_BASE;
  try {
    const activeUrl = (await getActiveTab())?.url;
    if (activeUrl) origin = new URL(activeUrl).origin;
  } catch { /* fall back to FLOW_BASE */ }

  if (!url.startsWith("http") && !url.startsWith("blob:")) url = origin + url;

  if (dirHandle) {
    const res = await sendToFlowTab({ type: "NEXUS_FETCH_IMAGE", url });
    if (res?.base64) {
      const blob = base64ToBlob(res.base64);
      const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } else {
      throw new Error(res?.error || "Image fetch failed");
    }
  } else {
    const folder = (downloadFolderEl.value || "nexus-flow").replace(/[/\\]+$/, "");
    await chrome.downloads.download({
      url,
      filename: `${folder}/${filename}`,
      saveAs: false,
      conflictAction: "overwrite"
    });
    return true;
  }
}

async function runSerialDownload() {
  if (isSerialDownloading) return;
  if (!serialScannedImages.length) {
    await scanProjectForSerialDownload();
    if (!serialScannedImages.length) return;
  }

  const tab = await getActiveTab();
  if (!tab?.id || !FLOW_PROJECT_RE.test(tab.url || "")) {
    setSerialStatus("Please open a Flow project tab first.");
    return;
  }

  isSerialDownloading = true;
  if (serialScanBtn) serialScanBtn.disabled = true;
  if (serialDownloadBtn) serialDownloadBtn.disabled = true;
  if (serialStartNumEl) serialStartNumEl.disabled = true;
  if (serialPrefixEl) serialPrefixEl.disabled = true;
  if (serialPadDigitsEl) serialPadDigitsEl.disabled = true;
  if (serialExcludeRefEl) serialExcludeRefEl.disabled = true;
  if (serialExcludePatEl) serialExcludePatEl.disabled = true;
  if (serialStopBtn) serialStopBtn.style.display = "";

  const total = serialScannedImages.length;
  const start = parseInt(serialStartNumEl?.value, 10) || 1;
  const pad = parseInt(serialPadDigitsEl?.value, 10) || 3;
  const rawPrefix = (serialPrefixEl?.value || "").trim();
  const prefix = rawPrefix ? safePromptName(rawPrefix) : "";

  let savedCount = 0;
  try {
    for (let i = 0; i < total; i++) {
      if (!isSerialDownloading) break;
      const currentNum = start + i;
      const numStr = String(currentNum).padStart(pad, "0");
      const filename = prefix ? `${numStr}-${prefix}.jpg` : `${numStr}.jpg`;
      const url = serialScannedImages[i];

      setSerialStatus(`Saving image ${i + 1} of ${total} (${filename})...`);

      await downloadSingleImage(url, filename);
      savedCount++;
      await sleep(100);
    }

    if (isSerialDownloading) {
      setSerialStatus(`✓ Successfully downloaded all ${savedCount} image(s) to folder!`);
    } else {
      setSerialStatus(`Stopped — saved ${savedCount}/${total} images.`);
    }
  } catch (err) {
    setSerialStatus(`Download stopped with error: ${err.message || err}`);
  } finally {
    isSerialDownloading = false;
    if (serialScanBtn) serialScanBtn.disabled = false;
    if (serialDownloadBtn) serialDownloadBtn.disabled = false;
    if (serialStartNumEl) serialStartNumEl.disabled = false;
    if (serialPrefixEl) serialPrefixEl.disabled = false;
    if (serialPadDigitsEl) serialPadDigitsEl.disabled = false;
    if (serialExcludeRefEl) serialExcludeRefEl.disabled = false;
    if (serialExcludePatEl) serialExcludePatEl.disabled = false;
    if (serialStopBtn) serialStopBtn.style.display = "none";
  }
}

if (serialScanBtn)     serialScanBtn.addEventListener("click", scanProjectForSerialDownload);
if (serialDownloadBtn) serialDownloadBtn.addEventListener("click", runSerialDownload);
if (serialStopBtn)     serialStopBtn.addEventListener("click", () => {
  isSerialDownloading = false;
  setSerialStatus("Stopping serial download...");
});

// ─────────────────────────────────────────────
// Step-by-Step Prompt Sender (Enter to Send & Remove)
// ─────────────────────────────────────────────
const stepPromptsEl    = document.getElementById("stepPrompts");
const stepTxtUploadEl  = document.getElementById("stepTxtUpload");
const stepClearBtnEl   = document.getElementById("stepClearBtn");
const stepCountHintEl  = document.getElementById("stepCountHint");
const stepListWrapEl   = document.getElementById("stepListWrap");
const stepListCountEl  = document.getElementById("stepListCount");
const stepPromptListEl = document.getElementById("stepPromptList");
const stepStatusEl     = document.getElementById("stepStatus");

let stepPromptList = [];
let isStepSubmitting = false;

function setStepStatus(msg) {
  if (!stepStatusEl) return;
  if (!msg) {
    stepStatusEl.style.display = "none";
    stepStatusEl.textContent = "";
  } else {
    stepStatusEl.style.display = "block";
    stepStatusEl.textContent = msg;
  }
}

function parseStepPrompts() {
  const raw = stepPromptsEl?.value || "";
  const lines = raw
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);
  stepPromptList = lines.map(text => ({ text }));
  renderStepPromptList();
}

function syncStepTextarea() {
  if (!stepPromptsEl) return;
  stepPromptsEl.value = stepPromptList.map(p => p.text).join("\n");
}

function renderStepPromptList() {
  if (!stepPromptListEl) return;
  stepPromptListEl.innerHTML = "";

  const total = stepPromptList.length;
  if (total === 0) {
    if (stepListWrapEl) stepListWrapEl.style.display = "none";
    if (stepClearBtnEl) stepClearBtnEl.style.display = "none";
    if (stepCountHintEl) stepCountHintEl.textContent = "0 prompts ready";
    return;
  }

  if (stepListWrapEl) stepListWrapEl.style.display = "block";
  if (stepClearBtnEl) stepClearBtnEl.style.display = "inline-flex";
  if (stepCountHintEl) stepCountHintEl.textContent = `${total} prompt${total === 1 ? "" : "s"} ready`;
  if (stepListCountEl) stepListCountEl.textContent = `${total} left`;

  stepPromptList.forEach((item, idx) => {
    const row = document.createElement("div");
    row.className = "step-item";
    row.id = `step-row-${idx}`;

    row.innerHTML = `
      <span class="step-num">${idx + 1}</span>
      <span class="step-text" title="${escHtml(item.text)}">${escHtml(item.text)}</span>
      <button type="button" class="btn-step-enter" data-idx="${idx}" title="Fill reference image &amp; prompt, then submit in Flow">
        Enter ⏎
      </button>
    `;
    stepPromptListEl.appendChild(row);
  });
}

if (stepPromptsEl) {
  stepPromptsEl.addEventListener("input", () => {
    parseStepPrompts();
    setStepStatus("");
  });
}

if (stepClearBtnEl) {
  stepClearBtnEl.addEventListener("click", () => {
    if (stepPromptsEl) stepPromptsEl.value = "";
    stepPromptList = [];
    renderStepPromptList();
    setStepStatus("Prompts cleared.");
  });
}

if (stepTxtUploadEl) {
  stepTxtUploadEl.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const text = evt.target?.result;
      if (typeof text === "string" && stepPromptsEl) {
        stepPromptsEl.value = text;
        parseStepPrompts();
        setStepStatus(`Loaded ${stepPromptList.length} prompt(s) from ${file.name}.`);
      }
    };
    reader.readAsText(file);
    stepTxtUploadEl.value = "";
  });
}

async function sendStepPrompt(index) {
  if (isStepSubmitting) return;
  const promptItem = stepPromptList[index];
  if (!promptItem) return;

  const tab = await getActiveTab();
  if (!tab?.id || !FLOW_PROJECT_RE.test(tab.url || "")) {
    setStepStatus("Please open a Flow project tab first.");
    return;
  }

  isStepSubmitting = true;
  setStepStatus(`Sending prompt #${index + 1} to Flow...`);

  const rowEl = document.getElementById(`step-row-${index}`);
  const btnEl = rowEl?.querySelector(".btn-step-enter");
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = "Sending…";
  }

  try {
    const rawText = promptItem.text;
    const cleanPrompt = stripTimestamp(rawText);

    const res = await sendToFlowTab({
      type: "FLOW_SUBMIT_ONE",
      prompt: cleanPrompt,
      charDelayMs: 30,
      refImages: (refImages || []).map(r => r.base64),
      isFirstPrompt: false,
    });

    if (!res || res.error) {
      setStepStatus(`Submit error: ${res?.error || "Failed to submit prompt to Flow."}`);
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.textContent = "Enter ⏎";
      }
      return;
    }

    // Success! Animate out the submitted prompt card
    if (rowEl) {
      rowEl.classList.add("is-sent");
      await sleep(220);
    }

    // Remove from the list so the next prompt moves to the top
    stepPromptList.splice(index, 1);
    syncStepTextarea();
    renderStepPromptList();

    if (stepPromptList.length > 0) {
      setStepStatus(`✓ Prompt submitted! Next prompt is ready (#1 of ${stepPromptList.length}).`);
    } else {
      setStepStatus("🎉 All prompts submitted successfully!");
    }
  } catch (err) {
    setStepStatus(`Error: ${err.message || err}`);
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.textContent = "Enter ⏎";
    }
  } finally {
    isStepSubmitting = false;
  }
}

if (stepPromptListEl) {
  stepPromptListEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".btn-step-enter");
    if (!btn || isStepSubmitting) return;
    const idx = parseInt(btn.dataset.idx, 10);
    if (!isNaN(idx)) sendStepPrompt(idx);
  });
}

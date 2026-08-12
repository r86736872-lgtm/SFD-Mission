// ==========================================
// 1. KONFIGURASI FIREBASE & AUTHENTICATION
// ==========================================
const firebaseConfig = {
  apiKey: "AIzaSyA9-fz5YwCvVhTzV4mT65uQ727MWTOm32U",
  authDomain: "system-ocm.firebaseapp.com",
  databaseURL:
    "https://system-ocm-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "system-ocm",
  storageBucket: "system-ocm.firebasestorage.app",
  messagingSenderId: "433934854222",
  appId: "1:433934854222:web:39e21493d1a20d5c993b1f",
  measurementId: "G-WCT66Z2CCZ",
};

firebase.initializeApp(firebaseConfig);
const database = firebase.database();
const firestore = firebase.firestore();
const auth = firebase.auth();
const DUMMY_DOMAIN = "@sfd-mission.com";

let secondaryApp;
let secondaryAuth;

try {
  if (
    !firebase.apps.length ||
    !firebase.apps.find((app) => app.name === "SecondaryApp")
  ) {
    secondaryApp = firebase.initializeApp(firebaseConfig, "SecondaryApp");
  } else {
    secondaryApp = firebase.app("SecondaryApp");
  }
  secondaryAuth = secondaryApp.auth();
} catch (e) {
  console.error("Gagal inisialisasi Secondary App:", e);
}

// ==========================================
// 2. KONFIGURASI INDEXED DB & PROTEKSI SESI
// ==========================================
const DB_NAME = "SystemOCMLocal";
const DB_VERSION = 3;
let localDB;

function initIndexedDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = function (event) {
      const db = event.target.result;
      if (!db.objectStoreNames.contains("konsumen_data")) {
        db.createObjectStore("konsumen_data", { keyPath: "kontrak" });
      }
      if (!db.objectStoreNames.contains("session_data")) {
        db.createObjectStore("session_data", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("pending_updates")) {
        db.createObjectStore("pending_updates", { keyPath: "kontrak" });
      }
    };

    request.onsuccess = function (event) {
      localDB = event.target.result;
      resolve(localDB);
    };

    request.onerror = function (event) {
      console.error("IndexedDB error:", event.target.errorCode);
      reject(event.target.errorCode);
    };
  });
}

function getAllFromIDB(storeName) {
  return new Promise((resolve) => {
    const tx = localDB.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
  });
}

async function setLoginSession(userData) {
  const now = new Date();
  let expireTime = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    0,
    5,
    0,
  ).getTime();
  // Sesi selalu berakhir di jam 00:05 BERIKUTNYA (bukan yang sudah lewat hari ini)
  if (expireTime <= now.getTime()) {
    expireTime += 24 * 60 * 60 * 1000;
  }
  const sessionData = { user: userData, expire: expireTime };

  localStorage.setItem("userSession", JSON.stringify(sessionData));
  if (localDB) {
    await saveToIDB("session_data", {
      id: "current_session",
      data: sessionData,
    });
  }
}

async function checkSession() {
  const sessionStr = localStorage.getItem("userSession");
  if (!sessionStr) return false;

  let sessionData;
  try {
    sessionData = JSON.parse(sessionStr); // Aman dari crash
  } catch (error) {
    console.warn("Data checkSession korup.");
    localStorage.removeItem("userSession");
    return false;
  }

  const now = new Date().getTime();

  if (now > sessionData.expire) {
    tampilkanPopupSesiBerakhir();
    return false;
  }
  return true;
}

// ==========================================
// JAM OPERASIONAL WEB: buka 05:00, tutup mulai 00:05
// ==========================================
function cekWebSedangTutup() {
  const now = new Date();
  const jam = now.getHours();
  const menit = now.getMinutes();
  if (jam >= 5) return false; // 05:00 - 23:59 => buka
  if (jam === 0 && menit < 5) return false; // 00:00 - 00:04 => masih buka
  return true; // 00:05 - 04:59 => tutup
}

// Popup: sesi hari ini habis, paksa logout user yang sedang aktif
let _sesiBerakhirDitampilkan = false;
function tampilkanPopupSesiBerakhir() {
  if (_sesiBerakhirDitampilkan) return; // cegah trigger dobel
  _sesiBerakhirDitampilkan = true;

  if (window.sessionWatcherInterval) clearInterval(window.sessionWatcherInterval);

  // Bersihkan data sesi browser (reload ditunda sampai user klik "Oke")
  localStorage.removeItem("userSession");
  sessionStorage.removeItem("ocm_session");
  if (localDB) {
    try {
      const tx = localDB.transaction("session_data", "readwrite");
      tx.objectStore("session_data").delete("current_session");
    } catch (e) {
      console.error("Gagal menghapus session di IDB:", e);
    }
  }
  if (typeof auth !== "undefined" && auth.currentUser) {
    auth.signOut().catch((e) => console.error("Firebase logout error:", e));
  }

  const modal = document.getElementById("session-expired-modal");
  const box = document.getElementById("session-expired-modal-box");
  if (modal) {
    modal.classList.remove("hidden");
    requestAnimationFrame(() => {
      modal.classList.remove("opacity-0");
      if (box) box.classList.remove("scale-90");
    });
  } else {
    alert("Sesi login berakhir. Silakan login kembali esok hari.");
    tutupPopupSesiBerakhir();
  }
}

function tutupPopupSesiBerakhir() {
  window.location.href =
    window.location.pathname + "?t=" + new Date().getTime();
}

// Pemantau berkala: cek tiap 20 detik supaya user yang sedang login otomatis
// ter-logout begitu jam menyentuh 00:05, tanpa perlu reload/aksi manual.
window.sessionWatcherInterval = setInterval(() => {
  if (localStorage.getItem("userSession")) {
    checkSession();
  }
}, 20000);

// ==========================================
// 3. VARIABEL STATE APLIKASI
// ==========================================
let defaultUsers = { admin: { pass: "admin123", role: "admin" } };
let USERS = defaultUsers;
let currentDB = [];
// Pagination untuk ocm_main_db (khusus Admin) — lihat muatDataLengkap() & muatLebihBanyakDataUtama()
const MAIN_DB_PAGE_SIZE = 500;
let mainDbLastVisibleDoc = null;
let mainDbHasMore = false;

// Panggil fungsi ini dari tombol "Muat Lebih Banyak" / infinite-scroll di UI Admin
// untuk mengambil halaman berikutnya dari ocm_main_db tanpa menarik ulang semuanya.
function muatLebihBanyakDataUtama() {
  if (!loggedInUser || loggedInUser.role !== "admin") return;
  if (!mainDbHasMore || !mainDbLastVisibleDoc) {
    if (typeof showToast === "function")
      showToast("Semua data sudah dimuat.", "info");
    return;
  }
  firestore
    .collection("ocm_main_db")
    .orderBy(firebase.firestore.FieldPath.documentId())
    .startAfter(mainDbLastVisibleDoc)
    .limit(MAIN_DB_PAGE_SIZE)
    .get()
    .then((snapshot) => {
      trackFirestoreUsage("reads", snapshot.docs.length);
      const extra = snapshot.docs.map((doc) => ({
        ...doc.data(),
        docId: doc.id,
      }));
      currentDB = currentDB.concat(extra);
      localStorage.setItem("ocm_main_db_local", JSON.stringify(currentDB));
      mainDbLastVisibleDoc = snapshot.docs[snapshot.docs.length - 1] || mainDbLastVisibleDoc;
      mainDbHasMore = snapshot.docs.length === MAIN_DB_PAGE_SIZE;
      if (typeof renderDashboard === "function") renderDashboard();
    })
    .catch((error) => {
      console.error("Gagal memuat data tambahan:", error);
      if (typeof showToast === "function")
        showToast("Gagal memuat data tambahan: " + error.message, "error");
    });
}
let dailyValidation = {};
let BUGS = {};
let PENGAJUAN_PINJAMAN = {};

let adminTaskMarkers = {};
let userTaskMarkers = {};
let userCanvassingMap = null;
let userLocMarker = null;
let mapRoutingControl = null;
let activeDestination = null;

let defaultEformFields = [
  { id: "f_nama", label: "Nama Lengkap", type: "text" },
  { id: "f_ttl", label: "Tempat, Tgl Lahir", type: "text" },
  { id: "f_domisili", label: "Domisili Saat Ini", type: "text" },
  { id: "f_hp", label: "No. HP Aktif", type: "number" },
  { id: "f_bpkb", label: "Ket. BPKB (A/n Sendiri/Orang Lain)", type: "text" },
  { id: "f_nominal", label: "Nominal Pinjaman (Rp)", type: "number" },
  { id: "f_tenor", label: "Tenor Pinjaman (Bulan)", type: "number" },
];
let EFORM_SETTINGS = [];

let loggedInUser = null;
const sessionDataStr = localStorage.getItem("userSession");
if (sessionDataStr) {
  try {
    // Tambahkan try...catch di sini
    let parsedSession = JSON.parse(sessionDataStr);
    if (new Date().getTime() < parsedSession.expire) {
      loggedInUser = parsedSession.user;
    } else {
      localStorage.removeItem("userSession");
    }
  } catch (error) {
    console.warn("Data sesi korup. Membersihkan cache otomatis...");
    localStorage.removeItem("userSession");
  }
}

let ocmIdx = localStorage.getItem("ocm_ongoing_idx");
let currentOngoingIndex =
  ocmIdx !== null && ocmIdx !== "null" && ocmIdx !== "undefined"
    ? parseInt(ocmIdx)
    : null;

let activeDay = 1;
let ITEMS_PER_DAY = 100;
let WA_DELAY = 0;
let WORK_ON_SUNDAY = false;
let lastWaTime = 0;
let WA_TEMPLATE =
  "Selamat pagi ka, apakah benar ini dengan kk [nama_konsumen]? Saya [nama_user] dari FIFGroup.";

let chartInstance = null;
window.countdownInterval = null;
let editingUserId = null;
let BATCH_LIMIT = 25;
let renderDebounceTimer = null;

// ==========================================
// 3. FUNGSI SIMPAN KE FIREBASE
// ==========================================
function saveUsers() {
  database.ref("ocm_users").update(USERS);
}

function saveValidation() {
  database.ref("ocm_validation").set(dailyValidation);
  if (typeof checkAutoApproveUser === "function") {
    checkAutoApproveUser();
  }
}
function saveState() {
  localStorage.setItem("ocm_main_db_local", JSON.stringify(currentDB));
  if (currentOngoingIndex !== null)
    localStorage.setItem("ocm_ongoing_idx", currentOngoingIndex);
  else localStorage.removeItem("ocm_ongoing_idx");
}

// ==========================================
// 3.5 SISTEM PEMANTAUAN KUOTA FIRESTORE (REALTIME)
// ==========================================
const FIRESTORE_QUOTA = {
  MAX_READS: 50000,   // Batas gratis harian Reads
  MAX_WRITES: 20000,  // Batas gratis harian Writes
  MAX_DELETES: 20000  // Batas gratis harian Deletes
};

let currentQuota = { reads: 0, writes: 0, deletes: 0 };
let quotaFlags = {
  blockAllLogin: false,
  blockUserAccess: false,
  blockUpload: false,
  blockDelete: false
};
let quotaAlertsShown = {}; // Mencegah spam alert berkali-kali

// Waktu reset Firestore adalah Tengah Malam waktu Pacific Time (PT)
function getPTDateString() {
  let ptDate = new Date().toLocaleString("en-US", {timeZone: "America/Los_Angeles"});
  let d = new Date(ptDate);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// [PERBAIKAN BUG - rollover tanggal]: sebelumnya listener kuota dipasang
// SEKALI ke node tanggal hari itu saja (mis. "2026-08-09") lalu tidak pernah
// dipindah. Kalau tab admin dibiarkan terbuka melewati tengah malam waktu
// Pacific Time (saat kuota Firestore reset), listener lama tetap menempel ke
// node tanggal kemarin yang sudah tidak bertambah lagi -> indikator kuota
// terlihat "macet"/tidak berfungsi sampai halaman di-refresh manual.
// Sekarang dicek berkala; begitu tanggal PT berganti, listener lama
// dilepas (off) dan dipasang ulang ke node tanggal yang baru.
let _quotaMonitorRef = null;
let _quotaMonitorDate = null;
let _quotaRolloverInterval = null;
const QUOTA_ROLLOVER_CHECK_MS = 60 * 1000; // cek pergantian tanggal tiap 1 menit

function attachQuotaListenerForDate(dateStr) {
  // Lepas listener tanggal sebelumnya dulu supaya tidak dobel/bocor memori
  if (_quotaMonitorRef) {
    _quotaMonitorRef.off("value");
  }

  _quotaMonitorDate = dateStr;
  _quotaMonitorRef = database.ref(`ocm_quota_tracker/${dateStr}`);
  _quotaMonitorRef.on("value", (snapshot) => {
    currentQuota = snapshot.val() || { reads: 0, writes: 0, deletes: 0 };
    evaluasiBatasKuota();

    // TAMBAHKAN BARIS INI: Update grafik setiap ada perubahan kuota
    if (window.isAppInitialized) {
      renderQuotaCharts();
    }
  });
}

// Menjalankan pemantauan realtime dari RTDB
function initQuotaMonitor() {
  attachQuotaListenerForDate(getPTDateString());

  if (!_quotaRolloverInterval) {
    _quotaRolloverInterval = setInterval(() => {
      let todayPT = getPTDateString();
      if (todayPT !== _quotaMonitorDate) {
        // Hari baru dimulai (reset kuota Firestore) -> pindah listener &
        // bersihkan status alert/blokir supaya tidak "mengingat" hari kemarin
        quotaAlertsShown = {};
        quotaFlags = {
          blockAllLogin: false,
          blockUserAccess: false,
          blockUpload: false,
          blockDelete: false
        };
        attachQuotaListenerForDate(todayPT);
      }
    }, QUOTA_ROLLOVER_CHECK_MS);
  }
}

// Fungsi Peringatan & Pemblokiran
function evaluasiBatasKuota() {
  let sisaReads = ((FIRESTORE_QUOTA.MAX_READS - currentQuota.reads) / FIRESTORE_QUOTA.MAX_READS) * 100;
  let sisaWrites = ((FIRESTORE_QUOTA.MAX_WRITES - currentQuota.writes) / FIRESTORE_QUOTA.MAX_WRITES) * 100;
  let sisaDeletes = ((FIRESTORE_QUOTA.MAX_DELETES - currentQuota.deletes) / FIRESTORE_QUOTA.MAX_DELETES) * 100;

  // --- EVALUASI READS ---
  if (sisaReads <= 3) {
    quotaFlags.blockAllLogin = true;
    if (loggedInUser && !quotaAlertsShown.r3) {
      showDialog("Akses Ditutup", "Kuota Reads Firestore habis (Sisa <= 3%). Sistem dinonaktifkan.", "alert", () => logout());
      quotaAlertsShown.r3 = true;
    }
  } else if (sisaReads <= 5 && !quotaAlertsShown.r5) {
    showToast("Peringatan Kritis: Kuota Reads sisa <= 5%. Segera selesaikan pekerjaan!", "error");
    quotaAlertsShown.r5 = true;
  } else if (sisaReads <= 10 && !quotaAlertsShown.r10) {
    showToast("Peringatan: Kuota Reads Firestore mendekati 10%.", "warning");
    quotaAlertsShown.r10 = true;
  }

  // --- EVALUASI WRITES ---
  if (sisaWrites <= 3) {
    quotaFlags.blockUserAccess = true;
    quotaFlags.blockUpload = true;
    if (loggedInUser && loggedInUser.role !== "admin" && !quotaAlertsShown.w3) {
      showDialog("Akses Ditutup", "Kuota Writes habis. Akses user biasa dihentikan hingga besok.", "alert", () => logout());
      quotaAlertsShown.w3 = true;
    }
  } else if (sisaWrites <= 5 && !quotaAlertsShown.w5) {
    showToast("Peringatan: Kuota Write menipis (<= 5%).", "error");
    quotaAlertsShown.w5 = true;
  } else if (sisaWrites <= 10 && !quotaAlertsShown.w10) {
    showToast("Peringatan: Kuota Write Firestore mendekati 10%.", "warning");
    quotaAlertsShown.w10 = true;
  }

  // --- EVALUASI DELETES ---
  if (sisaDeletes <= 3) {
    quotaFlags.blockDelete = true;
  } else if (sisaDeletes <= 8 && !quotaAlertsShown.d8) {
    showToast("Peringatan: Kuota Delete menipis (<= 8%).", "warning");
    quotaAlertsShown.d8 = true;
  }
}

// Fungsi untuk mencatat pemakaian
// OPTIMASI: hitungan disimpan di memori lokal dulu (bukan langsung write ke
// Firebase setiap dipanggil), lalu di-flush berkala. Ini menghindari extra
// read/write traffic hanya untuk mencatat angka statistik.
let _quotaUsageBuffer = { reads: 0, writes: 0, deletes: 0 };
let _quotaFlushInterval = null;
const QUOTA_FLUSH_INTERVAL_MS = 5 * 60 * 1000; // flush tiap 5 menit

function trackFirestoreUsage(type, count) {
  if (count <= 0) return;
  if (!(type in _quotaUsageBuffer)) _quotaUsageBuffer[type] = 0;
  _quotaUsageBuffer[type] += count;
  // [LOG SEMENTARA UNTUK DEBUG]: konfirmasi trackFirestoreUsage benar-benar
  // dipanggil. Bisa dihapus lagi setelah masalah indikator kuota terlacak.
  console.log(`[QuotaTracker] +${count} ${type} dicatat. Buffer saat ini:`, JSON.stringify(_quotaUsageBuffer));

  if (!_quotaFlushInterval) {
    // [PERBAIKAN BUG]: sebelumnya flush PERTAMA baru terjadi setelah 5 menit
    // penuh (interval reguler), jadi indikator kuota terlihat kosong/0%
    // cukup lama di awal sesi meski sudah ada aksi Firestore. Percepat flush
    // pertama jadi 15 detik saja, baru setelah itu lanjut ke jadwal hemat
    // kuota tiap 5 menit seperti semula.
    setTimeout(flushQuotaUsageBuffer, 15 * 1000);
    _quotaFlushInterval = setInterval(flushQuotaUsageBuffer, QUOTA_FLUSH_INTERVAL_MS);
  }
}

function flushQuotaUsageBuffer() {
  let todayPT = getPTDateString();
  // [LOG SEMENTARA UNTUK DEBUG]
  console.log("[QuotaTracker] flushQuotaUsageBuffer jalan, buffer:", JSON.stringify(_quotaUsageBuffer));
  Object.keys(_quotaUsageBuffer).forEach((type) => {
    const count = _quotaUsageBuffer[type];
    if (count > 0) {
      // Kosongkan buffer lokal DULU (bukan setelah transaction), supaya
      // pemakaian baru yang masuk selama pengiriman ini tidak ikut ke-nol-kan.
      _quotaUsageBuffer[type] = 0;

      let ref = database.ref(`ocm_quota_tracker/${todayPT}/${type}`);
      // Gunakan transaction agar akurat jika banyak user melakukan aksi bersamaan.
      // [PERBAIKAN BUG]: pakai callback onComplete (bukan .then/.catch atas nilai
      // baliknya) karena tidak semua versi Firebase RTDB SDK menjamin
      // transaction() mengembalikan Promise — kalau tidak, .catch() akan
      // melempar "is not a function" dan MENGHENTIKAN seluruh proses flush,
      // sehingga data tidak pernah terkirim ke RTDB sama sekali. Signature
      // callback ini didukung di semua versi SDK.
      ref.transaction(
        (current) => (current || 0) + count,
        (error, committed) => {
          if (error) {
            // Gagal terkirim (offline/permission/dll) -> kembalikan ke buffer
            // supaya dicoba kirim lagi di flush berikutnya, jangan hilang.
            console.error(`[QuotaTracker] GAGAL kirim ${count} ${type} ke RTDB:`, error);
            _quotaUsageBuffer[type] = (_quotaUsageBuffer[type] || 0) + count;
          } else {
            // [LOG SEMENTARA UNTUK DEBUG]
            console.log(`[QuotaTracker] BERHASIL kirim ${count} ${type} ke RTDB (committed=${committed})`);
          }
        }
      );
    }
  });
}

// Pastikan rekapan terakhir tetap terkirim saat tab/halaman ditutup.
// [PERBAIKAN BUG]: "beforeunload" saja tidak cukup andal di WebView Android
// (app ini punya jembatan window.AndroidApp) — saat user menutup app lewat
// tombol Home/Back, "beforeunload" sering tidak terpicu sama sekali, jadi
// sisa buffer yang belum di-flush (maks. 5 menit terakhir) hilang tanpa
// pernah terkirim ke RTDB. Tambahkan "pagehide" dan "visibilitychange"
// (saat app diminimize/tab disembunyikan) sebagai jaring pengaman tambahan.
window.addEventListener("beforeunload", flushQuotaUsageBuffer);
window.addEventListener("pagehide", flushQuotaUsageBuffer);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    flushQuotaUsageBuffer();
  }
});

// [PERBAIKAN BUG]: initQuotaMonitor() TIDAK dipanggil langsung di sini lagi.
// Sebelumnya dipanggil saat script baru diload (SEBELUM Firebase Auth selesai
// login), sehingga read ke "ocm_quota_tracker" kena permission-denied oleh
// security rules dan currentQuota tidak pernah terisi -> indikator kuota
// (reads/writes/deletes) diam/tidak pernah update.
// Sekarang dipanggil dari dalam auth.onAuthStateChanged (lihat window.onload
// di bawah), sama seperti listener data lain (ocm_settings, ocm_users, dll),
// supaya baru jalan setelah user benar-benar terautentikasi.

// ==========================================
// 4. SINKRONISASI REALTIME & MANAJEMEN LOADING
// ==========================================
let isDataLoaded = false;
let loadingInterval = null;
let currentProgress = 0;
let isLoginScreenInitialized = false;

window.onload = function () {
  mulaiLoadingProgress(
    loggedInUser
      ? "Mengautentikasi sesi & mengunduh data utama..."
      : "Menyiapkan halaman login...",
  );

  auth.onAuthStateChanged((firebaseUser) => {
    if (firebaseUser) {
      // PERBAIKAN BUG: Tambahkan && !isProcessingLogin agar tidak menendang user yang sedang proses masuk
      if (!loggedInUser && !isProcessingLogin) {
        console.warn("Sesi tidak sinkron. Memaksa logout...");
        auth.signOut();
        return;
      }

      console.log("Sesi valid, mulai mengunduh data rahasia...");

      // 1. Auth Firebase sudah siap -> aman baca semua ref yang butuh auth != null
      muatDataLengkap();

      // 2. Pasang monitor kuota
      if (!window.isQuotaMonitorAttached) {
        window.isQuotaMonitorAttached = true;
        initQuotaMonitor();
      }

      // 3. Pasang listener form
      if (!window.isEformListenerAttached) {
        window.isEformListenerAttached = true;
        if (typeof listenPengajuanEform === "function") listenPengajuanEform();
      }

      // 4. Pasang listener notifikasi (Pindahan dari luar scope)
      inisialisasiListenerNotifikasiAdmin();
    } else {
      // Firebase Auth tidak punya sesi aktif
      console.log("User belum terautentikasi atau sesi telah berakhir.");
      if (loggedInUser) {
        loggedInUser = null;
        sessionStorage.removeItem("ocm_session");
      }
      muatDataLoginOnly();
    }
  });

  window.dbStatusInterval1 = setTimeout(() => {
    const txt = document.getElementById("loading-database-status");
    if (txt && !isDataLoaded)
      txt.innerText = "Sinkronisasi struktur data pengajuan pinjaman...";
  }, 1000);

  window.dbStatusInterval2 = setTimeout(() => {
    const txt = document.getElementById("loading-database-status");
    if (txt && !isDataLoaded)
      txt.innerText = "Menyusun baris tabel & rendering dashboard...";
  }, 2200);
};

function muatDataLoginOnly(callbackSukses) {
  database.ref("ocm_users").once(
    "value",
    (snapshot) => {
      USERS = snapshot.val() || defaultUsers;
      if (!isLoginScreenInitialized) {
        isLoginScreenInitialized = true;
        selesaikanLoadingProgress(() => {
          const loginScreen = document.getElementById("login-screen");
          if (loginScreen) loginScreen.classList.remove("hidden");
          const mainApp =
            document.getElementById("app-layout") ||
            document.getElementById("main-dashboard");
          if (mainApp) mainApp.classList.add("hidden");
          if (callbackSukses) callbackSukses();
        });
      }
    },
    (error) => {
      if (typeof matikanLoadingAwal === "function") matikanLoadingAwal();
      if (typeof showToast === "function")
        showToast("Gagal memuat data login: " + error.message, "error");
    },
  );
}

// ==========================================
// FUNGSI LOADING UTAMA (METODE v7.31)
// ==========================================
function muatDataLengkap(callbackSelesai) {
  let loaded = {
    settings: false,
    users: false,
    validation: false,
    bugs: false,
    eform: false,
    pengajuan: false,
    main: false, // TAMBAHAN WAJIB UNTUK FIRESTORE
  };

  function checkSemuaDataSelesai() {
    if (
      loaded.settings &&
      loaded.users &&
      loaded.validation &&
      loaded.bugs &&
      loaded.eform &&
      loaded.pengajuan &&
      loaded.main
    ) {
      if (!isDataLoaded) {
        isDataLoaded = true;
        if (loggedInUser && loggedInUser.role === "admin") {
          if (typeof renderAdminEformSubmissions === "function")
            renderAdminEformSubmissions();
          if (typeof renderEformBuilderList === "function")
            renderEformBuilderList();
        }
        if (typeof updateBugNotification === "function")
          updateBugNotification();

        selesaikanLoadingProgress(() => {
          const loginScreen = document.getElementById("login-screen");
          if (loginScreen) loginScreen.classList.add("hidden");

          const mainApp =
            document.getElementById("app-layout") ||
            document.getElementById("main-dashboard");
          if (mainApp) mainApp.classList.remove("hidden");

          if (typeof initApp === "function") initApp();
          if (callbackSelesai) callbackSelesai();
        });
      } else {
        if (window.isAppInitialized) {
          clearTimeout(renderDebounceTimer);
          renderDebounceTimer = setTimeout(() => {
            if (loggedInUser && loggedInUser.role === "admin") {
              if (typeof renderDashboard === "function") renderDashboard();
            } else if (loggedInUser) {
              if (typeof renderTabs === "function") renderTabs();
              if (typeof renderTable === "function") renderTable();
            }
          }, 500);
        }
      }
    }
  }

  // --- LISTENER FIREBASE RTDB ---
  database.ref("ocm_settings").on("value", (snapshot) => {
    const settings = snapshot.val() || {};
    ITEMS_PER_DAY = settings.items_per_day || 100;
    WA_DELAY = settings.wa_delay || 0;
    WORK_ON_SUNDAY = settings.work_on_sunday || false;
    WA_TEMPLATE =
      settings.wa_template ||
      "Selamat pagi ka, apakah benar ini dengan kk [nama_konsumen]? Saya [nama_user] dari FIFGroup.";
    const templateInput = document.getElementById("setting-wa-template");
    if (templateInput) templateInput.value = WA_TEMPLATE;
    loaded.settings = true;
    checkSemuaDataSelesai();
  });

  database.ref("ocm_users").on("value", (snapshot) => {
    USERS = snapshot.val() || defaultUsers;
    loaded.users = true;
    checkSemuaDataSelesai();
  });

  database.ref("ocm_validation").on("value", (snapshot) => {
    dailyValidation = snapshot.val() || {};
    loaded.validation = true;
    checkSemuaDataSelesai();
  });

  database.ref("ocm_bugs").on("value", (snapshot) => {
    BUGS = snapshot.val() || {};
    loaded.bugs = true;
    checkSemuaDataSelesai();
  });

  database.ref("ocm_eform_settings").on("value", (snapshot) => {
    EFORM_SETTINGS = snapshot.val() || defaultEformFields;
    loaded.eform = true;
    checkSemuaDataSelesai();
  });

  // OPTIMASI: sebelumnya .on("value") mengunduh ULANG seluruh tabel
  // pengajuan_pinjaman setiap ada 1 baris berubah. Sekarang: unduh sekali
  // penuh (once), lalu dengarkan hanya baris yang benar-benar berubah
  // (child_added/child_changed/child_removed) untuk update selanjutnya.
  database
    .ref("pengajuan_pinjaman")
    .once("value")
    .then((snapshot) => {
      PENGAJUAN_PINJAMAN = snapshot.val() || {};
      loaded.pengajuan = true;
      checkSemuaDataSelesai();

      const pengajuanRef = database.ref("pengajuan_pinjaman");

      pengajuanRef.on("child_added", (childSnap) => {
        if (PENGAJUAN_PINJAMAN[childSnap.key]) return; // sudah ada dari initial load
        PENGAJUAN_PINJAMAN[childSnap.key] = childSnap.val();
        if (window.isAppInitialized && typeof renderAdminEformSubmissions === "function") {
          renderAdminEformSubmissions();
        }
      });

      pengajuanRef.on("child_changed", (childSnap) => {
        PENGAJUAN_PINJAMAN[childSnap.key] = childSnap.val();
        if (window.isAppInitialized && typeof renderAdminEformSubmissions === "function") {
          renderAdminEformSubmissions();
        }
      });

      pengajuanRef.on("child_removed", (childSnap) => {
        delete PENGAJUAN_PINJAMAN[childSnap.key];
        if (window.isAppInitialized && typeof renderAdminEformSubmissions === "function") {
          renderAdminEformSubmissions();
        }
      });
    })
    .catch((error) => {
      console.error("Gagal memuat pengajuan_pinjaman:", error);
      loaded.pengajuan = true;
      checkSemuaDataSelesai();
    });

  // =========================================================================
  // MENGGUNAKAN FIRESTORE UNTUK DATA EXCEL UTAMA (REALTIME)
  // =========================================================================
  let localMainDB = localStorage.getItem("ocm_main_db_local");

  // 1. Tampilkan data dari Local Storage secara INSTAN (Mencegah layar blank)
  if (localMainDB) {
    try {
      // Tambahkan pengamanan parsing
      let dbData = JSON.parse(localMainDB);
      currentDB = Array.isArray(dbData) ? dbData : Object.values(dbData);
      loaded.main = true;
      checkSemuaDataSelesai();
    } catch (error) {
      console.warn("Database lokal korup, mengunduh ulang dari server...");
      localStorage.removeItem("ocm_main_db_local");
      // Sistem akan otomatis lanjut mengunduh dari Firestore tanpa crash
    }
  }

  // 2. Listener Realtime Firestore (Hanya download data yang diperlukan)
  let dbQuery = firestore.collection("ocm_main_db");

  // Jika yang login BUKAN admin, minta Firebase HANYA mengirimkan data milik user ini saja
  // (query ini SENGAJA tidak diberi orderBy tambahan, supaya tidak butuh
  // composite index baru di Firestore — pagination memang tidak diperlukan
  // di jalur ini karena datanya sudah dibatasi per-user)
  if (loggedInUser && loggedInUser.role !== "admin") {
    dbQuery = dbQuery.where("kodeUser", "==", loggedInUser.username);
  } else {
    // OPTIMASI: sebelumnya Admin menarik SELURUH koleksi (bisa puluhan ribu
    // dokumen) tanpa batas lewat onSnapshot yang terus memantau semuanya
    // selamanya = boros kuota Reads. Sekarang halaman pertama saja yang live
    // (MAIN_DB_PAGE_SIZE dokumen); halaman berikutnya dimuat manual lewat
    // muatLebihBanyakDataUtama() — panggil ini dari tombol "Muat Lebih
    // Banyak" atau saat admin scroll ke bawah tabel.
    // orderBy(documentId()) di sini aman tanpa composite index tambahan
    // (index bawaan/merge untuk orderBy tunggal tanpa where).
    dbQuery = dbQuery
      .orderBy(firebase.firestore.FieldPath.documentId())
      .limit(MAIN_DB_PAGE_SIZE);
  }

  dbQuery.onSnapshot(
    (snapshot) => {
      // [TAMBAHKAN BARIS INI UNTUK MENGHITUNG READS]
      let readCount = snapshot.docChanges().length;
      trackFirestoreUsage("reads", readCount);

      if (loggedInUser && loggedInUser.role === "admin") {
        mainDbLastVisibleDoc = snapshot.docs[snapshot.docs.length - 1] || null;
        mainDbHasMore = snapshot.docs.length === MAIN_DB_PAGE_SIZE;
      }

      let freshData = [];
      snapshot.forEach((doc) => {
        freshData.push({ ...doc.data(), docId: doc.id });
      });

      currentDB = freshData;
      localStorage.setItem("ocm_main_db_local", JSON.stringify(currentDB));

      // Update tampilan UI secara realtime jika aplikasi sudah terbuka
      if (window.isAppInitialized) {
        if (loggedInUser && loggedInUser.role === "admin") {
          if (typeof renderDashboard === "function") renderDashboard();
        } else {
          if (typeof renderTable === "function") renderTable();
        }
      }

      // Memicu penutupan layar loading jika ini unduhan pertama kali
      if (!loaded.main) {
        loaded.main = true;
        checkSemuaDataSelesai();
      }
    },
    (error) => {
      console.error("Error mendengarkan Firestore: ", error);
      if (typeof showToast === "function")
        showToast("Gagal membaca data Firestore: " + error.message, "error");
    },
  );

}

function mulaiLoadingProgress(pesanStatus = "Mengunduh Database...") {
  const loader = document.getElementById("initial-loading-screen");
  const circle = document.getElementById("loading-progress-circle");
  const text = document.getElementById("loading-percentage");
  const statusTxt = document.getElementById("loading-database-status");

  if (loader)
    loader.classList.remove("hidden", "opacity-0", "pointer-events-none");
  currentProgress = 0;
  if (statusTxt) statusTxt.innerText = pesanStatus;

  clearInterval(loadingInterval);
  loadingInterval = setInterval(() => {
    if (currentProgress < 90) {
      let increment =
        currentProgress < 60
          ? Math.floor(Math.random() * 8) + 2
          : Math.floor(Math.random() * 3) + 1;
      currentProgress += increment;
      if (currentProgress > 90) currentProgress = 90;
      updateProgressUI(currentProgress, circle, text);
    }
  }, 180);
}

function updateProgressUI(percent, circleEl, textEl) {
  if (textEl) textEl.innerText = percent + "%";
  if (circleEl) {
    const offset = 283 - (283 * percent) / 100;
    circleEl.style.strokeDashoffset = offset;
  }
}

function selesaikanLoadingProgress(callback) {
  if (typeof loadingInterval !== "undefined") clearInterval(loadingInterval);
  const circle = document.getElementById("loading-progress-circle");
  const text = document.getElementById("loading-percentage");
  if (circle || text) updateProgressUI(100, circle, text);

  setTimeout(() => {
    if (typeof matikanLoadingAwal === "function") matikanLoadingAwal();
    if (typeof callback === "function") callback();
  }, 500);
}

function matikanLoadingAwal() {
  clearInterval(loadingInterval);
  clearTimeout(window.dbStatusInterval1);
  clearTimeout(window.dbStatusInterval2);

  const loader = document.getElementById("initial-loading-screen");
  const statusTxt = document.getElementById("loading-database-status");

  if (loader) {
    if (statusTxt) statusTxt.innerText = "Selesai! Membuka halaman...";
    loader.classList.add("opacity-0", "pointer-events-none");
    setTimeout(() => {
      loader.classList.add("hidden");
    }, 500);
  }
}

// ==========================================
// GRAFIK INDIKATOR KUOTA FIRESTORE
// ==========================================
let quotaChartInstances = { reads: null, writes: null, deletes: null };

// Tooltip HTML kustom (bukan tooltip bawaan canvas) supaya:
// 1. Tidak pernah kepotong oleh elemen/parent lain (posisinya "fixed" relatif ke layar).
// 2. Lebarnya menyesuaikan isi teks, jadi angka tidak pernah terpotong.
// 3. Muncul di BAWAH lingkaran, bukan menimpa teks persentase di tengah.
function getQuotaTooltipEl() {
    let tooltipEl = document.getElementById('quota-chart-tooltip');
    if (!tooltipEl) {
        tooltipEl = document.createElement('div');
        tooltipEl.id = 'quota-chart-tooltip';
        tooltipEl.style.position = 'fixed';
        tooltipEl.style.top = '0';
        tooltipEl.style.left = '0';
        tooltipEl.style.zIndex = '10000';
        tooltipEl.style.pointerEvents = 'none';
        tooltipEl.style.opacity = '0';
        tooltipEl.style.transition = 'opacity 0.12s ease';
        tooltipEl.style.background = '#1e293b';
        tooltipEl.style.color = '#ffffff';
        tooltipEl.style.borderRadius = '10px';
        tooltipEl.style.padding = '8px 12px';
        tooltipEl.style.fontSize = '11px';
        tooltipEl.style.fontFamily = "'Plus Jakarta Sans', sans-serif";
        tooltipEl.style.boxShadow = '0 10px 25px -5px rgba(0,0,0,0.35)';
        tooltipEl.style.whiteSpace = 'nowrap';
        tooltipEl.style.width = 'max-content';
        tooltipEl.style.maxWidth = '220px';
        document.body.appendChild(tooltipEl);
    }
    return tooltipEl;
}

function quotaExternalTooltipHandler(context) {
    const { chart, tooltip } = context;
    const tooltipEl = getQuotaTooltipEl();

    // Sembunyikan jika tidak ada hover aktif
    if (tooltip.opacity === 0) {
        tooltipEl.style.opacity = '0';
        return;
    }

    // Susun isi tooltip dari title & body bawaan Chart.js
    if (tooltip.body) {
        const titleLines = tooltip.title || [];
        const bodyLines = tooltip.body.map(b => b.lines).flat();

        let innerHtml = '';
        titleLines.forEach(title => {
            innerHtml += `<div style="font-weight:700;margin-bottom:2px;">${title}</div>`;
        });
        bodyLines.forEach(line => {
            innerHtml += `<div style="opacity:0.9;">${line}</div>`;
        });
        tooltipEl.innerHTML = innerHtml;
    }

    const canvasRect = chart.canvas.getBoundingClientRect();

    // Posisi horizontal: mengikuti titik hover, tapi dijaga tidak keluar layar
    let left = canvasRect.left + tooltip.caretX;
    // Posisi vertikal: SELALU di bawah lingkaran, supaya tidak menimpa teks persentase di tengah
    let top = canvasRect.top + canvasRect.height + 10;

    tooltipEl.style.left = '0px';
    tooltipEl.style.top = '0px';
    tooltipEl.style.opacity = '1';
    // Ukur lebar tooltip setelah kontennya di-render
    const tooltipWidth = tooltipEl.offsetWidth;
    const tooltipHeight = tooltipEl.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let finalLeft = left - tooltipWidth / 2;
    // Jaga agar tidak keluar dari sisi kiri/kanan layar
    if (finalLeft < 8) finalLeft = 8;
    if (finalLeft + tooltipWidth > vw - 8) finalLeft = vw - tooltipWidth - 8;

    let finalTop = top;
    // Jika ruang di bawah tidak cukup (mepet ke bawah layar), tampilkan di atas lingkaran
    if (finalTop + tooltipHeight > vh - 8) {
        finalTop = canvasRect.top - tooltipHeight - 10;
    }

    tooltipEl.style.transform = `translate(${finalLeft}px, ${finalTop}px)`;
}

function renderQuotaCharts() {
    // Pastikan hanya admin yang merender grafik ini
    if (!loggedInUser || loggedInUser.role !== "admin") return;

    const maxReads = FIRESTORE_QUOTA.MAX_READS;
    const maxWrites = FIRESTORE_QUOTA.MAX_WRITES;
    const maxDeletes = FIRESTORE_QUOTA.MAX_DELETES;

    const usedReads = currentQuota.reads || 0;
    const usedWrites = currentQuota.writes || 0;
    const usedDeletes = currentQuota.deletes || 0;

    updateSingleQuotaChart('chart-quota-reads', usedReads, maxReads, '#2563eb', 'reads');    // Biru
    updateSingleQuotaChart('chart-quota-writes', usedWrites, maxWrites, '#f59e0b', 'writes'); // Kuning/Amber
    updateSingleQuotaChart('chart-quota-deletes', usedDeletes, maxDeletes, '#e11d48', 'deletes'); // Merah
}

function updateSingleQuotaChart(canvasId, used, max, color, key) {
    const canvasEl = document.getElementById(canvasId);
    if (!canvasEl) return;
    
    let sisa = max - used;
    if (sisa < 0) sisa = 0; // Cegah nilai minus di grafik
    let percent = Math.round((used / max) * 100);

    // Update teks di tengah grafik dan di bawah grafik
    const textEl = document.getElementById(`${canvasId}-text`);
    if (textEl) textEl.innerText = `${percent}%`;

    const subTextEl = document.getElementById(`${canvasId}-subtext`);
    if (subTextEl) subTextEl.innerText = `${used.toLocaleString('id-ID')} / ${max.toLocaleString('id-ID')}`;

    // Jika grafik sudah ada, cukup update datanya (animasi lebih mulus)
    if (quotaChartInstances[key]) {
        quotaChartInstances[key].data.datasets[0].data = [used, sisa];
        quotaChartInstances[key].update();
    } else {
        // Buat grafik baru
        const ctx = canvasEl.getContext("2d");
        quotaChartInstances[key] = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['Terpakai', 'Sisa Kuota'],
                datasets: [{
                    data: [used, sisa],
                    backgroundColor: [color, '#f1f5f9'], // Warna baris isi dan background sisa
                    borderWidth: 0,
                    cutout: '80%', // Membuat cincin donat lebih tipis
                    borderRadius: 5 // Membuat ujung baris melengkung
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { animateScale: true, animateRotate: true },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        enabled: false, // Matikan tooltip bawaan canvas (penyebab kepotong/menimpa)
                        external: quotaExternalTooltipHandler,
                        callbacks: {
                            label: function(context) {
                                return ` ${context.label}: ${context.raw.toLocaleString('id-ID')}`;
                            }
                        }
                    }
                }
            }
        });
    }
}
function showLoading() {
  document.getElementById("loading-screen").classList.remove("hidden");
  setTimeout(
    () =>
      document.getElementById("loading-screen").classList.remove("opacity-0"),
    10,
  );
}

function hideLoading() {
  document.getElementById("loading-screen").classList.add("opacity-0");
  setTimeout(
    () => document.getElementById("loading-screen").classList.add("hidden"),
    300,
  );
}

async function uploadToImgbb(file, isExpiring = false) {
  const IMGBB_API_KEY = "2ddf22ef3afd37bf01d9e278177061ac";
  const formData = new FormData();
  formData.append("image", file);
  if (isExpiring) formData.append("expiration", "2592000");

  try {
    const response = await fetch(
      `https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`,
      { method: "POST", body: formData },
    );
    const data = await response.json();
    if (data.success) return data.data.url;
    console.error("ImgBB Error:", data);
    return null;
  } catch (error) {
    console.error("Gagal upload ke ImgBB:", error);
    return null;
  }
}

function showToast(msg, type = "info") {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.className =
      "fixed top-5 right-5 z-[10010] flex flex-col gap-3 pointer-events-none";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  let bgClass = "bg-slate-800/90 text-white border-slate-700";
  let icon = `<svg class="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>`;

  if (type === "success") {
    bgClass = "bg-emerald-50/95 text-emerald-900 border-emerald-200";
    icon = `<svg class="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>`;
  } else if (type === "error") {
    bgClass = "bg-rose-50/95 text-rose-900 border-rose-200";
    icon = `<svg class="w-5 h-5 text-rose-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>`;
  }

  toast.className = `flex items-center gap-3 px-4 py-3.5 rounded-2xl shadow-xl backdrop-blur-md border transform translate-x-full opacity-0 transition-all duration-400 ease-out z-[9999] min-w-[280px] max-w-sm cursor-pointer hover:scale-[1.02] ${bgClass}`;
  toast.innerHTML = `
    <div class="flex-shrink-0">${icon}</div>
    <span class="text-sm font-semibold tracking-wide flex-1">${msg}</span>
    <button onclick="this.parentElement.remove()" class="text-current opacity-60 hover:opacity-100 transition-opacity p-1">
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
    </button>
  `;

  container.appendChild(toast);

  requestAnimationFrame(() => {
    setTimeout(
      () => toast.classList.remove("translate-x-full", "opacity-0"),
      10,
    );
  });

  setTimeout(() => {
    toast.classList.add("opacity-0", "translate-x-8");
    setTimeout(() => toast.remove(), 400);
  }, 4000);
}

// --- CUSTOM MODAL SYSTEM (RESTORED) ---
let dialogConfirmCallback = null;
function showDialog(title, message, type = "alert", onConfirm = null) {
  dialogConfirmCallback = onConfirm;
  document.getElementById("custom-dialog-title").innerText = title;
  document.getElementById("custom-dialog-message").innerText = message;
  const btnContainer = document.getElementById("custom-dialog-buttons");
  if (type === "confirm") {
    btnContainer.innerHTML = `<button onclick="closeDialog()" class="px-5 py-2.5 text-sm font-bold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-xl transition-all cursor-pointer">Batal</button><button onclick="confirmDialog()" class="px-5 py-2.5 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 active:scale-95 rounded-xl transition-all shadow-md cursor-pointer">Ya, Mengerti & Lanjutkan</button>`;
  } else {
    btnContainer.innerHTML = `<button onclick="closeDialog()" class="px-5 py-2.5 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 active:scale-95 rounded-xl transition-all shadow-md cursor-pointer w-full">Mengerti</button>`;
  }
  const overlay = document.getElementById("custom-dialog-overlay");
  const box = document.getElementById("custom-dialog-box");
  if (overlay && box) {
    overlay.classList.remove("hidden");
    requestAnimationFrame(() => {
      overlay.classList.remove("opacity-0");
      box.classList.remove("scale-90");
    });
  }
}

function closeDialog() {
  const overlay = document.getElementById("custom-dialog-overlay");
  const box = document.getElementById("custom-dialog-box");
  if (overlay && box) {
    overlay.classList.add("opacity-0");
    box.classList.add("scale-90");
    setTimeout(() => {
      overlay.classList.add("hidden");
    }, 300);
  }
  dialogConfirmCallback = null;
}

function confirmDialog() {
  if (dialogConfirmCallback) dialogConfirmCallback();
  closeDialog();
}

function copyText(elementId, btnId) {
  let el = document.getElementById(elementId);
  if (!el) return showToast("Gagal: Elemen teks tidak ditemukan", "error");

  let textToCopy = el.innerText || el.textContent;
  textToCopy = textToCopy
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard
      .writeText(textToCopy)
      .then(() => successFeedback())
      .catch(() => fallbackCopy(textToCopy));
  } else {
    fallbackCopy(textToCopy);
  }

  function fallbackCopy(text) {
    let textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.top = "0";
    textArea.style.left = "0";
    textArea.style.position = "fixed";
    textArea.style.opacity = "0";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      let successful = document.execCommand("copy");
      if (successful) successFeedback();
      else showToast("Gagal menyalin teks.", "error");
    } catch (err) {
      showToast("Browser tidak mendukung fitur salin.", "error");
    }
    document.body.removeChild(textArea);
  }

  function successFeedback() {
    const btn = document.getElementById(btnId);
    if (!btn) {
      showToast("Teks berhasil disalin!", "success");
      return;
    }
    const originalHTML = btn.innerHTML;
    btn.innerHTML = `<span class="text-[10px] text-emerald-600 font-bold px-1">Tersalin!</span>`;
    setTimeout(() => {
      btn.innerHTML = originalHTML;
    }, 1500);
  }
}

// --- SISTEM LAPOR BUG (RESTORED) ---
function openBugModal() {
  document.getElementById("bug-msg").value = "";
  const modal = document.getElementById("user-bug-modal");
  if (modal) {
    modal.classList.remove("hidden");
    modal.classList.add("flex");
    setTimeout(() => modal.classList.remove("opacity-0"), 10);
  }
}

function closeBugModal() {
  const modal = document.getElementById("user-bug-modal");
  if (modal) {
    modal.classList.add("opacity-0");
    setTimeout(() => {
      modal.classList.add("hidden");
      modal.classList.remove("flex");
    }, 300);
  }
}

function submitBug() {
  let msgInput = document.getElementById("bug-msg");
  if (!msgInput) return;
  let msg = msgInput.value.trim();
  if (!msg) return showToast("Pesan laporan bug tidak boleh kosong!", "error");
  msg = escapeHTML(msg);

  const newBug = {
    user: loggedInUser.username,
    name:
      USERS[loggedInUser.username]?.name || loggedInUser.username.toUpperCase(),
    message: msg,
    date: new Date().toLocaleString("id-ID"),
    isRead: false,
  };

  database
    .ref("ocm_bugs")
    .push(newBug)
    .then(() => {
      showToast("Laporan bug berhasil dikirim.", "success");
      msgInput.value = "";
      closeBugModal();
    })
    .catch((err) => {
      showToast("Gagal mengirim laporan.", "error");
      console.error(err);
    });
}

function updateBugNotification() {
  if (!loggedInUser || loggedInUser.role !== "admin") return;
  const badge = document.getElementById("bug-notif-badge");
  if (!badge) return;
  let hasUnread = false;
  if (BUGS && typeof BUGS === "object") {
    for (let key in BUGS) {
      if (BUGS[key].isRead === false) {
        hasUnread = true;
        break;
      }
    }
  }
  if (hasUnread) badge.classList.remove("hidden");
  else badge.classList.add("hidden");
}

function openAdminBugModal() {
  const modal = document.getElementById("admin-bug-modal");
  const list = document.getElementById("admin-bug-list");
  if (!modal || !list) return;
  list.innerHTML = "";
  let hasData = false;
  let updates = {};

  for (let key in BUGS) {
    hasData = true;
    let b = BUGS[key];
    let badgeHTML = b.isRead
      ? `<span class="text-[9px] text-slate-400 font-normal">Dibaca</span>`
      : `<span class="text-[9px] bg-rose-100 text-rose-600 px-2 py-0.5 rounded-full font-bold">Baru</span>`;

    let itemHTML = `
        <div class="bg-slate-50 p-3.5 rounded-xl border border-slate-200 mb-3 shadow-sm ${b.isRead ? "" : "border-l-4 border-l-rose-500"}">
            <div class="flex justify-between items-start mb-2">
                <span class="text-xs font-bold text-slate-800">${b.name} <span class="text-slate-500 font-normal ml-1">(ID: ${b.user.toUpperCase()})</span></span>
                <span class="text-[10px] text-slate-500 font-mono">${b.date} ${badgeHTML}</span>
            </div>
            <p class="text-sm text-slate-700 whitespace-pre-wrap">${b.message}</p>
        </div>`;
    list.innerHTML = itemHTML + list.innerHTML;
    if (!b.isRead) updates[`ocm_bugs/${key}/isRead`] = true;
  }
  if (!hasData)
    list.innerHTML =
      '<p class="text-sm text-slate-400 text-center py-6 font-medium">✨ Belum ada laporan bug sistem yang masuk.</p>';
  if (Object.keys(updates).length > 0) database.ref().update(updates);

  modal.classList.remove("hidden");
  modal.classList.add("flex");
  setTimeout(() => modal.classList.remove("opacity-0"), 10);
}

function closeAdminBugModal() {
  const modal = document.getElementById("admin-bug-modal");
  if (modal) {
    modal.classList.add("opacity-0");
    setTimeout(() => {
      modal.classList.add("hidden");
      modal.classList.remove("flex");
    }, 300);
  }
}

// --- MASTER ADMIN MODAL FUNCTIONS (RESTORED) ---
function openMasterSettingsModal() {
  // Tambahkan proteksi (null check) untuk menghindari crash jika elemen tidak ada di HTML
  const editUser = document.getElementById("edit-admin-user");
  const editPass = document.getElementById("edit-admin-pass");
  const editName = document.getElementById("edit-admin-name");
  const editPhoto = document.getElementById("edit-admin-photo");

  if (editUser) editUser.value = loggedInUser.username;
  if (editPass) {
    editPass.value = USERS[loggedInUser.username]
      ? USERS[loggedInUser.username].pass
      : "";
  }
  if (editName) editName.value = USERS[loggedInUser.username]?.name || "";
  if (editPhoto) editPhoto.value = "";

  updateUserSelector();
  renderUserGDriveSettings();
  renderModalUserList();
  switchAdminTab("upload");
  resetUserForm();
  updateWaTemplateUserSelector();

  const modal = document.getElementById("master-admin-settings-modal");
  if (modal) {
    modal.classList.remove("hidden");
    modal.classList.add("flex");
    document.body.style.overflow = "hidden";
    setTimeout(() => {
      modal.classList.remove("opacity-0");
    }, 10);
  }
}

function closeMasterSettingsModal() {
  const modal = document.getElementById("master-admin-settings-modal");
  if (modal) {
    modal.classList.add("opacity-0");
    document.body.style.overflow = "";
    setTimeout(() => {
      modal.classList.add("hidden");
      modal.classList.remove("flex");
    }, 300);
  }
}

function switchAdminTab(tabName) {
  document
    .querySelectorAll(".admin-tab-content")
    .forEach((el) => el.classList.add("hidden"));
  document.querySelectorAll(".admin-tab-btn").forEach((btn) => {
    btn.classList.remove("bg-blue-600", "text-white", "shadow-md");
    btn.classList.add("text-slate-600", "hover:bg-slate-50");
  });

  const contentEl = document.getElementById(`content-admin-${tabName}`);
  const btnEl = document.getElementById(`btn-admin-${tabName}`);

  if (contentEl) contentEl.classList.remove("hidden");
  if (btnEl) {
    btnEl.classList.remove("text-slate-600", "hover:bg-slate-50");
    btnEl.classList.add("bg-blue-600", "text-white", "shadow-md");
  }

  if (tabName === "peta") {
    initAdminMap();
    setTimeout(() => {
      if (adminMap) adminMap.invalidateSize();
    }, 300);
  }
}

function renderUserGDriveSettings() {
  const container = document.getElementById("user-gdrive-settings-container");
  if (!container) return;
  container.innerHTML = "";
  let hasUsers = false;
  for (let u in USERS) {
    if (USERS[u].role === "admin") continue;
    hasUsers = true;
    let currentUrl = USERS[u].gdrive_upload_url || "";
    let uName = USERS[u].name || u.toUpperCase();
    container.innerHTML += `
        <div class="p-3 bg-white rounded-xl border border-slate-200 space-y-1.5 shadow-sm">
            <span class="text-xs font-bold text-slate-700 uppercase">${uName} (ID: ${u.toUpperCase()})</span>
            <div class="flex gap-2">
                <input type="text" id="gdrive-url-${u}" value="${currentUrl}" placeholder="Link Folder Google Drive User..." class="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-xs outline-none focus:ring-1 focus:ring-blue-500">
                <button onclick="saveUserGDriveUrl('${u}')" class="bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold px-3 py-1.5 rounded-lg transition-all shrink-0 cursor-pointer">Simpan</button>
            </div>
        </div>`;
  }
  if (!hasUsers)
    container.innerHTML =
      '<p class="text-xs text-slate-400 italic text-center py-2">Belum ada user karyawan terdaftar.</p>';
}

function saveUserGDriveUrl(user) {
  const urlVal = document.getElementById(`gdrive-url-${user}`).value.trim();
  if (!USERS[user]) return;
  USERS[user].gdrive_upload_url = urlVal;
  saveUsers();
  showToast(`Link GDrive ${user.toUpperCase()} diperbarui!`, "success");
}

function updateWaTemplateUserSelector() {
  const sel = document.getElementById("wa-template-user-selector");
  if (!sel) return;
  sel.innerHTML = "";
  for (let u in USERS) {
    if (USERS[u].role !== "admin") {
      let displayName = USERS[u].name || u.toUpperCase();
      sel.innerHTML += `<option value="${u}">${displayName} (ID: ${u.toUpperCase()})</option>`;
    }
  }
  loadUserWaTemplates();
}

function loadUserWaTemplates() {
  const user = document.getElementById("wa-template-user-selector")?.value;
  if (!user || !USERS[user]) return;
  let templates = USERS[user].wa_templates || {};
  const pagi = document.getElementById("wa-template-pagi");
  const siang = document.getElementById("wa-template-siang");
  const sore = document.getElementById("wa-template-sore");
  if (pagi) pagi.value = templates.pagi || "";
  if (siang) siang.value = templates.siang || "";
  if (sore) sore.value = templates.sore || "";
}

function saveUserWaTemplates() {
  const user = document.getElementById("wa-template-user-selector")?.value;
  if (!user || !USERS[user]) {
    showToast("Pilih user terlebih dahulu!", "error");
    return;
  }

  const templatePagi =
    document.getElementById("wa-template-pagi")?.value.trim() || "";
  const templateSiang =
    document.getElementById("wa-template-siang")?.value.trim() || "";
  const templateSore =
    document.getElementById("wa-template-sore")?.value.trim() || "";

  // 1. Update data lokal agar UI langsung tersinkronisasi
  if (!USERS[user].wa_templates) USERS[user].wa_templates = {};
  USERS[user].wa_templates.pagi = templatePagi;
  USERS[user].wa_templates.siang = templateSiang;
  USERS[user].wa_templates.sore = templateSore;

  // 2. PERBAIKAN: Gunakan .update() di level root "ocm_users" seperti struktur aslimu,
  // namun targetkan secara presisi (Targeted Update) hanya pada path template user ini.
  let updates = {};
  updates[`${user}/wa_templates`] = {
    pagi: templatePagi,
    siang: templateSiang,
    sore: templateSore,
  };

  database
    .ref("ocm_users")
    .update(updates)
    .then(() => {
      showToast(
        `Template WA untuk ${USERS[user].name || user.toUpperCase()} berhasil disimpan!`,
        "success",
      );
    })
    .catch((error) => {
      // 3. Menampilkan pesan error asli dari Firebase (error.message) ke dalam toast
      // agar jika masih gagal, kita bisa tahu pasti apa yang diblokir oleh Rules Firebase.
      showToast("Gagal menyimpan: " + error.message, "error");
      console.error("Firebase Error: ", error);
    });
}

function handleLogoUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  showLoading();
  uploadToImgbb(file).then((imgUrl) => {
    if (imgUrl) {
      database
        .ref("ocm_settings/logo_url")
        .set(imgUrl)
        .then(() => {
          hideLoading();
          showToast("Logo utama website berhasil diubah!", "success");
        })
        .catch(() => {
          hideLoading();
          showToast("Gagal menyimpan logo ke database.", "error");
        });
    } else {
      hideLoading();
      showToast("Gagal upload logo ke server ImgBB!", "error");
    }
  });
}

// ==========================================
// 6. MANAJEMEN LOGIN & SESI
// ==========================================
let isProcessingLogin = false;
let lastLoginAttempt = 0;

async function handleLogin() {
  if (cekWebSedangTutup()) {
    return showToast(
      "Sesi hari ini telah habis. Web tutup pukul 00:05 - 05:00, silakan login kembali esok hari mulai pukul 05:00.",
      "error",
    );
  }

  if (quotaFlags.blockAllLogin) {
    return showToast(
      "Gagal Login: Kuota server (Reads) telah habis hari ini.",
      "error",
    );
  }

  const now = Date.now();
  // Proteksi dasar: Jeda 3 detik setiap klik tombol (mencegah double-click spam)
  if (now - lastLoginAttempt < 3000) {
    let sisaDetik = Math.ceil((3000 - (now - lastLoginAttempt)) / 1000);
    return showToast(`Tunggu ${sisaDetik} detik lagi ya...`, "error");
  }

  if (isProcessingLogin) return;
  if (!isLoginScreenInitialized)
    return showToast("Sistem sedang disiapkan, tunggu sebentar...", "info");
  if (!USERS || Object.keys(USERS).length === 0)
    return showToast("Menyiapkan data akun...", "info");

  const userEl = document.getElementById("login-username");
  const passEl = document.getElementById("login-password");

  if (!userEl || !passEl) return showToast("Halaman sedang dimuat...", "error");

  const user = userEl.value.toLowerCase().trim();
  const pass = passEl.value.trim();

  if (!user || !pass) return showToast("ID dan Password wajib diisi!", "error");

  // =========================================================
  // FITUR KEAMANAN: BLOKIR 5 MENIT JIKA SPAM PASSWORD SALAH
  // =========================================================
  const lockKey = `lockUntil_${user}`;
  const attemptsKey = `loginAttempts_${user}`;
  const lockTime = localStorage.getItem(lockKey);

  // Cek apakah akun sedang dalam masa hukuman (terkunci)
  if (lockTime && now < parseInt(lockTime)) {
    let sisaWaktu = Math.ceil((parseInt(lockTime) - now) / 60000); // Konversi ke menit
    return showToast(
      `Akun terkunci demi keamanan! Coba lagi dalam ${sisaWaktu} menit.`,
      "error",
    );
  } else if (lockTime && now >= parseInt(lockTime)) {
    // Jika masa hukuman 5 menit sudah lewat, buka kunci akun
    localStorage.removeItem(lockKey);
    localStorage.removeItem(attemptsKey);
  }
  // =========================================================

  isProcessingLogin = true;
  lastLoginAttempt = now;
  const dummyEmail = user + DUMMY_DOMAIN;
  const loginBtn = document.getElementById("btn-login-submit");
  let originalBtnText = "Login";

  let checkRole = USERS[user]?.role || "user";
  if (quotaFlags.blockUserAccess && checkRole !== "admin") {
    isProcessingLogin = false;
    return showToast(
      "Gagal Login: Kuota server (Writes) menipis. Hanya Admin yang dapat login.",
      "error",
    );
  }

  if (loginBtn) {
    originalBtnText = loginBtn.innerText;
    loginBtn.innerText = "Memeriksa...";
    loginBtn.disabled = true;
    loginBtn.classList.add("opacity-70", "cursor-not-allowed");
  }

  const resetLoginSistem = () => {
    isProcessingLogin = false;
    if (loginBtn) {
      loginBtn.innerText = originalBtnText;
      loginBtn.disabled = false;
      loginBtn.classList.remove("opacity-70", "cursor-not-allowed");
    }
  };

  try {
    await auth.signInWithEmailAndPassword(dummyEmail, pass);
    if (!USERS[user]) {
      await auth.signOut();
      showToast(
        "Akses Ditolak: Akun Anda telah dinonaktifkan oleh Admin.",
        "error",
      );
      resetLoginSistem();
      return;
    }

    // Jika berhasil login, BERSIHKAN riwayat percobaan gagal dari memori browser
    localStorage.removeItem(lockKey);
    localStorage.removeItem(attemptsKey);

    prosesLoginBerhasil(user);
 } catch (error) {
    let errCode = error.code;
    let pesanError = "Terjadi kesalahan saat login.";

    // 1. PRIORITASKAN ERROR SISTEM/JARINGAN DARI FIREBASE DULU
    if (errCode === "auth/network-request-failed") {
      pesanError = "Koneksi internet terputus. Pastikan sinyal stabil lalu coba lagi.";
      showToast(pesanError, "error");
      resetLoginSistem();
      return;
    } else if (errCode === "auth/too-many-requests") {
      pesanError = "Akses ditahan sementara oleh server karena aktivitas mencurigakan.";
      showToast(pesanError, "error");
      resetLoginSistem();
      return;
    } else if (errCode === "auth/user-disabled") {
      pesanError = "Akun Anda telah dinonaktifkan oleh Admin.";
      showToast(pesanError, "error");
      resetLoginSistem();
      return;
    }

    // 2. JIKA ERROR TERKAIT KREDENSIAL, KITA CEK DATA LOKAL KITA
    // Fallback Darurat: Jika Firebase menolak tapi data lokal kita cocok
    // PERINGATAN: path ini memanggil prosesLoginBerhasil() TANPA auth.currentUser
    // benar-benar terisi (signInWithEmailAndPassword di atas gagal). Karena rules
    // RTDB mensyaratkan "auth != null", user yang lolos lewat fallback ini akan
    // tetap kena permission_denied di semua path (pengajuan_pinjaman, dst) walau
    // tampilannya sudah "berhasil login". Idealnya fallback ini juga mencoba
    // auth.createUserWithEmailAndPassword(dummyEmail, pass) lalu sign-in ulang,
    // bukan sekadar melewati proses auth Firebase.
    if (USERS[user] && String(USERS[user].pass) === pass) {
      localStorage.removeItem(lockKey);
      localStorage.removeItem(attemptsKey);
      prosesLoginBerhasil(user);
      return;
    }

    // Evaluasi Error Mandiri (Jika ID/Password memang salah)
    if (!USERS[user]) {
      pesanError = "Gagal Login: ID Tidak Terdaftar!";
    } else if (String(USERS[user].pass) !== pass) {
      // PROSES MENGHITUNG KEGAGALAN PASSWORD
      let currentAttempts = parseInt(localStorage.getItem(attemptsKey) || "0");
      currentAttempts++;

      if (currentAttempts >= 5) {
        // Kunci selama 5 menit
        const unlockTime = Date.now() + (5 * 60 * 1000); 
        localStorage.setItem(lockKey, unlockTime);
        localStorage.setItem(attemptsKey, "0"); 
        pesanError = "Akses Diblokir! 5x password salah. Akun terkunci selama 5 menit.";
      } else {
        localStorage.setItem(attemptsKey, currentAttempts);
        pesanError = `Gagal Login: Password salah! (Peringatan: ${currentAttempts}/5)`;
      }
    } else {
      pesanError = "Sistem Error: " + errCode;
    }

    // Tampilkan pesan error dan kembalikan tombol ke semula
    showToast(pesanError, "error");
    resetLoginSistem();
  }}
function prosesLoginBerhasil(user) {
  loggedInUser = { username: user, role: USERS[user]?.role || "user" };
  sessionStorage.setItem("ocm_session", JSON.stringify(loggedInUser));
  
  // PERBAIKAN BUG: Simpan sesi ke localStorage & IndexedDB agar persisten
  setLoginSession(loggedInUser);

  document
    .getElementById("login-screen")
    .classList.add("opacity-0", "scale-105");

  setTimeout(() => {
    document.getElementById("login-screen").classList.add("hidden");
    if (
      typeof mulaiLoadingProgress === "function" &&
      typeof muatDataLengkap === "function"
    ) {
      mulaiLoadingProgress("Berhasil! Mengunduh data Dashboard & Laporan...");
      muatDataLengkap(() => {
        showLoginSuccessPopup(loggedInUser);
      });
    } else {
      showLoginSuccessPopup(loggedInUser);
    }
  }, 500);
}

// ==========================================
// BLOK FUNGSI TAMBAH USER (KARYAWAN)
// ==========================================
async function saveEmployee() {
  let id = document.getElementById("user-form-id").value.trim().toLowerCase();
  let name = document.getElementById("user-form-name").value.trim();
  let pass = document.getElementById("user-form-pass").value.trim();
  let photoInput = document.getElementById("user-form-photo");

  if (!id || !name || !pass)
    return showToast("ID, Nama Lengkap, dan Password wajib diisi!", "error");
  if (!editingUserId && USERS[id])
    return showToast("ID Login ini sudah terdaftar!", "error");
  if (!photoInput.files || !photoInput.files[0]) showLoading();

  let dummyEmail = id + DUMMY_DOMAIN;

  let saveToDB = async (photoBase64) => {
    try {
      const oldPass = USERS[id] ? USERS[id].pass : undefined;
      const passwordBerubah =
        editingUserId && oldPass !== undefined && String(oldPass) !== pass;

      if (!editingUserId) {
        await secondaryAuth.createUserWithEmailAndPassword(dummyEmail, pass);
      } else if (passwordBerubah) {
        // PERBAIKAN BUG: sebelumnya password baru HANYA disimpan ke RTDB
        // (ocm_users), sementara akun Firebase Authentication user ini
        // tetap memakai password LAMA. Akibatnya saat user login dengan
        // password baru, Firebase Auth menolak (signInWithEmailAndPassword
        // gagal) dan kode jatuh ke "Fallback Darurat" di handleLogin() —
        // login tetap terlihat "berhasil" tapi auth.currentUser TIDAK
        // pernah benar-benar terisi. Semua fitur yang butuh "auth != null"
        // di rules (termasuk baca notifikasi ocm_global_notif) jadi ditolak
        // diam-diam dengan permission_denied. Di sini password Firebase
        // Auth-nya ikut disamakan, dengan sign-in sekali pakai password
        // LAMA di instance auth kedua (secondaryAuth) supaya sesi admin
        // yang sedang login tidak ikut ter-logout.
        try {
          await secondaryAuth.signInWithEmailAndPassword(dummyEmail, oldPass);
          await secondaryAuth.currentUser.updatePassword(pass);
          await secondaryAuth.signOut();
        } catch (syncErr) {
          await secondaryAuth.signOut().catch(() => {});
          console.error(
            "Gagal menyinkronkan password ke Firebase Auth:",
            syncErr,
          );
          hideLoading();
          showToast(
            "Password lokal tersimpan, TAPI gagal disinkronkan ke sistem keamanan (password lama di sistem sudah tidak cocok). User ini kemungkinan sudah pernah kena masalah ini sebelumnya — hapus akunnya di Firebase Console > Authentication, lalu tambahkan ulang sebagai karyawan baru.",
            "error",
          );
          return;
        }
      }
      if (!USERS[id]) USERS[id] = { role: "user", gdrive_upload_url: "" };
      USERS[id].pass = pass;
      USERS[id].name = name;
      if (photoBase64 !== undefined) USERS[id].photo = photoBase64;

      saveUsers();
      hideLoading();
      showToast(
        editingUserId
          ? "Data user diperbarui!"
          : "User baru berhasil ditambahkan!",
        "success",
      );

      resetUserForm();
      renderModalUserList();
      if (loggedInUser.role === "admin") renderDashboard();
    } catch (error) {
      hideLoading();
      let pesanGagal = "Gagal memproses data.";
      if (error.code === "auth/email-already-in-use")
        pesanGagal = "ID ini sudah terdaftar di sistem keamanan.";
      else if (error.code === "auth/network-request-failed")
        pesanGagal =
          "Internet terputus. Pastikan koneksi stabil lalu coba lagi.";
      else if (error.code === "auth/weak-password")
        pesanGagal = "Password terlalu pendek. Gunakan minimal 6 karakter.";
      showToast(pesanGagal, "error");
    }
  };

  if (photoInput.files && photoInput.files[0]) {
    showLoading();
    uploadToImgbb(photoInput.files[0]).then((imgUrl) => {
      if (imgUrl) {
        saveToDB(imgUrl);
      } else {
        hideLoading();
        showToast("Gagal mengupload foto profil, coba lagi.", "error");
      }
    });
  } else {
    saveToDB(editingUserId ? undefined : null);
  }
}

// ==========================================
// BLOK FUNGSI UPDATE KREDENSIAL ADMIN
// ==========================================
function saveAdminCredentials() {
  const newUser = document
    .getElementById("edit-admin-user")
    .value.trim()
    .toLowerCase();
  const newPass = document.getElementById("edit-admin-pass").value.trim();
  const newName = document.getElementById("edit-admin-name").value.trim();
  const photoInput = document.getElementById("edit-admin-photo");
  const oldUser = loggedInUser.username;

  if (!newUser || !newPass)
    return showToast("Username dan Password tidak boleh kosong!", "error");
  if (newUser !== oldUser && USERS[newUser])
    return showToast("Username sudah dipakai user lain!", "error");

  let dummyEmail = newUser + DUMMY_DOMAIN;

  let saveToDB = async (photoBase64) => {
    showDialog(
      "Simpan Kredensial?",
      "Data Anda akan disinkronisasikan secara penuh ke sistem keamanan. Lanjutkan?",
      "confirm",
      async () => {
        showLoading();
        try {
          try {
            await auth.createUserWithEmailAndPassword(dummyEmail, newPass);
          } catch (e) {
            if (e.code === "auth/email-already-in-use") {
              await auth.signInWithEmailAndPassword(
                dummyEmail,
                USERS[oldUser].pass || newPass,
              );
              if (auth.currentUser)
                await auth.currentUser.updatePassword(newPass);
            } else {
              throw e;
            }
          }

          let adminData = USERS[oldUser] || { role: "admin" };
          adminData.pass = newPass;
          if (newName) adminData.name = newName;
          if (photoBase64 !== undefined) adminData.photo = photoBase64;

          if (newUser !== oldUser) {
            currentDB.forEach((d) => {
              if (d.kodeUser === oldUser) d.kodeUser = newUser;
            });
            saveState();
            USERS[newUser] = adminData;
            delete USERS[oldUser];
            loggedInUser.username = newUser;
            sessionStorage.setItem("ocm_session", JSON.stringify(loggedInUser));
            document.getElementById("display-username").innerText = newUser;
          } else {
            USERS[oldUser] = adminData;
          }

          saveUsers();
          hideLoading();
          closeMasterSettingsModal();
          showToast("Kredensial Admin berhasil diperbarui!", "success");
          initApp();
        } catch (error) {
          hideLoading();
          let pesanGagal = "Gagal memperbarui data Admin.";
          if (error.code === "auth/network-request-failed")
            pesanGagal =
              "Internet terputus. Pastikan koneksi stabil lalu coba lagi.";
          else if (error.code === "auth/weak-password")
            pesanGagal = "Password terlalu pendek. Gunakan minimal 6 karakter.";
          else if (error.code === "auth/requires-recent-login")
            pesanGagal =
              "Sesi terlalu lama. Silakan logout dan login kembali untuk mengubah keamanan akun.";
          showToast(pesanGagal, "error");
        }
      },
    );
  };

  if (photoInput.files && photoInput.files[0]) {
    showLoading();
    uploadToImgbb(photoInput.files[0]).then((imgUrl) => {
      if (imgUrl) saveToDB(imgUrl);
      else {
        hideLoading();
        showToast("Gagal mengupload foto profil, coba lagi.", "error");
      }
    });
  } else {
    saveToDB(undefined);
  }
}

function showLoginSuccessPopup(user) {
  let currentUserData = USERS[user.username] || {};
  let displayName = currentUserData.name || user.username.toUpperCase();
  let photoUrl =
    currentUserData.photo ||
    `https://ui-avatars.com/api/?name=${displayName}&background=0D8ABC&color=fff`;

  document.getElementById("popup-user-photo").src = photoUrl;
  document.getElementById("popup-greeting").innerText = `Halo, ${displayName}!`;
  document.getElementById("popup-id-display").innerText =
    `ID: ${user.username.toUpperCase()}`;

  const clockEl = document.getElementById("popup-realtime-clock");
  if (clockEl) {
    const updateClock = () => {
      const now = new Date();
      const options = {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      };
      clockEl.innerText = now
        .toLocaleString("id-ID", options)
        .replace(/\./g, ":");
    };
    updateClock();
    window.popupClockInterval = setInterval(updateClock, 1000);
  }

  const motivationQuotes = [
    "Target bukan sekadar angka, tapi pembuktian dedikasi kita! Semangat closing!",
    "Setiap penolakan adalah satu langkah lebih dekat menuju kata 'DEAL'.",
    "Kerja keras hari ini, panen komisi dan rezeki esok hari! Gasss!",
    "Jangan tunggu peluang datang, ciptakan peluangmu sendiri hari ini!",
    "Fokus, Konsisten, Closing! Mari cetak rekor baru hari ini!",
    "Target di depan mata. Ayo raih dan jadilah Top Achiever bulan ini!",
  ];
  document.getElementById("popup-motivation").innerText =
    motivationQuotes[Math.floor(Math.random() * motivationQuotes.length)];

  const popup = document.getElementById("login-success-popup");
  popup.classList.remove("hidden");
  popup.classList.add("flex");
  setTimeout(() => popup.classList.remove("opacity-0"), 50);
}

function closeLoginPopup() {
  if (window.popupClockInterval) clearInterval(window.popupClockInterval);
  const popup = document.getElementById("login-success-popup");
  popup.classList.add("opacity-0");
  setTimeout(() => {
    popup.classList.add("hidden");
    popup.classList.remove("flex");
  }, 300);
}

// ==========================================
// 4. LOGOUT & INIT
// ==========================================
async function logout() {
  // Ubah teks tombol jika memungkinkan sebagai indikator visual
  const btnLogout = document.getElementById("btn-logout");
  if (btnLogout) btnLogout.innerHTML = "Keluar...";

  // [FITUR KEAMANAN] Beri batas waktu maksimal 2.5 detik.
  // Jika proses sync nyangkut/loading terus, sistem akan memaksa logout.
  let forceReload = setTimeout(() => {
    bersihkanSesiDanReload();
  }, 2500);

  try {
    // Coba sinkronisasi sisa data ke server sebelum logout
    if (typeof checkAndSyncBatch === "function") {
      await checkAndSyncBatch(true);
    }
  } catch (error) {
    console.error("Gagal sinkronisasi data saat logout:", error);
  }

  // Jika sync berhasil sebelum 2.5 detik, batalkan paksaan reload
  clearTimeout(forceReload);

  // Eksekusi pembersihan sesi
  bersihkanSesiDanReload();
}

function bersihkanSesiDanReload() {
  // 1. Logout dari Firebase Auth
  if (typeof auth !== "undefined" && auth.currentUser) {
    auth.signOut().catch((e) => console.error("Firebase logout error:", e));
  }

  // 2. Hapus data sesi di penyimpanan browser
  localStorage.removeItem("userSession");
  sessionStorage.removeItem("ocm_session");

  // 3. Hapus data sesi dari database lokal (IndexedDB)
  if (localDB) {
    try {
      const tx = localDB.transaction("session_data", "readwrite");
      tx.objectStore("session_data").delete("current_session");
    } catch (e) {
      console.error("Gagal menghapus session di IDB:", e);
    }
  }

  // 4. Refresh halaman secara paksa dari server (mengabaikan cache)
  window.location.href =
    window.location.pathname + "?t=" + new Date().getTime();
}

// ==========================================
// 2. FUNGSI UPDATE STATUS LANGSUNG KE FIRESTORE (v7.31)
// ==========================================
function triggerOngoing(index) {
  let currentItem = currentDB[index];
  if (!currentItem) return;

  // Reset status data lain yang masih 'Proses' di Firestore (Mencegah double task)
  currentDB.forEach((item, idx) => {
    if (
      item.status === "Proses" &&
      idx !== index &&
      item.kodeUser === loggedInUser.username
    ) {
      firestore
        .collection("ocm_main_db")
        .doc(item.kontrak)
        .update({ status: "Belum" });
    }
  });

  // Update data yang baru diklik menjadi 'Proses'
  firestore
    .collection("ocm_main_db")
    .doc(currentItem.kontrak)
    .update({ status: "Proses" })
    .then(() => {
      trackFirestoreUsage("writes", 1);
    }); // Tambahkan ini

  currentOngoingIndex = index;
  localStorage.setItem("ocm_ongoing_idx", currentOngoingIndex);
  localStorage.setItem("ocm_last_interacted_idx", index);
}

function completeOngoing() {
  if (currentOngoingIndex !== null && currentDB[currentOngoingIndex]) {
    let currentItem = currentDB[currentOngoingIndex];

    firestore
      .collection("ocm_main_db")
      .doc(currentItem.kontrak)
      .update({ status: "Selesai", alasan: "" }) // Update ke status 'Selesai' dan hilangkan alasan
      .then(() => {
        trackFirestoreUsage("writes", 1);
        moveToNextContract();
      })
      .catch((err) => {
        showToast("Gagal mengupdate status: " + err.message, "error");
      });
  }
}

function submitFail() {
  let alasan = document.getElementById("fail-reason").value;
  if (!alasan) return showToast("Pilih alasan gagal!", "error");

  if (currentOngoingIndex !== null && currentDB[currentOngoingIndex]) {
    let currentItem = currentDB[currentOngoingIndex];

    firestore
      .collection("ocm_main_db")
      .doc(currentItem.kontrak)
      .update({
        status: "Gagal",
        alasan: alasan,
      })
      .then(() => {
        closeFailModal();
        moveToNextContract();
      });
  }
}

function clearData() {
  if (loggedInUser.role !== "admin") return;

  // 1. CEK BLOKIR KUOTA DELETE (SISA 3%)
  if (quotaFlags.blockDelete) {
    return showToast(
      "Penghapusan ditolak: Kuota Delete Firestore telah mencapai batas maksimal harian (<= 3%).",
      "error",
    );
  }

  const selectedUser = document.getElementById("clear-db-user-select").value;
  if (!selectedUser) return showToast("Pilih user.", "error");

  showDialog(
    "Hapus Data",
    `⚠️ PERINGATAN KRITIS\n\nYakin hapus data untuk: ${selectedUser.toUpperCase()} dari server Firestore?`,
    "confirm",
    () => {
      showLoading(); // Tampilkan loading karena menghapus banyak dokumen butuh waktu

      // 2. AMBIL DOKUMEN YANG AKAN DIHAPUS LANGSUNG DARI FIRESTORE
      // PENTING: sebelumnya ini memakai `currentDB` (data yang sedang ada di
      // memori browser). Sekarang bahwa ocm_main_db dipaginasi (lihat
      // dbQuery/.limit di atas), currentDB TIDAK LAGI berisi seluruh data
      // saat jumlah dokumen besar — kalau tetap dipakai di sini, "Hapus Semua"
      // hanya akan menghapus dokumen yang sedang termuat di halaman saat itu,
      // sisanya diam-diam tertinggal di server. Jadi query ulang ke Firestore
      // agar dapat SEMUA doc id yang cocok, terlepas dari pagination di UI.
      let deleteQuery = firestore.collection("ocm_main_db");
      if (selectedUser !== "all") {
        deleteQuery = deleteQuery.where("kodeUser", "==", selectedUser);
      }

      deleteQuery
        .get()
        .then((snapshot) => {
          if (snapshot.empty) {
            hideLoading();
            showToast(
              "Tidak ada data untuk dihapus pada user tersebut.",
              "info",
            );
            return Promise.reject({ _handled: true });
          }

          let deleteCount = 0;
          let batchArray = [];
          let currentBatch = firestore.batch();
          let operationCounter = 0;

          // 3. SUSUN BATCH DELETE UNTUK ocm_main_db
          snapshot.docs.forEach((doc) => {
            currentBatch.delete(doc.ref);

            operationCounter++;
            deleteCount++;

            // Pecah batch setiap 490 operasi sesuai aturan maksimal Firestore
            if (operationCounter === 490) {
              batchArray.push(currentBatch.commit());
              currentBatch = firestore.batch();
              operationCounter = 0;
            }
          });

          if (operationCounter > 0) {
            batchArray.push(currentBatch.commit());
          }

          // 4. EKSEKUSI PENGHAPUSAN DI SERVER FIRESTORE
          return Promise.all(batchArray).then(() => deleteCount);
        })
        .then((deleteCount) => {
          // [FITUR BARU] Catat pemakaian kuota Delete ke Realtime Database
          trackFirestoreUsage("deletes", deleteCount);

          // 5. BERSIHKAN DATA DI PENYIMPANAN LOKAL (UI/Browser)
          if (selectedUser === "all") {
            currentDB = [];
            dailyValidation = {};
          } else {
            currentDB = currentDB.filter((d) => d.kodeUser !== selectedUser);
            delete dailyValidation[selectedUser];
          }

          currentOngoingIndex = null;
          saveState();
          saveValidation();
          hideLoading();

          showToast(
            `Berhasil menghapus ${deleteCount} dokumen dari Firestore!`,
            "success",
          );
        })
        .catch((err) => {
          if (err && err._handled) return; // sudah ditangani (data kosong)
          hideLoading();
          showDialog(
            "Error",
            "Gagal menghapus data dari Firestore: " + (err.message || err),
            "alert",
          );
        });
    },
  );
}

// --- CHECKER AUTO APPROVE ---
function checkAutoApproveUser() {
  if (!loggedInUser) return;
  let nowHours = new Date().getHours();
  let isAutoApproveTime = nowHours >= 19 || nowHours < 7;

  if (isAutoApproveTime && dailyValidation[loggedInUser.username]) {
    let updated = false;

    for (let day in dailyValidation[loggedInUser.username]) {
      let val = dailyValidation[loggedInUser.username][day];
      if (val.status === "pending") {
        if (val.link && val.link.trim() !== "") {
          val.status = "approved";
          val.autoApproved = true;
          val.approvedAt = Date.now();
          updated = true;
        }
      }
    }

    if (updated) {
      saveValidation();
      showToast(
        "Tugas disetujui otomatis (Berada di luar jam kerja admin).",
        "success",
      );
      if (typeof renderTabs === "function") renderTabs();
      if (typeof renderValidationPanel === "function") renderValidationPanel();
    }
  }
}

// --- INIT APP & NAVIGATION ---
function initApp() {
  if (window.isAppInitialized) return;

  // [PERBAIKAN BUG]: Jaring pengaman cegah layar blank
  if (!loggedInUser || !loggedInUser.username) {
    console.error("Gagal memuat UI: Identitas user hilang.");
    logout(); // Arahkan kembali ke sistem pembersihan secara aman
    return;
  }

  window.isAppInitialized = true;

  let currentUserData = USERS[loggedInUser.username] || {};
  let displayName = currentUserData.name || loggedInUser.username.toUpperCase();
  // ... (kode sisanya tetap sama)

  const btnDistributor = document.getElementById("btn-distributor");
  if (btnDistributor) {
    if (loggedInUser && loggedInUser.role === "admin")
      btnDistributor.classList.remove("hidden");
    else btnDistributor.classList.add("hidden");
  }

  document.getElementById("display-username").innerText = loggedInUser.username;
  document.getElementById("header-user-name").innerText = displayName;

  const headerPhoto = document.getElementById("header-user-photo");
  if (headerPhoto) {
    const fallbackLogo = document.getElementById("login-logo-img")?.src || "";
    headerPhoto.src = currentUserData.photo || fallbackLogo;
  }

  document.getElementById("main-app").classList.remove("hidden");

  if (loggedInUser.role === "admin") {
    document.getElementById("admin-controls").classList.remove("hidden");
    document.getElementById("admin-controls").classList.add("flex");
    document.getElementById("btn-admin-bugs").classList.remove("hidden");
    document.getElementById("workspace-view").classList.add("hidden");
    document.getElementById("dashboard-view").classList.remove("hidden");
    const notifBanner = document.getElementById("user-notif-banner");
    if (notifBanner) notifBanner.classList.add("hidden");
    renderDashboard();
    updateBugNotification(); // DI SINI ERROR SEBELUMNYA KARENA FUNGSINYA HILANG
  } else {
    // Mode User
    // (Listener notifikasi admin dikelola terpusat oleh
    // inisialisasiListenerNotifikasiAdmin() — lihat bawah file, jadi tidak
    // perlu listener terpisah di sini lagi)
    document.getElementById("btn-lapor-bug").classList.remove("hidden");
    document.getElementById("workspace-view").classList.remove("hidden");
    document.getElementById("dashboard-view").classList.add("hidden");

    const btnCanvassingHeader = document.getElementById(
      "btn-canvassing-header",
    );
    const floatingCanvassing = document.getElementById("floating-canvassing");
    if (btnCanvassingHeader) btnCanvassingHeader.classList.remove("hidden");
    if (floatingCanvassing) floatingCanvassing.classList.remove("hidden");

    database
      .ref(`ocm_canvassing/${loggedInUser.username}/status`)
      .on("value", (snapshot) => {
        const status = snapshot.val();
        const btnStopCanvassing = document.getElementById(
          "btn-stop-canvassing-sidebar",
        );
        if (btnStopCanvassing) {
          if (status === "active") btnStopCanvassing.classList.remove("hidden");
          else btnStopCanvassing.classList.add("hidden");
        }
      });

    renderTabs();
    if (typeof activeDay !== "number") activeDay = 1;
    setDay(activeDay);

    if (window.autoApproveInterval) clearInterval(window.autoApproveInterval);
    window.autoApproveInterval = setInterval(() => {
      checkAutoApproveUser();
    }, 60000);
  }
}

// FUNGSI KHUSUS ADMIN UNTUK MENGIRIM NOTIFIKASI
function kirimNotifikasiAdmin() {
  const modal = document.getElementById("modern-notif-modal");
  document.getElementById("input-notif-msg").value = "";
  modal.classList.remove("hidden");
  modal.classList.add("flex");
  setTimeout(() => {
    modal.classList.remove("opacity-0");
    modal.querySelector(".bg-white").classList.remove("scale-90");
  }, 10);
}

function closeNotifModal() {
  const modal = document.getElementById("modern-notif-modal");
  modal.classList.add("opacity-0");
  modal.querySelector(".bg-white").classList.add("scale-90");
  setTimeout(() => {
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  }, 300);
}

function prosesKirimNotifikasi() {
  const msg = document.getElementById("input-notif-msg").value.trim();
  const isRealtime = document.getElementById("check-realtime").checked;
  const isMarquee = document.getElementById("check-marquee").checked;

  if (!msg) {
    if (typeof showToast === "function")
      showToast("Pesan tidak boleh kosong!", "error");
    return;
  }

  const payload = {
    pesan: msg,
    realtime: isRealtime,
    marquee: isMarquee,
    timestamp: Date.now(),
    sender: loggedInUser ? loggedInUser.username : "Admin",
  };

  database
    .ref("ocm_global_notif")
    .set(payload)
    .then(() => {
      if (typeof showToast === "function")
        showToast("Notifikasi berhasil dikirim!", "success");
      closeNotifModal();
    })
    .catch((err) => {
      if (typeof showToast === "function")
        showToast("Gagal mengirim notifikasi.", "error");
    });
}


// ==========================================
function inisialisasiListenerNotifikasiAdmin() {
  database.ref("ocm_global_notif").on(
    "value",
    (snapshot) => {
      const notif = snapshot.val();
      const bar = document.getElementById("admin-notif-marquee-bar");
      const textEl = document.getElementById("admin-notif-marquee-text");

      // Admin tidak perlu melihat notifikasinya sendiri berjalan di layarnya
      if (loggedInUser && loggedInUser.role === "admin") {
        if (bar) bar.classList.add("hidden");
        return;
      }

      if (!notif || !notif.pesan) {
        if (bar) bar.classList.add("hidden");
        return;
      }

      const sekarang = Date.now();
      const duaHariDalamMs = 2 * 24 * 60 * 60 * 1000;
      const masihBerlaku = sekarang - notif.timestamp <= duaHariDalamMs;

      if (!masihBerlaku) {
        if (bar) bar.classList.add("hidden");
        return;
      }

      if (bar && textEl) {
        textEl.innerText = notif.pesan;
        bar.classList.remove("hidden");
        // Nyalakan animasi berjalan (marquee) hanya jika admin mencentang
        // "Jadikan Teks Berjalan"; jika tidak, tampilkan sebagai teks diam.
        if (notif.marquee === false) {
          textEl.classList.remove("marquee-track");
          textEl.style.paddingLeft = "0";
        } else {
          textEl.classList.add("marquee-track");
          textEl.style.paddingLeft = "";
        }
      }

      // Pop-up realtime: dedup berbasis timestamp notifikasi (bukan jendela
      // waktu 10 detik yang lama & rapuh terhadap selisih jam/latensi), jadi
      // pop-up tetap muncul kapan pun user membuka/menerima notifikasi baru,
      // dan hanya tampil SEKALI per notifikasi per perangkat.
      if (notif.realtime) {
        const sudahDilihatKey = "notif_seen_" + notif.timestamp;
        if (!sessionStorage.getItem(sudahDilihatKey)) {
          sessionStorage.setItem(sudahDilihatKey, "true");
          if (window.AndroidApp && window.AndroidApp.showNotification) {
            window.AndroidApp.showNotification("Pengumuman SFDM", notif.pesan);
          }
          if (typeof showToast === "function") {
            showToast("🔔 Pengumuman Admin: " + notif.pesan, "info");
          }
        }
      }
    },
    (error) => {
      // Sebelumnya tidak ada error handler sama sekali di listener ini,
      // jadi kalau terjadi permission-denied di rules RTDB, kegagalan
      // terjadi tanpa jejak sama sekali. Sekarang minimal tercatat di
      // console untuk memudahkan diagnosa ke depannya.
      console.error("Gagal memuat notifikasi admin (ocm_global_notif):", error);
    },
  );
}


function resetUserForm() {
  editingUserId = null;

  // Tangkap elemen dengan aman
  const formTitle = document.getElementById("user-form-title");
  const formId = document.getElementById("user-form-id");
  const formName = document.getElementById("user-form-name");
  const formPass = document.getElementById("user-form-pass");
  const formPhoto = document.getElementById("user-form-photo");

  if (formTitle) formTitle.innerText = "Tambah User Baru";

  if (formId) {
    formId.value = "";
    formId.disabled = false;
    formId.classList.remove("bg-slate-200");
  }

  if (formName) formName.value = "";
  if (formPass) formPass.value = "";
  if (formPhoto) formPhoto.value = "";
}

function editUser(id) {
  let user = USERS[id];
  if (!user) return;
  editingUserId = id;
  document.getElementById("user-form-title").innerText =
    `Edit User: ${id.toUpperCase()}`;
  document.getElementById("user-form-id").value = id;
  document.getElementById("user-form-id").disabled = true;
  document.getElementById("user-form-id").classList.add("bg-slate-200");
  document.getElementById("user-form-name").value = user.name || "";
  document.getElementById("user-form-pass").value = user.pass || "";
  document.getElementById("user-form-photo").value = "";
}

function renderModalUserList() {
  const list = document.getElementById("modal-user-list");
  if (!list) return;
  list.innerHTML = "";
  for (let u in USERS) {
    if (USERS[u].role === "admin") continue;
    let user = USERS[u];
    let displayName = user.name || u.toUpperCase();
    let photoSrc =
      user.photo ||
      `https://ui-avatars.com/api/?name=${displayName}&background=0D8ABC&color=fff`;

    list.innerHTML += `
        <li class="flex justify-between items-center bg-white p-3 rounded-xl border border-slate-200 shadow-sm transition-all hover:border-blue-300">
            <div class="flex items-center gap-3">
                <img src="${photoSrc}" class="w-10 h-10 rounded-full border border-slate-200 object-cover shadow-sm">
                <div>
                    <span class="text-sm font-bold text-slate-800">${displayName}</span>
                    <span class="text-[11px] font-medium text-slate-500 block">ID Login: <span class="font-bold text-blue-600 uppercase">${u}</span> | Pass: <span class="font-mono text-slate-700">${user.pass}</span></span>
                </div>
            </div>
            <div class="flex flex-col md:flex-row gap-2">
                <button onclick="editUser('${u}')" class="text-xs bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold px-3 py-1.5 rounded-lg transition-colors cursor-pointer">Edit</button>
                <button onclick="removeUser('${u}')" class="text-xs bg-rose-50 hover:bg-rose-500 hover:text-white text-rose-600 font-bold px-3 py-1.5 rounded-lg transition-colors cursor-pointer border border-rose-200 hover:border-transparent">Hapus</button>
            </div>
        </li>`;
  }
  updateUserSelector();
  renderUserGDriveSettings();
}

function removeUser(id) {
  showDialog(
    "Konfirmasi Hapus",
    `Yakin menghapus User [${id.toUpperCase()}]?`,
    "confirm",
    () => {
      database
        .ref("ocm_users/" + id)
        .remove()
        .then(() => {
          delete USERS[id];
          saveUsers();
          renderModalUserList();
          if (loggedInUser.role === "admin") renderDashboard();
          showToast(`User ${id.toUpperCase()} dihapus`, "success");
        })
        .catch((error) => {
          showToast("Gagal menghapus user dari database server.", "error");
          console.error(error);
        });
    },
  );
}

function updateUserSelector() {
  const sel = document.getElementById("admin-user-selector");
  const clearSel = document.getElementById("clear-db-user-select");
  if (sel) {
    sel.innerHTML = "";
    for (let u in USERS) {
      if (USERS[u].role !== "admin") {
        let displayName = USERS[u].name || u.toUpperCase();
        sel.innerHTML += `<option value="${u}">Kirim Bahan OCM ke: ${displayName} (ID: ${u.toUpperCase()})</option>`;
      }
    }
  }
  if (clearSel) {
    clearSel.innerHTML = '<option value="all">⚠️ Hapus SEMUA Data</option>';
    let activeDbUsers = new Set();
    currentDB.forEach((d) => {
      if (d.kodeUser && d.kodeUser !== "admin") activeDbUsers.add(d.kodeUser);
    });
    for (let u in USERS) {
      if (USERS[u].role !== "admin") activeDbUsers.add(u);
    }
    activeDbUsers.forEach((u) => {
      let displayName =
        USERS[u] && USERS[u].name ? USERS[u].name : u.toUpperCase();
      let label = USERS[u]
        ? `Hanya Hapus Data: ${displayName} (${u.toUpperCase()})`
        : `Hapus Data Tanpa Owner: ${u.toUpperCase()}`;
      clearSel.innerHTML += `<option value="${u}">${label}</option>`;
    });
  }
}

// --- DASHBOARD ADMIN ---
function renderDashboard() {
  let total = currentDB.length;
  let selesai = 0,
    belum = 0,
    gagal = 0;
  let userStats = {};
  for (let u in USERS) {
    if (USERS[u].role !== "admin")
      userStats[u] = { total: 0, selesai: 0, belum: 0, gagal: 0, proses: 0 };
  }

  currentDB.forEach((item) => {
    let usr = item.kodeUser || "unknown";
    if (!userStats[usr])
      userStats[usr] = { total: 0, selesai: 0, belum: 0, gagal: 0, proses: 0 };
    userStats[usr].total++;
    if (item.status === "Selesai") {
      selesai++;
      userStats[usr].selesai++;
    } else if (item.status === "Gagal") {
      gagal++;
      userStats[usr].gagal++;
    } else if (item.status === "Proses") {
      belum++;
      userStats[usr].proses++;
    } else {
      belum++;
      userStats[usr].belum++;
    }
  });

  if (document.getElementById("dash-tot-all"))
    document.getElementById("dash-tot-all").innerText = total;
  if (document.getElementById("dash-tot-selesai"))
    document.getElementById("dash-tot-selesai").innerText = selesai;
  if (document.getElementById("dash-tot-gagal"))
    document.getElementById("dash-tot-gagal").innerText = gagal;
  if (document.getElementById("dash-tot-belum"))
    document.getElementById("dash-tot-belum").innerText = belum;

  const tbody = document.getElementById("dashboard-table-body");
  if (tbody) tbody.innerHTML = "";
  let labels = [],
    dataSelesai = [],
    dataGagal = [];

  for (let usr in userStats) {
    if (userStats[usr].total === 0 && !USERS[usr]) continue;
    let s = userStats[usr];
    let sisa = s.belum + s.proses;
    let rate = s.total > 0 ? Math.round((s.selesai / s.total) * 100) : 0;
    let isDeleted = !USERS[usr];
    let displayName =
      USERS[usr] && USERS[usr].name ? USERS[usr].name : usr.toUpperCase();
    let nameTag =
      displayName +
      ` <span class="text-[10px] text-slate-400 font-normal ml-1">(ID: ${usr.toUpperCase()})</span>` +
      (isDeleted
        ? ' <span class="text-[9px] text-rose-500 bg-rose-50 px-1 rounded ml-1 font-bold">DELETED</span>'
        : "");

    labels.push(displayName);
    dataSelesai.push(s.selesai);
    dataGagal.push(s.gagal);
    if (tbody)
      tbody.innerHTML += `<tr class="hover:bg-slate-50/50 transition-colors"><td class="py-3 px-6 font-bold text-slate-700">${nameTag}</td><td class="py-3 px-6 text-center font-mono">${s.total}</td><td class="py-3 px-6 text-center font-bold text-emerald-600">${s.selesai}</td><td class="py-3 px-6 text-center font-bold text-rose-500">${s.gagal}</td><td class="py-3 px-6 text-center font-mono text-slate-500">${sisa}</td><td class="py-3 px-6 text-right"><span class="px-2 py-1 bg-blue-50 text-blue-700 rounded-md font-bold text-xs">${rate}%</span></td></tr>`;
  }

  const canvasEl = document.getElementById("performanceChart");
  if (canvasEl) {
    const ctx = canvasEl.getContext("2d");
    if (chartInstance) chartInstance.destroy();
    chartInstance = new Chart(ctx, {
      type: "bar",
      data: {
        labels: labels,
        datasets: [
          {
            label: "Selesai (✅)",
            data: dataSelesai,
            backgroundColor: "#10b981",
            borderRadius: 4,
          },
          {
            label: "Gagal Kirim (❌)",
            data: dataGagal,
            backgroundColor: "#f43f5e",
            borderRadius: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { min: 1, ticks: { stepSize: 1 }, grid: { color: "#f1f5f9" } },
          x: { grid: { display: false } },
        },
        plugins: {
          legend: {
            position: "top",
            labels: { usePointStyle: true, boxWidth: 8 },
          },
        },
      },
    });
  }
  renderAdminValidation();
  renderAdminValidation();
  renderQuotaCharts();
}

function renderAdminValidation() {
  const tbody = document.getElementById("admin-validation-list");
  if (!tbody) return;
  tbody.innerHTML = "";
  let hasData = false;
  for (let user in dailyValidation) {
    for (let day in dailyValidation[user]) {
      hasData = true;
      let val = dailyValidation[user][day];
      let displayName =
        USERS[user] && USERS[user].name ? USERS[user].name : user.toUpperCase();
      let badge =
        val.status === "pending"
          ? '<span class="bg-amber-100 text-amber-700 px-2 py-1 rounded text-[10px] font-bold uppercase">Pending</span>'
          : '<span class="bg-emerald-100 text-emerald-700 px-2 py-1 rounded text-[10px] font-bold uppercase">Approved</span>';
      let actionBtn = "";
      if (val.status === "pending") {
        actionBtn = `<div class="flex gap-2 justify-center">
            <button onclick="approveValidation('${user}', ${day})" class="bg-emerald-500 hover:bg-emerald-600 text-white px-2 py-1.5 rounded-lg text-[10px] font-bold transition cursor-pointer shadow-sm" title="Setujui Saja">✓ Setujui</button>
            <button onclick="approveAndBypass('${user}', ${day})" class="bg-blue-500 hover:bg-blue-600 text-white px-2 py-1.5 rounded-lg text-[10px] font-bold transition cursor-pointer shadow-sm" title="Setujui & Buka Waktu Tunggu">✓ Setujui & Bypass</button>
            <button onclick="rejectValidation('${user}', ${day})" class="bg-rose-50 text-rose-600 border border-rose-200 hover:bg-rose-500 hover:text-white px-2 py-1.5 rounded-lg text-[10px] font-bold transition cursor-pointer">✕ Tolak</button>
        </div>`;
      } else {
        actionBtn = !val.isBypassed
          ? `<div class="flex gap-2 justify-center items-center"><span class="text-xs font-bold text-slate-400">Selesai</span><button onclick="bypassValidationTime('${user}', ${day})" class="bg-indigo-500 hover:bg-indigo-600 text-white px-2 py-1 rounded-lg text-[10px] font-bold transition cursor-pointer shadow-sm">Buka Akses</button></div>`
          : `<span class="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-1 rounded">Selesai & Waktu Terbuka</span>`;
      }
      tbody.innerHTML += `<tr class="hover:bg-indigo-50/30 transition-colors"><td class="py-3 px-6 font-bold text-slate-700 uppercase">${displayName} <span class="text-[10px] text-slate-400 normal-case">(ID: ${user})</span></td><td class="py-3 px-6 font-bold text-indigo-600">Hari ${day}</td><td class="py-3 px-6"><a href="${val.link}" target="_blank" class="text-blue-600 hover:underline hover:text-blue-800 text-xs font-mono break-all line-clamp-1 max-w-[250px]" title="${val.link}">👁️ Lihat Folder Upload</a></td><td class="py-3 px-6">${badge}</td><td class="py-3 px-6 text-center">${actionBtn}</td></tr>`;
    }
  }
  if (!hasData)
    tbody.innerHTML =
      '<tr><td colspan="5" class="py-6 text-center text-sm font-medium text-slate-400">Belum ada bukti tugas yang disubmit user.</td></tr>';
}

function approveValidation(user, day) {
  dailyValidation[user][day].status = "approved";
  dailyValidation[user][day].approvedAt = Date.now();
  saveValidation();
  showToast(`Tugas disetujui.`, "success");
}

function rejectValidation(user, day) {
  showDialog(
    "Tolak Validasi",
    `Tolak bukti tugas dari ${user.toUpperCase()}?`,
    "confirm",
    () => {
      delete dailyValidation[user][day];
      saveValidation();
      showToast("Ditolak.", "success");
    },
  );
}

function approveAndBypass(user, day) {
  dailyValidation[user][day].status = "approved";
  dailyValidation[user][day].approvedAt = Date.now();
  dailyValidation[user][day].isBypassed = true;
  saveValidation();
  showToast("Tugas disetujui & Akses Hari Berikutnya Terbuka.", "success");
}

function bypassValidationTime(user, day) {
  dailyValidation[user][day].isBypassed = true;
  saveValidation();
  showToast("Akses hari berikutnya berhasil dibuka secara paksa.", "success");
}

// --- WORKSPACE LOGIC (USER ONLY) ---
function renderTabs() {
  if (loggedInUser.role === "admin") return;
  const tabsContainer = document.getElementById("day-tabs");
  if (!tabsContainer) return;
  tabsContainer.innerHTML = "";
  let accessibleData = currentDB.filter(
    (d) => d.kodeUser === loggedInUser.username,
  );
  if (accessibleData.length === 0) return;

  let dailyData = accessibleData.filter(
    (d) => !d.taskType || d.taskType === "daily",
  );
  let emgData = accessibleData.filter((d) => d.taskType === "emergency");

  if (dailyData.length > 0) {
    const totalDays = Math.ceil(dailyData.length / ITEMS_PER_DAY) || 1;
    for (let i = 1; i <= totalDays; i++) {
      let isLocked = false,
        lockReason = "";
      if (i > 1) {
        let prevVal =
          dailyValidation[loggedInUser.username] &&
          dailyValidation[loggedInUser.username][i - 1]
            ? dailyValidation[loggedInUser.username][i - 1]
            : null;
        if (!prevVal || prevVal.status !== "approved") {
          isLocked = true;
          lockReason =
            "Peringatan: Tugas hari sebelumnya belum disetujui Admin.\nHarap tunggu persetujuan sebelum Anda dapat melanjutkan ke hari ini.";
        } else {
          let approvedTime = prevVal.approvedAt || Date.now();
          let targetDate = new Date(approvedTime);
          targetDate.setDate(targetDate.getDate() + 1);

          if (!WORK_ON_SUNDAY && targetDate.getDay() === 0)
            targetDate.setDate(targetDate.getDate() + 1);
          targetDate.setHours(7, 0, 0, 0);

          if (Date.now() < targetDate.getTime() && !prevVal.isBypassed) {
            isLocked = true;
            let liburTag =
              !WORK_ON_SUNDAY &&
              new Date(approvedTime + 86400000).getDay() === 0
                ? "\n(Sistem Libur Hari Minggu)"
                : "";
            lockReason = `Belum waktunya. Akses akan terbuka pada:\n${targetDate.toLocaleDateString("id-ID")} Pukul 07:00 Pagi.${liburTag}`;
          }
        }
      }

      const activeClass =
        i === activeDay
          ? "bg-blue-600 text-white shadow-md shadow-blue-500/30 transform scale-105 ring-2 ring-blue-600 ring-offset-2"
          : "bg-white border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-blue-600";
      const lockIcon = isLocked
        ? `<svg class="w-3.5 h-3.5 inline mb-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path></svg>`
        : "";
      const cursorClass = isLocked
        ? "cursor-not-allowed opacity-60"
        : "cursor-pointer";
      tabsContainer.innerHTML += `<button onclick="setDay(${i}, ${isLocked}, '${lockReason.replace(/\n/g, "\\n")}')" class="px-5 py-2 rounded-full font-bold text-xs shrink-0 transition-all duration-300 ${activeClass} ${cursorClass}">📅 Hari ${i} ${lockIcon}</button>`;
    }
  }

  if (Array.isArray(emgData) && emgData.length > 0) {
    let batches = [...new Set(emgData.map((d) => d.batchId))];
    batches.forEach((batch, idx) => {
      let emgId = `emg-${batch}`;
      let num = idx + 1;
      const isEmgActive = activeDay === emgId;
      const activeClass = isEmgActive
        ? "bg-rose-600 text-white shadow-md shadow-rose-500/30 transform scale-105 ring-2 ring-rose-600 ring-offset-2"
        : "bg-white border border-rose-200 text-rose-600 hover:bg-rose-50";
      tabsContainer.innerHTML += `<button onclick="setDay('${emgId}', false, '')" class="px-5 py-2 rounded-full font-bold text-xs shrink-0 transition-all duration-300 ${activeClass} cursor-pointer">🚨 Emergency ${num}</button>`;
    });
  }
}

function setDay(d, isLocked = false, reason = "") {
  if (isLocked) return showDialog("Akses Terkunci", reason, "alert");
  activeDay = d;
  renderTabs();
  renderTable();
}

function scrollToLastClicked() {
  let lastIdx =
    localStorage.getItem("ocm_last_interacted_idx") || currentOngoingIndex;
  if (lastIdx !== null && lastIdx !== undefined) {
    let activeRow = document.getElementById(`row-${lastIdx}`);
    if (activeRow) {
      activeRow.classList.add(
        "bg-indigo-50",
        "border-l-4",
        "border-indigo-500",
      );
      setTimeout(() => {
        activeRow.classList.remove(
          "bg-indigo-50",
          "border-l-4",
          "border-indigo-500",
        );
      }, 3000);
    }
  }
}

function renderTable() {
  if (loggedInUser.role === "admin") return;
  const rowsContainer = document.getElementById("table-rows");
  const searchVal =
    document.getElementById("search-box")?.value.toLowerCase() || "";
  const noDataMsg = document.getElementById("no-data-msg");
  if (!rowsContainer) return;
  rowsContainer.innerHTML = "";

  let userSpecificData = currentDB
    .map((item, index) => ({ item, originalIndex: index }))
    .filter((d) => d.item.kodeUser === loggedInUser.username);

  if (searchVal)
    userSpecificData = userSpecificData.filter(
      (d) =>
        d.item.nama.toLowerCase().includes(searchVal) ||
        d.item.kontrak.includes(searchVal) ||
        (d.item.hp && d.item.hp.toLowerCase().includes(searchVal)),
    );

  let displayData = [];
  let isEmergency =
    typeof activeDay === "string" && activeDay.startsWith("emg-");

  if (isEmergency) {
    let batchId = activeDay.split("emg-")[1];
    displayData = userSpecificData.filter((d) => d.item.batchId === batchId);
  } else {
    let dailySpecificData = userSpecificData.filter(
      (d) => !d.item.taskType || d.item.taskType === "daily",
    );
    if (searchVal) {
      displayData = dailySpecificData;
    } else {
      const startIndex = (activeDay - 1) * ITEMS_PER_DAY;
      displayData = dailySpecificData.slice(
        startIndex,
        startIndex + ITEMS_PER_DAY,
      );
    }
  }

  if (displayData.length === 0 && userSpecificData.length === 0) {
    if (noDataMsg) noDataMsg.classList.remove("hidden");
    syncOngoingPanel();
    checkDayCompletion([], false);
    return;
  }
  if (displayData.length === 0 && searchVal) {
    rowsContainer.innerHTML =
      '<tr><td colspan="6" class="text-center py-8 text-slate-400 bg-slate-50/50">Pencarian tidak ditemukan di tab ini.</td></tr>';
    return;
  }

  if (noDataMsg) noDataMsg.classList.add("hidden");
  let htmlContent = "";

  displayData.forEach((dataWrapper, idx) => {
    const data = dataWrapper.item;
    const origIdx = dataWrapper.originalIndex;

    let badgeStyle =
      data.status === "Proses"
        ? "bg-amber-100 text-amber-700 ring-1 ring-amber-200"
        : data.status === "Selesai"
          ? "bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200"
          : data.status === "Gagal"
            ? "bg-rose-100 text-rose-700 ring-1 ring-rose-200"
            : "bg-slate-100 text-slate-500 ring-1 ring-slate-200";
    let ket = data.alasan
      ? `<span class="text-[10px] text-rose-500 bg-rose-50 px-2 py-1 rounded-md inline-block font-medium truncate max-w-[150px]">${data.alasan}</span>`
      : "-";
    let displayNumber = isEmergency
      ? idx + 1
      : (activeDay - 1) * ITEMS_PER_DAY + idx + 1;
    let isOngoingRow =
      origIdx === currentOngoingIndex && data.status === "Proses";

    let rowClass = isOngoingRow
      ? "table-row-active shadow-sm"
      : data.status === "Proses"
        ? "bg-amber-50/30"
        : isEmergency
          ? "emergency-row hover:bg-slate-50"
          : "hover:bg-blue-50/40 hover:shadow-[0_2px_10px_-3px_rgba(6,81,237,0.1)] transition-all duration-200 group";
    let isOngoing = origIdx === currentOngoingIndex;
    let visualNumber = `
      <div class="relative overflow-hidden border px-3 py-1.5 rounded-lg inline-flex items-center justify-center font-bold min-w-[32px] group transition-all duration-300 ${isOngoing ? "bg-indigo-600 text-white border-indigo-600 shadow-md" : "bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200"}">
          <span class="absolute inset-0 w-full h-full bg-gradient-to-r from-transparent via-white/40 to-transparent -translate-x-full group-hover:animate-[shimmer_1.5s_infinite]"></span>
          <span class="relative z-10 text-xs">${displayNumber}</span>
      </div>`;

    htmlContent += `<tr id="row-${origIdx}" class="border-b border-slate-100 ${rowClass}">
            <td class="py-4 px-6 text-center">${visualNumber}</td>
            <td class="py-4 px-6 font-mono font-bold"><button onclick="triggerOngoing(${origIdx})" class="text-blue-600 bg-blue-50 px-2 py-1 rounded-lg hover:bg-blue-600 hover:text-white transition-all cursor-pointer shadow-sm" id="k-${origIdx}">${data.kontrak}</button></td>
            <td class="py-4 px-6 font-semibold text-slate-800">${data.nama} ${isEmergency ? '<span class="bg-rose-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-md ml-1 shadow-sm">🚨 DARURAT</span>' : ""}</td>
            <td class="py-4 px-6">
                <div class="flex flex-col gap-1">
                    <span class="text-[9px] bg-slate-100 text-slate-600 font-bold px-2 py-0.5 rounded-full w-max">${data.type}</span>
                    <span class="text-[12px] font-mono font-bold text-rose-600">${new Intl.NumberFormat("id-ID").format(data.sisa)}</span>
                </div>
            </td>
            <td class="py-4 px-6 text-center"><span class="text-[10px] px-3 py-1.5 rounded-full font-bold uppercase shadow-sm ${badgeStyle}">${data.status}</span></td>
            <td class="py-4 px-6">${ket}</td></tr>`;
  });

  rowsContainer.innerHTML = htmlContent;
  syncOngoingPanel();
  checkDayCompletion(displayData, isEmergency);
}

function checkDayCompletion(displayData, isEmergency) {
  const valPanel = document.getElementById("validation-panel");
  if (!valPanel) return;
  if (window.countdownInterval) clearInterval(window.countdownInterval);
  if (isEmergency || !displayData || displayData.length === 0) {
    valPanel.classList.add("hidden");
    return;
  }

  if (
    displayData.every(
      (d) => d.item.status === "Selesai" || d.item.status === "Gagal",
    )
  ) {
    valPanel.classList.remove("hidden");
    renderValidationPanel();
  } else {
    valPanel.classList.add("hidden");
  }
}

function renderValidationPanel() {
  const valPanel = document.getElementById("validation-panel");
  if (!valPanel) return;
  let currentDayVal = (dailyValidation[loggedInUser.username] || {})[activeDay];
  if (window.countdownInterval) clearInterval(window.countdownInterval);

  if (!currentDayVal) {
    valPanel.innerHTML = `
        <div class="flex flex-col md:flex-row gap-6 items-center">
            <div class="flex-1">
                <h3 class="text-lg font-bold text-indigo-900 mb-1">🎉 Tugas Hari ${activeDay} Selesai!</h3>
                <p class="text-xs text-indigo-700">Upload bukti kerja langsung ke folder Google Drive Anda secara manual.</p>
            </div>
            <div class="w-full md:w-[350px]">
                <button onclick="redirectToGDrive()" class="w-full bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 text-white font-bold py-3.5 rounded-xl text-sm shadow-md cursor-pointer transition-colors flex items-center justify-center gap-2">
                    📁 Buka Google Drive & Submit
                </button>
            </div>
        </div>`;
  } else if (currentDayVal.status === "pending") {
    valPanel.innerHTML = `<div class="flex items-center gap-4 bg-white p-4 rounded-2xl border"><div class="spinner border-indigo-500 w-8 h-8"></div><div><h3 class="text-sm font-bold text-indigo-900">Menunggu Verifikasi</h3><p class="text-xs">Sistem mencatat Anda telah ke Google Drive. Menunggu persetujuan Admin.</p></div></div>`;
  } else {
    let approvedTime = currentDayVal.approvedAt || Date.now();
    let nextDayTarget = new Date(approvedTime);
    nextDayTarget.setDate(nextDayTarget.getDate() + 1);

    if (!WORK_ON_SUNDAY && nextDayTarget.getDay() === 0)
      nextDayTarget.setDate(nextDayTarget.getDate() + 1);
    nextDayTarget.setHours(7, 0, 0, 0);

    let now = Date.now();
    if (now < nextDayTarget.getTime() && !currentDayVal.isBypassed) {
      valPanel.innerHTML = `<div class="flex items-center gap-4 bg-emerald-50 p-4 rounded-2xl border"><div class="bg-emerald-500 text-white rounded-full p-1.5"><svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"></path></svg></div><div class="flex-1"><h3 class="text-sm font-bold text-emerald-900">Disetujui!</h3><p class="text-xs text-emerald-800 mt-0.5">Tugas berikutnya terbuka dalam: <span id="realtime-countdown" class="font-mono font-bold text-rose-600 bg-rose-50 px-2 py-0.5 rounded border border-rose-100 ml-1">Menghitung...</span></p></div></div>`;

      window.countdownInterval = setInterval(() => {
        let distance = nextDayTarget.getTime() - Date.now();
        if (distance < 0) {
          clearInterval(window.countdownInterval);
          renderTabs();
          renderValidationPanel();
        } else {
          let h = Math.floor(
            (distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60),
          );
          let m = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
          let s = Math.floor((distance % (1000 * 60)) / 1000);
          let el = document.getElementById("realtime-countdown");
          if (el) el.innerText = `${h}j ${m}m ${s}d`;
        }
      }, 1000);
    } else {
      valPanel.innerHTML = `<div class="flex items-center gap-4 bg-emerald-50 p-4 rounded-2xl border"><div class="bg-emerald-500 text-white rounded-full p-1.5"><svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"></path></svg></div><div><h3 class="text-sm font-bold text-emerald-900">Disetujui!</h3><p class="text-xs">Silakan klik Tab Hari Berikutnya.</p></div></div>`;
    }
  }
}

function redirectToGDrive() {
  const userConfig = USERS[loggedInUser.username];
  const gdriveLink = userConfig ? userConfig.gdrive_upload_url : "";

  if (!gdriveLink || !gdriveLink.startsWith("http")) {
    return showDialog(
      "Link GDrive Kosong",
      "Admin belum mensetting Link Folder GDrive untuk akun Anda. Harap lapor ke Admin.",
      "alert",
    );
  }

  showDialog(
    "Panduan Upload Bukti",
    "Note: Ketika upload bukti kerja, tambah dulu folder format (Tgl Bulan Tahun) serta kelola akses di folder tersebut di ubah menjadi publik.",
    "confirm",
    () => {
      let nowHours = new Date().getHours();
      let isAutoApproveTime = nowHours >= 19 || nowHours < 7;
      let nextStatus = isAutoApproveTime ? "approved" : "pending";
      let approvedAtVal = nextStatus === "approved" ? Date.now() : null;

      if (!dailyValidation[loggedInUser.username])
        dailyValidation[loggedInUser.username] = {};
      dailyValidation[loggedInUser.username][activeDay] = {
        link: gdriveLink,
        status: nextStatus,
        approvedAt: approvedAtVal,
      };
      saveValidation();
      window.open(gdriveLink, "_blank");

      if (nextStatus === "approved")
        showToast(
          "Bukti tugas disubmit & Otomatis Disetujui (Melewati Jam Kerja Admin).",
          "success",
        );
      else
        showToast(
          "Bukti tugas disubmit. Menunggu verifikasi Admin.",
          "success",
        );

      renderValidationPanel();
      renderTabs();
    },
  );
}

function syncOngoingPanel() {
  const emptyDiv = document.getElementById("ongoing-empty"),
    activeDiv = document.getElementById("ongoing-active");
  if (!emptyDiv || !activeDiv) return;

  if (
    currentOngoingIndex !== null &&
    currentDB[currentOngoingIndex] &&
    currentDB[currentOngoingIndex].status === "Proses"
  ) {
    const data = currentDB[currentOngoingIndex];

    if (
      loggedInUser.role === "user" &&
      data.kodeUser !== loggedInUser.username
    ) {
      emptyDiv.classList.remove("hidden");
      activeDiv.classList.add("hidden");
      return;
    }

    document.getElementById("og-kontrak").innerText = data.kontrak;
    document.getElementById("og-nama").innerText = data.nama;
    document.getElementById("og-type").innerText = data.type;
    document.getElementById("og-sisa").innerText = new Intl.NumberFormat(
      "id-ID",
    ).format(data.sisa);
    document.getElementById("og-hp").innerText = data.hp;

    emptyDiv.classList.add("hidden");
    activeDiv.classList.remove("hidden");

    const animatedElements = activeDiv.querySelectorAll(".slide-in-right");
    animatedElements.forEach((el) => {
      el.style.animation = "none";
      el.offsetHeight;
      el.style.animation = null;
    });
  } else {
    emptyDiv.classList.remove("hidden");
    activeDiv.classList.add("hidden");
  }
}

function dWAAman(jenis = "biasa") {
  let now = Date.now();
  let elapsed = now - lastWaTime;
  let requiredDelay = WA_DELAY * 1000;

  if (elapsed < requiredDelay) {
    let sisa = Math.ceil((requiredDelay - elapsed) / 1000);
    return showToast(
      `Anti-Spam: Tunggu ${sisa} detik lagi untuk kirim WA.`,
      "error",
    );
  }

  lastWaTime = now;
  let phoneNum = document.getElementById("og-hp").innerText.replace(/\D/g, "");
  if (phoneNum.startsWith("0")) phoneNum = "62" + phoneNum.substring(1);

  let consumerName = document.getElementById("og-nama").innerText.trim();
  let userName =
    USERS[loggedInUser.username]?.name || loggedInUser.username.toUpperCase();
  let userTemplates = USERS[loggedInUser.username]?.wa_templates || {};
  let defaultTemplate =
    "Halo ka, apakah benar ini dengan kk [nama_konsumen]? Saya [nama_user] dari FIFGroup.";
  let activeTemplate = defaultTemplate;

  let nowHours = new Date().getHours();
  if (nowHours >= 7 && nowHours < 10)
    activeTemplate = userTemplates.pagi || defaultTemplate;
  else if (nowHours >= 10 && nowHours < 14)
    activeTemplate = userTemplates.siang || defaultTemplate;
  else if (nowHours >= 14 && nowHours < 17)
    activeTemplate = userTemplates.sore || defaultTemplate;
  else
    activeTemplate =
      userTemplates.sore ||
      userTemplates.siang ||
      userTemplates.pagi ||
      defaultTemplate;

  let finalMessage = activeTemplate
    .replace(/\[nama_konsumen\]/gi, consumerName)
    .replace(/\[nama_user\]/gi, userName);
  let encodedMessage = encodeURIComponent(finalMessage);
  let isAndroid = /android/i.test(navigator.userAgent || navigator.vendor);

  if (isAndroid) {
    if (jenis === "business")
      window.open(
        `intent://send?phone=${phoneNum}&text=${encodedMessage}#Intent;package=com.whatsapp.w4b;scheme=whatsapp;end`,
        "_blank",
      );
    else
      window.open(
        `intent://send?phone=${phoneNum}&text=${encodedMessage}#Intent;package=com.whatsapp;scheme=whatsapp;end`,
        "_blank",
      );
  } else {
    window.open(`https://wa.me/${phoneNum}?text=${encodedMessage}`, "_blank");
  }
}

// --- UPLOAD EXCEL ---
function showSuccessModal(total, usr, typeLabel) {
  let displayName =
    USERS[usr] && USERS[usr].name ? USERS[usr].name : usr.toUpperCase();
  document.getElementById("succ-total-data").innerText = total + " Baris";
  document.getElementById("succ-target-user").innerText = displayName;
  document.getElementById("succ-task-type").innerText = typeLabel;
  document.getElementById("success-upload-modal").classList.remove("hidden");
  setTimeout(() => {
    document
      .getElementById("success-upload-modal")
      .classList.remove("opacity-0");
    document.getElementById("success-modal-box").classList.remove("scale-90");
  }, 10);
}

function closeSuccessModal() {
  document.getElementById("success-upload-modal").classList.add("opacity-0");
  document.getElementById("success-modal-box").classList.add("scale-90");
  setTimeout(
    () =>
      document.getElementById("success-upload-modal").classList.add("hidden"),
    300,
  );
}

// ==========================================
// FUNGSI UPLOAD EXCEL KE FIRESTORE 
// ==========================================
function processModalUpload() {
  if (quotaFlags.blockUpload) {
    return showToast(
      "Upload ditolak: Kuota Writes Firestore menipis (<= 3%).",
      "error",
    );
  }

  const file = document.getElementById("modal-file-input").files[0];
  const targetUser = document.getElementById("admin-user-selector").value;
  const taskType = document.getElementById("upload-task-type").value;

  if (!file) return showToast("Pilih file!", "error");
  closeMasterSettingsModal();
  showLoading();

  setTimeout(() => {
    const reader = new FileReader();
    reader.onload = function (e) {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: "array" });
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
        const jsonRows = XLSX.utils.sheet_to_json(worksheet, { defval: "" });
        const emgBatchId =
          taskType === "emergency" ? Date.now().toString() : null;

        // 1. Deteksi Kolom Excel & Formatting
        let parsedData = jsonRows
          .map((row) => {
            let k = Object.keys(row);

            // Perbaikan findCol: fallbackIndex sekarang bisa diset null agar tidak sembarangan mengambil kolom lain
            let findCol = (exactKeywords, partialKeyword, fallbackIndex) => {
              let exact = k.find((x) =>
                exactKeywords.includes(x.toUpperCase().trim()),
              );
              if (exact) return exact;
              let partial = k.find((x) =>
                x.toUpperCase().includes(partialKeyword),
              );
              return partial || (fallbackIndex !== null ? k[fallbackIndex] : null);
            };

            let colKontrak = findCol(
              ["KONTRAK", "NO KONTRAK", "NO. KONTRAK", "NOMOR KONTRAK"],
              "KONTRAK",
              0,
            );
            let colNama = findCol(
              ["NAMA", "NAMA KONSUMEN", "NAMA PELANGGAN"],
              "NAMA",
              1,
            );
            let colHp = findCol(
              ["HP", "NO HP", "NO. HP", "TELEPON", "NO TLP"],
              "HP",
              2,
            );
            // PROTEKSI TYPE: Fallback diset ke 'null' agar sistem tidak mengambil kolom lain jika tidak ada kolom TYPE
            let colType = findCol(
              ["TYPE", "JENIS", "TIPE", "KENDARAAN", "BARANG"], 
              "TYPE", 
              null
            );
            let colSisa = findCol(["SISA", "SALDO", "SISA HUTANG"], "SISA", 4);

            // ========================================================
            // FITUR PROTEKSI NO HP (AUTO-CORRECT)
            // ========================================================
            let rawHp = String(row[colHp] || "").replace(/\D/g, ""); 
            
            if (rawHp.length > 5 && !rawHp.startsWith("0") && !rawHp.startsWith("62")) {
                rawHp = "0" + rawHp; 
            } else if (rawHp.length === 0) {
                rawHp = "-"; 
            }

            // ========================================================
            // FITUR PROTEKSI TYPE / JENIS BARANG
            // ========================================================
            // Jika kolom Type tidak ditemukan ATAU isinya kosong, maka langsung beri tanda "-"
            let rawType = (colType && row[colType] !== undefined && String(row[colType]).trim() !== "") 
                ? String(row[colType]).trim().toUpperCase() 
                : "-";

            return {
              kontrak: String(row[colKontrak] || "").trim(),
              nama: String(row[colNama] || "")
                .trim()
                .toUpperCase(),
              hp: rawHp,
              type: rawType, // Menggunakan rawType yang sudah diproteksi
              sisa:
                parseInt((row[colSisa] || "0").toString().replace(/\D/g, "")) ||
                0,
              kodeUser: targetUser,
              status: "Belum",
              alasan: "",
              taskType: taskType,
              batchId: emgBatchId,
            };
          })
          .filter((d) => d.kontrak !== "" && d.nama !== "");

        // 2. Filter Duplikat (memeriksa database saat ini)
        let existingKontrak = new Set(
          currentDB.map((d) => String(d.kontrak).trim()),
        );
        let newData = parsedData.filter((d) => !existingKontrak.has(d.kontrak));

        // Jika semua data ternyata duplikat
        if (newData.length === 0) {
          hideLoading();
          return showDialog(
            "Upload Dibatalkan",
            "Semua data dalam file Excel sudah ada di database (Duplikat seluruhnya).",
            "alert",
          );
        }

        // 3. PROSES SIMPAN KE FIRESTORE MENGGUNAKAN BATCH
        const batchArray = [];
        let currentBatch = firestore.batch();
        let operationCounter = 0;

        newData.forEach((item) => {
          let docRef = firestore.collection("ocm_main_db").doc(item.kontrak);
          currentBatch.set(docRef, item);
          operationCounter++;

          if (operationCounter === 490) {
            batchArray.push(currentBatch.commit());
            currentBatch = firestore.batch();
            operationCounter = 0;
          }
        });

      if (operationCounter > 0) {
        batchArray.push(currentBatch.commit());
      }

      trackFirestoreUsage("writes", newData.length);

      // 4. Tunggu semua proses upload batch selesai
      Promise.all(batchArray)
        .then(() => {
          currentOngoingIndex = null;
          if (taskType === "daily") activeDay = 1;
          else activeDay = `emg-${emgBatchId}`;

          saveState();
          hideLoading();

          let duplicateCount = parsedData.length - newData.length;
          if (duplicateCount > 0) {
            showDialog(
              "Upload Selesai (Ada Duplikat)",
              `Berhasil memproses Excel.\n\n📊 Total Data Excel: ${parsedData.length} baris\n✅ Data Baru Masuk: ${newData.length} baris\n⚠️ Data Diabaikan: ${duplicateCount} baris (Sudah ada di database sebelumnya berdasarkan No. Kontrak).\n\nSistem mengabaikan data duplikat untuk mencegah bentrok tugas.`,
              "alert",
              () =>
                showSuccessModal(
                  newData.length,
                  targetUser,
                  taskType === "emergency"
                    ? "🚨 Emergency"
                    : "📅 Harian Normal",
                ),
            );
          } else {
            showSuccessModal(
              parsedData.length,
              targetUser,
              taskType === "emergency" ? "🚨 Emergency" : "📅 Harian Normal",
            );
          }
        })
        .catch((error) => {
          hideLoading();
          showDialog(
            "Error Upload",
            "Gagal menyimpan ke Firestore: " + error.message,
            "alert",
          );
        });
      } catch (err) {
        hideLoading();
        showDialog(
          "Error Ekstrak",
          "Gagal memproses file Excel. Pastikan format tabel sudah benar.\n\nDetail: " +
            err.message,
          "alert",
        );
      }
    };
    reader.readAsArrayBuffer(file);
  }, 400);
}
function openFailModal() {
  document.getElementById("fail-modal").classList.remove("hidden");
  setTimeout(() => {
    document.getElementById("fail-modal").classList.remove("opacity-0");
    document.getElementById("fail-modal-box").classList.remove("scale-90");
  }, 10);
}

function closeFailModal() {
  document.getElementById("fail-modal").classList.add("opacity-0");
  document.getElementById("fail-modal-box").classList.add("scale-90");
  setTimeout(
    () => document.getElementById("fail-modal").classList.add("hidden"),
    300,
  );
}

function saveSystemSettings() {
  let newVal = parseInt(document.getElementById("setting-items-per-day").value);
  let newDelay = parseInt(document.getElementById("setting-wa-delay").value);
  let isMinggu = document.getElementById("setting-minggu-kerja").checked;

  if (isNaN(newVal) || newVal < 1)
    return showToast("Masukkan angka limit yang valid!", "error");
  if (isNaN(newDelay) || newDelay < 0)
    return showToast("Masukkan angka jeda WA yang valid!", "error");

  showDialog(
    "Simpan Pengaturan?",
    `Perbarui batasan harian, jeda WA, template WA, dan pengaturan kerja Minggu?`,
    "confirm",
    () => {
      database
        .ref("ocm_settings")
        .update({
          items_per_day: newVal,
          wa_delay: newDelay,
          work_on_sunday: isMinggu,
        });
      showToast("Pengaturan berhasil diperbarui!", "success");
      if (loggedInUser && loggedInUser.role !== "admin") {
        renderTabs();
        renderTable();
      }
    },
  );
}

function renderEformBuilderList() {
  const list = document.getElementById("eform-builder-list");
  if (!list) return;
  list.innerHTML = "";
  let fields =
    EFORM_SETTINGS && EFORM_SETTINGS.length > 0
      ? EFORM_SETTINGS
      : defaultEformFields;
  fields.forEach((field, index) => {
    list.innerHTML += `<div class="flex justify-between items-center bg-white p-2 border border-slate-200 rounded-lg"><div><span class="text-xs font-bold text-slate-800">${field.label}</span><span class="text-[10px] text-slate-500 ml-2 bg-slate-100 px-1 rounded uppercase">${field.type}</span></div><button onclick="removeEformField(${index})" class="text-rose-500 hover:text-rose-700 font-bold text-[10px]">Hapus</button></div>`;
  });
}

function renderAdminEformSubmissions() {
  const tbody = document.getElementById("admin-eform-submissions");
  if (!tbody) return;
  tbody.innerHTML = "";
  let hasData = false;

  for (let key in PENGAJUAN_PINJAMAN) {
    hasData = true;
    let sub = PENGAJUAN_PINJAMAN[key];
    let detailHtml = `<span class="block text-xs mb-1"><strong class="text-slate-600">CS ID:</strong> <span class="bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded text-[10px] font-bold uppercase">${sub.cs_id || "Tanpa CS"}</span></span><span class="block text-xs"><strong class="text-slate-600">Nominal:</strong> Rp ${new Intl.NumberFormat("id-ID").format(sub.nominal_pengajuan || 0)}</span><span class="block text-xs"><strong class="text-slate-600">No HP:</strong> ${sub.no_hp || "-"}</span><span class="block text-xs"><strong class="text-slate-600">TTL:</strong> ${sub.tempat_lahir || "-"}, ${sub.tgl_lahir || "-"}</span><span class="block text-xs"><strong class="text-slate-600">Alamat:</strong> ${sub.alamat || "-"}</span><span class="block text-xs"><strong class="text-slate-600">BPKB:</strong> ${sub.status_bpkb || "-"}</span>`;
    let kontrakInput = sub.kontrakAdmin
      ? `<span class="font-bold text-emerald-600">${sub.kontrakAdmin}</span>`
      : `<div class="flex gap-1"><input type="text" id="kontrak-${key}" class="w-full text-xs p-1.5 border border-slate-200 rounded outline-none" placeholder="Input Kontrak..."><button onclick="saveKontrakEform('${key}')" class="bg-blue-600 hover:bg-blue-700 text-white text-[10px] px-2 rounded cursor-pointer transition">Simpan</button></div>`;
    tbody.innerHTML += `<tr class="hover:bg-slate-50 transition-colors"><td class="py-3 px-6"><span class="font-bold text-slate-800">${sub.nama || "Tanpa Nama"}</span><br><span class="text-[10px] text-slate-500">${sub.tanggal_masuk || "-"}</span></td><td class="py-3 px-6 space-y-1">${detailHtml}</td><td class="py-3 px-6">${kontrakInput}</td></tr>`;
  }
  if (!hasData)
    tbody.innerHTML =
      '<tr><td colspan="3" class="text-center py-6 text-slate-500 text-sm">Belum ada pengajuan dana tunai yang masuk.</td></tr>';
}

setTimeout(() => {
  if (document.getElementById("initial-loading-screen") && !isDataLoaded) {
    matikanLoadingAwal();
    if (typeof showExcelToast === "function")
      showExcelToast(
        "Koneksi Lambat",
        "Dashboard dimuat menggunakan cache.",
        "error",
      );
  }
}, 8000);

function listenPengajuanEform() {
  firebase
    .database()
    .ref("pengajuan_pinjaman")
    .on(
      "value",
      (snapshot) => {
        if (typeof matikanLoadingAwal === "function") matikanLoadingAwal();
        if (typeof renderAdminEformSubmissions === "function") {
          renderAdminEformSubmissions(snapshot.val());
        } else {
          const tbody = document.getElementById("table-body-pengajuan");
          if (!tbody) return;
          tbody.innerHTML = "";

          if (!snapshot.exists()) {
            tbody.innerHTML =
              '<tr><td colspan="10" class="text-center py-6 text-slate-500 text-sm font-medium">Belum ada pengajuan dana tunai yang masuk bulan ini.</td></tr>';
            return;
          }

          const data = snapshot.val();
          let hasData = false;
          Object.keys(data).forEach((key) => {
            hasData = true;
            let sub = data[key];
            let row = `<tr class="border-b border-slate-100 hover:bg-slate-50 transition-colors"><td class="py-3 px-4"><span class="block text-xs mb-1"><strong class="text-slate-600">CS ID:</strong> <span class="bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded text-[10px] font-bold uppercase">${sub.cs_id || "Tanpa CS"}</span></span><span class="block text-xs"><strong class="text-slate-600">Nama:</strong> ${sub.nama || "-"}</span><span class="block text-xs"><strong class="text-slate-600">Nominal:</strong> Rp ${new Intl.NumberFormat("id-ID").format(sub.nominal_pengajuan || 0)}</span><span class="block text-xs"><strong class="text-slate-600">No HP:</strong> ${sub.no_hp || "-"}</span><span class="block text-xs"><strong class="text-slate-600">TTL:</strong> ${sub.tempat_lahir || "-"}, ${sub.tgl_lahir || "-"}</span><span class="block text-xs"><strong class="text-slate-600">Alamat:</strong> ${sub.alamat || "-"}</span><span class="block text-xs"><strong class="text-slate-600">BPKB:</strong> ${sub.status_bpkb || "-"}</span></td><td class="py-3 px-4 text-center"><input type="text" id="kontrak-${key}" value="${sub.kontrakAdmin || ""}" placeholder="Input No. Kontrak" class="border border-slate-300 rounded px-2 py-1 text-xs w-full mb-2"><button onclick="saveKontrakEform('${key}')" class="bg-indigo-600 hover:bg-indigo-700 text-white text-[10px] px-3 py-1 rounded shadow cursor-pointer w-full">Simpan Kontrak</button></td></tr>`;
            tbody.insertAdjacentHTML("afterbegin", row);
          });
          if (!hasData)
            tbody.innerHTML =
              '<tr><td colspan="10" class="text-center py-6 text-slate-500 text-sm font-medium">Belum ada pengajuan dana tunai yang masuk bulan ini.</td></tr>';
        }
      },
      (error) => {
        // PERBAIKAN BUG: Cek apakah user memang sedang/sudah logout
        if (!firebase.auth().currentUser) {
          console.warn(
            "Listener terputus karena user logout (Aman diabaikan).",
          );
          return; // Hentikan fungsi agar alert tidak muncul
        }

        if (typeof matikanLoadingAwal === "function") matikanLoadingAwal();
        alert("Gagal memuat data dari server: " + error.message);
      },
    );
}



function saveKontrakEform(key) {
  let val = document.getElementById(`kontrak-${key}`).value.trim();
  if (!val)
    return showToast
      ? showToast("Isi nomor kontrak terlebih dahulu!", "error")
      : alert("Isi nomor kontrak!");

  database
    .ref(`pengajuan_pinjaman/${key}/kontrakAdmin`)
    .set(val)
    .then(() => {
      if (typeof showToast === "function")
        showToast("Kontrak berhasil disimpan!", "success");
      else alert("Kontrak berhasil disimpan!");
    })
    .catch((err) => {
      alert("Gagal menyimpan: " + err.message);
    });
}

function simpanPengajuanManual(dataPengajuan) {
  let isResolved = false;
  let loadingEl = document.getElementById("loading-screen");
  if (loadingEl) loadingEl.classList.remove("hidden");

  firebase
    .database()
    .ref("pengajuan_masuk")
    .push(dataPengajuan)
    .then(() => {
      isResolved = true;
      if (loadingEl) loadingEl.classList.add("hidden");
      if (typeof showToast === "function")
        showToast("Pengajuan berhasil ditambahkan.", "success");
    })
    .catch((error) => {
      isResolved = true;
      if (loadingEl) loadingEl.classList.add("hidden");
      alert("Error: " + error.message);
    });

  setTimeout(() => {
    if (!isResolved) {
      if (loadingEl) loadingEl.classList.add("hidden");
      alert(
        "Waktu koneksi habis. Silakan periksa koneksi internet Anda dan coba lagi.",
      );
    }
  }, 10000);
}

function recapMonthlyData() {
  const modal = document.getElementById("recap-confirm-modal");
  modal.classList.remove("hidden");
  setTimeout(() => {
    modal.classList.remove("opacity-0");
    modal.firstElementChild.classList.remove("scale-95");
  }, 20);
}

function closeRecapModal() {
  const modal = document.getElementById("recap-confirm-modal");
  modal.classList.add("opacity-0");
  modal.firstElementChild.classList.add("scale-95");
  setTimeout(() => {
    modal.classList.add("hidden");
  }, 300);
}

function executeRecapAndReset() {
  closeRecapModal();
  if (document.getElementById("loading-screen"))
    document.getElementById("loading-screen").classList.remove("hidden");

  const monthNames = [
    "Januari",
    "Februari",
    "Maret",
    "April",
    "Mei",
    "Juni",
    "Juli",
    "Agustus",
    "September",
    "Oktober",
    "November",
    "Desember",
  ];

  setTimeout(() => {
    if (document.getElementById("loading-screen"))
      document.getElementById("loading-screen").classList.add("hidden");
    if (typeof showToast === "function")
      showToast("Rekap bulanan berhasil diproses!", "success");
  }, 1500);

  const now = new Date();
  const currentMonth = monthNames[now.getMonth()] + " " + now.getFullYear();
  const recapId = "rekap_" + now.getTime();

  firebase
    .database()
    .ref("pengajuan_pinjaman")
    .once("value")
    .then((snapshot) => {
      if (!snapshot.exists()) {
        if (document.getElementById("loading-screen"))
          document.getElementById("loading-screen").classList.add("hidden");
        showExcelToast(
          "Gagal",
          "Tabel kosong, tidak ada data untuk direkap.",
          "error",
        );
        return Promise.reject("empty");
      }
      return firebase
        .database()
        .ref(`rekapan_pengajuan/${recapId}`)
        .set({
          periode: currentMonth,
          tanggal_rekap: now.toLocaleString("id-ID"),
          data: snapshot.val(),
        });
    })
    .then(() => firebase.database().ref("pengajuan_pinjaman").remove())
    .then(() => {
      if (document.getElementById("loading-screen"))
        document.getElementById("loading-screen").classList.add("hidden");
      showExcelToast(
        "Berhasil!",
        `Data periode ${currentMonth} diarsipkan.`,
        "success",
      );
      if (typeof loadRecapData === "function") loadRecapData();
    })
    .catch((error) => {
      if (error === "empty") return;
      if (document.getElementById("loading-screen"))
        document.getElementById("loading-screen").classList.add("hidden");
      showExcelToast("Error", error.message || error, "error");
    });
}

function loadRecapData() {
  firebase
    .database()
    .ref("rekapan_pengajuan")
    .on("value", (snapshot) => {
      const container = document.getElementById("recap-list-container");
      if (!container) return;
      container.innerHTML = "";
      if (!snapshot.exists()) {
        container.innerHTML =
          '<p class="text-sm text-slate-500 italic text-center py-4">Belum ada arsip rekapan tersedia.</p>';
        return;
      }

      const recaps = snapshot.val();
      Object.keys(recaps)
        .reverse()
        .forEach((key) => {
          let item = recaps[key];
          let totalData = item.data ? Object.keys(item.data).length : 0;
          let div = document.createElement("div");
          div.className =
            "bg-white p-4 border border-indigo-200 rounded-xl flex justify-between items-center shadow-sm hover:shadow-md transition-shadow";
          div.innerHTML = `<div><h5 class="font-bold text-slate-800 text-sm">Rekapan ${item.periode}</h5><p class="text-[10px] text-slate-500 mt-0.5">Tanggal Reset: ${item.tanggal_rekap} • ${totalData} Pengajuan</p></div><button onclick="downloadModernExcel('${key}')" class="bg-emerald-500 hover:bg-emerald-600 text-white px-3 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-1 cursor-pointer">📥 Download Excel</button>`;
          container.appendChild(div);
        });
    });
}

function showExcelToast(title, desc, status) {
  const toast = document.getElementById("excel-toast");
  const iconBox = document.getElementById("excel-toast-icon");
  if (!toast || !iconBox) return;

  document.getElementById("excel-toast-title").innerText = title;
  document.getElementById("excel-toast-desc").innerText = desc;

  if (status === "loading") {
    iconBox.className =
      "w-9 h-9 rounded-xl flex items-center justify-center shrink-0 bg-amber-50 text-amber-600";
    iconBox.innerHTML = `<svg class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>`;
  } else if (status === "success") {
    iconBox.className =
      "w-9 h-9 rounded-xl flex items-center justify-center shrink-0 bg-emerald-50 text-emerald-600";
    iconBox.innerHTML = `<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"></path></svg>`;
  } else if (status === "error") {
    iconBox.className =
      "w-9 h-9 rounded-xl flex items-center justify-center shrink-0 bg-rose-50 text-rose-600";
    iconBox.innerHTML = `<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"></path></svg>`;
  }

  toast.classList.remove("translate-y-24", "opacity-0");
  toast.classList.add("translate-y-0", "opacity-100");
  if (status !== "loading") {
    setTimeout(() => {
      toast.classList.remove("translate-y-0", "opacity-100");
      toast.classList.add("translate-y-24", "opacity-0");
    }, 3500);
  }
}

function downloadModernExcel(recapId) {
  showExcelToast(
    "Mengunduh...",
    "Mengumpulkan data arsip dari cloud...",
    "loading",
  );
  firebase
    .database()
    .ref(`rekapan_pengajuan/${recapId}`)
    .once("value")
    .then((snapshot) => {
      if (!snapshot.exists()) {
        showExcelToast("Gagal Unduh", "Arsip data tidak ditemukan.", "error");
        return;
      }

      let recapData = snapshot.val();
      let rawData = recapData.data;
      let periode = recapData.periode;
      let excelRows = [
        [
          "ID Database",
          "Tanggal Masuk",
          "CS ID",
          "Nama Nasabah",
          "No. HP/WA",
          "Plafon Dana",
          "BPKB",
          "No. Kontrak Admin",
          "Tempat Lahir",
          "Tgl Lahir",
          "Alamat",
        ],
      ];

      Object.keys(rawData).forEach((dataKey) => {
        let d = rawData[dataKey];
        excelRows.push([
          dataKey,
          d.tanggal_masuk || "-",
          d.cs_id || "Tanpa CS",
          d.nama || "-",
          d.no_hp || "-",
          d.nominal_pengajuan
            ? `Rp ${parseInt(d.nominal_pengajuan).toLocaleString("id-ID")}`
            : "-",
          d.status_bpkb || "-",
          d.kontrakAdmin || "Belum Diinput",
          d.tempat_lahir || "-",
          d.tgl_lahir || "-",
          d.alamat || "-",
        ]);
      });

      let ws = XLSX.utils.aoa_to_sheet(excelRows);
      ws["!cols"] = [
        { wch: 22 },
        { wch: 20 },
        { wch: 15 },
        { wch: 25 },
        { wch: 18 },
        { wch: 18 },
        { wch: 12 },
        { wch: 22 },
        { wch: 18 },
        { wch: 15 },
        { wch: 50 },
      ];
      let wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Rekap " + periode);

      XLSX.writeFile(
        wb,
        `Laporan_Pengajuan_${periode.replace(/\s+/g, "_")}.xlsx`,
      );
      setTimeout(() => {
        showExcelToast(
          "Berhasil Diunduh!",
          "File Excel siap digunakan.",
          "success",
        );
      }, 500);
    })
    .catch((err) => {
      showExcelToast("Gagal Sistem", err.message, "error");
    });
}

function escapeHTML(str) {
  if (!str) return "";
  return str.replace(
    /[&<>'"]/g,
    (tag) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        tag
      ] || tag,
  );
}

function moveToNextContract() {
  if (currentOngoingIndex === null) return;
  let nextIndex = currentOngoingIndex + 1;
  let foundTarget = false;
  let isEmergency =
    typeof activeDay === "string" && activeDay.startsWith("emg-");

  let userSpecificData = currentDB
    .map((item, index) => ({ item, originalIndex: index }))
    .filter((d) => d.item.kodeUser === loggedInUser.username);
  let dailySpecificData = userSpecificData.filter(
    (d) => !d.item.taskType || d.item.taskType === "daily",
  );
  let allowedStartIndex = (activeDay - 1) * ITEMS_PER_DAY;
  let allowedEndIndex = allowedStartIndex + ITEMS_PER_DAY - 1;
  let emgBatchId = isEmergency ? activeDay.split("emg-")[1] : null;

  while (nextIndex < currentDB.length) {
    let item = currentDB[nextIndex];
    if (
      item &&
      item.kodeUser === loggedInUser.username &&
      item.status !== "Selesai" &&
      item.status !== "Gagal"
    ) {
      let isAllowedInCurrentTab = false;
      if (isEmergency) {
        isAllowedInCurrentTab = item.batchId === emgBatchId;
      } else {
        if (!item.taskType || item.taskType === "daily") {
          let itemDailyIndex = dailySpecificData.findIndex(
            (d) => d.originalIndex === nextIndex,
          );
          if (
            itemDailyIndex >= allowedStartIndex &&
            itemDailyIndex <= allowedEndIndex
          )
            isAllowedInCurrentTab = true;
        }
      }
      if (isAllowedInCurrentTab) {
        foundTarget = true;
        break;
      } else {
        break;
      }
    }
    nextIndex++;
  }

  // ... KODE SEBELUMNYA ...

  if (foundTarget) {
    // Memanggil fungsi eksekusi OnGoing yang sah
    triggerOngoing(nextIndex);

    // Animasi Gulir Otomatis Ke Kontrak Baru Tersebut
    setTimeout(() => {
      let nextRow = document.getElementById(`row-${nextIndex}`);
      if (nextRow) {
        let tableContainer = nextRow.closest("div");
        if (tableContainer) {
          // 1. Pastikan tabel diatur untuk bisa scroll internal
          tableContainer.classList.add(
            "overflow-y-auto",
            "max-h-[60vh]",
            "custom-scrollbar",
          );

          // 2. PERBAIKAN SCROLL AMAN: Hitung jarak persis di dalam kotak tabel
          const containerRect = tableContainer.getBoundingClientRect();
          const rowRect = nextRow.getBoundingClientRect();

          // Hitung posisi baris relatif terhadap kotak tabel saat ini
          const offsetTopRelatif = rowRect.top - containerRect.top;

          // Gulir hanya bagian dalam tabel, tidak mengganggu halaman web utama
          tableContainer.scrollBy({
            top:
              offsetTopRelatif -
              tableContainer.clientHeight / 2 +
              rowRect.height / 2,
            behavior: "smooth",
          });
        }

        // === AKTIFKAN ANIMASI TRANSISI DRAMATIS KONTRAK BARU ===
        nextRow.classList.add(
          "bg-indigo-100", // Flash warna background lebih terang
          "scale-[1.02]", // Sedikit membesar keluar dari baris
          "ring-4", // Efek border luar bulat (Glow)
          "ring-indigo-500/40", // Warna glow indigo transparan
          "transition-all",
          "duration-500", // Durasi masuk animasi
          "shadow-xl", // Bayangan tebal memberi efek melayang
          "z-10",
          "relative",
        );

        // Kembalikan baris ke kondisi normal secara halus (Fade-out effect)
        setTimeout(() => {
          nextRow.classList.remove(
            "scale-[1.02]",
            "ring-4",
            "ring-indigo-500/40",
            "shadow-xl",
          );
          nextRow.classList.replace("bg-indigo-100", "bg-indigo-50");
          nextRow.classList.add("duration-700");
        }, 1000);
      }
    }, 150);
  } else {
    // ... KODE SELANJUTNYA ...
    // Jika tidak ada lagi target di hari INI, matikan auto-select dan render ulang
    currentOngoingIndex = null;
    localStorage.removeItem("ocm_ongoing_idx");
    if (typeof syncOngoingPanel === "function") syncOngoingPanel();
    renderTable();
    showToast(
      "Semua data pengajuan di tab hari ini telah selesai diproses!",
      "success",
    );
  }
}

// ==========================================
// VARIABEL & FUNGSI MODE CANVASSING, BATERAI & SOS
// ==========================================
let isCanvassingActive = false;
let canvassingWatchId = null;
let adminMap = null;
let adminMarkers = {};
let batteryLevel = "100%";

async function initBatteryTracking() {
  if ("getBattery" in navigator) {
    let battery = await navigator.getBattery();
    updateBatteryUI(battery);
    battery.addEventListener("levelchange", () => updateBatteryUI(battery));
    battery.addEventListener("chargingchange", () => updateBatteryUI(battery));
  } else {
    const batEl = document.getElementById("canvassing-battery");
    if (batEl) batEl.innerText = "Tidak Didukung";
  }
}

function updateBatteryUI(battery) {
  batteryLevel = Math.round(battery.level * 100) + "%";
  let icon = battery.charging ? "⚡" : "🔋";
  const batEl = document.getElementById("canvassing-battery");
  if (batEl) batEl.innerText = `${icon} ${batteryLevel}`;

  if (isCanvassingActive && loggedInUser && loggedInUser.username) {
    database
      .ref(`ocm_canvassing/${loggedInUser.username}`)
      .update({ battery: batteryLevel });
  }
}

// OPTIMASI: sebelumnya setiap event GPS dari watchPosition langsung
// menulis ke Firebase (bisa beberapa kali per detik saat karyawan
// bergerak). Sekarang UI tetap update instan secara lokal, tapi
// penulisan ke server di-throttle: hanya dikirim tiap
// CANVASSING_PUSH_INTERVAL_MS sekali (default 30 detik), atau segera saat
// canvassing baru dimulai (agar admin langsung lihat status "active").
const CANVASSING_PUSH_INTERVAL_MS = 30 * 1000;
let canvassingPushTimer = null;
let canvassingPendingPosition = null;

function pushCanvassingPosition() {
  if (!canvassingPendingPosition) return;
  if (!loggedInUser || !loggedInUser.username) return;

  const { lat, lng } = canvassingPendingPosition;
  const currentUserFullData = USERS[loggedInUser.username];
  const userName =
    currentUserFullData?.name || loggedInUser.username.toUpperCase();
  const userPhoto =
    currentUserFullData?.photo ||
    `https://ui-avatars.com/api/?name=${userName}&background=0D8ABC&color=fff`;

  database.ref(`ocm_canvassing/${loggedInUser.username}`).update({
    nama: userName,
    foto: userPhoto,
    lat: lat,
    lng: lng,
    battery: batteryLevel,
    waktu_update: firebase.database.ServerValue.TIMESTAMP,
    status: "active",
  });
}

function mulaiCanvassing() {
  if (!navigator.geolocation) {
    if (typeof showToast === "function")
      showToast("Geolocation tidak didukung di perangkat ini", "error");
    return;
  }
  isCanvassingActive = true;

  // Status 'active' instan ke server agar rekan/admin bisa bersiap
  if (loggedInUser && loggedInUser.username) {
    const currentUserFullData = USERS[loggedInUser.username];
    const userName =
      currentUserFullData?.name || loggedInUser.username.toUpperCase();
    const userPhoto =
      currentUserFullData?.photo ||
      `https://ui-avatars.com/api/?name=${userName}&background=0D8ABC&color=fff`;

    database.ref(`ocm_canvassing/${loggedInUser.username}`).update({
      nama: userName,
      foto: userPhoto,
      status: "active",
      battery: batteryLevel,
      waktu_update: firebase.database.ServerValue.TIMESTAMP,
    });
  }

  if (typeof showToast === "function") {
    showToast("Mencari titik koordinat GPS...", "info");
  }

  canvassingWatchId = navigator.geolocation.watchPosition(
    (position) => {
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;
      const time = new Date().toLocaleTimeString("id-ID");

      const latEl = document.getElementById("canvassing-lat");
      const lngEl = document.getElementById("canvassing-lng");
      const timeEl = document.getElementById("canvassing-time");

      if (latEl) latEl.innerText = lat.toFixed(5);
      if (lngEl) lngEl.innerText = lng.toFixed(5);
      if (timeEl) timeEl.innerText = time;

      // ==========================================
      // FIX BUG: UPDATE PETA LOKAL SECARA INSTAN
      // ==========================================
      // Menggeser marker di peta pengguna secara langsung (real-time)
      // tanpa harus menunggu interval pengiriman 30 detik ke Firebase.
      if (typeof userLocMarker !== "undefined" && userLocMarker !== null) {
        const newLatLng = [lat, lng];
        userLocMarker.setLatLng(newLatLng);

        // Pastikan kamera peta ikut bergeser saat mendapat sinyal pertama
        if (
          typeof userCanvassingMap !== "undefined" &&
          !window.hasCenteredLocalMap
        ) {
          userCanvassingMap.setView(newLatLng, 15);
          window.hasCenteredLocalMap = true;
        }
      }

      const isFirstFix = canvassingPendingPosition === null;
      canvassingPendingPosition = { lat, lng };

      if (isFirstFix) {
        if (typeof showToast === "function")
          showToast("Lokasi berhasil dikunci!", "success");
        pushCanvassingPosition();
      }
    },
    (error) => {
      console.error("Error Geolocation: ", error);

      let pesanError = "Gagal mendapatkan lokasi GPS.";
      if (error.code === 1)
        pesanError = "Izin lokasi ditolak! Izinkan browser mengakses GPS.";
      else if (error.code === 2)
        pesanError = "Sinyal GPS tidak ditemukan. Cobalah ke area terbuka.";
      else if (error.code === 3)
        pesanError =
          "Mencari lokasi membutuhkan waktu lebih lama. Tetap mencari sinyal...";

      if (typeof showToast === "function") showToast(pesanError, "error");

      // ==========================================
      // FIX BUG: JANGAN MATIKAN CANVASSING SAAT TIMEOUT
      // ==========================================
      // Abaikan error code 3 (Timeout), biarkan perangkat terus mencari sinyal
      // sampai pengguna benar-benar mendapatkannya.
      if (error.code !== 3 && canvassingPendingPosition === null) {
        hentikanCanvassing();
      }
    },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 },
  );

  // Interval sinkronisasi background (30 detik sekali ke Firebase)
  if (!canvassingPushTimer) {
    canvassingPushTimer = setInterval(
      pushCanvassingPosition,
      CANVASSING_PUSH_INTERVAL_MS,
    );
  }
}

function hentikanCanvassing() {
  isCanvassingActive = false;
  const btnHeader = document.getElementById("btn-canvassing-header");
  const lockOverlay = document.getElementById("canvassing-lock-overlay");
  const floatingPanel = document.getElementById("floating-canvassing");
  const ping = document.getElementById("canvassing-ping");
  const statusTxt = document.getElementById("canvassing-status");

  if (lockOverlay) {
    lockOverlay.classList.add("hidden");
    lockOverlay.classList.remove("flex");
    lockOverlay.style.display = ""; // FIX BUG: Hapus inline style pembatas klik
  }
  if (btnHeader) {
    btnHeader.classList.replace("bg-sky-600", "bg-sky-50");
    btnHeader.classList.replace("text-white", "text-sky-700");
  }
  if (ping) ping.classList.add("hidden");
  if (statusTxt) {
    statusTxt.innerText = "Nonaktif";
    statusTxt.classList.replace("text-sky-600", "text-slate-400");
  }
  if (floatingPanel) {
    floatingPanel.classList.remove("translate-x-0");
    floatingPanel.classList.add("-translate-x-[150%]");
    setTimeout(() => {
      floatingPanel.classList.add("hidden");
      floatingPanel.style.display = "";
    }, 300);
  }

  document.body.style.overflow = "";

  if (canvassingWatchId) {
    navigator.geolocation.clearWatch(canvassingWatchId);
    canvassingWatchId = null;
  }

  if (canvassingPushTimer) {
    clearInterval(canvassingPushTimer);
    canvassingPushTimer = null;
  }
  canvassingPendingPosition = null;

  if (loggedInUser && loggedInUser.username) {
    database.ref(`ocm_canvassing/${loggedInUser.username}`).update({
      status: "inactive",
      waktu_update: firebase.database.ServerValue.TIMESTAMP,
    });
  }
  if (typeof showToast === "function")
    showToast("Mode Canvassing dinonaktifkan.", "success");
}
function toggleFloatingCanvassing() {
  const panel = document.getElementById("floating-canvassing");
  const icon = document.getElementById("icon-toggle-canvassing");
  if (!panel) return;
  if (panel.classList.contains("-translate-x-full")) {
    panel.classList.remove("-translate-x-full");
    if (icon)
      icon.innerHTML =
        '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path>';
  } else {
    panel.classList.add("-translate-x-full");
    if (icon)
      icon.innerHTML =
        '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path>';
  }
}

let isSosActive = false;
function triggerSOS() {
  if (isSosActive) {
    showToast("Sinyal SOS sudah aktif!", "info");
    return;
  }
  isSosActive = true;
  const btnSos = document.getElementById("btn-sos");
  const btnMatiSos = document.getElementById("btn-mati-sos");

  if (btnSos) {
    btnSos.innerHTML = "🚨 SOS AKTIF! 🚨";
    btnSos.classList.remove("bg-rose-600", "hover:bg-rose-700");
    btnSos.classList.add(
      "bg-red-800",
      "animate-pulse",
      "border-2",
      "border-white",
    );
  }
  if (btnMatiSos) btnMatiSos.classList.remove("hidden");
  if (loggedInUser && loggedInUser.username)
    database
      .ref(`ocm_canvassing/${loggedInUser.username}`)
      .update({ sos: true });
  showToast("Sinyal SOS Darurat Telah Dikirim!", "error");
}

function turnOffSOS() {
  if (!isSosActive) return;
  isSosActive = false;
  const btnSos = document.getElementById("btn-sos");
  const btnMatiSos = document.getElementById("btn-mati-sos");

  if (btnSos) {
    btnSos.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg> KIRIM SINYAL SOS`;
    btnSos.classList.remove(
      "bg-red-800",
      "animate-pulse",
      "border-2",
      "border-white",
    );
    btnSos.classList.add("bg-rose-600", "hover:bg-rose-700");
  }
  if (btnMatiSos) btnMatiSos.classList.add("hidden");
  if (loggedInUser && loggedInUser.username)
    database
      .ref(`ocm_canvassing/${loggedInUser.username}`)
      .update({ sos: false });
  showToast("Mode SOS Telah Dimatikan.", "success");
}
function toggleCanvassing() {
  const overlay = document.getElementById("canvassing-lock-overlay");
  const floatingPanel = document.getElementById("floating-canvassing");
  const btnHeader = document.getElementById("btn-canvassing-header");
  const ping = document.getElementById("canvassing-ping");
  const statusTxt = document.getElementById("canvassing-status");

  if (overlay) {
    if (!overlay.classList.contains("hidden")) {
      overlay.classList.add("hidden");
      overlay.style.display = ""; // FIX BUG: Hapus inline style pembatas klik

      if (floatingPanel) {
        floatingPanel.classList.remove("translate-x-0");
        floatingPanel.classList.add("-translate-x-[150%]");
        setTimeout(() => {
          floatingPanel.classList.add("hidden");
          floatingPanel.style.display = "";
        }, 300);
      }
      document.body.style.overflow = "";
      hentikanCanvassing();
      if (typeof showToast === "function")
        showToast("Mode Canvassing Dinonaktifkan.", "success");
    } else {
      overlay.classList.remove("hidden");
      overlay.style.display = "flex"; // Ini memicu kunci layar

      if (floatingPanel) {
        floatingPanel.classList.remove("hidden");
        floatingPanel.style.display = "flex";
        setTimeout(() => {
          floatingPanel.classList.remove(
            "-translate-x-full",
            "-translate-x-[150%]",
          );
          floatingPanel.classList.add("translate-x-0");
          if (typeof initUserCanvassingMap === "function")
            initUserCanvassingMap();
          setTimeout(() => {
            if (userCanvassingMap) userCanvassingMap.invalidateSize();
          }, 500);
        }, 50);
      }
      document.body.style.overflow = "hidden";
      if (btnHeader) {
        btnHeader.classList.replace("bg-sky-50", "bg-sky-600");
        btnHeader.classList.replace("text-sky-700", "text-white");
      }
      if (ping) ping.classList.remove("hidden");
      if (statusTxt) {
        statusTxt.innerText = "AKTIF - Terkunci";
        statusTxt.classList.replace("text-slate-400", "text-sky-600");
      }
      initBatteryTracking();
      mulaiCanvassing();
      if (typeof showToast === "function")
        showToast("Mode Canvassing Diaktifkan. Utamakan Keselamatan!", "info");
    }
  }
}
// ==========================================
// PETA PANTAU ADMIN (LEAFLET.JS)
// ==========================================
let tempAdminMapMarkers = [];
let isModeTambahTitik = false;

window.toggleModeTambahTitik = function () {
  isModeTambahTitik = !isModeTambahTitik;
  const btn = document.getElementById("btn-toggle-tambah-titik");
  if (btn) {
    if (isModeTambahTitik) {
      btn.innerHTML = "<span>📍 Mode Tambah Titik: ON</span>";
      btn.classList.replace("bg-amber-500", "bg-emerald-500");
      btn.classList.replace("hover:bg-amber-600", "hover:bg-emerald-600");
      if (typeof showToast === "function")
        showToast("Mode Tambah Titik AKTIF. Silakan klik peta.", "info");
    } else {
      btn.innerHTML = "<span>📍 Mode Tambah Titik: OFF</span>";
      btn.classList.replace("bg-emerald-500", "bg-amber-500");
      btn.classList.replace("hover:bg-emerald-600", "hover:bg-amber-600");
      if (typeof showToast === "function")
        showToast("Mode Tambah Titik NONAKTIF. Bebas geser peta.", "info");
    }
  }
};

function initAdminMap() {
  if (adminMap) {
    setTimeout(() => adminMap.invalidateSize(), 300);
    return;
  }

  adminMap = L.map("admin-map-container").setView([-6.2088, 106.8456], 12);
  L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    { attribution: "&copy; OpenStreetMap", maxZoom: 20 },
  ).addTo(adminMap);

  const selMapUser = document.getElementById("admin-map-user-selector");
  if (selMapUser) {
    selMapUser.innerHTML = '<option value="">-- Pilih User --</option>';
    for (let u in USERS) {
      if (USERS[u].role !== "admin")
        selMapUser.innerHTML += `<option value="${u}">${USERS[u].name || u.toUpperCase()} (ID: ${u.toUpperCase()})</option>`;
    }
  }

  adminMap.on("click", function (e) {
    if (!isModeTambahTitik) return;
    const targetUser = document.getElementById("admin-map-user-selector").value;
    if (!targetUser)
      return showToast(
        "Pilih user karyawan terlebih dahulu di atas peta!",
        "error",
      );

    const lat = e.latlng.lat;
    const lng = e.latlng.lng;
    const tempIcon = L.divIcon({
      className: "temp-marker",
      html: `<div style="background-color: #f59e0b; width: 16px; height: 16px; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 5px rgba(0,0,0,0.3); animation: pulse 2s infinite;"></div>`,
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });

    const marker = L.marker([lat, lng], { icon: tempIcon }).addTo(adminMap);
    tempAdminMapMarkers.push({
      lat: lat,
      lng: lng,
      assignedTo: targetUser,
      markerObj: marker,
    });
    showToast("Titik ditambahkan. Jangan lupa klik Konfirmasi!", "info");
  });

  database.ref("ocm_task_markers").on("value", (snapshot) => {
    const data = snapshot.val();
    for (let id in adminTaskMarkers) {
      adminMap.removeLayer(adminTaskMarkers[id]);
      delete adminTaskMarkers[id];
    }

    if (data) {
      Object.keys(data).forEach((id) => {
        const markerData = data[id];
        const userName = markerData.assignedTo
          ? markerData.assignedTo.toUpperCase()
          : "Semua";
        let isVisited = markerData.status === "visited";
        let dotColor = isVisited ? "#10b981" : "#e11d48";
        let titleDot = isVisited ? "Titik Dikunjungin" : "Titik Tugas";

        const taskIcon = L.divIcon({
          className: "task-marker",
          html: `<div style="background-color: ${dotColor}; width: 16px; height: 16px; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 5px rgba(0,0,0,0.3);"></div>`,
          iconSize: [16, 16],
          iconAnchor: [8, 8],
        });

        const marker = L.marker([markerData.lat, markerData.lng], {
          icon: taskIcon,
        }).addTo(adminMap);
        let buktiHtml =
          isVisited && markerData.foto_bukti
            ? `<button onclick="showPhotoModal('${markerData.foto_bukti}')" class="block w-full bg-emerald-500 hover:bg-emerald-600 text-white text-[10px] font-bold px-3 py-1.5 rounded shadow cursor-pointer transition text-center mb-1">🖼️ Lihat Bukti Kerja</button>`
            : `<span class="block text-[10px] text-slate-400 bg-slate-100 p-1 rounded mb-1 text-center font-medium">Belum Dikunjungi</span>`;
        const popupContent = document.createElement("div");
        popupContent.innerHTML = `<div class="text-center p-1"><p class="text-xs font-bold ${isVisited ? "text-emerald-600" : "text-slate-800"}">📍 ${titleDot}</p><p class="text-[10px] text-slate-500 mb-2">Untuk: <b>${userName}</b></p>${buktiHtml}<button onclick="hapusTitikTugas('${id}')" class="bg-rose-500 hover:bg-rose-600 text-white text-[10px] font-bold px-3 py-1.5 rounded shadow cursor-pointer transition w-full">Hapus Titik</button></div>`;
        marker.bindPopup(popupContent);
        adminTaskMarkers[id] = marker;
      });
    }
  });

  database.ref("ocm_canvassing").on("value", (snapshot) => {
    const data = snapshot.val();
    for (let id in adminMarkers) {
      if (!data || !data[id] || data[id].status !== "active") {
        adminMap.removeLayer(adminMarkers[id]);
        delete adminMarkers[id];
      }
    }

    if (data) {
      Object.keys(data).forEach((id) => {
        const user = data[id];
        if (user.status !== "active" || !user.lat) return;

        const markerColor = user.sos ? "#ef4444" : "#3b82f6";
        const displayAvatarsUrl = `https://ui-avatars.com/api/?name=${user.nama || id}&background=0D8ABC&color=fff`;
        const photoUrl = user.foto || displayAvatarsUrl;
        const markerHtml = `<div class="canvassing-marker ${user.sos ? "sos-active" : ""}" style="border: 3px solid ${markerColor}; display: flex; justify-content: center; align-items: center; border-radius: 50%; overflow: hidden; width: 100%; height: 100%; background: white; cursor: pointer;"><img src="${photoUrl}" alt="profil" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;" /></div>`;
        const customIcon = L.divIcon({
          className: "custom-div-icon-av",
          html: markerHtml,
          iconSize: [36, 36],
          iconAnchor: [18, 36],
          popupAnchor: [0, -38],
        });

        let timeString = "-";
        if (user.waktu_update) {
          const dateObj = new Date(user.waktu_update);
          timeString = dateObj.toLocaleTimeString("id-ID", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          });
        }

        const popupContentHtml = `<div class="text-center p-1 min-w-[120px]"><p class="text-xs font-bold text-slate-800">${user.nama || id}</p><p class="text-[10px] text-slate-500 mb-1">ID Karyawan: ${id.toUpperCase()}</p><div class="bg-slate-50 border border-slate-100 rounded p-1.5 mb-2"><p class="text-[10px] font-semibold flex justify-between mb-1"><span>Baterai:</span> <span class="text-emerald-600">${user.battery || "-"}</span></p><p class="text-[10px] font-semibold flex justify-between"><span>Update :</span> <span class="font-mono text-indigo-600">${timeString}</span></p></div>${user.sos ? '<p class="text-[10px] font-bold text-white bg-rose-500 px-2 py-1 rounded shadow-sm animate-pulse">🚨 Butuh Bantuan Segera!!!</p>' : '<p class="text-[10px] font-bold text-blue-600 bg-blue-50 px-2 py-1 rounded">Kondisi Aman</p>'}</div>`;

        if (adminMarkers[id]) {
          adminMarkers[id].setLatLng([user.lat, user.lng]);
          adminMarkers[id].setIcon(customIcon);
          if (adminMarkers[id].getPopup())
            adminMarkers[id].getPopup().setContent(popupContentHtml);
          else adminMarkers[id].bindPopup(popupContentHtml);
        } else {
          adminMarkers[id] = L.marker([user.lat, user.lng], {
            icon: customIcon,
          }).addTo(adminMap);
          adminMarkers[id].bindPopup(popupContentHtml);
        }
      });
    }
  });
}

window.simpanTitikTugasAdmin = function () {
  if (tempAdminMapMarkers.length === 0)
    return showToast("Anda belum mengklik lokasi apapun di peta!", "error");
  showDialog(
    "Simpan Titik?",
    `Menyimpan ${tempAdminMapMarkers.length} titik tugas untuk karyawan tersebut?`,
    "confirm",
    () => {
      tempAdminMapMarkers.forEach((item) => {
        database
          .ref("ocm_task_markers")
          .push({
            lat: item.lat,
            lng: item.lng,
            assignedTo: item.assignedTo,
            timestamp: firebase.database.ServerValue.TIMESTAMP,
          });
        adminMap.removeLayer(item.markerObj);
      });
      tempAdminMapMarkers = [];
      showToast("Titik tugas berhasil dikirim ke user!", "success");
    },
  );
};

window.hapusTitikTugas = function (id) {
  database
    .ref("ocm_task_markers/" + id)
    .remove()
    .then(() => {
      if (typeof showToast === "function")
        showToast("Titik tugas dihapus.", "success");
    });
};

// Tambahkan variabel global untuk menyimpan marker rekan kerja dan rute
window.userPeerMarkers = {};
window.currentActiveRouteId = null;

function initUserCanvassingMap() {
  if (userCanvassingMap) {
    setTimeout(() => userCanvassingMap.invalidateSize(), 500);
    return;
  }

  // 1. INISIALISASI PETA
  userCanvassingMap = L.map("user-canvassing-map").setView(
    [-6.2088, 106.8456],
    13,
  );
  L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    { attribution: "&copy; OpenStreetMap", maxZoom: 20 },
  ).addTo(userCanvassingMap);

  // 2. INISIALISASI KONTROL RUTE
  mapRoutingControl = L.Routing.control({
    waypoints: [],
    routeWhileDragging: false,
    addWaypoints: false,
    show: true,
    collapsible: true,
    lineOptions: { styles: [{ color: "#4f46e5", opacity: 0.8, weight: 6 }] },
    createMarker: function () {
      return null;
    },
  }).addTo(userCanvassingMap);

  if (!document.getElementById("leaflet-routing-fix")) {
    const style = document.createElement("style");
    style.id = "leaflet-routing-fix";
    style.innerHTML = `.leaflet-routing-container { background-color: rgba(255, 255, 255, 0.95) !important; color: #1e293b !important; border-radius: 12px !important; box-shadow: 0 4px 15px rgba(0,0,0,0.1) !important; max-height: 180px !important; overflow-y: auto !important; font-family: 'Plus Jakarta Sans', sans-serif !important; } .leaflet-routing-alt h2 { font-size: 13px !important; font-weight: 800 !important; } .leaflet-routing-alt h3 { font-size: 11px !important; } .leaflet-routing-alt table { width: 100% !important; font-size: 11px !important; } .leaflet-routing-collapse-btn { font-size: 18px !important; color: #4f46e5 !important; font-weight: bold !important; right: 5px !important; top: 5px !important; }`;
    document.head.appendChild(style);
  }

  // 3. UBAH TITIK BIRU JADI FOTO PROFIL (LOKASI DIRI SENDIRI)
  const currentUserFullData = USERS[loggedInUser.username];
  const userName = currentUserFullData?.name || loggedInUser.username.toUpperCase();
  const userPhotoUrl = currentUserFullData?.photo || `https://ui-avatars.com/api/?name=${userName}&background=0D8ABC&color=fff`;

  userLocMarker = L.marker([-6.2088, 106.8456], {
    icon: L.divIcon({
      html: `<div style="width:34px; height:34px; border-radius:50%; border:3px solid #3b82f6; box-shadow:0 0 10px rgba(59,130,246,0.8); overflow:hidden; background:white; position:relative; z-index:10;"><img src="${userPhotoUrl}" style="width:100%; height:100%; object-fit:cover;"></div>`,
      className: "",
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    }),
    zIndexOffset: 1000 // Agar posisi diri sendiri selalu di atas marker lain
  }).addTo(userCanvassingMap);

  let isUserMapCentered = false;

  // Lacak Lokasi Realtime Diri Sendiri
  if (loggedInUser && loggedInUser.username) {
    database
      .ref(`ocm_canvassing/${loggedInUser.username}`)
      .on("value", (snap) => {
        let data = snap.val();
        if (data && data.lat && data.lng) {
          let latlng = [data.lat, data.lng];
          userLocMarker.setLatLng(latlng);
          
          // Kamera mengikuti hanya di awal buka peta agar tidak mengganggu scroll
          if (!isUserMapCentered) {
            userCanvassingMap.setView(latlng, 15);
            isUserMapCentered = true;
          }
        }
      });
  }

  // 4. FITUR RADAR: LACAK LOKASI REKAN KERJA YANG SEDANG CANVASSING
  database.ref("ocm_canvassing").on("value", (snapshot) => {
    const data = snapshot.val();
    
    // Bersihkan marker rekan kerja jika mereka offline/selesai
    for (let id in window.userPeerMarkers) {
      if (!data || !data[id] || data[id].status !== "active" || id === loggedInUser.username) {
        userCanvassingMap.removeLayer(window.userPeerMarkers[id]);
        delete window.userPeerMarkers[id];
      }
    }

    if (data) {
      Object.keys(data).forEach((id) => {
        const user = data[id];
        
        // Abaikan lokasi diri sendiri (karena sudah ada userLocMarker) & user yang offline
        if (id === loggedInUser.username || user.status !== "active" || !user.lat) return;

        const markerColor = user.sos ? "#ef4444" : "#10b981"; // Merah = Darurat, Hijau = Aman
        const displayAvatarsUrl = `https://ui-avatars.com/api/?name=${user.nama || id}&background=0D8ABC&color=fff`;
        const photoUrl = user.foto || displayAvatarsUrl;
        
        const markerHtml = `
            <div class="canvassing-marker ${user.sos ? 'sos-active animate-pulse' : ''}" 
                 style="border: 3px solid ${markerColor}; display: flex; justify-content: center; align-items: center; border-radius: 50%; overflow: hidden; width: 100%; height: 100%; background: white; cursor: pointer; box-shadow: 0 2px 5px rgba(0,0,0,0.3);">
                <img src="${photoUrl}" alt="profil" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;" />
            </div>`;
        
        const customIcon = L.divIcon({
          className: "custom-div-icon-av",
          html: markerHtml,
          iconSize: [32, 32],
          iconAnchor: [16, 32],
          popupAnchor: [0, -34],
        });

        let timeString = "-";
        if (user.waktu_update) {
          const dateObj = new Date(user.waktu_update);
          timeString = dateObj.toLocaleTimeString("id-ID", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          });
        }

        const popupContentHtml = `
            <div class="text-center p-1 min-w-[120px]">
                <p class="text-xs font-bold text-slate-800">${user.nama || id}</p>
                <p class="text-[10px] text-slate-500 mb-1">Rekan Kerja</p>
                <div class="bg-slate-50 border border-slate-100 rounded p-1.5 mb-2">
                    <p class="text-[10px] font-semibold flex justify-between mb-1"><span>Baterai:</span> <span class="text-emerald-600">${user.battery || "-"}</span></p>
                    <p class="text-[10px] font-semibold flex justify-between"><span>Update :</span> <span class="font-mono text-indigo-600">${timeString}</span></p>
                </div>
                ${user.sos ? '<p class="text-[10px] font-bold text-white bg-rose-500 px-2 py-1 rounded shadow-sm animate-pulse">🚨 Darurat SOS!!!</p>' : '<p class="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-1 rounded">Aktif Canvassing</p>'}
            </div>`;

        if (window.userPeerMarkers[id]) {
          window.userPeerMarkers[id].setLatLng([user.lat, user.lng]);
          window.userPeerMarkers[id].setIcon(customIcon);
          if (window.userPeerMarkers[id].getPopup()) {
            window.userPeerMarkers[id].getPopup().setContent(popupContentHtml);
          } else {
            window.userPeerMarkers[id].bindPopup(popupContentHtml);
          }
        } else {
          window.userPeerMarkers[id] = L.marker([user.lat, user.lng], {
            icon: customIcon,
          }).addTo(userCanvassingMap);
          window.userPeerMarkers[id].bindPopup(popupContentHtml);
        }
      });
    }
  });

  // 5. TAMPILKAN TITIK TUGAS
  database.ref("ocm_task_markers").on("value", (snapshot) => {
    const data = snapshot.val();
    for (let id in userTaskMarkers) {
      userCanvassingMap.removeLayer(userTaskMarkers[id]);
      delete userTaskMarkers[id];
    }

    if (data && loggedInUser && loggedInUser.username) {
      Object.keys(data).forEach((id) => {
        const markerData = data[id];
        if (markerData.assignedTo === loggedInUser.username) {
          let isVisited = markerData.status === "visited";
          let dotColor = isVisited ? "#10b981" : "#e11d48";
          let titleDot = isVisited ? "Titik Dikunjungin" : "Titik Tugas";

          const taskIcon = L.divIcon({
            className: "task-marker",
            html: `<div style="background-color: ${dotColor}; width: 18px; height: 18px; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 6px rgba(0,0,0,0.4); cursor:pointer;"></div>`,
            iconSize: [18, 18],
            iconAnchor: [9, 9],
          });
          const marker = L.marker([markerData.lat, markerData.lng], {
            icon: taskIcon,
          }).addTo(userCanvassingMap);

          let dynamicActionBtn = isVisited
            ? `<div class="bg-emerald-50 text-emerald-700 text-[10px] font-bold p-2 rounded text-center border border-emerald-200 mt-1">✅ Kunjungan Selesai</div>`
            : `<button onclick="tutupPopupDanBukaKamera('${id}')" class="bg-purple-600 hover:bg-purple-700 text-white text-[10px] font-bold px-3 py-1.5 rounded shadow cursor-pointer transition w-full mt-1 border border-purple-700">📸 Ambil Foto Bukti</button>`;

          const popupContent = document.createElement("div");
          popupContent.className = "p-1 min-w-[140px]";
          popupContent.innerHTML = `<div class="text-center mb-2"><p class="text-xs font-bold ${isVisited ? "text-emerald-700" : "text-slate-800"}">📍 ${titleDot}</p></div><div class="flex flex-col gap-1.5"><button id="btn-rute-lokal-${id}" class="bg-blue-600 hover:bg-blue-700 text-white text-[10px] font-bold px-3 py-1.5 rounded shadow cursor-pointer transition w-full">🗺️ Rute di Peta Ini</button><button id="btn-rute-gmaps-${id}" class="bg-emerald-500 hover:bg-emerald-600 text-white text-[10px] font-bold px-3 py-1.5 rounded shadow cursor-pointer transition w-full">📍 Buka Google Maps</button><button id="btn-batal-rute-${id}" class="hidden bg-slate-500 hover:bg-slate-600 text-white text-[10px] font-bold px-3 py-1.5 rounded shadow cursor-pointer transition w-full border border-slate-600">❌ Batalkan Rute</button>${dynamicActionBtn}</div>`;

          marker.bindPopup(popupContent);

          marker.on("popupopen", () => {
            const btnBatal = document.getElementById(`btn-batal-rute-${id}`);
            const btnRuteLokal = document.getElementById(`btn-rute-lokal-${id}`);

            if (window.currentActiveRouteId === id) {
              btnBatal.classList.remove("hidden");
              btnRuteLokal.classList.add("hidden");
            } else {
              btnBatal.classList.add("hidden");
              btnRuteLokal.classList.remove("hidden");
            }

            document.getElementById(`btn-rute-lokal-${id}`).onclick = () => {
              activeDestination = L.latLng(markerData.lat, markerData.lng);
              if (userLocMarker && mapRoutingControl) {
                mapRoutingControl.setWaypoints([
                  userLocMarker.getLatLng(),
                  activeDestination,
                ]);
                window.currentActiveRouteId = id;
              }
              marker.closePopup();
            };

            document.getElementById(`btn-rute-gmaps-${id}`).onclick = () => {
              window.open(`https://www.google.com/maps/dir/?api=1&destination=${markerData.lat},${markerData.lng}`, "_blank");
              marker.closePopup();
            };

            document.getElementById(`btn-batal-rute-${id}`).onclick = () => {
              if (mapRoutingControl) {
                mapRoutingControl.setWaypoints([]);
                window.currentActiveRouteId = null;
              }
              marker.closePopup();
            };
          });
          userTaskMarkers[id] = marker;
        }
      });
    }
  });
}


function toggleUserMapSidebar() {
  const panel = document.getElementById("user-map-sidebar");
  const icon = document.getElementById("icon-toggle-usermap");
  if (!panel) return;

  if (panel.classList.contains("translate-x-full")) {
    panel.classList.remove("translate-x-full");
    if (icon)
      icon.innerHTML =
        '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path>';
    if (userCanvassingMap)
      setTimeout(() => userCanvassingMap.invalidateSize(), 300);
  } else {
    panel.classList.add("translate-x-full");
    if (icon)
      icon.innerHTML =
        '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path>';
  }
}

// ==========================================
// SISTEM KAMERA BUKTI KERJA CANVASSING
// ==========================================
let activeCameraStream = null;
let currentTaskIdForPhoto = null;
let currentFacingMode = "environment"; // Default kamera belakang

// Fungsi pembantu untuk menutup popup Leaflet dengan aman sebelum buka kamera
window.tutupPopupDanBukaKamera = function(taskId) {
    if (userCanvassingMap) {
        userCanvassingMap.closePopup(); 
    }
    openCameraPanel(taskId);
};

// Fungsi memutar kamera (Depan / Belakang)
window.toggleCamera = function() {
    currentFacingMode = currentFacingMode === "environment" ? "user" : "environment";
    
    // Matikan stream saat ini
    if (activeCameraStream) {
        activeCameraStream.getTracks().forEach(track => track.stop());
        activeCameraStream = null;
    }
    // Nyalakan ulang dengan mode baru
    bukaKameraStream();
};

async function openCameraPanel(taskId) {
  currentTaskIdForPhoto = taskId;
  const canvassingPanel = document.getElementById("floating-canvassing");
  const cameraPanel = document.getElementById("camera-panel");

  if (canvassingPanel) canvassingPanel.classList.add("hidden");
  cameraPanel.classList.remove("hidden");
  cameraPanel.classList.add("flex");

  document.getElementById("photo-preview").classList.add("hidden");
  document.getElementById("camera-stream").classList.remove("hidden");
  document.getElementById("camera-controls").classList.remove("hidden");
  document.getElementById("camera-controls").classList.add("flex");
  document.getElementById("preview-controls").classList.add("hidden");
  document.getElementById("preview-controls").classList.remove("flex");

  // --- AUTO-INJECT KOTAK PRATINJAU PETA & TEKS ---
  let guideOverlay = document.getElementById("camera-guide-overlay");
  if (!guideOverlay) {
    const videoContainer = document.getElementById("camera-stream").parentElement;
    guideOverlay = document.createElement("div");
    guideOverlay.id = "camera-guide-overlay";
    guideOverlay.className =
      "absolute bottom-0 left-0 w-full h-[175px] bg-black/40 border-t border-white/30 pointer-events-none flex items-center px-[20px] z-[9999]";
    guideOverlay.innerHTML = `
            <div class="w-[125px] h-[125px] border-2 border-dashed border-white/70 rounded-xl flex items-center justify-center bg-black/20 shrink-0">
                <span class="text-white/70 text-[10px] font-bold text-center">Area Peta<br>Akan Muncul<br>Di Sini</span>
            </div>
            <div class="ml-6 flex-1 space-y-3">
                 <div class="h-4 bg-white/40 rounded w-3/4"></div>
                 <div class="h-2.5 bg-white/30 rounded w-full"></div>
                 <div class="h-2.5 bg-white/30 rounded w-5/6"></div>
                 <div class="h-2.5 bg-white/30 rounded w-4/6"></div>
            </div>
        `;
    videoContainer.appendChild(guideOverlay);
  } else {
    guideOverlay.classList.remove("hidden");
    guideOverlay.classList.add("flex");
  }

  bukaKameraStream();
}

async function bukaKameraStream() {
    try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            showToast("Akses kamera diblokir browser. Pastikan web menggunakan HTTPS!", "error");
            closeCameraPanel();
            return;
        }

        activeCameraStream = await navigator.mediaDevices.getUserMedia({ 
            video: { facingMode: currentFacingMode } 
        });
        
        const videoEl = document.getElementById('camera-stream');
        videoEl.srcObject = activeCameraStream;
        
        // Agar kamera depan terlihat seperti cermin saat preview
        if (currentFacingMode === "user") {
            videoEl.style.transform = "scaleX(-1)";
        } else {
            videoEl.style.transform = "scaleX(1)";
        }

    } catch (err) {
        console.error(err);
        showToast("Gagal mengakses kamera.", "error");
        closeCameraPanel();
    }
}

function closeCameraPanel() {
    if (activeCameraStream) {
        activeCameraStream.getTracks().forEach(track => track.stop());
        activeCameraStream = null;
    }
    document.getElementById('camera-panel').classList.add('hidden');
    document.getElementById('camera-panel').classList.remove('flex');
    
    const canvassingPanel = document.getElementById('floating-canvassing');
    if(canvassingPanel) canvassingPanel.classList.remove('hidden');
}

// ----------------------------------------------------
// FITUR WATERMARK GPS ALAMAT & WAKTU (ASYNC TINGKAT LANJUT)
// ----------------------------------------------------
async function capturePhoto() {
  const video = document.getElementById("camera-stream");
  const canvas = document.getElementById("camera-canvas");
  const preview = document.getElementById("photo-preview");
  const ctx = canvas.getContext("2d");

  // 1. Ubah tombol menjadi status loading
  const btnContainer = document.getElementById("camera-controls");
  const btnJepret = btnContainer.querySelector(
    "button[onclick='capturePhoto()']",
  );
  const originalBtnHTML = btnJepret ? btnJepret.innerHTML : "";
  if (btnJepret) {
    btnJepret.innerHTML = "⏳ Memproses Lokasi & Peta...";
    btnJepret.disabled = true;
  }

  try {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    // 2. Gambar frame video
    if (currentFacingMode === "user") {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // 3. Ambil Data Koordinat
    let lat = "-",
      lng = "-";
    const latEl = document.getElementById("canvassing-lat");
    const lngEl = document.getElementById("canvassing-lng");

    if (latEl && latEl.textContent !== "-")
      lat = parseFloat(latEl.textContent).toFixed(5);
    if (lngEl && lngEl.textContent !== "-")
      lng = parseFloat(lngEl.textContent).toFixed(5);

    // 4. Proses Reverse Geocoding (Rinci: Jalan, Kelurahan, Kecamatan)
    let detailLokasi = "Memuat detail lokasi...";
    if (lat !== "-" && lng !== "-") {
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`,
        );
        const data = await res.json();

        if (data && data.address) {
          let addr = data.address;
          let jalan = addr.road || addr.pedestrian || "";
          let kelurahan =
            addr.village ||
            addr.suburb ||
            addr.neighbourhood ||
            addr.residential ||
            "";
          let kecamatan =
            addr.city_district || addr.county || addr.town || addr.city || "";

          let parts = [];
          if (jalan) parts.push(jalan);
          if (kelurahan) parts.push("Kel. " + kelurahan);
          if (kecamatan) parts.push("Kec. " + kecamatan);

          detailLokasi = parts.join(", ");

          if (!detailLokasi)
            detailLokasi = data.display_name.split(",").slice(0, 3).join(", ");

          // Potong teks jika terlalu panjang
          if (detailLokasi.length > 48) {
            detailLokasi = detailLokasi.substring(0, 45) + "...";
          }
        }
      } catch (err) {
        detailLokasi = "Gagal memuat data jalan";
      }
    }

    // 5. Format Tanggal & Waktu
    const dateOpts = {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    };
    const timeOpts = {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    };
    const dateStr = new Date().toLocaleDateString("id-ID", dateOpts);
    const timeStr = new Date()
      .toLocaleTimeString("id-ID", timeOpts)
      .replace(/\./g, ":");

    // 6. Menggambar Background Watermark Hitam Transparan
    const boxHeight = 175;
    const boxY = canvas.height - boxHeight;
    const padding = 20;

    ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
    ctx.fillRect(0, boxY, canvas.width, boxHeight);
    ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
    ctx.fillRect(0, boxY, canvas.width, 2);

    // 7. Menggambar Peta Lokasi (Sistem Grid 3x3)
    const mapBoxSize = 125;
    const mapBoxY = boxY + (boxHeight - mapBoxSize) / 2;

    const centerX = padding + mapBoxSize / 2;
    const centerY = mapBoxY + mapBoxSize / 2;

    let mapLoaded = false;

    const drawRoundedRect = (x, y, w, h, r) => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    };

    if (lat !== "-" && lng !== "-") {
      const zoom = 16;
      const latNum = parseFloat(lat);
      const lngNum = parseFloat(lng);

      const n = Math.pow(2, zoom);
      const xExact = ((lngNum + 180) / 360) * n;
      const yExact =
        ((1 -
          Math.log(
            Math.tan((latNum * Math.PI) / 180) +
              1 / Math.cos((latNum * Math.PI) / 180),
          ) /
            Math.PI) /
          2) *
        n;

      const tileX = Math.floor(xExact);
      const tileY = Math.floor(yExact);

      const xFraction = xExact - tileX;
      const yFraction = yExact - tileY;

      const tileSize = 256;

      const mainTileDrawX = centerX - xFraction * tileSize;
      const mainTileDrawY = centerY - yFraction * tileSize;

      const promises = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const promise = new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = "Anonymous";
            img.src = `https://tile.openstreetmap.org/${zoom}/${tileX + dx}/${tileY + dy}.png`;
            img.onload = () => resolve({ img, dx, dy });
            img.onerror = () => resolve(null); 
          });
          promises.push(promise);
        }
      }

      const loadedTiles = await Promise.all(promises);

      // Load foto profil user untuk Watermark
      const currentUserFullData = USERS[loggedInUser.username];
      const userName =
        currentUserFullData?.name || loggedInUser.username.toUpperCase();
      const userPhoto =
        currentUserFullData?.photo ||
        `https://ui-avatars.com/api/?name=${userName}&background=0D8ABC&color=fff`;

      const profileImg = await new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = "Anonymous";
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = userPhoto;
      });

      ctx.save();
      drawRoundedRect(padding, mapBoxY, mapBoxSize, mapBoxSize, 12);
      ctx.clip();

      ctx.fillStyle = "#e2e8f0";
      ctx.fillRect(padding, mapBoxY, mapBoxSize, mapBoxSize);

      for (const tile of loadedTiles) {
        if (tile) {
          const drawX = mainTileDrawX + tile.dx * tileSize;
          const drawY = mainTileDrawY + tile.dy * tileSize;
          ctx.drawImage(tile.img, drawX, drawY, tileSize, tileSize);
        }
      }
      ctx.restore();

      ctx.strokeStyle = "rgba(255,255,255,0.8)";
      ctx.lineWidth = 2.5;
      drawRoundedRect(padding, mapBoxY, mapBoxSize, mapBoxSize, 12);
      ctx.stroke();

      if (profileImg) {
        ctx.save();
        ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
        ctx.shadowBlur = 6;
        ctx.shadowOffsetY = 2;

        ctx.beginPath();
        ctx.arc(centerX, centerY, 14, 0, 2 * Math.PI); 
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.shadowColor = "transparent"; 

        ctx.beginPath();
        ctx.arc(centerX, centerY, 12, 0, 2 * Math.PI); 
        ctx.clip();

        ctx.drawImage(profileImg, centerX - 12, centerY - 12, 24, 24);
        ctx.restore();
      } else {
        ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
        ctx.shadowBlur = 6;
        ctx.shadowOffsetY = 2;

        ctx.beginPath();
        ctx.arc(centerX, centerY, 6.5, 0, 2 * Math.PI);
        ctx.fillStyle = "#ef4444";
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();

        ctx.shadowColor = "transparent";
      }

      mapLoaded = true;
    }

    if (!mapLoaded) {
      ctx.fillStyle = "#334155";
      drawRoundedRect(padding, mapBoxY, mapBoxSize, mapBoxSize, 12);
      ctx.fill();

      ctx.font = "40px Arial";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("📍", centerX, centerY - 10);
      ctx.fillStyle = "#cbd5e1";
      ctx.font = "bold 14px Arial";
      ctx.fillText("MAPS", centerX, centerY + 18);
    }

    // 8. Menulis Teks Watermark 
    const textStartX = padding + mapBoxSize + 25;
    let currentTextY = mapBoxY + 5;

    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 20px sans-serif";
    ctx.fillText("Titik Kunjungan SFDM", textStartX, currentTextY);

    currentTextY += 32;

    ctx.font = "14px sans-serif";
    const colWidth = 90;

    const printRow = (label, value) => {
      ctx.fillStyle = "#94a3b8";
      ctx.fillText(label, textStartX, currentTextY);

      ctx.fillStyle = "#ffffff";
      ctx.fillText(":", textStartX + colWidth, currentTextY);
      ctx.fillText(value, textStartX + colWidth + 10, currentTextY);

      currentTextY += 21;
    };

    const userIdText = loggedInUser
      ? loggedInUser.username.toUpperCase()
      : "UNKNOWN";

    printRow("ID Karyawan", userIdText);
    printRow("Lokasi", detailLokasi);
    printRow("Lat, Long", `${lat}, ${lng}`);
    printRow("Tanggal", dateStr);
    printRow("Waktu", timeStr);

    // 9. Selesai dan Tampilkan Preview
    preview.src = canvas.toDataURL("image/jpeg", 0.85);

    const guideOverlay = document.getElementById("camera-guide-overlay");
    if (guideOverlay) {
      guideOverlay.classList.add("hidden");
      guideOverlay.classList.remove("flex");
    }

    video.classList.add("hidden");
    preview.classList.remove("hidden");
    document.getElementById("camera-controls").classList.add("hidden");
    document.getElementById("camera-controls").classList.remove("flex");
    document.getElementById("preview-controls").classList.remove("hidden");
    document.getElementById("preview-controls").classList.add("flex");
  } finally {
    if (btnJepret) {
      btnJepret.innerHTML = originalBtnHTML;
      btnJepret.disabled = false;
    }
  }
}

function retakePhoto() {
  document.getElementById("photo-preview").classList.add("hidden");
  document.getElementById("camera-stream").classList.remove("hidden");

  // Munculkan kembali kotak pratinjau
  const guideOverlay = document.getElementById("camera-guide-overlay");
  if (guideOverlay) {
    guideOverlay.classList.remove("hidden");
    guideOverlay.classList.add("flex");
  }

  document.getElementById("camera-controls").classList.remove("hidden");
  document.getElementById("camera-controls").classList.add("flex");
  document.getElementById("preview-controls").classList.add("hidden");
  document.getElementById("preview-controls").classList.remove("flex");
}

function confirmPhotoUpload() {
  const canvas = document.getElementById("camera-canvas");
  const btnConfirm = document.getElementById("btn-confirm-photo");

  btnConfirm.innerHTML = "Mengunggah... ⏳";
  btnConfirm.disabled = true;

  canvas.toBlob(
    (blob) => {
      const file = new File(
        [blob],
        `bukti_${loggedInUser.username}_${Date.now()}.jpg`,
        { type: "image/jpeg" },
      );
      showLoading();
      
      // Memanfaatkan parameter expiration (isExpiring) agar sinkron dengan yang ada di script 8.2
      uploadToImgbb(file, true).then((url) => {
        hideLoading();
        btnConfirm.innerHTML = "Kirim & Selesai";
        btnConfirm.disabled = false;

        if (url) {
          database
            .ref(`ocm_task_markers/${currentTaskIdForPhoto}`)
            .update({ status: "visited", foto_bukti: url })
            .then(() => {
              showToast("Bukti kerja berhasil disimpan!", "success");
              closeCameraPanel();
            });
        } else {
          showToast("Gagal mengunggah foto ke server.", "error");
        }
      });
    },
    "image/jpeg",
    0.85,
  );
}

window.showPhotoModal = function (url) {
  const modal = document.getElementById("photo-viewer-modal");
  const img = document.getElementById("viewing-photo");
  img.src = url;
  modal.classList.remove("hidden");
  modal.classList.add("flex");
  document.body.style.overflow = "hidden";
};

window.closePhotoViewer = function () {
  const modal = document.getElementById("photo-viewer-modal");
  modal.classList.add("hidden");
  modal.classList.remove("flex");
  document.body.style.overflow = "";
};
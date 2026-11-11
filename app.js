// 名刺ボックス - 名刺を撮影して管理するアプリ
// 画像を含むためデータは IndexedDB に保存します(サーバー不要)。

(() => {
  "use strict";

  const DB_NAME = "meishi-box";
  const STORE = "cards";
  const MAX_IMAGE_SIZE = 1600; // 長辺の最大ピクセル数
  const THUMB_SIZE = 480;
  const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";

  const FIELD_LABELS = {
    kana: "ふりがな",
    company: "会社名",
    department: "部署",
    title: "役職",
    phone: "電話",
    mobile: "携帯",
    email: "メール",
    url: "Web",
    address: "住所",
    metOn: "交換日",
    memo: "メモ",
  };

  const $ = (id) => document.getElementById(id);

  // ---------- IndexedDB ----------
  let dbPromise;
  function openDB() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore(STORE, { keyPath: "id" });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function tx(mode, fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      const result = fn(store);
      t.oncomplete = () => resolve(result && "result" in result ? result.result : undefined);
      t.onerror = () => reject(t.error);
    });
  }

  const dbAll = () => tx("readonly", (s) => s.getAll());
  const dbPut = (card) => tx("readwrite", (s) => s.put(card));
  const dbDelete = (id) => tx("readwrite", (s) => s.delete(id));

  // ---------- 画像処理 ----------
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  async function resizeDataUrl(dataUrl, maxSize, rotate = 0, quality = 0.85) {
    const img = await loadImage(dataUrl);
    const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const swap = rotate % 180 !== 0;
    const canvas = document.createElement("canvas");
    canvas.width = swap ? h : w;
    canvas.height = swap ? w : h;
    const ctx = canvas.getContext("2d");
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((rotate * Math.PI) / 180);
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    return canvas.toDataURL("image/jpeg", quality);
  }

  async function fileToImage(file) {
    const raw = await readFile(file);
    return resizeDataUrl(raw, MAX_IMAGE_SIZE);
  }

  // ---------- 状態 ----------
  let cards = [];
  let activeTag = null;
  let editing = null; // 編集中の名刺(下書き)
  let viewing = null; // 詳細表示中の名刺

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const today = () => new Date().toISOString().slice(0, 10);
  const parseTags = (s) =>
    [...new Set(String(s || "").split(/[,、，]/).map((t) => t.trim()).filter(Boolean))];

  // ---------- 一覧表示 ----------
  function matches(card, q) {
    if (activeTag && !(card.tags || []).includes(activeTag)) return false;
    if (!q) return true;
    const hay = [
      card.name, card.kana, card.company, card.department, card.title,
      card.email, card.phone, card.mobile, card.address, card.memo,
      ...(card.tags || []), card.ocrText,
    ].join(" ").toLowerCase();
    return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
  }

  function sortCards(list) {
    const mode = $("sort").value;
    const collator = new Intl.Collator("ja");
    const by = {
      createdDesc: (a, b) => b.createdAt - a.createdAt,
      createdAsc: (a, b) => a.createdAt - b.createdAt,
      nameAsc: (a, b) => collator.compare(a.kana || a.name || "", b.kana || b.name || ""),
      companyAsc: (a, b) => collator.compare(a.company || "", b.company || ""),
    }[mode];
    return list.slice().sort(by);
  }

  function renderTags() {
    const all = new Set();
    cards.forEach((c) => (c.tags || []).forEach((t) => all.add(t)));
    if (activeTag && !all.has(activeTag)) activeTag = null;
    const box = $("tag-filter");
    box.innerHTML = "";
    [...all].sort(new Intl.Collator("ja").compare).forEach((t) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + (t === activeTag ? " active" : "");
      b.textContent = "#" + t;
      b.onclick = () => {
        activeTag = activeTag === t ? null : t;
        render();
      };
      box.appendChild(b);
    });
  }

  function render() {
    renderTags();
    const q = $("search").value.trim();
    const list = sortCards(cards.filter((c) => matches(c, q)));
    const ul = $("card-list");
    ul.innerHTML = "";
    list.forEach((card) => {
      const li = document.createElement("li");
      li.className = "card-item";
      li.tabIndex = 0;

      const img = document.createElement("img");
      img.className = "card-thumb";
      img.alt = "";
      img.loading = "lazy";
      img.src = card.thumb || card.front || "";
      li.appendChild(img);

      const info = document.createElement("div");
      info.className = "card-info";
      const name = document.createElement("div");
      name.className = "card-name";
      name.textContent = card.name || "(名前未入力)";
      const comp = document.createElement("div");
      comp.className = "card-company";
      comp.textContent = [card.company, card.title].filter(Boolean).join(" / ");
      info.append(name, comp);
      if (card.tags && card.tags.length) {
        const tags = document.createElement("div");
        tags.className = "card-tags";
        card.tags.forEach((t) => {
          const s = document.createElement("span");
          s.className = "chip";
          s.textContent = "#" + t;
          tags.appendChild(s);
        });
        info.appendChild(tags);
      }
      li.appendChild(info);

      li.onclick = () => openDetail(card);
      li.onkeydown = (e) => { if (e.key === "Enter") openDetail(card); };
      ul.appendChild(li);
    });

    $("empty").hidden = cards.length > 0;
    $("count").textContent = cards.length
      ? `${list.length} 件表示 / 全 ${cards.length} 件`
      : "";
  }

  // ---------- 詳細 ----------
  function openDetail(card) {
    viewing = card;
    $("detail-front").src = card.front || "";
    $("detail-front").hidden = !card.front;
    $("detail-back").src = card.back || "";
    $("detail-back").hidden = !card.back;
    $("detail-name").textContent = card.name || "(名前未入力)";
    $("detail-sub").textContent = [card.company, card.department, card.title].filter(Boolean).join(" ");

    const dl = $("detail-fields");
    dl.innerHTML = "";
    const add = (label, value, href) => {
      if (!value) return;
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      if (href) {
        const a = document.createElement("a");
        a.href = href;
        a.textContent = value;
        if (href.startsWith("http")) { a.target = "_blank"; a.rel = "noopener"; }
        dd.appendChild(a);
      } else {
        dd.textContent = value;
      }
      dl.append(dt, dd);
    };
    add(FIELD_LABELS.kana, card.kana);
    add(FIELD_LABELS.phone, card.phone, card.phone && "tel:" + card.phone.replace(/[^\d+]/g, ""));
    add(FIELD_LABELS.mobile, card.mobile, card.mobile && "tel:" + card.mobile.replace(/[^\d+]/g, ""));
    add(FIELD_LABELS.email, card.email, card.email && "mailto:" + card.email);
    add(FIELD_LABELS.url, card.url, card.url && (/^https?:\/\//.test(card.url) ? card.url : "https://" + card.url));
    add(FIELD_LABELS.address, card.address,
      card.address && "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(card.address));
    add(FIELD_LABELS.metOn, card.metOn);
    add("タグ", (card.tags || []).map((t) => "#" + t).join(" "));
    add(FIELD_LABELS.memo, card.memo);

    $("detail-dialog").showModal();
  }

  function showLarge(src) {
    if (!src) return;
    $("photo-large").src = src;
    $("photo-dialog").showModal();
  }

  // ---------- 編集 ----------
  const form = $("edit-form");
  const FORM_FIELDS = ["name", "kana", "company", "department", "title", "phone",
    "mobile", "email", "url", "address", "metOn", "memo"];

  function openEditor(draft, isNew) {
    editing = { ...draft };
    $("edit-title").textContent = isNew ? "名刺を登録" : "名刺を編集";
    FORM_FIELDS.forEach((f) => { form.elements[f].value = editing[f] || ""; });
    form.elements.tags.value = (editing.tags || []).join(", ");
    $("ocr-status").hidden = true;
    refreshEditorPhotos();
    $("edit-dialog").showModal();
  }

  function refreshEditorPhotos() {
    $("edit-front").src = editing.front || "";
    $("edit-front").hidden = !editing.front;
    $("edit-back").src = editing.back || "";
    $("edit-back").hidden = !editing.back;
  }

  async function saveEditor() {
    FORM_FIELDS.forEach((f) => { editing[f] = form.elements[f].value.trim(); });
    editing.tags = parseTags(form.elements.tags.value);
    editing.updatedAt = Date.now();
    editing.thumb = editing.front
      ? await resizeDataUrl(editing.front, THUMB_SIZE, 0, 0.75)
      : "";
    const toSave = { ...editing };
    await dbPut(toSave);
    const idx = cards.findIndex((c) => c.id === toSave.id);
    if (idx >= 0) cards[idx] = toSave; else cards.push(toSave);
    editing = null;
    $("edit-dialog").close();
    render();
  }

  // ---------- 文字読み取り(OCR) ----------
  let tesseractLoading;
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (!tesseractLoading) {
      tesseractLoading = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = TESSERACT_URL;
        s.onload = () => resolve(window.Tesseract);
        s.onerror = () => { tesseractLoading = null; reject(new Error("OCRライブラリを読み込めませんでした")); };
        document.head.appendChild(s);
      });
    }
    return tesseractLoading;
  }

  // 読み取ったテキストから項目を推定(空欄のみ埋める)
  function extractFields(text) {
    const lines = text.split(/\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
    const flat = text.replace(/\s+/g, " ");
    // 数字の間のスペースを除去した版(OCRは数字を分割しがち)
    const compact = flat.replace(/(\d)\s+(?=[\d\-‐－()])/g, "$1").replace(/([\-‐－()])\s+(?=\d)/g, "$1");
    const out = {};

    const email = flat.replace(/\s*@\s*/g, "@").match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/);
    if (email) out.email = email[0];

    const url = flat.match(/(https?:\/\/)?(www\.)[\w-]+(\.[\w-]+)+[\w\/\-.?=&#%]*/i) ||
      flat.match(/https?:\/\/[\w-]+(\.[\w-]+)+[\w\/\-.?=&#%]*/i);
    if (url) out.url = url[0];

    const phoneRe = /(\+81[\s-]?)?\(?0\d{1,4}\)?[-‐－\s]?\d{1,4}[-‐－\s]\d{3,4}/g;
    const phones = compact.match(phoneRe) || [];
    phones.forEach((p) => {
      const n = p.replace(/[‐－]/g, "-").trim();
      if (/^(\+81[\s-]?)?0[789]0/.test(n.replace(/[()]/g, ""))) {
        if (!out.mobile) out.mobile = n;
      } else if (!out.phone) {
        // FAX番号は除外
        const idx = compact.indexOf(p);
        const before = compact.slice(Math.max(0, idx - 6), idx);
        if (!/fax/i.test(before)) out.phone = n;
      }
    });

    const addrLine = lines.find((l) => /〒|[都道府県].*[市区町村郡]/.test(l));
    if (addrLine) out.address = addrLine.replace(/^(住所|所在地)[:：]?\s*/, "");

    const companyLine = lines.find((l) =>
      /(株式会社|有限会社|合同会社|一般社団法人|公益財団法人|\(株\)|（株）|Inc\.?|Co\.,? ?Ltd\.?|Corporation|LLC)/i.test(l));
    if (companyLine) out.company = companyLine;

    const titleRe = /(代表取締役|取締役|社長|副社長|部長|課長|係長|主任|室長|所長|マネージャー|マネジャー|ディレクター|エンジニア|リーダー|CEO|CTO|COO|CFO|Manager|Director)/;
    const titleLine = lines.find((l) => titleRe.test(l) && l !== companyLine);
    if (titleLine) {
      const deptMatch = titleLine.match(/^(.*?(部|課|室|グループ|チーム|センター|事業部))\s*(.*)$/);
      if (deptMatch && deptMatch[3]) {
        out.department = deptMatch[1];
        out.title = deptMatch[3];
      } else {
        out.title = titleLine;
      }
    }

    // 氏名: 漢字/かなのみで 2〜8 文字程度の短い行を候補にする
    const used = new Set([companyLine, titleLine, addrLine]);
    const nameLine = lines.find((l) => {
      if (used.has(l)) return false;
      const s = l.replace(/\s/g, "");
      return /^[\u4E00-\u9FFF\u3040-\u30FF々ヶ]{2,8}$/.test(s);
    });
    if (nameLine) out.name = nameLine;

    return out;
  }

  async function runOcr() {
    if (!editing || !editing.front) return;
    const status = $("ocr-status");
    const btn = $("btn-ocr");
    status.hidden = false;
    btn.disabled = true;
    try {
      status.textContent = "OCRエンジンを読み込み中...(初回は数十秒かかることがあります)";
      const Tesseract = await loadTesseract();
      const { data } = await Tesseract.recognize(editing.front, "jpn+eng", {
        logger: (m) => {
          if (m.status === "recognizing text") {
            status.textContent = `文字を読み取り中... ${Math.round(m.progress * 100)}%`;
          }
        },
      });
      editing.ocrText = data.text;
      const found = extractFields(data.text);
      let filled = 0;
      Object.entries(found).forEach(([k, v]) => {
        const el = form.elements[k];
        if (el && !el.value.trim() && v) { el.value = v; filled++; }
      });
      status.textContent = filled
        ? `${filled} 項目を自動入力しました。内容を確認・修正してください。`
        : "項目を特定できませんでした。手入力してください(読み取った文字は検索に使われます)。";
    } catch (err) {
      console.error(err);
      status.textContent = "読み取りに失敗しました: " + (err.message || err) + "(オフライン時は利用できません)";
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- vCard ----------
  function toVCard(c) {
    const esc = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");
    const lines = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      `FN:${esc(c.name)}`,
      `N:${esc(c.name)};;;;`,
    ];
    if (c.kana) lines.push(`X-PHONETIC-LAST-NAME:${esc(c.kana)}`);
    if (c.company || c.department) lines.push(`ORG:${esc(c.company)}${c.department ? ";" + esc(c.department) : ""}`);
    if (c.title) lines.push(`TITLE:${esc(c.title)}`);
    if (c.phone) lines.push(`TEL;TYPE=WORK,VOICE:${esc(c.phone)}`);
    if (c.mobile) lines.push(`TEL;TYPE=CELL:${esc(c.mobile)}`);
    if (c.email) lines.push(`EMAIL;TYPE=WORK:${esc(c.email)}`);
    if (c.url) lines.push(`URL:${esc(c.url)}`);
    if (c.address) lines.push(`ADR;TYPE=WORK:;;${esc(c.address)};;;;`);
    if (c.memo) lines.push(`NOTE:${esc(c.memo)}`);
    lines.push("END:VCARD");
    return lines.join("\r\n");
  }

  function download(filename, content, type) {
    const blob = new Blob([content], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- イベント ----------
  async function handleImageInput(input, apply) {
    const file = input.files && input.files[0];
    input.value = "";
    if (!file) return;
    try {
      apply(await fileToImage(file));
    } catch (e) {
      alert("画像を読み込めませんでした。");
    }
  }

  $("capture").addEventListener("change", (e) =>
    handleImageInput(e.target, (img) => {
      openEditor({ id: uid(), createdAt: Date.now(), front: img, metOn: today(), tags: [] }, true);
    }));

  $("retake-front").addEventListener("change", (e) =>
    handleImageInput(e.target, (img) => { editing.front = img; refreshEditorPhotos(); }));

  $("add-back").addEventListener("change", (e) =>
    handleImageInput(e.target, (img) => { editing.back = img; refreshEditorPhotos(); }));

  $("btn-rotate").addEventListener("click", async () => {
    if (!editing || !editing.front) return;
    editing.front = await resizeDataUrl(editing.front, MAX_IMAGE_SIZE, 90, 0.9);
    refreshEditorPhotos();
  });

  $("btn-ocr").addEventListener("click", runOcr);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    saveEditor().catch((err) => {
      console.error(err);
      alert("保存に失敗しました。ストレージの空き容量を確認してください。");
    });
  });

  $("btn-cancel").addEventListener("click", () => { editing = null; $("edit-dialog").close(); });

  $("btn-close").addEventListener("click", () => $("detail-dialog").close());
  $("btn-edit").addEventListener("click", () => {
    $("detail-dialog").close();
    openEditor(viewing, false);
  });
  $("btn-delete").addEventListener("click", async () => {
    if (!viewing || !confirm(`「${viewing.name || "この名刺"}」を削除しますか?`)) return;
    await dbDelete(viewing.id);
    cards = cards.filter((c) => c.id !== viewing.id);
    $("detail-dialog").close();
    render();
  });
  $("btn-vcard").addEventListener("click", () => {
    if (!viewing) return;
    download(`${viewing.name || "contact"}.vcf`, toVCard(viewing), "text/vcard");
  });

  $("detail-front").addEventListener("click", (e) => showLarge(e.target.src));
  $("detail-back").addEventListener("click", (e) => showLarge(e.target.src));
  $("photo-dialog").addEventListener("click", () => $("photo-dialog").close());

  // ダイアログの外側クリックで閉じる(編集中は誤操作防止のため閉じない)
  $("detail-dialog").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) e.currentTarget.close();
  });

  $("search").addEventListener("input", render);
  $("sort").addEventListener("change", render);

  $("btn-export").addEventListener("click", () => {
    if (!cards.length) { alert("書き出す名刺がありません。"); return; }
    const data = { app: "meishi-box", version: 1, exportedAt: new Date().toISOString(), cards };
    download(`meishi-backup-${today()}.json`, JSON.stringify(data), "application/json");
  });

  $("import-file").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const list = Array.isArray(data) ? data : data.cards;
      if (!Array.isArray(list)) throw new Error("形式が正しくありません");
      let n = 0;
      for (const c of list) {
        if (!c || typeof c !== "object" || !c.id) continue;
        await dbPut(c);
        n++;
      }
      cards = await dbAll();
      render();
      alert(`${n} 件の名刺を読み込みました。`);
    } catch (err) {
      alert("読み込みに失敗しました: " + err.message);
    }
  });

  // ---------- 起動 ----------
  (async () => {
    try {
      cards = await dbAll();
    } catch (e) {
      alert("データベースを開けませんでした。プライベートブラウズでは利用できない場合があります。");
    }
    render();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  })();

  // ---------- アプリ化(PWA) ----------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW登録失敗", e));
    });
  }

  // Android/PCのChrome系: インストールボタンを表示
  let installPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPrompt = e;
    $("install-banner").hidden = false;
  });
  $("btn-install").addEventListener("click", async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    $("install-banner").hidden = true;
  });
  $("btn-install-close").addEventListener("click", () => { $("install-banner").hidden = true; });
  window.addEventListener("appinstalled", () => { $("install-banner").hidden = true; });

  // テスト用に公開
  window.__meishi = { extractFields };
})();

const MONTHS = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
const DOW = ["Pz", "Pt", "Sa", "Ça", "Pe", "Cu", "Ct"];
const $ = (id) => document.getElementById(id);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

let state;
let plan;
let dragFrom;

const year = () => Number($("year").value);
const month = () => Number($("month").value);
const nurseName = (id) => state.nurses.find((n) => n.id === id)?.name ?? "?";
const cellKey = (i, d) => `${state.nurses[i].id}|${d + 1}`;

const STORAGE_KEY = "hemsire-nobet-state";

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    $("status").textContent = "Kaydedildi";
  } catch {
    $("status").textContent = "Kaydedilemedi, yedek indirmeyi unutma";
  }
}

function loadSaved() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function useState(s) {
  state = s;
  state.prevRest ??= {};
  state.prefs ??= {};
  state.schedules ??= {};
  render();
}

function update(change) {
  change();
  render();
  save();
}

function monthShifts() {
  return new Set(state.schedules[monthKey(year(), month())]);
}

function setMonthShifts(set) {
  state.schedules[monthKey(year(), month())] = [...set];
}

function onCellClick(i, d) {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  if (mode !== "shift") return togglePref(i, d, mode);
  if (!plan.shifts[i][d] && blockedPopup([[i, d]])) return;
  update(() => {
    const set = monthShifts();
    const key = cellKey(i, d);
    set.has(key) ? set.delete(key) : set.add(key);
    setMonthShifts(set);
  });
}

function togglePref(i, d, value) {
  update(() => {
    const prefs = (state.prefs[monthKey(year(), month())] ??= {});
    const key = cellKey(i, d);
    prefs[key] === value ? delete prefs[key] : (prefs[key] = value);
  });
}

function onDrop(from, to) {
  const fromKey = cellKey(from.i, from.d);
  const toKey = cellKey(to.i, to.d);
  if (fromKey === toKey) return;
  const swap = plan.shifts[to.i][to.d];
  if (blockedPopup(swap ? [[from.i, to.d], [to.i, from.d]] : [[to.i, to.d]])) return;
  update(() => {
    const set = monthShifts();
    if (swap) {
      const swapA = cellKey(from.i, to.d);
      const swapB = cellKey(to.i, from.d);
      set.delete(fromKey);
      set.delete(toKey);
      set.add(swapA);
      set.add(swapB);
    } else {
      set.delete(fromKey);
      set.add(toKey);
    }
    setMonthShifts(set);
  });
}

function popup(title, items) {
  $("errors-title").textContent = title;
  $("errors-list").innerHTML = items.map((e) => `<li>${esc(e)}</li>`).join("");
  $("errors").showModal();
}

// Shows why a shift cannot be placed on the given [nurse, day] cells; returns true if any is blocked.
function blockedPopup(cells) {
  const reasons = cells
    .filter(([i, d]) => plan.blocked[i][d])
    .map(([i, d]) => {
      const why = plan.leave[i][d] ? "yıllık izinde"
        : plan.rest[i][d] || (d === 0 && plan.prevRest[i]) ? "nöbet izninde"
        : plan.off[i][d] ? "çalışmak istemiyor"
        : "yol izninde";
      return `${state.nurses[i].name}, ${d + 1} ${MONTHS[month()]} günü ${why}.`;
    });
  if (reasons.length) popup("Nöbet yazılamaz", reasons);
  return reasons.length > 0;
}

function showErrors() {
  const { errors } = plan;
  const title = `${MONTHS[month()]} ${year()}: ${errors.length ? `${errors.length} hata` : "hata yok"}`;
  popup(title, errors.length ? errors : [`Her gün ${state.perDay} kişi çalışıyor, izin ve üst üste nöbet çakışması yok.`]);
}

function renderGrid() {
  plan = checkSchedule(state, year(), month(), state.schedules[monthKey(year(), month())] ?? []);
  const { daysInMonth, leave, rest, want, off, prevRest, longGap, shortRests, shifts, count, dayCount, bad, errors } = plan;
  const prevDay = new Date(year(), month(), 0).toLocaleDateString("tr-TR", { day: "numeric", month: "short" });
  const dows = Array.from({ length: daysInMonth }, (_, d) => new Date(year(), month(), d + 1).getDay());
  const col = (d) => [(dows[d] === 0 || dows[d] === 6) && "weekend", dows[d] === 1 && d > 0 && "week-start"];
  const cls = (...names) => names.flat().filter(Boolean).join(" ");

  const head = `<thead><tr><th class="name">Ad Soyad</th><th class="prev" title="Önceki ayın son günü (${prevDay}) nöbet tutanlar">N<br><span class="dow">${prevDay}</span></th>${dows
    .map((dow, d) => `<th class="${cls(col(d))}">${d + 1}<br><span class="dow">${DOW[dow]}</span></th>`)
    .join("")}<th>Nöbet</th><th title="Nöbet başına 24 saat, yıllık izin günü başına 8 saat">Saat</th><th title="3 günden kısa dinlenme sayısı">Kısa ara</th></tr></thead>`;

  const body = state.nurses.map((n, i) => `<tr><td class="name"><input type="text" value="${esc(n.name)}" data-rename="${n.id}"><button title="Sil" data-remove-nurse="${n.id}">×</button></td><td class="${cls("prev", prevRest[i] && "shift")}" data-prev="${n.id}">${prevRest[i] ? "N" : ""}</td>${dows
    .map((_, d) => {
      const on = shifts[i][d];
      const resting = rest[i][d] || (d === 0 && prevRest[i]);
      const c = cls(col(d), on && "shift", on && bad[i][d] && "bad", !on && leave[i][d] && "leave", !on && resting && "rest",
        !on && longGap[i][d] && "gap", want[i][d] && "want", off[i][d] && "off");
      const text = on ? "N" : leave[i][d] ? "İ" : resting ? "Nİ" : off[i][d] ? "×" : want[i][d] ? "+" : "";
      return `<td class="${c}" data-i="${i}" data-d="${d}" ${on ? 'draggable="true"' : ""}>${text}</td>`;
    })
    .join("")}<td>${count[i]}</td><td>${count[i] * 24 + leave[i].filter(Boolean).length * 8}</td><td>${shortRests[i]}</td></tr>`).join("") +
    `<tr class="add-row"><td class="name"><form id="add-nurse"><input id="new-nurse" type="text" placeholder="+ Hemşire ekle"></form></td></tr>`;

  const foot = `<tfoot><tr><td class="name">Günlük toplam</td><td class="prev">${prevRest.filter(Boolean).length}</td>${dayCount
    .map((c, d) => `<td class="${cls(col(d), c !== state.perDay && "bad")}">${c}</td>`)
    .join("")}<td>${count.reduce((a, b) => a + b, 0)}</td><td></td><td></td></tr></tfoot>`;

  $("grid").innerHTML = head + `<tbody>${body}</tbody>` + foot;
  $("check").textContent = errors.length ? `Kontrol et (${errors.length} hata)` : "Kontrol et";
  $("check").classList.toggle("has-errors", errors.length > 0);
}

function renderNurses() {
  const selected = $("leave-nurse").value;
  $("leave-nurse").innerHTML = state.nurses.map((n) => `<option value="${n.id}">${esc(n.name)}</option>`).join("");
  if (selected) $("leave-nurse").value = selected;
}

const fmt = (iso, opts = { day: "numeric", month: "short", year: "numeric" }) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("tr-TR", opts);
};
const dayCountOf = (l) => Math.round((Date.parse(l.end) - Date.parse(l.start)) / 86400000) + 1;
const prepText = (l) => {
  const { work, rest } = leavePrep(l);
  const short = (iso) => fmt(iso, { day: "numeric", month: "short" });
  return `${short(work[0])} ve ${short(work[1])} nöbet, ${short(rest)} nöbet izni`;
};

function renderLeaves() {
  const from = isoDate(year(), month(), 1);
  const to = isoDate(year(), month(), new Date(year(), month() + 1, 0).getDate());
  const visible = state.leaves
    .map((l, idx) => ({ ...l, idx }))
    .filter((l) => $("leave-all").checked || (l.start <= to && l.end >= from))
    .sort((a, b) => a.start.localeCompare(b.start) || nurseName(a.nurseId).localeCompare(nurseName(b.nurseId), "tr"));
  $("leaves").innerHTML = visible.length
    ? visible.map((l) => `<tr>
        <td>${esc(nurseName(l.nurseId))}</td>
        <td>${fmt(l.start)} – ${fmt(l.end)}</td>
        <td class="days">${dayCountOf(l)}</td>
        <td class="prep">${prepText(l)}</td>
        <td><button data-remove-leave="${l.idx}">Sil</button></td>
      </tr>`).join("")
    : `<tr><td class="empty" colspan="5">${$("leave-all").checked ? "Henüz izin girilmedi." : `${MONTHS[month()]} ${year()} için izin yok.`}</td></tr>`;
}

function leaveDraft() {
  const start = $("leave-start").value;
  const end = $("leave-end").value || start;
  if (!start) return { message: "" };
  if (end < start) return { error: "Bitiş tarihi başlangıçtan önce olamaz." };
  const leave = { nurseId: $("leave-nurse").value, start, end };
  return { leave, message: `${dayCountOf(leave)} gün izin. ${prepText(leave)} yazılacak.` };
}

function renderLeavePreview() {
  const { error, message } = leaveDraft();
  $("leave-preview").textContent = error || message;
  $("leave-preview").classList.toggle("error", Boolean(error));
}

// Touches only this nurse: clears rest, travel and leave days, adds the shifts before and after.
// A month without a saved schedule gets the same rules when it is generated.
function applyLeavePrep(leave) {
  const { work, rest } = leavePrep(leave);
  for (let date = rest; date <= addDays(leave.end, 2); date = addDays(date, 1)) setShift(leave.nurseId, date, false);
  for (const date of work) setShift(leave.nurseId, date, true);
}

function setShift(nurseId, date, on) {
  const keys = state.schedules[date.slice(0, 7)];
  if (!keys) return;
  const key = `${nurseId}|${Number(date.slice(8))}`;
  const set = new Set(keys);
  on ? set.add(key) : set.delete(key);
  state.schedules[date.slice(0, 7)] = [...set];
}

function render() {
  renderGrid();
  renderNurses();
  renderLeaves();
}

const cellOf = (el) => {
  const td = el.closest("td[data-i]");
  return td && { td, i: Number(td.dataset.i), d: Number(td.dataset.d) };
};
const clearOver = () => document.querySelectorAll("td.over").forEach((td) => td.classList.remove("over"));

$("grid").addEventListener("click", (e) => {
  const prevId = e.target.dataset.prev;
  if (prevId) {
    const key = monthKey(year(), month());
    const marked = new Set(state.prevRest[key]);
    marked.has(prevId) ? marked.delete(prevId) : marked.add(prevId);
    return update(() => (state.prevRest[key] = [...marked]));
  }
  const c = cellOf(e.target);
  if (c) onCellClick(c.i, c.d);
});
$("grid").addEventListener("dragstart", (e) => {
  dragFrom = cellOf(e.target);
  e.dataTransfer.effectAllowed = "move";
});
$("grid").addEventListener("dragover", (e) => {
  const c = cellOf(e.target);
  if (!c) return;
  e.preventDefault();
  clearOver();
  c.td.classList.add("over");
});
$("grid").addEventListener("drop", (e) => {
  e.preventDefault();
  const c = cellOf(e.target);
  if (c && dragFrom) onDrop(dragFrom, c);
});
$("grid").addEventListener("dragend", () => {
  dragFrom = undefined;
  clearOver();
});

$("check").addEventListener("click", showErrors);
$("autofill").addEventListener("click", () => {
  const key = monthKey(year(), month());
  const filled = state.schedules[key]?.length;
  if (filled && !confirm(`${MONTHS[month()]} ${year()} nöbetleri silinip otomatik yeniden doldurulsun mu? Elle yaptığın değişiklikler kaybolur.`)) return;
  update(() => (state.schedules[key] = generateSchedule(state, year(), month())));
});
$("clear").addEventListener("click", () => {
  if (!confirm(`${MONTHS[month()]} ${year()} nöbetleri silinsin mi? İzinler, işaretler ve tercihler kalır.`)) return;
  update(() => (state.schedules[monthKey(year(), month())] = []));
});

$("grid").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("new-nurse").value.trim();
  if (!name) return;
  update(() => state.nurses.push({ id: `n${Date.now()}`, name }));
  $("new-nurse").focus();
});
$("grid").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.dataset.rename) e.target.blur();
});
$("grid").addEventListener("change", (e) => {
  const id = e.target.dataset.rename;
  const name = e.target.value.trim();
  if (id && name) update(() => (state.nurses.find((n) => n.id === id).name = name));
});
$("grid").addEventListener("click", (e) => {
  const id = e.target.dataset.removeNurse;
  if (!id || !confirm(`${nurseName(id)} silinsin mi? İzinleri ve tüm nöbetleri de silinir.`)) return;
  update(() => {
    state.nurses = state.nurses.filter((n) => n.id !== id);
    state.leaves = state.leaves.filter((l) => l.nurseId !== id);
    for (const [key, keys] of Object.entries(state.schedules)) {
      state.schedules[key] = keys.filter((k) => !k.startsWith(`${id}|`));
    }
  });
});

$("add-leave").addEventListener("submit", (e) => {
  e.preventDefault();
  const { leave } = leaveDraft();
  if (!leave) return;
  update(() => {
    state.leaves.push(leave);
    applyLeavePrep(leave);
  });
  $("leave-start").value = "";
  $("leave-end").value = "";
  renderLeavePreview();
});
$("add-leave").addEventListener("input", renderLeavePreview);
$("leave-start").addEventListener("change", () => {
  if (!$("leave-end").value || $("leave-end").value < $("leave-start").value) $("leave-end").value = $("leave-start").value;
  renderLeavePreview();
});
$("leave-all").addEventListener("change", renderLeaves);
$("leaves").addEventListener("click", (e) => {
  const idx = e.target.dataset.removeLeave;
  if (idx !== undefined) update(() => state.leaves.splice(Number(idx), 1));
});

$("month").innerHTML = MONTHS.map((m, i) => `<option value="${i}">${m}</option>`).join("");
$("month").value = 11;
$("year").value = 2026;
$("month").addEventListener("change", render);
$("year").addEventListener("change", render);

$("backup-download").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `nobet-yedek-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  URL.revokeObjectURL(url);
});
$("backup-upload").addEventListener("click", () => $("backup-file").click());
$("backup-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  let s;
  try {
    s = JSON.parse(await file.text());
  } catch {
    return popup("Yedek yüklenemedi", ["Dosya okunamadı. Bu sitenin \"Yedek indir\" ile indirdiği .json dosyasını seç."]);
  }
  if (!Array.isArray(s?.nurses) || !Array.isArray(s?.leaves)) {
    return popup("Yedek yüklenemedi", ["Bu dosya bir nöbet yedeği değil."]);
  }
  if (!confirm(`Yedekteki ${s.nurses.length} hemşire, izinler ve çizelgeler yüklensin mi? Şu anki veriler silinir.`)) return;
  useState(s);
  save();
});

useState(loadSaved() ?? { perDay: 6, nurses: [], leaves: [] });

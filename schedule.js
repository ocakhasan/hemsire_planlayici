function isoDate(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function monthKey(year, month) {
  return isoDate(year, month, 1).slice(0, 7);
}

// Every-other-day shifts (one free day between two shifts) allowed per nurse per month.
const MAX_ALTERNATE = 2;
// Longest run of free days between shifts; leave-related days end a run.
const MAX_GAP = 4;

function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + n));
  return isoDate(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

// Leave is wrapped in two travel days ("yol izni") on each side. Before the travel days the
// nurse has a post-shift rest day ("nöbet izni"), so their last shift is the day before that;
// they work again right after the return travel days.
function leavePrep(leave) {
  return {
    work: [addDays(leave.start, -4), addDays(leave.end, 3)],
    rest: addDays(leave.start, -3),
    travel: [addDays(leave.start, -2), addDays(leave.start, -1), addDays(leave.end, 1), addDays(leave.end, 2)],
  };
}

function dayMatrices(state, year, month, daysInMonth) {
  const dates = Array.from({ length: daysInMonth }, (_, d) => isoDate(year, month, d + 1));
  const byNurse = (test) => state.nurses.map((n) => dates.map((date) => state.leaves.some((l) => l.nurseId === n.id && test(l, date))));
  const leave = byNurse((l, date) => date >= l.start && date <= l.end);
  const rest = byNurse((l, date) => leavePrep(l).rest === date).map((row, i) => row.map((r, d) => r && !leave[i][d]));
  const travel = byNurse((l, date) => leavePrep(l).travel.includes(date)).map((row, i) => row.map((t, d) => t && !leave[i][d]));
  // Marked by hand per day: "want" is a requested shift, "off" a day the nurse does not want to work.
  const prefs = state.prefs[monthKey(year, month)] ?? {};
  const pref = (value) => state.nurses.map((n) => dates.map((_, d) => prefs[`${n.id}|${d + 1}`] === value));
  const want = pref("want");
  const off = pref("off");
  const work = byNurse((l, date) => leavePrep(l).work.includes(date)).map((row, i) => row.map((w, d) => (w || want[i][d]) && !leave[i][d]));
  // Marked by hand: nurses who worked the previous month's last day rest on day 1.
  const marked = new Set(state.prevRest[monthKey(year, month)]);
  const prevRest = state.nurses.map((n) => marked.has(n.id));
  const breaks = leave.map((row, i) => row.map((l, d) => l || rest[i][d] || travel[i][d]));
  const blocked = breaks.map((row, i) => row.map((b, d) => b || off[i][d] || (d === 0 && prevRest[i])));
  return { leave, rest, travel, want, off, work, prevRest, breaks, blocked };
}

// Free days in a row after each day, starting from the run carried in from before day 1.
function gapRuns(row, breaks, startRun) {
  let run = startRun;
  return row.map((on, d) => (run = on || breaks[d] ? 0 : run + 1));
}

function savedShifts(state, year, month) {
  const keys = state.schedules[monthKey(year, month)];
  if (!keys) return undefined;
  const set = new Set(keys);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  return state.nurses.map((n) => Array.from({ length: daysInMonth }, (_, d) => set.has(`${n.id}|${d + 1}`)));
}

// Free-day run each nurse brings into the month from the previous month's saved schedule;
// a hand-marked last-day shift means 0. Without a saved previous month only the hand-marked
// last day is known, so an unmarked nurse brings 1 free day.
function carriedRuns(state, year, month, prevRest) {
  const [py, pm] = month === 0 ? [year - 1, 11] : [year, month - 1];
  const prev = savedShifts(state, py, pm);
  if (!prev) return prevRest.map((p) => (p ? 0 : 1));
  const { breaks } = dayMatrices(state, py, pm, prev[0]?.length ?? 0);
  return prev.map((row, i) => (prevRest[i] ? 0 : gapRuns(row, breaks[i], 0).at(-1) ?? 0));
}

// Free days at the start of the next month's saved schedule, or undefined if not planned yet.
function nextLeads(state, year, month) {
  const [ny, nm] = month === 11 ? [year + 1, 0] : [year, month + 1];
  const next = savedShifts(state, ny, nm);
  if (!next) return undefined;
  const { breaks } = dayMatrices(state, ny, nm, next[0]?.length ?? 0);
  return next.map((row, i) => {
    const end = row.findIndex((on, d) => on || breaks[i][d]);
    return end === -1 ? row.length : end;
  });
}

// Preferred rest is 3 free days after a shift; shorter rest is used only when needed.
function restPenalty(lastShift, d) {
  return Math.max(0, 3 - (d - lastShift - 1));
}

// Every-other-day shifts in a nurse's month; prev is whether they worked the previous month's last day.
function alternateCount(row, prev) {
  const at = (d) => (d === -1 ? prev : row[d]);
  return row.filter((on, d) => on && !at(d - 1) && at(d - 2)).length;
}

// Most shifts a nurse can take this month under the hard rules, filling greedily around
// the fixed leave-related shifts.
function capacity(blockedRow, workRow, prev) {
  const row = workRow.map((w, d) => w && !blockedRow[d]);
  blockedRow.forEach((b, d) => {
    if (b || row[d] || row[d - 1] || row[d + 1] || (d === 0 && prev)) return;
    row[d] = true;
    if (alternateCount(row, prev) > MAX_ALTERNATE) row[d] = false;
  });
  return row.filter(Boolean).length;
}

// Equal share for everyone; a nurse who cannot reach it (leave) takes what fits and the
// remainder is spread over the others, so counts differ by at most 1 where possible.
function quotas(total, caps) {
  const order = caps.map((_, i) => i).sort((a, b) => caps[a] - caps[b] || a - b);
  const quota = caps.map(() => 0);
  let left = total;
  order.forEach((i, k) => {
    quota[i] = Math.min(caps[i], Math.ceil(left / (order.length - k)));
    left -= quota[i];
  });
  return quota;
}

// Initial plan only; after this the month is edited by hand and never regenerated silently.
// Hard rules: leave-related days, no back-to-back shifts, at most MAX_ALTERNATE every-other-day
// shifts. Soft goals: every day fully staffed, counts on each nurse's quota (equal where leave
// allows), 3 free days after a shift. Two fill orders are tried and the better result kept.
// Returns "nurseId|day" keys.
function generateSchedule(state, year, month) {
  const { nurses } = state;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const m = dayMatrices(state, year, month, daysInMonth);
  const quota = quotas(daysInMonth * state.perDay, m.blocked.map((row, i) => capacity(row, m.work[i], m.prevRest[i])));
  const carried = carriedRuns(state, year, month, m.prevRest);
  const ctx = { ...m, nurses, perDay: state.perDay, daysInMonth, quota, carried };

  // Tight months (many days marked off) depend on tie-breaks, so try several fixed orders.
  const attempts = [];
  for (let seed = 0; seed < ATTEMPTS; seed++) {
    const rank = shuffledRanks(nurses.length, seed);
    for (const urgentFirst of [false, true]) {
      const shifts = fillMonth(ctx, urgentFirst, rank);
      attempts.push({ shifts, score: scoreOf(ctx, shifts) });
    }
  }
  const best = attempts.sort((a, b) => a.score.reduce((acc, v, k) => acc || v - b.score[k], 0))[0].shifts;

  return nurses.flatMap((n, i) => best[i].flatMap((on, d) => (on ? [`${n.id}|${d + 1}`] : [])));
}

const ATTEMPTS = 12;

// Seed 0 keeps list order; other seeds give a repeatable shuffle (mulberry32).
function shuffledRanks(n, seed) {
  const ranks = Array.from({ length: n }, (_, i) => i);
  let t = seed * 0x9e3779b9;
  const random = () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = n - 1; seed && i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [ranks[i], ranks[j]] = [ranks[j], ranks[i]];
  }
  return ranks;
}

function gapCost(row, prev) {
  let last = prev ? -1 : -Infinity;
  let cost = 0;
  row.forEach((on, d) => {
    if (on) (cost += restPenalty(last, d)), (last = d);
  });
  return cost;
}

// Lower is better, compared in order: too-long gaps, understaffed slots, count spread among
// nurses without leave, distance from quotas, short rests.
function scoreOf({ nurses, perDay, daysInMonth, quota, prevRest, breaks, carried }, shifts) {
  const longGaps = nurses.reduce((acc, _, i) => acc + gapRuns(shifts[i], breaks[i], carried[i]).filter((r) => r > MAX_GAP).length, 0);
  const days = Array.from({ length: daysInMonth }, (_, d) => d);
  const understaffed = days.reduce((acc, d) => acc + Math.max(0, perDay - shifts.filter((row) => row[d]).length), 0);
  const offQuota = nurses.reduce((acc, _, i) => acc + Math.abs(shifts[i].filter(Boolean).length - quota[i]), 0);
  const rest = nurses.reduce((acc, _, i) => acc + gapCost(shifts[i], prevRest[i]), 0);
  const counts = shifts.filter((_, i) => !breaks[i].some(Boolean)).map((row) => row.filter(Boolean).length);
  const spread = counts.length ? Math.max(0, Math.max(...counts) - Math.min(...counts) - 1) : 0;
  return [longGaps, understaffed, spread, offQuota, rest];
}

// Greedy daily fill, then a repair pass that moves shifts from nurses over quota to nurses
// under it on the same day, directly or through a third nurse.
function fillMonth({ nurses, perDay, daysInMonth, quota, work, prevRest, breaks, blocked, carried }, urgentFirst, rank) {
  const freeDaysFrom = (i, d) => blocked[i].slice(d).filter((b) => !b).length || 1;
  const urgency = (i, d) => (quota[i] - count[i]) / freeDaysFrom(i, d);
  const shifts = nurses.map(() => Array(daysInMonth).fill(false));
  const count = nurses.map(() => 0);
  const lastShift = prevRest.map((p) => (p ? -1 : -Infinity));
  const alternates = nurses.map(() => 0);
  const run = [...carried];
  const shortRest = nurses.map(() => 0);

  for (let d = 0; d < daysInMonth; d++) {
    // Must work today if the next day they could work comes too late for MAX_GAP; days they
    // cannot work (marked off, rest) still count as free, leave-related days end the run.
    const mustWork = (i) => {
      if (breaks[i][d]) return false;
      let next = d + 1;
      while (next < daysInMonth && blocked[i][next] && !breaks[i][next]) next++;
      if (next < daysInMonth && breaks[i][next]) return false;
      return run[i] + (next - d) > MAX_GAP;
    };
    const forced = nurses.map((_, i) => i).filter((i) => work[i][d] && !blocked[i][d]);
    // Short rest goes to whoever has had the least of it so far.
    const burden = (i) => shortRest[i] + restPenalty(lastShift[i], d);
    const byRest = (a, b) => burden(a) - burden(b);
    const byUrgency = (a, b) => urgency(b, d) - urgency(a, d);
    const free = nurses
      .map((_, i) => i)
      .filter((i) => !blocked[i][d] && !work[i][d] && !work[i][d + 1] && lastShift[i] < d - 1)
      .filter((i) => alternates[i] + (lastShift[i] === d - 2) + Boolean(work[i][d + 2]) <= MAX_ALTERNATE)
      .sort((a, b) =>
        mustWork(b) - mustWork(a) ||
        (count[a] >= quota[a]) - (count[b] >= quota[b]) ||
        (urgentFirst ? byUrgency(a, b) || byRest(a, b) : byRest(a, b) || byUrgency(a, b)) || rank[a] - rank[b]
      )
      .slice(0, Math.max(0, perDay - forced.length));
    for (const i of [...forced, ...free]) {
      if (lastShift[i] === d - 2) alternates[i]++;
      shifts[i][d] = true;
      count[i]++;
      shortRest[i] += restPenalty(lastShift[i], d);
      lastShift[i] = d;
    }
    nurses.forEach((_, i) => (run[i] = shifts[i][d] || breaks[i][d] ? 0 : run[i] + 1));
  }

  const canTake = (i, d) => {
    if (blocked[i][d] || shifts[i][d] || shifts[i][d - 1] || shifts[i][d + 1]) return false;
    shifts[i][d] = true;
    const ok = alternateCount(shifts[i], prevRest[i]) <= MAX_ALTERNATE;
    shifts[i][d] = false;
    return ok;
  };
  const gapsOk = (i) => gapRuns(shifts[i], breaks[i], carried[i]).every((r) => r <= MAX_GAP);
  const move = (from, to, d) => {
    shifts[from][d] = false;
    shifts[to][d] = true;
    count[from]--;
    count[to]++;
  };
  const directMove = (hi, under) => {
    let best;
    for (const lo of under) {
      for (let d = 0; d < daysInMonth; d++) {
        if (!shifts[hi][d] || work[hi][d] || !canTake(lo, d)) continue;
        move(hi, lo, d);
        const cost = gapCost(shifts[hi], prevRest[hi]) + gapCost(shifts[lo], prevRest[lo]);
        const ok = gapsOk(hi);
        move(lo, hi, d);
        if (ok && (!best || cost < best.cost)) best = { lo, d, cost };
      }
    }
    return best && (move(hi, best.lo, best.d), true);
  };
  const chainMove = (hi, lo) => {
    for (let d = 0; d < daysInMonth; d++) {
      if (!shifts[hi][d] || work[hi][d]) continue;
      for (let mid = 0; mid < nurses.length; mid++) {
        if (mid === hi || mid === lo || !canTake(mid, d)) continue;
        move(hi, mid, d);
        if (gapsOk(hi)) {
          for (let e = 0; e < daysInMonth; e++) {
            if (!shifts[mid][e] || work[mid][e] || !canTake(lo, e)) continue;
            move(mid, lo, e);
            if (gapsOk(mid)) return true;
            move(lo, mid, e);
          }
        }
        move(mid, hi, d);
      }
    }
    return false;
  };

  const fits = (i) =>
    shifts[i].every((on, d) => !on || (!blocked[i][d] && !shifts[i][d + 1])) &&
    alternateCount(shifts[i], prevRest[i]) <= MAX_ALTERNATE &&
    gapsOk(i);
  const swap = (a, b, d, e) => {
    move(a, b, d);
    move(b, a, e);
  };

  // Fill days the greedy pass left short with whoever can still take a shift, fewest shifts first.
  for (let d = 0; d < daysInMonth; d++) {
    const short = perDay - nurses.filter((_, i) => shifts[i][d]).length;
    nurses
      .map((_, i) => i)
      .filter((i) => canTake(i, d))
      .sort((a, b) => count[a] - count[b] || a - b)
      .slice(0, Math.max(0, short))
      .forEach((i) => ((shifts[i][d] = true), count[i]++));
  }

  // Close gaps longer than MAX_GAP: give the nurse a shift inside the gap and take that day
  // from someone who can spare it; if their own neighbouring shift is in the way, move it into
  // the gap and hand its old day to someone else. Day totals stay the same.
  const longDays = (i) => gapRuns(shifts[i], breaks[i], carried[i]).filter((r) => r > MAX_GAP).length;
  const snapshot = () => shifts.map((row) => [...row]);
  const restore = (snap) => snap.forEach((row, k) => ((shifts[k] = row), (count[k] = row.filter(Boolean).length)));
  const others = (except) => nurses.map((_, j) => j).filter((j) => j !== except);
  const giveUp = (t, except) => {
    const j = others(except)
      .filter((j) => shifts[j][t] && !work[j][t])
      .sort((a, b) => count[b] - count[a] || a - b)
      .find((j) => ((shifts[j][t] = false), (shifts[j][t] = !gapsOk(j)), !shifts[j][t]));
    if (j === undefined) return false;
    count[j]--;
    return true;
  };
  const takeOver = (a, except) => {
    const j = others(except).filter((j) => canTake(j, a)).sort((x, y) => count[x] - count[y] || x - y)[0];
    if (j === undefined) return false;
    shifts[j][a] = true;
    count[j]++;
    return true;
  };
  const closeGap = (i) => {
    const before = longDays(i);
    for (let t = 0; t < daysInMonth; t++) {
      if (shifts[i][t] || blocked[i][t]) continue;
      for (const a of [undefined, t - 1, t + 1]) {
        if (a !== undefined && (!shifts[i][a] || work[i][a])) continue;
        const snap = snapshot();
        if (a !== undefined) (shifts[i][a] = false), count[i]--;
        const ok = canTake(i, t) && ((shifts[i][t] = true), count[i]++, longDays(i) < before) &&
          giveUp(t, i) && (a === undefined || takeOver(a, i));
        if (ok) return true;
        restore(snap);
      }
    }
    return false;
  };
  for (let fixed = true; fixed; ) fixed = nurses.some((_, i) => longDays(i) > 0 && closeGap(i));

  const rebalance = (isOver, isUnder) => {
    for (let moved = true; moved; ) {
      const over = nurses.map((_, i) => i).filter(isOver);
      const under = nurses.map((_, i) => i).filter(isUnder);
      moved =
        over.some((hi) => directMove(hi, under)) ||
        over.some((hi) => under.some((lo) => chainMove(hi, lo)));
    }
  };
  rebalance((i) => count[i] > quota[i], (i) => count[i] < quota[i]);
  // Quotas can overestimate what a nurse with leave can take; close any gap of 2 or more directly.
  rebalance((i) => count[i] === Math.max(...count), (i) => count[i] <= Math.max(...count) - 2);

  // Long rest is a privilege, so short rests are shared evenly: swap shift days between a
  // nurse with more short rest and one with less, keeping every count unchanged.
  const trySwap = (a, b, cost) => {
    for (let d = 0; d < daysInMonth; d++) {
      if (!shifts[a][d] || shifts[b][d] || work[a][d]) continue;
      for (let e = 0; e < daysInMonth; e++) {
        if (!shifts[b][e] || shifts[a][e] || work[b][e]) continue;
        swap(a, b, d, e);
        const [ca, cb] = [restCost(a), restCost(b)];
        if (fits(a) && fits(b) && ca * ca + cb * cb < cost[a] * cost[a] + cost[b] * cost[b]) return true;
        swap(a, b, e, d);
      }
    }
    return false;
  };
  const restCost = (i) => gapCost(shifts[i], prevRest[i]);
  for (let improved = true; improved; ) {
    const cost = nurses.map((_, i) => restCost(i));
    const byCost = nurses.map((_, i) => i).sort((x, y) => cost[x] - cost[y]);
    improved = [...byCost]
      .reverse()
      .some((a) => byCost.filter((b) => cost[b] < cost[a] - 1).some((b) => trySwap(a, b, cost)));
  }
  return shifts;
}

function checkSchedule(state, year, month, keys) {
  const { nurses, perDay } = state;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const { leave, rest, travel, want, off, prevRest, breaks, blocked } = dayMatrices(state, year, month, daysInMonth);
  const carried = carriedRuns(state, year, month, prevRest);
  const leads = nextLeads(state, year, month);
  const set = new Set(keys);
  const shifts = nurses.map((n) => Array.from({ length: daysInMonth }, (_, d) => set.has(`${n.id}|${d + 1}`)));
  const count = shifts.map((row) => row.filter(Boolean).length);
  const dayCount = Array.from({ length: daysInMonth }, (_, d) => shifts.filter((row) => row[d]).length);
  // Marks each every-other-day shift beyond the monthly cap.
  const overAlternate = shifts.map((row, i) => {
    let seen = 0;
    return row.map((on, d) => on && !row[d - 1] && (d === 1 ? prevRest[i] : row[d - 2]) && ++seen > MAX_ALTERNATE);
  });
  const bad = shifts.map((row, i) =>
    row.map((on, d) => on && (blocked[i][d] || row[d - 1] || row[d + 1] || overAlternate[i][d]))
  );

  const runs = shifts.map((row, i) => gapRuns(row, breaks[i], carried[i]));
  // Rests shorter than the preferred 3 free days; shown per nurse to judge fairness.
  const shortRests = shifts.map((row, i) => {
    let last = prevRest[i] ? -1 : -Infinity;
    let short = 0;
    row.forEach((on, d) => {
      if (!on) return;
      if (d - last - 1 < 3) short++;
      last = d;
    });
    return short;
  });
  const longGap = runs.map((row) => row.map((r) => r > MAX_GAP));

  const errors = [];
  dayCount.forEach((c, d) => {
    if (c !== perDay) errors.push(`${d + 1}. gün: ${c} kişi çalışıyor (${perDay} olmalı)`);
  });
  nurses.forEach((n, i) => {
    shifts[i].forEach((on, d) => {
      if (on && leave[i][d]) errors.push(`${n.name}: ${d + 1}. gün izinli ama nöbeti var`);
      if (on && rest[i][d]) errors.push(`${n.name}: ${d + 1}. gün izin öncesi nöbet izni ama nöbeti var`);
      if (on && d === 0 && prevRest[i]) errors.push(`${n.name}: 1. gün nöbet izni (önceki ayın son günü nöbet) ama nöbeti var`);
      if (on && off[i][d]) errors.push(`${n.name}: ${d + 1}. gün çalışmak istemiyor ama nöbeti var`);
      if (!on && want[i][d]) errors.push(`${n.name}: ${d + 1}. gün çalışmak istiyor ama nöbeti yok`);
      if (on && travel[i][d]) errors.push(`${n.name}: ${d + 1}. gün yol izni ama nöbeti var`);
      if (on && shifts[i][d + 1]) errors.push(`${n.name}: ${d + 1} ve ${d + 2}. gün üst üste nöbet`);
      if (longGap[i][d] && !longGap[i][d + 1]) {
        errors.push(`${n.name}: ${d + 1}. güne kadar ${runs[i][d]} gün boşluk (en fazla ${MAX_GAP}, önceki ay dahil)`);
      }
      if (overAlternate[i][d]) errors.push(`${n.name}: ${d - 1} ve ${d + 1}. gün gün aşırı nöbet (ayda en fazla ${MAX_ALTERNATE} kez)`);
    });
  });

  if (leads) {
    nurses.forEach((n, i) => {
      const end = runs[i][daysInMonth - 1];
      if (end <= MAX_GAP && end + leads[i] > MAX_GAP) {
        errors.push(`${n.name}: ay sonu ve sonraki ay başı ile ${end + leads[i]} gün boşluk (en fazla ${MAX_GAP})`);
      }
    });
  }

  // Nurses without leave this month can always be balanced, so a spread above 1 is a mistake.
  const fullMonth = nurses.map((_, i) => i).filter((i) => !leave[i].some((l, d) => l || rest[i][d] || travel[i][d]));
  if (fullMonth.length) {
    const [low, high] = [Math.min, Math.max].map((f) => fullMonth.reduce((a, b) => (f(count[a], count[b]) === count[a] ? a : b)));
    if (count[high] - count[low] > 1) {
      errors.push(`Nöbet sayıları dengesiz: ${nurses[high].name} ${count[high]}, ${nurses[low].name} ${count[low]} (izni olmayanlar arasında fark en fazla 1 olmalı)`);
    }
  }

  return { daysInMonth, leave, rest, travel, want, off, prevRest, blocked, longGap, shortRests, shifts, count, dayCount, bad, errors };
}

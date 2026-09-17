import { finishSignIn, signIn, signOut, getSession, getAccessToken } from './auth.mjs';
import { createAppPicksApi } from './picks-api.mjs';
const cloudApi = createAppPicksApi(getAccessToken);
let accountMode = false;
let cloudReady = false;
let saving = false;
const cloudSelections = new Map();
const ACCOUNT_STATUS = document.getElementById('accountStatus');
const SIGN_IN = document.getElementById('signIn');
const SIGN_OUT = document.getElementById('signOut');
SIGN_IN.addEventListener('click', () => signIn().catch(() => { ACCOUNT_STATUS.textContent = 'Could not start sign-in. Check that browser storage is enabled.'; }));
SIGN_OUT.addEventListener('click', signOut);

// app.js — NFL Schedule (ESPN unofficial API)
// Features: Light-theme friendly, status headers (Final/Live/Upcoming), outlines per state,
// sort by status then kickoff time, auto-refreshes while games are LIVE.

const GRID = document.getElementById("grid");
const STATUS = document.getElementById("statusBar");
const WEEK_SELECT = document.getElementById("weekSelect");
const PREV_BTN = document.getElementById("prevWeek");
const NEXT_BTN = document.getElementById("nextWeek");
const REFRESH_BTN = document.getElementById("refreshBtn");
const SEASON_LABEL = document.getElementById("seasonLabel");
// Tunables
const DEFAULT_SEASON_TYPE = 2; // 1=Pre, 2=Reg, 3=Post
const AUTO_REFRESH_MS = 30000; // 30s live refresh

const state = {
  seasonYear: null,
  seasonType: DEFAULT_SEASON_TYPE,
  week: null,
  maxWeeks: 18,
  liveEventIds: new Set(),
  refreshTimer: null,
  requestId: 0,
  selections: new Map(),
};

// ---- Status helpers: Final → Live → Upcoming, then start time
const STATUS_ORDER = { post: 0, in: 1, pre: 2 };
function getState(e){
  return (e?.competitions?.[0]?.status?.type?.state || e?.status?.type?.state || "").toLowerCase();
}
function sortEvents(evts){
  return evts.slice().sort((a,b) => {
    const sa = STATUS_ORDER[getState(a)] ?? 3;
    const sb = STATUS_ORDER[getState(b)] ?? 3;
    if (sa !== sb) return sa - sb;
    return new Date(a.date) - new Date(b.date);
  });
}

// Bootstrap
init();

async function init(){
  try{
    try { await finishSignIn(); }
    catch (error) { ACCOUNT_STATUS.textContent = error.message; }
    accountMode = !!getSession();
    SIGN_IN.hidden = accountMode;
    SIGN_OUT.hidden = !accountMode;
    if (accountMode) ACCOUNT_STATUS.textContent = 'Signed in. Loading your cloud picks…';
    STATUS.textContent = "Loading current week…";
    // Detect current season/year/week
    const base = await fetchJSON("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard");
    const league = base?.leagues?.[0];
    const currentSeason = base?.season || league?.season;
    const currentWeek = league?.week?.number || base?.week?.number;

    const now = new Date();
    state.seasonYear = currentSeason?.year || (now.getMonth() < 2 ? now.getFullYear() - 1 : now.getFullYear());

    // Derive regular season max weeks if available
    const calendar = Array.isArray(league?.calendar) ? league.calendar : [];
    const regSeasonEntry = calendar.find((c) => typeof c.label === "string" && /regular/i.test(c.label));
    if (regSeasonEntry?.entries?.length){
      state.maxWeeks = regSeasonEntry.entries.length;
    }

    // Clamp current week
    const seasonType = Number(base?.season?.type || league?.season?.type?.type || 2);
    state.week = clamp(seasonType === 2 ? (currentWeek || 1) : (seasonType === 1 ? 1 : state.maxWeeks), 1, state.maxWeeks);

    // Populate Week selector
    WEEK_SELECT.innerHTML = "";
    for (let i=1; i<=state.maxWeeks; i++){
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = i;
      if (i === state.week) opt.selected = true;
      WEEK_SELECT.appendChild(opt);
    }

    SEASON_LABEL.textContent = `Season ${state.seasonYear} • Regular Season`;

    // Wire controls
    WEEK_SELECT.addEventListener("change", () => {
      state.week = parseInt(WEEK_SELECT.value, 10);
      loadWeek();
    });
    PREV_BTN.addEventListener("click", () => {
      if (state.week > 1){ state.week--; WEEK_SELECT.value = state.week; loadWeek(); }
    });
    NEXT_BTN.addEventListener("click", () => {
      if (state.week < state.maxWeeks){ state.week++; WEEK_SELECT.value = state.week; loadWeek(); }
    });
    REFRESH_BTN.addEventListener("click", () => loadWeek());

    await loadWeek();
  }catch(err){
    console.error(err);
    STATUS.textContent = "Failed to load current week. Try refresh.";
  }
}

async function loadWeek(){
  if (saving) return;
  cloudReady = false;
  const requestId = ++state.requestId;
  clearInterval(state.refreshTimer);
  PREV_BTN.disabled = state.week <= 1;
  NEXT_BTN.disabled = state.week >= state.maxWeeks;
  state.liveEventIds.clear();
  STATUS.textContent = `Loading Week ${state.week}…`;
  GRID.innerHTML = "";

  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${state.seasonYear}&seasontype=${state.seasonType}&week=${state.week}&limit=1000`;
  try {
  const data = await fetchJSON(url);
  if (requestId !== state.requestId) return;

  if (accountMode) {
    try {
      const picks = await cloudApi.listPicks(state.seasonYear, state.week);
      if (requestId !== state.requestId) return;
      cloudSelections.clear();
      for (const pick of picks) cloudSelections.set(String(pick.eventId), pick.selectionHomeAway);
      cloudReady = true;
      ACCOUNT_STATUS.textContent = 'Signed in. Picks save to your account.';
    } catch (error) {
      if (requestId !== state.requestId) return;
      cloudSelections.clear();
      ACCOUNT_STATUS.textContent = 'Could not load cloud picks. Refresh to retry, or sign out and sign in again.';
    }
  }
  const events = Array.isArray(data?.events) ? sortEvents(data.events) : [];
  if (!events.length){
    STATUS.textContent = `No games found for Week ${state.week}.`;
    return;
  }

  STATUS.textContent = `Showing ${events.length} game${events.length>1?"s":""} — Week ${state.week}`;
  renderEvents(events);

  // Refresh upcoming games too, so the page notices kickoff and updated lines.
  if (events.some(event => getState(event) !== "post")){
    state.refreshTimer = setInterval(() => refreshLive(), AUTO_REFRESH_MS);
  }
  } catch (err) {
    if (requestId !== state.requestId) return;
    console.warn("Week load failed:", err);
    STATUS.textContent = `Could not load Week ${state.week}. Tap refresh to retry.`;
  }
}

// Render with section headers; headers are full-width (outside the card grids)
function renderEvents(events){
  GRID.innerHTML = "";
  GRID.classList.remove("grid");
  GRID.classList.add("stack");
  state.liveEventIds.clear();

  // Group by state
  const groups = { post: [], in: [], pre: [] };
  for (const e of events) {
    const s = getState(e);
    (groups[s] ?? groups.pre).push(e);
  }

  const ORDER = [
    { key: "post", label: "Final"    },
    { key: "in",   label: "Live"     },
    { key: "pre",  label: "Upcoming" },
  ];

  for (const { key, label } of ORDER){
    const list = groups[key];
    if (!list.length) continue;

    // Header (does not occupy a grid cell)
    const header = document.createElement("div");
    header.className = "section-header";
    header.textContent = `${label} (${list.length})`;
    GRID.appendChild(header);

    // Grid of cards for this section
    const groupGrid = document.createElement("div");
    groupGrid.className = "grid";
    for (const ev of list){
      const card = createCard(ev);
      groupGrid.appendChild(card);
    }
    GRID.appendChild(groupGrid);
  }
}

function createCard(event){
  const comp = event?.competitions?.[0] || {};
  const stateStr = (comp.status?.type?.state || event?.status?.type?.state || "").toLowerCase();

  const detail = comp.status?.type?.shortDetail || comp.status?.type?.detail || "";
  const startLocal = event.date
    ? new Date(event.date).toLocaleString([], { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })
    : "";

  const cAway = comp?.competitors?.find(t => t.homeAway === "away") || comp?.competitors?.[0] || {};
  const cHome = comp?.competitors?.find(t => t.homeAway === "home") || comp?.competitors?.[1] || {};
  const homeSpread = parseHomeSpread(comp);

  const card = el("article", "game-card");

  // Outline + live tracking
  if (stateStr === "in") { card.classList.add("state-live"); state.liveEventIds.add(event.id); }
  else if (stateStr === "post") card.classList.add("state-final");
  else card.classList.add("state-upcoming");

  // Header
  const head = el("div", "card-head");
  const title = el("div");
  title.innerHTML = `<div class="kv">${event.shortName || comp.name || "NFL Game"}</div>`;
  const badge = el("span", "badge");
  if (stateStr === "in"){ badge.classList.add("live"); badge.textContent = "LIVE"; }
  else if (stateStr === "post"){ badge.classList.add("final"); badge.textContent = "FINAL"; }
  else { badge.textContent = "UPCOMING"; }
  head.append(title, badge);

  // Teams: stacked left; scores to the right
  const teams = el("div", "teams");
  const awayBtn = teamCell(cAway, homeSpread, /* isHome */ false); // expects .team-btn.away
  const homeBtn = teamCell(cHome, homeSpread, /* isHome */ true);  // expects .team-btn.home

  const awayScore = el("div", "score-right awayScore");
  const homeScore = el("div", "score-right homeScore");
  const showDash = stateStr === "pre";
  awayScore.textContent = showDash ? "—" : String(safeInt(cAway.score));
  homeScore.textContent = showDash ? "—" : String(safeInt(cHome.score));

  teams.append(awayBtn, awayScore, homeBtn, homeScore);

    // Derive the visible team button name once and store it
  awayBtn.dataset.teamButtonName = readableTeamLabel(awayBtn);
  homeBtn.dataset.teamButtonName = readableTeamLabel(homeBtn);

  // Enable recording ONLY when upcoming
  const canRecord = isPickOpen(event) && !saving && (!accountMode || (cloudReady && !!getSession()));
  awayBtn.disabled = !canRecord;
  homeBtn.disabled = !canRecord;

  if (canRecord) {
    awayBtn.addEventListener("click", () => {
      if (!isPickOpen(event) || saving || (accountMode && (!cloudReady || !getSession()))) { loadWeek(); return; }
      applySelection(card, "away");
      recordPick(event, awayBtn.dataset.teamButtonName, "away");
    });
    homeBtn.addEventListener("click", () => {
      if (!isPickOpen(event) || saving || (accountMode && (!cloudReady || !getSession()))) { loadWeek(); return; }
      applySelection(card, "home");
      recordPick(event, homeBtn.dataset.teamButtonName, "home");
    });
  }

  // Linescore (if available)
  const bodyParts = [head, teams];
  if (hasLineScores(comp)) bodyParts.push(buildLineScoreTable(comp));

  // Meta
  const meta = el("div", "meta");
  const leftMeta = el("div");  leftMeta.textContent = (stateStr === "pre") ? startLocal : (detail || startLocal);
  const rightMeta = el("div"); rightMeta.textContent = comp.broadcasts?.[0]?.names?.[0] || comp.venue?.fullName || "";
  meta.append(leftMeta, rightMeta);
  bodyParts.push(meta);

  for (const part of bodyParts) card.append(part);
  card.dataset.eventId = event.id;
  applySelection(card, readSelection(event));

  return card;
}

// Extract a clean label from the team button (lineA nickname + lineB city without spread)
function readableTeamLabel(btn){
  const nick = btn.querySelector(".lineA")?.textContent?.trim() || "";
  const cityRaw = btn.querySelector(".lineB")?.textContent?.trim() || "";
  const city = cityRaw.replace(/\s*\(.*\)\s*$/, ""); // strip spread suffix like " (+3.5)"
  return `${nick} • ${city}`.trim();
}

async function recordPick(event, teamButtonName, selectionHomeAway){
  if (!isPickOpen(event) || saving) return;
  if (!accountMode) {
    const stored = saveSelection(event, selectionHomeAway);
    STATUS.textContent = stored ? 'Pick saved on this device only. Sign in for cloud saving.' : 'Pick selected for this visit only. Device storage is unavailable.';
    return;
  }
  if (!cloudReady || !getSession()) {
    ACCOUNT_STATUS.textContent = 'Please sign out and sign in again to save picks.';
    return;
  }
  saving = true;
  const period = { seasonYear: state.seasonYear, weekNumber: state.week };
  for (const button of document.querySelectorAll('.team-btn')) button.disabled = true;
  WEEK_SELECT.disabled = PREV_BTN.disabled = NEXT_BTN.disabled = REFRESH_BTN.disabled = true;
  STATUS.textContent = 'Saving pick to your account…';
  try {
    const pick = await cloudApi.savePick({ eventId: event.id, ...period, selectionHomeAway });
    cloudSelections.set(String(event.id), pick.selectionHomeAway);
    STATUS.textContent = 'Pick saved to your account.';
  } catch (error) {
    STATUS.textContent = `Cloud save was not confirmed: ${error.message} Refresh before retrying.`;
    cloudReady = false;
  } finally {
    saving = false;
    WEEK_SELECT.disabled = REFRESH_BTN.disabled = false;
    PREV_BTN.disabled = state.week <= 1;
    NEXT_BTN.disabled = state.week >= state.maxWeeks;
    await refreshLive();
  }
}


function teamCell(comp, homeSpread, isHome){
  const btn = document.createElement("button");
  btn.className = "team-btn " + (isHome ? "home" : "away");
  btn.type = "button";

  const logoUrl = comp.team?.logo || comp.team?.logos?.[0]?.href || "";
  const img = document.createElement("img");
  img.alt = comp.team?.abbreviation || comp.team?.name || "Logo";
  img.src = logoUrl || "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

  const nick = teamNickname(comp.team);
  const city = teamCity(comp.team) || "";
  const spreadText = spreadSuffixForSide(homeSpread, isHome); // " (PK)" / " (+3.5)" / ""

  // Accessible name for screen readers
  const ariaSpread = spreadText ? ` ${spreadText.replace(/[()]/g,"")}` : "";
  btn.setAttribute("aria-label", `${nick}, ${city}${ariaSpread}`);

  const label = document.createElement("div");
  label.innerHTML = `
    <div class="lineA">${nick}</div>
    <div class="lineB">${city}${spreadText}</div>
  `;

  btn.append(img, label);
  return btn;
}



function scoreCell(cAway, cHome, competition){
  const s = el("div", "score");
  const stateStr = (competition?.status?.type?.state || "").toLowerCase();
  const away = safeInt(cAway.score);
  const home = safeInt(cHome.score);
  const big = el("div", "big");
  if (stateStr === "pre"){
    big.textContent = "—";
  } else {
    big.textContent = `${away}–${home}`;
  }
  const sub = el("div");
  sub.textContent = "";
  s.append(big, sub);
  return s;
}

function hasLineScores(competition){
  const comps = competition?.competitors || [];
  return comps.length >= 2 && comps.every(c => Array.isArray(c?.linescores) && c.linescores.length);
}

function buildLineScoreTable(competition){
  const comps = competition.competitors;
  const maxPeriods = Math.max(
    comps[0]?.linescores?.length || 0,
    comps[1]?.linescores?.length || 0
  );

  const header = ["", ...Array.from({length: maxPeriods}, (_,i)=> (i<4 ? `Q${i+1}` : `OT${i-3}`)), "T"];
  const rows = comps.map(c => {
    const byP = (c.linescores || []).map(ls => safeInt(ls.value ?? ls.displayValue ?? ls.score ?? 0));
    while (byP.length < maxPeriods) byP.push("");
    return { team: c.team?.abbreviation || c.team?.shortDisplayName || "", cells: byP.concat([safeInt(c.score)]) };
  });

  const wrap = el("div", "linescore");
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  for (const h of header){
    const th = document.createElement("th"); th.textContent = h; trh.appendChild(th);
  }
  thead.appendChild(trh);
  const tbody = document.createElement("tbody");

  for (const r of rows){
    const tr = document.createElement("tr");
    const th = document.createElement("th"); th.textContent = r.team; tr.appendChild(th);
    for (const c of r.cells){
      const td = document.createElement("td"); td.textContent = (c === "" ? "" : String(c)); tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  table.append(thead, tbody);
  wrap.appendChild(table);
  return wrap;
}

async function refreshLive(){
  if (saving) return;
  const requestId = ++state.requestId;
  try{
    const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${state.seasonYear}&seasontype=${state.seasonType}&week=${state.week}&limit=1000`;
    const data = await fetchJSON(url);
    if (requestId !== state.requestId) return;
    const events = Array.isArray(data?.events) ? sortEvents(data.events) : [];
    renderEvents(events);
    if (!events.some(event => getState(event) !== "post")){
      clearInterval(state.refreshTimer);
    }
  }catch(err){
    console.warn("Live refresh failed:", err);
  }
}

// ---- Utils
function el(tag, cls){ const n = document.createElement(tag); if (cls) n.className = cls; return n; }
function safeInt(x){ const n = parseInt(x, 10); return Number.isFinite(n) ? n : 0; }
function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }

async function fetchJSON(url){
  const res = await fetch(url, { headers: { "Accept":"application/json" }});
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}

function teamNickname(team){
  return team?.name || team?.shortDisplayName || team?.abbreviation || team?.displayName || "";
}
function teamCity(team){
  return team?.location || team?.city || ""; // ESPN usually provides 'location'
}
function parseHomeSpread(competition){
  const odds = competition?.odds?.[0];
  const raw = odds?.pointSpread?.home?.close?.line ?? odds?.spread;
  if (raw == null || (typeof raw === "string" && !raw.trim())) return null;
  if (typeof raw === "string" && /^(PK|PICK|EVEN)$/i.test(raw.trim())) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
function prettyNum(n){
  // trim trailing .0; keep halves, etc.
  const s = Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, "");
  return s;
}
function spreadSuffixForSide(homeSpread, isHome){
  if (homeSpread === null || homeSpread === undefined) return "";
  let val = isHome ? homeSpread : -homeSpread;
  // handle -0 / +0
  if (Math.abs(val) < 1e-9) return " (PK)";
  const sign = val > 0 ? "+" : ""; // minus is in the number itself
  return ` (${sign}${prettyNum(val)})`;
}

function applySelection(cardEl, side){ // side: 'home' | 'away'
  const away = cardEl.querySelector('.team-btn.away');
  const home = cardEl.querySelector('.team-btn.home');
  if (!away || !home) return;

  away.classList.toggle('selected', side === 'away');
  home.classList.toggle('selected', side === 'home');

  away.setAttribute('aria-pressed', String(side === 'away'));
  home.setAttribute('aria-pressed', String(side === 'home'));

  cardEl.dataset.selectedSide = side; // optional: store for later
}

function isPickOpen(event){
  const kickoff = Date.parse(event.date || event.competitions?.[0]?.date);
  return getState(event) === "pre" && Number.isFinite(kickoff) && Date.now() < kickoff;
}

function selectionKey(event){
  return `sunday-pickem:${state.seasonYear}:${event.id}`;
}

function readSelection(event){
  if (accountMode) return cloudSelections.get(String(event.id)) || "";
  const key = selectionKey(event);
  let side = state.selections.get(key);
  if (!side) {
    try { side = localStorage.getItem(key); } catch (_) { /* Storage can be unavailable. */ }
  }
  return side === "home" || side === "away" ? side : "";
}

function saveSelection(event, side){
  const key = selectionKey(event);
  state.selections.set(key, side);
  try { localStorage.setItem(key, side); return true; }
  catch (_) { return false; }
}


export function gradePick(pick, game) {
  const comp = game?.competitions?.[0];
  const home = comp?.competitors?.find(t => t.homeAway === 'home');
  const away = comp?.competitors?.find(t => t.homeAway === 'away');
  const row = { ...pick, homeLogo: home?.team?.logo, awayLogo: away?.team?.logo, result: 'pending' };
  if (!comp?.status?.type?.completed || comp.status.type.state !== 'post') return row;
  const validNumber = n => n !== null && n !== undefined && String(n).trim() !== '' && Number.isFinite(Number(n));
  if (!validNumber(home?.score) || !validNumber(away?.score) || !validNumber(pick.spread) || !['home','away'].includes(pick.selectionHomeAway)) return { ...row, result: 'ungraded' };
  if (home.team?.abbreviation !== pick.homeTeam || away.team?.abbreviation !== pick.awayTeam) return { ...row, result: 'ungraded' };
  const margin = (Number(home.score) - Number(away.score)) * (pick.selectionHomeAway === 'home' ? 1 : -1) + Number(pick.spread);
  return { ...row, result: margin > 0 ? 'win' : margin < 0 ? 'loss' : 'push' };
}
export function filterRows(rows, { season, from, to, team = '', side = '' }) {
  return rows.filter(r => Number(r.seasonYear) === Number(season) && r.weekNumber >= from && r.weekNumber <= to && (!team || r.homeTeam === team || r.awayTeam === team) && (!side || r.selectionHomeAway === side));
}
export function summarize(rows, teamFilter = '') {
  const counts = { win: 0, loss: 0, push: 0, pending: 0, ungraded: 0 };
  const weeks = new Map(), teams = new Map();
  for (const row of rows) {
    counts[row.result]++;
    if (!weeks.has(Number(row.weekNumber))) weeks.set(Number(row.weekNumber), { week: Number(row.weekNumber), win: 0, loss: 0 });
    if (!['win','loss'].includes(row.result)) continue;
    weeks.get(Number(row.weekNumber))[row.result]++;
    for (const side of ['home','away']) {
      const team = row[side + 'Team'];
      if (teamFilter && team !== teamFilter) continue;
      if (!teams.has(team)) teams.set(team, { team, logo: row[side+'Logo'], tp: 0, fp: 0, tn: 0, fn: 0 });
      const t = teams.get(team), selected = row.selectionHomeAway === side;
      const covered = selected ? row.result === 'win' : row.result === 'loss';
      t[selected ? (covered ? 'tp' : 'fp') : (covered ? 'fn' : 'tn')]++;
    }
  }
  let wins = 0, decisions = 0;
  const weekly = [...weeks.values()].sort((a,b) => a.week-b.week).map(w => {
    wins += w.win; decisions += w.win+w.loss;
    return { ...w, n: w.win+w.loss, accuracy: w.win+w.loss ? w.win/(w.win+w.loss) : null, cumulative: decisions ? wins/decisions : null };
  });
  return { counts, accuracy: counts.win+counts.loss ? counts.win/(counts.win+counts.loss) : null, weekly,
    teams: [...teams.values()].map(t => ({ ...t, n: t.tp+t.fp+t.tn+t.fn, tpr: t.tp+t.fn ? t.tp/(t.tp+t.fn) : null, fpr: t.fp+t.tn ? t.fp/(t.fp+t.tn) : null })) };
}
export function demoRows() {
  const teams = ['BUF','KC','BAL','DET','GB','SF','PHI','DAL'];
  const rows = [];
  for (let week = 1; week <= 8; week++) for (let i = 0; i < teams.length; i += 2) {
    const home = teams[(i+week)%8], away = teams[(i+week+1)%8];
    rows.push({ eventId: `demo-${week}-${i}`, seasonYear: 2026, weekNumber: week, homeTeam: home, awayTeam: away,
      homeLogo: `https://a.espncdn.com/i/teamlogos/nfl/500/${home.toLowerCase()}.png`, awayLogo: `https://a.espncdn.com/i/teamlogos/nfl/500/${away.toLowerCase()}.png`,
      selectionHomeAway: (week+i)%3 ? 'home' : 'away', spread: -3,
      result: week === 8 ? 'pending' : (week+i)%7 === 0 ? 'push' : (week*3+i)%5 < 3 ? 'win' : 'loss' });
  }
  return rows;
}

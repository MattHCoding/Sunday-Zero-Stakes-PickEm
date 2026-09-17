import { gradePick } from './analysis-model.mjs';
// Sequential weekly reads respect the API's small per-account throughput budget.
export async function loadHistory(api, season, { fetchImpl = fetch, onProgress = () => {} } = {}) {
  const rows = [];
  for (let week = 1; week <= 18; week++) {
    onProgress(week);
    await new Promise(resolve => setTimeout(resolve, 250));
    const picks = await api.listPicks(season, week);
    if (!Array.isArray(picks)) throw new Error('Unexpected pick history response.');
    if (!picks.length) continue;
    const response = await fetchImpl(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${season}&seasontype=2&week=${week}&limit=1000`);
    if (!response.ok) throw new Error(`Scores for Week ${week} could not be loaded. Please retry.`);
    const feed = await response.json();
    if (Number(feed.season?.year) !== Number(season) || Number(feed.week?.number) !== week || !Array.isArray(feed.events)) throw new Error('Scoreboard period could not be verified.');
    const games = new Map(feed.events.map(g => [String(g.id), g]));
    for (const pick of picks) rows.push(games.has(String(pick.eventId)) ? gradePick(pick, games.get(String(pick.eventId))) : { ...pick, result: 'ungraded' });

  }
  return rows;
}

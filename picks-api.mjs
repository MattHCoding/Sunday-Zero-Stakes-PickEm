// Authenticated API adapter. Wire into app.js after the API and sign-in are deployed.
export function createPicksApi({ baseUrl, getAccessToken, fetchImpl = fetch }) {
  const origin = new URL(baseUrl);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash) {
    throw new Error('The picks API requires an HTTPS base URL.');
  }
  const base = origin.href.replace(/\/$/, '');
  async function request(path, options = {}) {
    const token = await getAccessToken();
    if (!token) throw new Error('Sign in to save or load your picks.');
    const result = await fetchImpl(base + path, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      cache: 'no-store',
    });
    let body;
    try { body = await result.json(); } catch { throw new Error('Could not confirm the save or load. Try again.'); }
    if (!result.ok) throw new Error(body.error || body.message || 'Could not save or load picks.');
    return body;
  }
  return {
    async listPicks(seasonYear, weekNumber) {
      const params = new URLSearchParams({ seasonYear, weekNumber });
      return (await request(`/picks?${params}`)).picks;
    },
    async savePick({ eventId, seasonYear, weekNumber, selectionHomeAway }) {
      return (await request(`/picks/${encodeURIComponent(eventId)}`, {
        method: 'PUT', body: JSON.stringify({ seasonYear, weekNumber, selectionHomeAway }),
      })).pick;
    },
  };
}

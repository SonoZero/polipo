'use strict';

// Ultima versione pubblicata su GitHub (Marlin, firmware Prusa), con cache di sei ore.

const cache = new Map();

async function latestRelease(repo, refresh) {
  const cached = cache.get(repo);
  if (cached && !refresh && Date.now() - cached.at < 6 * 3600 * 1000) return cached.value;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'SonoPrint' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const r = await res.json();
    const value = {
      version: String(r.tag_name || '').replace(/^v/i, ''),
      name: r.name || r.tag_name,
      url: r.html_url,
      publishedAt: r.published_at || null,
    };
    cache.set(repo, { at: Date.now(), value });
    return value;
  } catch (_) {
    return cached ? cached.value : null;
  }
}

/** Confronta due versioni ("6.2.4" e "6.1.3+8103"): > 0 se a è più recente di b. */
function compareVersions(a, b) {
  const parts = (v) => String(v).replace(/^v/i, '').split(/[+\-\s]/)[0].split('.').map((x) => parseInt(x, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

module.exports = { latestRelease, compareVersions };

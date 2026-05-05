require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'nxrd-novograf-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

const PROPERTY_ID = process.env.GA4_PROPERTY_ID || 'YOUR_GA4_PROPERTY_ID';
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://novograf-dashboard.onrender.com/auth/callback';

function getOAuthClient() {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

function requireAuth(req, res, next) {
  if (req.session && req.session.tokens) return next();
  if (req.path.startsWith('/api/ai-visibility')) return next();
  res.status(401).json({ success: false, error: 'Not authenticated', needsAuth: true });
}

function getAnalyticsClient(tokens) {
  const auth = getOAuthClient();
  auth.setCredentials(tokens);
  return new BetaAnalyticsDataClient({ authClient: auth });
}

function getDateRanges() {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const firstThisMonth = new Date(y, m, 1);
  const firstLastMonth = new Date(y, m - 1, 1);
  const lastLastMonth = new Date(y, m, 0);
  const fmt = d => d.toISOString().split('T')[0];
  return {
    current: { startDate: fmt(firstThisMonth), endDate: 'today' },
    previous: { startDate: fmt(firstLastMonth), endDate: fmt(lastLastMonth) }
  };
}

const AI_SOURCES = ['chatgpt', 'openai', 'perplexity', 'claude', 'gemini', 'copilot', 'you.com', 'phind', 'bard'];

// ── AUTH ──────────────────────────────────────────────────────────────────────

app.get('/auth/login', (req, res) => {
  const oauth2Client = getOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/analytics.readonly']
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    req.session.tokens = tokens;
    res.redirect('/');
  } catch (err) {
    console.error('Auth callback error:', err);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/status', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.tokens) });
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ── ANALYTICS API ─────────────────────────────────────────────────────────────

app.get('/api/overview', requireAuth, async (req, res) => {
  try {
    const client = getAnalyticsClient(req.session.tokens);
    const { current, previous } = getDateRanges();

    const fetchPeriod = async (startDate, endDate) => {
      const [r] = await client.runReport({
        property: `properties/${PROPERTY_ID}`,
        dateRanges: [{ startDate, endDate }],
        metrics: [
          { name: 'sessions' }, { name: 'totalUsers' }, { name: 'bounceRate' },
          { name: 'averageSessionDuration' }, { name: 'screenPageViews' }, { name: 'engagementRate' }
        ]
      });
      const row = r.rows?.[0];
      if (!row) return {};
      return {
        sessions: parseInt(row.metricValues[0].value),
        users: parseInt(row.metricValues[1].value),
        bounceRate: parseFloat(row.metricValues[2].value) * 100,
        avgDuration: parseFloat(row.metricValues[3].value),
        pageViews: parseInt(row.metricValues[4].value),
        engagementRate: parseFloat(row.metricValues[5].value) * 100
      };
    };

    const [curr, prev] = await Promise.all([
      fetchPeriod(current.startDate, current.endDate),
      fetchPeriod(previous.startDate, previous.endDate)
    ]);

    res.json({ success: true, data: { current: curr, previous: prev }, dateRanges: { current, previous } });
  } catch (err) {
    console.error('Overview error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/organic', requireAuth, async (req, res) => {
  try {
    const client = getAnalyticsClient(req.session.tokens);
    const { current, previous } = getDateRanges();

    const fetchPeriod = async (startDate, endDate) => {
      const [r] = await client.runReport({
        property: `properties/${PROPERTY_ID}`,
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: 'sessionDefaultChannelGroup' }],
        metrics: [{ name: 'sessions' }]
      });
      const result = {};
      r.rows?.forEach(row => { result[row.dimensionValues[0].value] = parseInt(row.metricValues[0].value); });
      return result;
    };

    const [curr, prev] = await Promise.all([
      fetchPeriod(current.startDate, current.endDate),
      fetchPeriod(previous.startDate, previous.endDate)
    ]);

    const channels = {};
    [...new Set([...Object.keys(curr), ...Object.keys(prev)])].forEach(k => {
      channels[k] = { current: curr[k] || 0, previous: prev[k] || 0 };
    });
    res.json({ success: true, data: channels });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/traffic-trend', requireAuth, async (req, res) => {
  try {
    const client = getAnalyticsClient(req.session.tokens);
    const { current, previous } = getDateRanges();

    const fetchPeriod = async (startDate, endDate) => {
      const [r] = await client.runReport({
        property: `properties/${PROPERTY_ID}`,
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: 'week' }],
        metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
        orderBys: [{ dimension: { dimensionName: 'week' } }]
      });
      return r.rows?.map(row => ({
        week: row.dimensionValues[0].value,
        sessions: parseInt(row.metricValues[0].value),
        users: parseInt(row.metricValues[1].value)
      })) || [];
    };

    const [curr, prev] = await Promise.all([
      fetchPeriod(current.startDate, current.endDate),
      fetchPeriod(previous.startDate, previous.endDate)
    ]);

    res.json({ success: true, data: { current: curr, previous: prev } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/geo', requireAuth, async (req, res) => {
  try {
    const client = getAnalyticsClient(req.session.tokens);
    const { current } = getDateRanges();
    const [response] = await client.runReport({
      property: `properties/${PROPERTY_ID}`,
      dateRanges: [{ startDate: current.startDate, endDate: current.endDate }],
      dimensions: [{ name: 'country' }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 15
    });

    const countries = response.rows?.map(row => ({
      country: row.dimensionValues[0].value,
      sessions: parseInt(row.metricValues[0].value),
      users: parseInt(row.metricValues[1].value)
    })) || [];
    res.json({ success: true, data: countries });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/top-pages', requireAuth, async (req, res) => {
  try {
    const client = getAnalyticsClient(req.session.tokens);
    const { current, previous } = getDateRanges();

    const fetchPeriod = async (startDate, endDate) => {
      const [r] = await client.runReport({
        property: `properties/${PROPERTY_ID}`,
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: 'pagePath' }],
        metrics: [{ name: 'screenPageViews' }],
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit: 10
      });
      const result = {};
      r.rows?.forEach(row => { result[row.dimensionValues[0].value] = parseInt(row.metricValues[0].value); });
      return result;
    };

    const [curr, prev] = await Promise.all([
      fetchPeriod(current.startDate, current.endDate),
      fetchPeriod(previous.startDate, previous.endDate)
    ]);

    const pages = {};
    [...new Set([...Object.keys(curr), ...Object.keys(prev)])].forEach(k => {
      pages[k] = { current: curr[k] || 0, previous: prev[k] || 0 };
    });
    res.json({ success: true, data: pages });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/ai-referrals', requireAuth, async (req, res) => {
  try {
    const client = getAnalyticsClient(req.session.tokens);
    const { current, previous } = getDateRanges();

    const fetchPeriod = async (startDate, endDate) => {
      const [r] = await client.runReport({
        property: `properties/${PROPERTY_ID}`,
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: 'sessionSource' }],
        metrics: [{ name: 'sessions' }]
      });
      const result = {};
      r.rows?.forEach(row => {
        const source = row.dimensionValues[0].value.toLowerCase();
        const sessions = parseInt(row.metricValues[0].value);
        if (AI_SOURCES.some(ai => source.includes(ai))) {
          result[source] = (result[source] || 0) + sessions;
        }
      });
      return result;
    };

    const [currMap, prevMap] = await Promise.all([
      fetchPeriod(current.startDate, current.endDate),
      fetchPeriod(previous.startDate, previous.endDate)
    ]);

    res.json({
      success: true,
      data: {
        current: Object.entries(currMap).map(([source, sessions]) => ({ source, sessions })).sort((a, b) => b.sessions - a.sessions),
        previous: Object.entries(prevMap).map(([source, sessions]) => ({ source, sessions })),
        totalCurrent: Object.values(currMap).reduce((s, v) => s + v, 0),
        totalPrevious: Object.values(prevMap).reduce((s, v) => s + v, 0)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── AI VISIBILITY TRACKER ─────────────────────────────────────────────────────

let aiVisibilityLog = [];

app.get('/api/ai-visibility', (req, res) => res.json({ success: true, data: aiVisibilityLog }));

app.post('/api/ai-visibility', (req, res) => {
  const { platform, query, cited, notes, date } = req.body;
  const entry = {
    id: Date.now(),
    platform,
    query,
    cited: cited === true || cited === 'true',
    notes: notes || '',
    date: date || new Date().toISOString().split('T')[0]
  };
  aiVisibilityLog.unshift(entry);
  aiVisibilityLog = aiVisibilityLog.slice(0, 100);
  res.json({ success: true, data: entry });
});

app.delete('/api/ai-visibility/:id', (req, res) => {
  aiVisibilityLog = aiVisibilityLog.filter(e => e.id !== parseInt(req.params.id));
  res.json({ success: true });
});

// ── LINKEDIN TRACKER ──────────────────────────────────────────────────────────

let linkedInLog = [];

app.get('/api/linkedin', (req, res) => res.json({ success: true, data: linkedInLog }));

app.post('/api/linkedin', (req, res) => {
  const { type, topic, impressions, engagement, followers, date } = req.body;
  const entry = {
    id: Date.now(),
    type: type || 'post',
    topic,
    impressions: parseInt(impressions) || 0,
    engagement: parseFloat(engagement) || 0,
    followers: parseInt(followers) || 0,
    date: date || new Date().toISOString().split('T')[0]
  };
  linkedInLog.unshift(entry);
  linkedInLog = linkedInLog.slice(0, 200);
  res.json({ success: true, data: linkedInLog });
});

app.delete('/api/linkedin/:id', (req, res) => {
  linkedInLog = linkedInLog.filter(e => e.id !== parseInt(req.params.id));
  res.json({ success: true, data: linkedInLog });
});

// ── CITATION TOOL ─────────────────────────────────────────────────────────────

app.get('/citation', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'citation.html'));
});

// ── LINKEDIN GROWTH TOOL ──────────────────────────────────────────────────────

app.get('/linkedin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'novograf-social-tool.html'));
});

// ── AI GENERATE PROXY ─────────────────────────────────────────────────────────
// Routes all Claude API calls through the server so the API key is never
// exposed in the browser and iframe CSP restrictions are avoided.

const CLAUDE_MODEL = 'claude-sonnet-4-5';

app.post('/api/generate', async (req, res) => {
  const { system, prompt, max_tokens } = req.body;
  if (!prompt) return res.status(400).json({ success: false, error: 'prompt is required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ success: false, error: 'ANTHROPIC_API_KEY not configured on server' });

  try {
    const body = {
      model: CLAUDE_MODEL,
      max_tokens: max_tokens || 1000,
      messages: [{ role: 'user', content: prompt }]
    };
    if (system) body.system = system;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ success: false, error: data.error?.message || 'Anthropic API error' });

    const text = (data.content || []).map(b => b.text || '').join('');
    res.json({ success: true, text });
  } catch (err) {
    console.error('Generate error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Vision endpoint — accepts a base64 image alongside the prompt
app.post('/api/generate-vision', async (req, res) => {
  const { system, prompt, imageBase64, max_tokens } = req.body;
  if (!prompt || !imageBase64) return res.status(400).json({ success: false, error: 'prompt and imageBase64 are required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ success: false, error: 'ANTHROPIC_API_KEY not configured on server' });

  try {
    const body = {
      model: CLAUDE_MODEL,
      max_tokens: max_tokens || 1000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: prompt }
        ]
      }]
    };
    if (system) body.system = system;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ success: false, error: data.error?.message || 'Anthropic API error' });

    const text = (data.content || []).map(b => b.text || '').join('');
    res.json({ success: true, text });
  } catch (err) {
    console.error('Vision error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── CATCH-ALL (keep this last) ────────────────────────────────────────────────

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Novograf dashboard running on port ${PORT}`));

const https = require('https');

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON from ' + url)); }
      });
    }).on('error', reject);
  });
}

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = https.request({ hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(bodyStr) } }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON from Anthropic')); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

exports.handler = async function(event) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  try {
    const { ticker } = JSON.parse(event.body || '{}');
    if (!ticker) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Ticker required' }) };

    const sym = ticker.toUpperCase().trim();
    const AK = process.env.ALPACA_KEY;
    const AS = process.env.ALPACA_SECRET;
    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

    // ── Fetch snapshot from Alpaca ──
    const snapData = await httpsGet(
      `https://data.alpaca.markets/v2/stocks/snapshots?symbols=${sym}&feed=iex`,
      { 'APCA-API-KEY-ID': AK, 'APCA-API-SECRET-KEY': AS }
    );

    const snap = snapData[sym];
    if (!snap || !snap.dailyBar) {
      return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: `No data found for ${sym}. Check the ticker symbol.` }) };
    }

    // ── Fetch news ──
    let headlines = 'No recent news available.';
    try {
      const newsData = await httpsGet(
        `https://data.alpaca.markets/v1beta1/news?symbols=${sym}&limit=5`,
        { 'APCA-API-KEY-ID': AK, 'APCA-API-SECRET-KEY': AS }
      );
      if (newsData.news && newsData.news.length > 0) {
        headlines = newsData.news.map(n => `- ${n.headline}`).join('\n');
      }
    } catch {}

    const q = snap.dailyBar;
    const lq = snap.latestTrade || {};
    const pq = snap.prevDailyBar || {};
    const price = lq.p || q.c;
    const prevClose = pq.c || q.o;
    const change = price - prevClose;
    const changePct = prevClose ? (change / prevClose * 100) : 0;
    const vwap = q.vw || 0;
    const volume = q.v || 0;

    // ── Fetch asset info for company name ──
    let companyName = sym;
    try {
      const assetData = await httpsGet(
        `https://paper-api.alpaca.markets/v2/assets/${sym}`,
        { 'APCA-API-KEY-ID': AK, 'APCA-API-SECRET-KEY': AS }
      );
      if (assetData.name) companyName = assetData.name;
    } catch {}

    // ── Build context for Claude ──
    const dataBlock = [
      `Ticker: ${sym}`,
      `Company: ${companyName}`,
      `Current Price: $${price.toFixed(2)}`,
      `Change: ${change >= 0 ? '+' : ''}${change.toFixed(2)} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%)`,
      `Open: $${q.o.toFixed(2)} | High: $${q.h.toFixed(2)} | Low: $${q.l.toFixed(2)} | Close: $${q.c.toFixed(2)}`,
      `VWAP: $${vwap.toFixed(2)} — price is ${price > vwap ? 'ABOVE' : 'BELOW'} VWAP`,
      `Volume: ${volume.toLocaleString()}`,
      `\nRecent Headlines:\n${headlines}`
    ].join('\n');

    // ── Call Claude ──
    const claudeRes = await httpsPost(
      'api.anthropic.com',
      '/v1/messages',
      {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: `You are Alpha Agent, a professional stock analyst. Given market data, provide a structured analysis.

Format your response EXACTLY like this (no markdown, no extra text):
SIGNAL: BUY
CONFIDENCE: HIGH
TARGET_12M: $XXX
ENTRY: Buy now / Wait for dip to $XXX-XXX / Avoid
BULL_CASE: 3-4 sentences on bullish thesis based on price action, technicals, and news.
BEAR_CASE: 3-4 sentences on bearish risks and concerns.
ANALYSIS: 2-3 sentence overall summary and recommendation.

CONFIDENCE must be LOW, MEDIUM, or HIGH.
TARGET_12M should be a realistic 12-month price target.
ENTRY should be a short actionable phrase.`,
        messages: [{ role: 'user', content: `Analyze this stock:\n\n${dataBlock}` }]
      }
    );

    const responseText = claudeRes.content?.[0]?.text || '';
    const field = (key) => {
      const m = responseText.match(new RegExp(`${key}:\\s*([^\\n]+)`));
      return m ? m[1].trim() : '';
    };
    const longField = (key) => {
      const m = responseText.match(new RegExp(`${key}:\\s*([\\s\\S]+?)(?=\\n[A-Z_]+:|$)`));
      return m ? m[1].trim() : '';
    };

    const signal = (field('SIGNAL') || 'HOLD').toUpperCase();
    const confidence = (field('CONFIDENCE') || 'MEDIUM').toUpperCase();
    const target12m = field('TARGET_12M');
    const entry = field('ENTRY');
    const bullCase = longField('BULL_CASE');
    const bearCase = longField('BEAR_CASE');
    const analysis = longField('ANALYSIS');

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticker: sym,
        name: companyName,
        price: price.toFixed(2),
        change: change.toFixed(2),
        changePct: changePct.toFixed(2),
        open: q.o.toFixed(2),
        high: q.h.toFixed(2),
        low: q.l.toFixed(2),
        prevClose: prevClose.toFixed(2),
        volume,
        vwap: vwap.toFixed(2),
        signal,
        confidence,
        target12m,
        entry,
        bullCase,
        bearCase,
        analysis
      })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message || 'Internal error' })
    };
  }
};

const https = require('https');

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  try {
    const { ticker } = JSON.parse(event.body);
    if (!ticker) throw new Error('Ticker required');

    const AK = process.env.ALPACA_KEY;
    const AS = process.env.ALPACA_SECRET;
    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

    // Fetch snapshot from Alpaca
    const snapData = await alpacaFetch(
      'https://data.alpaca.markets/v2/stocks/snapshots?symbols=' + ticker, AK, AS
    );
    const snap = snapData[ticker];
    if (!snap || !snap.dailyBar || !snap.prevDailyBar) {
      return respond(400, { error: 'No data found for ' + ticker });
    }

    // Fetch news from Alpaca
    const newsData = await alpacaFetch(
      'https://data.alpaca.markets/v1beta1/news?symbols=' + ticker + '&limit=3', AK, AS
    );
    const headlines = (newsData.news || []).map(n => n.headline).join('\n') || 'No recent news.';

    const q = snap.dailyBar, pq = snap.prevDailyBar;
    const price = q.c;
    const chg = ((price - pq.c) / pq.c * 100);
    const gap = ((q.o - pq.c) / pq.c * 100);
    const dr = q.h - q.l;
    const cp = dr > 0 ? ((price - q.l) / dr * 100).toFixed(0) : 'N/A';

    const dataBlock = [
      'Ticker: ' + ticker,
      'Price: $' + price.toFixed(2) + ' (' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + '% today)',
      'Open: $' + q.o.toFixed(2) + ' | High: $' + q.h.toFixed(2) + ' | Low: $' + q.l.toFixed(2),
      'VWAP: $' + q.vw.toFixed(2) + ' — price is ' + (price > q.vw ? 'ABOVE (bullish)' : 'BELOW (bearish)'),
      'Close position in day range: ' + cp + '% (100 = closed at high)',
      'Gap from prev close: ' + (gap >= 0 ? '+' : '') + gap.toFixed(2) + '%',
      'Volume: ' + (q.v / 1e6).toFixed(1) + 'M',
      '',
      'Recent news:',
      headlines
    ].join('\n');

    // Call Claude
    const analysis = await claudeFetch(ANTHROPIC_KEY, ticker, dataBlock);

    return respond(200, {
      ticker, price, chg, gap,
      high: q.h, low: q.l, vwap: q.vw, volume: q.v,
      prevClose: pq.c, closePosition: cp,
      analysis
    });

  } catch(e) {
    return respond(500, { error: e.message });
  }
};

function alpacaFetch(url, ak, as) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'APCA-API-KEY-ID': ak, 'APCA-API-SECRET-KEY': as }
    };
    https.get(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function claudeFetch(key, ticker, dataBlock) {
  return new Promise((resolve, reject) => {
    const prompt = 'Analyze ' + ticker + ':\n\n' + dataBlock + '\n\n'
      + 'Respond in EXACTLY this format:\n'
      + 'Catalyst: [primary driver of move or No clear catalyst]\n'
      + 'Bull: [bull case with numbers]\n'
      + 'Bear: [bear case with numbers]\n'
      + 'RECOMMENDATION: [BUY or HOLD or SELL]\n'
      + 'Confidence: [HIGH or MEDIUM or LOW]\n'
      + 'Target: $[12-month estimate]\n'
      + 'Entry: [buy now at $X or wait for dip to $X]\n'
      + 'Summary: [2 sentences]';

    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      system: 'You are a senior equity analyst. Give clear actionable recommendations with specific numbers. BUY for strong movers with real news catalysts. HOLD for mixed signals. SELL for weak price action.',
      messages: [{ role: 'user', content: prompt }]
    });

    const opts = {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          resolve(parsed.content[0].text);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function respond(status, body) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(body)
  };
}

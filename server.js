// خادم صغير: بيقدّم صفحة الدردشة وبيخبّي مفتاح API. ما محتاج مكتبات (Node 18 فما فوق).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL || 'claude-sonnet-5-5';
const ACCESS_CODE = process.env.ACCESS_CODE || '';   // اختياري: كلمة سر للدخول
const SYSTEM = process.env.SYSTEM_PROMPT || 'أنت مساعد ذكي ودود. رد بنفس لغة ولهجة المستخدم، وكن واضحاً ومختصراً.';
const PORT = process.env.PORT || 3000;
if (!KEY) { console.error('ANTHROPIC_API_KEY غير موجود'); process.exit(1); }

const page = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const hits = new Map(); // تحديد عدد الطلبات لكل IP
function limited(ip) {
  const now = Date.now(), arr = (hits.get(ip) || []).filter(t => now - t < 60000);
  arr.push(now); hits.set(ip, arr); return arr.length > 15;
}
setInterval(() => hits.clear(), 10 * 60 * 1000).unref();

function body(req, max = 200000) {
  return new Promise((ok, no) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > max) { no(new Error('big')); req.destroy(); } });
    req.on('end', () => ok(s));
    req.on('error', no);
  });
}

http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(page);
  }
  if (req.method === 'GET' && req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  if (req.method !== 'POST' || req.url !== '/api/chat') { res.writeHead(404); return res.end(); }

  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const fail = (code, msg) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: msg } })); };

  if (ACCESS_CODE && req.headers['x-access-code'] !== ACCESS_CODE) return fail(401, 'كلمة السر غلط.');
  if (limited(ip)) return fail(429, 'طلبات كتيرة، استنى شوية وجرب تاني.');

  let messages;
  try {
    messages = JSON.parse(await body(req)).messages;
    if (!Array.isArray(messages) || !messages.length || messages.length > 30) throw 0;
    messages = messages.map(m => {
      if (!['user', 'assistant'].includes(m.role) || typeof m.content !== 'string') throw 0;
      return { role: m.role, content: m.content.slice(0, 8000) };
    });
  } catch { return fail(400, 'طلب غير صالح.'); }

  const ctl = new AbortController();
  res.on('close', () => ctl.abort());
  try {
    const up = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 2048, stream: true, system: SYSTEM, messages })
    });
    if (!up.ok) {
      console.error('Anthropic', up.status, await up.text());
      return fail(502, 'الخدمة ما متاحة الآن (تأكد من المفتاح والرصيد).');
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    Readable.fromWeb(up.body).pipe(res);
  } catch (e) { if (!res.headersSent) fail(502, 'تعذر الاتصال بالخدمة.'); else res.end(); }
}).listen(PORT, () => console.log('يعمل على المنفذ ' + PORT));

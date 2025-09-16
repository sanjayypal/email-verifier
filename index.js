// bulk-smtp-verifier.js
const express = require('express');
const bodyParser = require('body-parser');
const dns = require('dns').promises;
const net = require('net');

const app = express();
app.use(bodyParser.json());

// ---- Configurable lists ----
const roleBased = [
  'admin', 'support', 'info', 'contact', 'sales',
  'help', 'billing', 'webmaster', 'security'
];

const disposableDomains = new Set([
  'tempmail.com', '10minutemail.com', 'guerrillamail.com',
  'yopmail.com', 'mailinator.com'
]);

// ---- Helpers ----
function parseSMTPResponse(text) {
  const lines = text.split(/\r\n|\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^(\d{3})[ -](.*)/);
    if (m) return { code: parseInt(m[1], 10), message: lines.join('\n') };
  }
  return null;
}

async function getMxHosts(domain) {
  try {
    const mx = await dns.resolveMx(domain);
    if (!mx || mx.length === 0) return [];
    mx.sort((a, b) => a.priority - b.priority);
    return mx.map(m => m.exchange.replace(/\.$/, ''));
  } catch {
    try {
      const a = await dns.resolve4(domain);
      if (a && a.length) return [domain];
      const a6 = await dns.resolve6(domain);
      if (a6 && a6.length) return [domain];
    } catch {}
    return [];
  }
}

function smtpProbe(host, port = 25, from = 'verify.sanjay@gmail.com', to) {
  return new Promise((resolve) => {
    const socket = net.createConnection(port, host);
    let buffer = '';
    let closed = false;
    const TIMEOUT = 8000;

    function cleanup() {
      if (!closed) {
        closed = true;
        try { socket.end(); } catch {}
      }
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve({ host, rcpt: { code: 0, message: 'timeout' } });
    }, TIMEOUT);

    socket.setEncoding('utf8');

    socket.on('data', (chunk) => {
      buffer += chunk;
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      cleanup();
      resolve({ host, rcpt: { code: 0, message: `socket_error: ${err.message}` } });
    });

    socket.on('connect', async () => {
      try {
        // Wait for greeting
        await new Promise((res) => {
          const waitGreeting = () => {
            const parsed = parseSMTPResponse(buffer);
            if (parsed && parsed.code) return res(parsed);
            setTimeout(waitGreeting, 50);
          };
          waitGreeting();
        });

        const sendCmd = (cmd) => new Promise((res, rej) => {
          buffer = '';
          socket.write(cmd + '\r\n', 'utf8', (err) => {
            if (err) return rej(err);
            const start = Date.now();
            (function waitResp() {
              const parsed = parseSMTPResponse(buffer);
              if (parsed && parsed.code) return res(parsed);
              if (Date.now() - start > TIMEOUT) return rej(new Error('smtp command timeout'));
              setTimeout(waitResp, 50);
            })();
          });
        });

        await sendCmd(`EHLO verifier.example.com`).catch(() => {});
        await sendCmd(`MAIL FROM:<${from}>`);
        const rcpt = await sendCmd(`RCPT TO:<${to}>`).catch(err => ({ code: 0, message: err.message }));

        try { socket.write('RSET\r\n'); socket.write('QUIT\r\n'); } catch {}
        clearTimeout(timer);
        cleanup();

        resolve({ host, rcpt });
      } catch (err) {
        clearTimeout(timer);
        cleanup();
        resolve({ host, rcpt: { code: 0, message: `protocol_error: ${err.message}` } });
      }
    });
  });
}

// ---- Main verify function ----
async function verifyEmail(email, from = 'sanjay@vamenture.com') {
  const parts = String(email).split('@');
  if (parts.length !== 2) return 'invalid_format';

  const [local, domain] = parts;

  if (roleBased.includes(local.toLowerCase())) return 'role_based';

  const hosts = await getMxHosts(domain);
  if (!hosts.length) return 'no_mx_record';

  if (disposableDomains.has(domain)) return 'disposable';

  console.log(`Verifying ${email} via SMTP on hosts:`, hosts);

  for (const host of hosts) {
    const result = await smtpProbe(host, 25, from, email);
    console.log(`Probed ${host} for ${email}:`, result.rcpt);

    const rcpt = result.rcpt;
    if (!rcpt || !rcpt.code) continue;

    if (rcpt.code >= 200 && rcpt.code < 300) {
      // check catch-all
      const randomUser = `catchall_test_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      const fakeEmail = `${randomUser}@${domain}`;
      const fakeResult = await smtpProbe(host, 25, from, fakeEmail);

      if (fakeResult.rcpt && fakeResult.rcpt.code >= 200 && fakeResult.rcpt.code < 300) {
        return 'catch_all';
      }
      return 'valid';
    }

    if (rcpt.code >= 500 && rcpt.code < 600) return 'invalid';
    if (rcpt.code >= 400 && rcpt.code < 500) return 'unknown';
  }

  return 'unknown';
}

// ---- API ----
app.post('/verify', async (req, res) => {
  const emails = req.body.email;
  if (!Array.isArray(emails)) {
    return res.status(400).json({ error: 'email array required' });
  }

  const results = {};
  for (const e of emails) {
    results[e] = await verifyEmail(e);
  }

  res.json(results);
});

const PORT = 3000;
app.listen(PORT, () => console.log(`Bulk SMTP verifier running at http://localhost:${PORT}`));

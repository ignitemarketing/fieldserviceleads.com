interface Env {
  POSTMARK_SERVER_TOKEN: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_FSM = ['Jobber', 'ServiceTitan', 'Housecall Pro', 'Other', ''];

// Where signup notifications go, and the verified Postmark sender they come from.
const NOTIFY_TO = 'colin+newco@colingreig.com';
const NOTIFY_FROM = 'newco@jdmbuysell.com';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  let data: Record<string, unknown>;
  try {
    const ct = request.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      data = await request.json();
    } else {
      const form = await request.formData();
      data = Object.fromEntries(form.entries());
    }
  } catch {
    return json({ ok: false, error: 'bad_request' }, 400);
  }

  // Honeypot: bots fill this hidden field — silently accept, send nothing.
  if (typeof data.company === 'string' && data.company.trim() !== '') {
    return json({ ok: true });
  }

  const email = String(data.email ?? '').trim().toLowerCase();
  const fsm = String(data.fsm ?? '').trim();
  const source = String(data.source ?? '').trim() || 'unknown';
  const page = String(data.page ?? '').slice(0, 300);

  if (!EMAIL_RE.test(email) || email.length > 254) {
    return json({ ok: false, error: 'invalid_email' }, 422);
  }
  if (!ALLOWED_FSM.includes(fsm)) {
    return json({ ok: false, error: 'invalid_fsm' }, 422);
  }

  const referrer = (request.headers.get('referer') || '').slice(0, 300);
  const ua = (request.headers.get('user-agent') || '').slice(0, 300);
  const country = request.headers.get('cf-ipcountry') || '';

  const textBody = [
    'New waitlist signup',
    '',
    `Source:   ${source}`,
    `Email:    ${email}`,
    `FSM:      ${fsm || '(not provided)'}`,
    `Page:     ${page || '/'}`,
    `Country:  ${country || '(unknown)'}`,
    `Referrer: ${referrer || '(none)'}`,
    `Agent:    ${ua || '(unknown)'}`,
  ].join('\n');

  try {
    const res = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': env.POSTMARK_SERVER_TOKEN,
      },
      body: JSON.stringify({
        From: NOTIFY_FROM,
        To: NOTIFY_TO,
        ReplyTo: email,
        Subject: `[newco] Waitlist: ${source} — ${email}`,
        TextBody: textBody,
        MessageStream: 'outbound',
      }),
    });
    if (!res.ok) {
      return json({ ok: false, error: 'server_error' }, 500);
    }
  } catch {
    return json({ ok: false, error: 'server_error' }, 500);
  }

  return json({ ok: true });
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The email for one notification: plain text plus a simple HTML version with an "Open" button.
export function renderEmail({ title, body, url, appUrl, appName = 'NexoneZ Hub', name }) {
  const link = url && appUrl ? `${String(appUrl).replace(/\/$/, '')}${url}` : null;
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const subject = String(title || appName).replace(/\s+/g, ' ').trim().slice(0, 120);
  const foot = 'You get this because email notifications are on. You can turn them off in Notification settings.';
  const text = [`Hi ${first},`, '', body || title, link ? `\nOpen: ${link}` : '', '', `${appName}`, foot].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1c1c28">
<h2 style="margin:0 0 8px;font-size:18px">${esc(title)}</h2>
<p style="margin:0 0 16px;line-height:1.5">Hi ${esc(first)},</p>
<p style="margin:0 0 20px;line-height:1.5">${esc(body || '')}</p>
${link ? `<p style="margin:0 0 24px"><a href="${esc(link)}" style="background:#2f22c8;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Open ${esc(appName)}</a></p>` : ''}
<p style="margin:0;color:#6b6b80;font-size:12px">${esc(foot)}</p></div>`;
  return { subject, text, html };
}

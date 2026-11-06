// Resend, called the same way Week of Us does (plain fetch, no SDK).
export async function sendEmail({ apiKey, from, to, subject, html, text, idempotencyKey }) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify({ from, to: [to], subject, html, text }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Resend returned ${response.status}: ${body.slice(0, 300)}`);
  }
  return response.json();
}

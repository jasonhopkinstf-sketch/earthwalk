// Sending an email to whoever runs the server (a new suggestion has come in: suggestions.ts).
//
// It goes through Resend (resend.com), a service that takes a letter over HTTPS, since a small cloud
// machine is often not allowed to speak to mail servers itself. Nothing is sent unless the server's
// settings give both a key and an address:
//   EARTHWALK_RESEND_KEY   the key of a Resend account
//   EARTHWALK_MAIL_TO      where the letters go (with Resend's own sender, below, that has to be the
//                          address the Resend account was made with)
//   EARTHWALK_MAIL_FROM    who they come from; Resend's test sender when not given
// Neither the key nor the address is ever written into this repository.

/** Sends one plain-text letter. Rejects when it could not be sent. */
export type Mailer = (subject: string, text: string) => Promise<void>;

const RESEND_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "EarthWalk <onboarding@resend.dev>";

/** A mailer that sends through Resend. `post` is the web request, replaceable for tests. */
export function resendMailer(key: string, to: string, from = DEFAULT_FROM, post: typeof fetch = fetch): Mailer {
  return async (subject, text) => {
    const res = await post(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject: subject.replace(/[\r\n]+/g, " ").slice(0, 200), text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      // What the service says is wrong, without the key (it is not in the answer, but a long answer is cut all the same).
      const said = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
      throw new Error(`the mail service answered ${res.status}${said ? `: ${said}` : ""}`);
    }
    void res.body?.cancel().catch(() => undefined);
  };
}

/** The mailer the server's settings ask for, or null when they ask for none. */
export function mailerFromSettings(env: Record<string, string | undefined> = process.env): Mailer | null {
  const key = env.EARTHWALK_RESEND_KEY?.trim(), to = env.EARTHWALK_MAIL_TO?.trim();
  if (!key || !to) return null;
  return resendMailer(key, to, env.EARTHWALK_MAIL_FROM?.trim() || DEFAULT_FROM);
}

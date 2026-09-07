---

name: email
description: "Send emails via s-nail, read inbox via the fetch-emails script (reads password from env/config)."
metadata:
{
"openclaw": {
"emoji": "📧",
"requires": { "bins": ["s-nail", "fetch-emails"] }
}
}
---

# Email

## Send (use s-nail, NOT himalaya)

himalaya is blocked for sending. Use s-nail instead.

Sending requires SMTP or Agentmail credentials configured on the gateway (see `!configure`).

```bash
echo "Body text here" | s-nail -s "Subject" recipient@example.com
```

Send from a specific account (set `EMAIL_FROM` on the gateway):

```bash
echo "Body" | s-nail -s "Subject" -S from=<email> recipient@example.com
```

## Read inbox (single method: fetch-emails)

Run `fetch-emails <n> <account>` — the account is required unless `GMAIL_ACCOUNT` is set on the gateway.

The script reads the Gmail app password from `GMAIL_APP_PASSWORD` env (or a file under `~/.config/gmail/`).

```bash
fetch-emails 5 <account>
```

## CRITICAL rules

- NEVER use himalaya for sending — it's blocked
- NEVER pass $GMAIL_APP_PASSWORD in any command — fetch-emails reads it from the environment (or `~/.config/gmail/`) internally
- Pass an explicit `<account>` unless `GMAIL_ACCOUNT` is set — never assume a default
- Present the fetched result exactly ONCE — do not re-fetch or re-summarize the same data
- Use `-S from=<email>` with s-nail when sending from a specific account

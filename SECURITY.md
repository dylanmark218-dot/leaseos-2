# Security Policy

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion for a suspected vulnerability.**
A public report tells everyone, including whoever would use it, before there is a fix.

Use GitHub's private vulnerability reporting for this repository where it is available —
the **Security** tab → **Report a vulnerability**. If it is not enabled, contact a
repository administrator privately and ask for a private channel before sending any
detail.

## What to include

- **Affected component** — the route, procedure, screen, job or file, as precisely as you
  can identify it.
- **Reproduction** — the steps, request or input that triggers it, and what is needed to
  be in a position to try it (an account, a role, a tenant, network position).
- **The boundary you expected to hold** — for example "a dispatcher in company A should
  not be able to read company B's records", or "this credential should never reach the
  browser". Naming the expected boundary is often more useful than the payload, because
  it says which rule is broken.
- **Impact** — what an attacker gains: whose data, which tenants, what actions, and
  whether it needs authentication first.
- **Version** — the commit or release you observed it on.

## What not to include

- **No live secrets.** Do not paste real tokens, API keys, session cookies, passwords or
  private keys. Describe the credential's type and where it came from. If a live secret
  is involved, say so — it needs rotating — but do not transmit its value.
- **No unnecessary personal or customer data.** Redact driver, employee and customer
  details, and trim logs to the lines that matter. Send the smallest evidence that
  demonstrates the problem.

## How fixes are handled

A security fix carries a **regression test** wherever that is technically possible. The
test must fail against the vulnerable code — a fix whose test passes both before and
after has proved nothing, and this is the one place that distinction is worth the extra
work every time.

Where a test genuinely cannot reach the behaviour, the pull request says so explicitly and
explains what was verified instead.

Fixing the reported instance is not the end of it. A vulnerability is usually a _pattern_ —
one unscoped query, one missing authorization gate, one credential on the wrong side of a
boundary — so the adjacent instances get reviewed in the same change, and the pull request
records what was searched and what was found.

## Scope note

This policy covers the code in this repository. Vulnerabilities in third-party services
LeaseOS integrates with should go to that provider, though telling us as well is welcome
so the integration can be defended in the meantime.

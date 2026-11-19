# Security

Hatchlight keeps API keys and private pictures on people's computers, so
security problems matter a lot to us.

## Report a problem

Please report it privately, not in a public issue: open
[a private vulnerability report](https://github.com/hatchlight/hatchlight/security/advisories/new)
(the **Security** tab of the repository, **Report a vulnerability**). Only the
maintainers see the report.

Say what an attacker could do, and how to reproduce it. We answer within a
week, keep you informed while we fix it, and credit you in the release notes
unless you prefer otherwise.

## Disclosure

We aim to release a fix within 90 days of the report, sooner for problems that
are easy to exploit. Once the fix is out, we publish a
[security advisory](https://github.com/hatchlight/hatchlight/security/advisories)
that describes the problem, the affected versions and the version that fixes
it. Please keep the problem private until then; if 90 days pass without a fix,
tell us before you disclose it.

## What counts

Anything that lets someone other than the person running Hatchlight read their
keys, pictures or prompts, run code on their computer, or make requests with
their keys. For example: another website reaching the local server, a crafted
model download or engine running something it should not, a key sent to the
wrong provider, or a path escaping the data directory.

## Supported versions

Fixes go into the latest release. Please check that a problem still happens
there before reporting it.

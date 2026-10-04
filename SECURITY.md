# Security Policy

## Supported versions

JAR is currently maintained from the canonical `main` branch. Historical research
branches and experimental treatments are retained for reproducibility and are not
supported security release lines.

## Reporting a vulnerability

Please do not disclose exploitable security details in a public issue.

If GitHub private vulnerability reporting is enabled for this repository, use
**Security → Report a vulnerability**.

If private vulnerability reporting is unavailable, open a minimal public issue
stating that you need a private reporting channel, without including exploit
details, credentials, private data, or reproduction material that would make the
issue actionable to an attacker.

Useful reports include:

- affected JAR version or commit;
- affected host/runtime and operating system;
- the security boundary involved;
- impact and prerequisites;
- a minimal safe reproduction;
- whether credentials, permissions, model-visible context, or telemetry privacy
  are involved.

## Security-sensitive surfaces

Please treat issues in these areas as security-sensitive:

- authentication and credential storage;
- capability exposure and permission boundaries;
- sandbox/runtime admission and command review;
- model-visible context or source material crossing an unintended boundary;
- telemetry redaction, local path privacy, or secret persistence;
- integrity checks around runtime materialization or source provenance.

Ordinary correctness bugs, benchmark disagreements, and research-result questions
can use normal GitHub issues.

## Project posture

JAR does not replace the host's permission model. Deterministic policy and host
authorization remain authoritative over execution, and telemetry is observational
rather than an authorization input.

The project is provided under the MIT License without warranty.

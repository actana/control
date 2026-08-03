# Governance

This document describes how decisions are made in this project.

## Roles

| Role | Rights | How to get there |
|---|---|---|
| **Contributor** | Anyone who opens issues/PRs | Just contribute |
| **Reviewer** | Triage issues, review PRs (non-binding) | Sustained quality contributions; nominated by a maintainer |
| **Maintainer** | Merge rights, release rights, binding review, CODEOWNERS | Nominated by a maintainer, approved by ⅔ of maintainers |
| **Lead / Steering** | Tie-breaking vote, roadmap ownership | Elected by maintainers annually |

Inactive maintainers (no activity for 6 months) are moved to emeritus status; emeritus maintainers can be reinstated by a simple majority vote.

## Decision making

- **Default: lazy consensus.** Proposals (issues, RFCs, PRs) are accepted if no maintainer objects within 5 business days.
- **Significant changes** (breaking API changes, new dependencies with license implications, architectural shifts) require an **RFC**: open a Discussion/issue labeled `rfc`, with problem statement, proposal, and alternatives. Accepted by lazy consensus of maintainers.
- **Contested decisions** are resolved by a simple majority vote of maintainers; the Lead breaks ties.
- **Changes to this document, CODEOWNERS, or the Code of Conduct** require ⅔ approval of all maintainers.

## Ground rules

- All project decisions happen in public (issues, discussions, PRs) — not in private channels.
- Conventions in [CONTRIBUTING.md](CONTRIBUTING.md) apply to everyone, including maintainers. CI enforcement is never bypassed except for a declared repository emergency, which must be documented in an issue afterwards.
- Security reports are handled per [SECURITY.md](SECURITY.md) and are the only accepted private workflow.

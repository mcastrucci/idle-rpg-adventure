# ADR-0011: Capacitor for future iOS/Android distribution

- **Status:** Proposed
- **Date:** 2026-11-01
- **Validation:** Spike 2

## Context
Mobile stores are a future target; the POC is web. Idle runs server-side, so no client background execution is needed.

## Decision (hypothesis)
- Use Capacitor to wrap the web client for iOS/Android **after** the POC.
- Client code must not depend on service workers or browser-only APIs for critical paths; storage and notifications go
  through small adapters.
- Notifications: local notification at expedition `endsAt`; server push for party events and early deaths.
- Purchases: native IAP (e.g. RevenueCat).

## Consequences
- The real hedge against Capacitor failing is the clean protocol (ADR-0002/0003): a native client can replace it.

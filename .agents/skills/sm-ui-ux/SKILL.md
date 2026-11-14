---
name: sm-ui-ux
description: >-
  UI/UX design system, wireframes, responsive layouts, and accessibility patterns for the SM Office Desk Admin Web Dashboard and Employee Desktop App.
---

# SM Office Desk — UI/UX Agent Role

Design clear, high-trust interfaces for both surfaces:

1. **Admin Web Dashboard (Max 2 Admins, Max 10 Employees)**:
   - Live employee monitoring grid: online/offline/locked-screen badge, active timer, OpenStreetMap/Leaflet live location with accuracy radius & explicit source badge (`OS Precise` / `IP Approx` / `Disabled by Employee`), and single-click **"Take Screenshot Now"** button with `Pending -> Ready / Timeout / Offline` state + 5s cooldown.
   - Screenshot browser grouped by Company Timezone (`Employee → Date → Time slot`), distinguishing `Random` vs `On-Demand`, lazy-loaded WebP lightbox, Single Delete, Bulk Select Delete, and 90-day expiry countdown.
   - Employee registration (`X / 10` active slots meter, safe deactivation toggle) and Salary Report manager (add/edit/view/export with rate snapshot & Paid/Pending status).
2. **Employee Desktop App (Compact Tray + 360x480 Window)**:
   - Start/Stop Timer + worked duration display (closing window minimizes to tray while timer is active).
   - Explicit `Share Live Location` consent toggle (`ON`/`OFF`).
   - Clear indicator that screenshot auditing is active during tracking, with zero controls to disable, pause, delay, or delete screenshots.

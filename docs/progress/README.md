# Progress notes

Day-by-day build notes for Fuse_Box, written as the work landed during
the Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026).

- **Day 1 (Oct 26)** — no separate note; Day 1 is the initial source
  release in this repo's history, and the main README describes what it
  proved: scareware protection (live test), text-first PC control, and
  machine-health checks on a real PC.
- **[Day 2 (Oct 27)](day-2.md)** — the box becomes the appliance; phone
  Guardian first light; on-screen keyboard; Settings and Wi-Fi.
- **[Day 3 (Oct 28)](day-3.md)** — the Guardian hold flow and family
  password, the back-to-back call fix, both house phones, the
  text-fraud warning call, the Fuse Shop.
- **[Day 4 (Oct 29)](day-4.md)** — cold-start recovery verified, the
  rules question settled, and this repository caught up.
- **Installer (Oct 29, evening)** — `install.sh` at the repo root: one
  command (clone + `sudo ./install.sh`) installs every dependency and
  turns a clean Ubuntu 24.04 machine into a Fuse Box, then reboots into
  it. Built and proven the same evening in a clean VM.

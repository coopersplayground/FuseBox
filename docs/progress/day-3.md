# Day 3 — Wednesday, October 28, 2026

The Guardian learned to step in, the second phone joined the line, and
the box got its app store.

**The hold flow, end to end.** When the live scam watch fires on a call,
the Guardian now steps in for real: the two parties are cut off from
each other into separate bridges, the caller hears a hold announcement
and music, and the person at home hears what was flagged and why. To put
the call back together, the Guardian asks the caller for the family
password first — a word only the family knows, set on the box's own
screen. Right answer, the call reconnects. Wrong answer or silence, the
call ends. Only the caller's side of the conversation is ever scanned;
the person at home can say anything.

Two tuning rules landed with it. A short list of phrases ends the debate
instantly — one mention of a social security number from the caller is
enough to step in. Everything else needs two distinct watch hits, so one
stray word does not hijack a real call.

**The back-to-back call bug.** Three test calls in a row exposed a real
failure: the first two stepped in cleanly, the third ran over a minute
with almost nothing transcribed live. The cause was in the transcription
service, not the phones: the end-of-call deep pass ran on the same loop
that feeds live transcription, so a long call's final pass starved the
next call. Fixed the same day — final passes now run on their own
thread, wait until no call is live, and the live buffer drops its oldest
audio when it falls behind instead of drowning. The recordings proved
the caller's audio had been there all along; the ear was just busy.

**Both house phones.** An old analog phone joined the desk phone on the
Guardian line through a phone adapter the box programs itself — pick it
in the Guardian app and the box writes the settings. Inbound calls ring
both phones. The move also surfaced a trunk bug worth the day alone: a
single rejected registration had latched the carrier trunk off, silently
killing inbound calls for hours. The generator now forbids the latch,
and registration state is the first thing checked when inbound dies.

**The text-fraud call.** A scam that arrives as a text on the PC screen
now makes the house phones ring. When the PC watcher calls a message a
fraud, the Guardian places a call to both phones and plays a plain
spoken warning: do not tap anything, do not reply, do not send money.
Proven live the same afternoon — board card, room announcement, and the
phone call all fired from one simulated scam text. Repeat calls are
deduplicated so the phones do not ring all day for the same warning.

**PC snapshot fix.** The board's view of the PC screen was showing only
the top-left quarter on high-DPI displays. The agent now captures in a
DPI-aware helper process and photographs the full physical screen; the
fix rides the agent's normal self-update.

**Fuse Shop.** The box runs Android apps now (Waydroid), and the Fuse
Shop is its store: a curated catalog mirrored from F-Droid, filtered to
apps a person would actually use — no launchers, no keyboards, no root
tools. Installed apps appear as tiles in the drawer, open full screen,
and close with one big red button. The kiosk browser rules were locked
down the same day: no pinch zoom, no split view, no drag-to-split, on
the board page and in the browser.

**Guardian page.** Rebuilt around the two Guardians — Phone Guardian and
PC Guardian as separate cards with honest online state — and it always
opens on that main view. Add-a-PC shipped with it: the box advertises
itself on the network as a device named FUSEBOX with a single installer
file, so adding a computer is a double-click, not a project.

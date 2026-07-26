# Test SIDs

Development fixtures — a spread of tunes used to exercise the analyzer,
the exporter and the visualizers during development. Nothing here is served by
the site or shipped in a build; the tunes visitors browse come from the HVSC
mirror (`hvsc-data/`, extracted to `public/HVSC/` at build time).

They are kept because the awkward cases are the useful ones. Between them these
files cover: PSID and RSID, 6581 and 8580, PAL and NTSC, single- and multi-song
tunes (`martingalway-parallax-multisong.sid`,
`charlesdeenen-mrheli-multisong.sid`), 2SID and 3SID setups
(`MCH-MontyOnTheRunDnBEdit-2SID.sid`, `Phat_Frog_2SID.sid`,
`shogoon-cheezzytop-3SID.sid`), multispeed and raster-timed players, tunes that
loop cleanly versus tunes that fade to silence, and players whose SID write
order is consistent (`JCH-Crystalline.sid`, `stinsen-diagonality.sid`) versus
players where it varies (`6r6-axelf.sid`, `Xiny-Laxity.sid`) — the cases that
decide whether the shadow-register bar method can be used. See
`SIDPlayers/BAR_HEIGHT_METHODS.md` for how that matters.

## Copyright

Each tune remains the copyright of its composer, credited in the SID header.
They are included here only as test input for developing SIDquake, and most are
also part of the High Voltage SID Collection. If you are a composer here and
would rather your tune was not in this repository, mail
<raistlin@c64demo.com> and it will be removed.

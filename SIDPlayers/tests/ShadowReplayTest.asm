//; =============================================================================
//; ShadowReplayTest.asm - assembles the shadow-register replay loop on its own so
//; scripts/test-shadow-replay.js can run it in the 6510 emulator and check it
//; pushes the mirror out to the real SID exactly as the exporter expects.
//;
//; PlayMusicShadow and public/prg-builder.js have to agree byte-for-byte on the
//; replay-order table: what an entry means ($D400 offset, so chip N is
//; $20*N + register), how many entries there are, and what ends the list. Get any
//; of that wrong and the export is silently mistuned or silent - so both sides are
//; pinned to the same answer here.
//;
//; Build:  java -jar KickAss.jar SIDPlayers/tests/ShadowReplayTest.asm \
//;                 -define SPECTROMETER_SHADOW -binfile -o <out>.bin
//; The .bin loads at $0800. Fixed entry points (see the runner):
//;   $0800  jmp PlayMusicShadow    - the routine under test
//;   $0803  .word sidRegisterMirror
//;   $0805  .word shadowOrder
//; =============================================================================

.const DATA_ADDRESS = $0700

#define INCLUDE_MUSIC_ANALYSIS

* = $0800 "test entry"

    jmp PlayMusicShadow                 //; $0800
    .word sidRegisterMirror             //; $0803
    .word shadowOrder                   //; $0805

//; The player tail-jumps into the bar analysis; it reads the same mirror but has
//; nothing to do with the replay contract, so it is stubbed out here.
AnalyzeSIDRegisters:
    rts

//; The tune's play routine. In a shadow export its $D4xx stores were repointed at
//; the mirror, so from the replay loop's point of view a play call writes nothing
//; to the SID - which is exactly what this stub does.
SIDPlayStub:
    rts

//; Host-player state RestartMusic reads (unused by the replay loop itself).
CurrentSong:
    .byte $00

#import "../INC/common.asm"
#import "../INC/musicplayback.asm"

//; Minimal data block: the player reaches the tune through the JMPs at its start.
* = DATA_ADDRESS "data block"
    jmp SIDPlayStub                     //; +$00 SIDInit
    jmp SIDPlayStub                     //; +$03 SIDPlay

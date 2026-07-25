// =============================================================================
//                          MUSIC PLAYBACK MODULE
//                     Unified music playback for all visualizers
// =============================================================================

#importonce

// Graphics-donor builds (-define GFX_DONOR) carry no code: the full-bank
// bins only donate the VIC assets to the relocating exporter.
#if !GFX_DONOR

// =============================================================================
// JustPlayMusic - call SIDPlay, optionally bracketed by border-colour writes
// to $D020 to draw a raster timing bar when ShowRasterBars is set.
// =============================================================================
JustPlayMusic:
    #if INCLUDE_F1_SHOWRASTERTIMINGBAR
    lda ShowRasterBars
    beq !skip+
    lda #$02
    sta $d020
!skip:
    #endif

    jsr SIDPlay

    #if INCLUDE_F1_SHOWRASTERTIMINGBAR
    lda ShowRasterBars
    beq !skip+
    lda #$00
    sta $d020
!skip:
    #endif // INCLUDE_F1_SHOWRASTERTIMINGBAR

    rts

// =============================================================================
// FORCED SONG LOOP
// MusicLoopFrames (data block $D0-$D2, see common.asm) is a 24-bit raster
// frame count after which the tune is restarted from the beginning. The web
// exporter sets it for tunes that fade to silence and stop instead of looping
// (0 = disabled, the default, so existing exports behave exactly as before).
//
// Live (realtime/shadow) players tick CheckMusicLoop once per frame from the
// shared IRQ scheduler (INC/multicallirq.asm) and from their fast-forward
// loops. Baked spectrometer players compile the countdown out and instead
// restart on the baked stream's wrap (INC/timer.asm ResetTimerToLoop), so the
// audio restarts on exactly the frame the bars wrap back to the start.
// =============================================================================

MusicLoopCounter: .fill 3, $00

// Arm (or re-arm) the countdown from the exporter-set frame count.
InitMusicLoop:
    ldx #$02
!copy:
    lda MusicLoopFrames, x
    sta MusicLoopCounter, x
    dex
    bpl !copy-
    rts

#if !SPECTROMETER_BAKED
// Tick the forced-loop countdown one frame. Returns carry SET when the tune
// was restarted this frame (the caller may skip that frame's play call).
CheckMusicLoop:
    lda MusicLoopFrames
    ora MusicLoopFrames + 1
    ora MusicLoopFrames + 2
    beq !off+
    // 24-bit decrement
    lda MusicLoopCounter
    bne !dec0+
    lda MusicLoopCounter + 1
    bne !dec1+
    dec MusicLoopCounter + 2
!dec1:
    dec MusicLoopCounter + 1
!dec0:
    dec MusicLoopCounter
    lda MusicLoopCounter
    ora MusicLoopCounter + 1
    ora MusicLoopCounter + 2
    bne !off+
    jsr InitMusicLoop
    jsr RestartMusic
    sec
    rts
!off:
    clc
    rts
#endif // !SPECTROMETER_BAKED

// Silence every SID and re-init the current song from the top. Interrupts are
// held off across the init: a mid-frame CIA music call (or, in the baked
// players, a nested call into FrameCall) must never play into a half-run init.
// $D420/$D440/$D460 mirror $D400 on a stock C64, so the extra clears are
// harmless there and silence real extra chips on multi-SID machines.
RestartMusic:
    php
    sei
    lda #$00
    ldx #$18
!silence:
    sta $d400, x
    sta $d420, x
    sta $d440, x
    sta $d460, x
    dex
    bpl !silence-
    lda CurrentSong
    tax
    tay
    jsr SIDInit
    plp
    rts

// =============================================================================
// Music playback with SID analysis (for visualizers)
// Supports up to 4 SID chips at $D400, $D420, $D440, $D460
// Baked (FFT) players never analyse, so this whole block - AnalyseMusic, the
// register mirror, and PlayMusicWithAnalysis - is dropped in baked builds.
// =============================================================================
#if INCLUDE_MUSIC_ANALYSIS && !SPECTROMETER_BAKED

#if !SPECTROMETER_SHADOW
AnalyseMusic:
    lda $01
    pha
    lda #$30
    sta $01

    jsr BackupSIDMemory
    jsr SIDPlay
    jsr RestoreSIDMemory

    // Mirror SID 1 registers ($D400-$D418) - always active
    ldy #24
!loopSID1:
    lda $d400, y
    sta sidRegisterMirror, y
    dey
    bpl !loopSID1-

    // Mirror SID 2 registers ($D420-$D438) if NumSIDChips >= 2
    lda NumSIDChips
    cmp #2
    bcc !skipSID2+
    ldy #24
!loopSID2:
    lda $d420, y
    sta sidRegisterMirror + 25, y
    dey
    bpl !loopSID2-
!skipSID2:

    // Mirror SID 3 registers ($D440-$D458) if NumSIDChips >= 3
    lda NumSIDChips
    cmp #3
    bcc !skipSID3+
    ldy #24
!loopSID3:
    lda $d440, y
    sta sidRegisterMirror + 50, y
    dey
    bpl !loopSID3-
!skipSID3:

    // Mirror SID 4 registers ($D460-$D478) if NumSIDChips >= 4
    lda NumSIDChips
    cmp #4
    bcc !skipSID4+
    ldy #24
!loopSID4:
    lda $d460, y
    sta sidRegisterMirror + 75, y
    dey
    bpl !loopSID4-
!skipSID4:

    pla
    sta $01

    jmp AnalyzeSIDRegisters

// 4 x 25 bytes = 100 bytes for up to 4 SID chip register mirrors.
// A player short on code space can relocate this runtime-only buffer by
// defining SIDREGMIRROR_EXTERNAL and providing its own
// `.label sidRegisterMirror = <address>` (no initial contents needed - the
// mirror is fully rewritten before it is read).
#if !SIDREGMIRROR_EXTERNAL
sidRegisterMirror: .fill 100, 0
#endif // !SIDREGMIRROR_EXTERNAL

#else // SPECTROMETER_SHADOW
// Shadow method (single SID): the play routine's $D4xx stores - including the
// ones in the tune's init - were repointed at sidRegisterMirror, so the mirror
// always holds the tune's full intended SID state (init's volume/filter plus
// whatever this frame's play wrote). We replay ALL 25 SID1 registers ($00-$18)
// every frame in shadowOrder's baked canonical order: that way no write is ever
// missed (init-only registers, or a frame that touches extra registers, still
// reach the real SID), and re-writing an unchanged register with its own mirror
// value is harmless. shadowOrder is a full permutation of $00-$18 (25 bytes);
// the exporter fills it with the tune's detected order, or a safe fallback
// ($18,$17,..,$00) when the per-frame order isn't consistent enough.
// sidRegisterMirror honours SIDREGMIRROR_EXTERNAL just like the analyse path,
// so logo players (short on code space) can relocate the runtime-only buffer.
#if !SIDREGMIRROR_EXTERNAL
.align $100
sidRegisterMirror: .fill 100, 0
#endif
shadowOrder: .fill 25, $00

//; The exporter must inject the SID mirror page + the 25-byte replay order at
//; the EXACT addresses these labels land on - both move as the code changes
//; (sidRegisterMirror is external in the logo players, inline elsewhere), so
//; hand-maintained config addresses silently drift and corrupt the export.
//; Emit them here so the build tooling (gen-reloc-codeonly.js) can capture the
//; live addresses into the reloc table instead. Compile-time only.
.print "SHADOW_LABELS mirror=" + toHexString(sidRegisterMirror & $ffff) + " order=" + toHexString(shadowOrder & $ffff)

PlayMusicShadow:
    jsr SIDPlay
    ldx #$00
!replay:
    ldy shadowOrder, x
    lda sidRegisterMirror, y
    sta $d400, y
    inx
    cpx #25
    bcc !replay-
    jmp AnalyzeSIDRegisters
#endif // !SPECTROMETER_SHADOW

#endif // INCLUDE_MUSIC_ANALYSIS && !SPECTROMETER_BAKED

// =============================================================================
// Combined playback routine for visualizers
// =============================================================================
#if INCLUDE_MUSIC_ANALYSIS && !SPECTROMETER_BAKED && !SPECTROMETER_SHADOW
PlayMusicWithAnalysis:
    jsr JustPlayMusic
    jmp AnalyseMusic
#endif // INCLUDE_MUSIC_ANALYSIS
#endif // !GFX_DONOR

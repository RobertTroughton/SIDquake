// =============================================================================
//                            ELAPSED-TIME TIMER
//        Shared MM:SS play-time counter + on-screen display for visualizers
// =============================================================================
//
// A visualizer that wants a timer defines these BEFORE importing this file,
// then calls InitTimer once (after its text is drawn) and UpdateTimer once per
// visual frame:
//
//   TIMER_SCREEN0 / TIMER_SCREEN1 : the two double-buffered screen RAM bases
//                                   (set both the same for a single-buffer player)
//   TIMER_POS                     : byte offset within a screen of the top-left
//                                   digit (line * 40 + column)
//   TIMER_COLOR                   : colour (0-15) written to $D800 for the digits
//   TIMER_DOUBLE_HEIGHT           : 1 for the 1x2 (double-height) bar fonts, where
//                                   the bottom row is char|$80; 0 for a 1x1 font
//   TIMER_FPS                     : frames per second (50 PAL / 60 NTSC); optional,
//                                   defaults to 50
//
// Digits use screen code 48+n and ':' is 58 - the same mapping the web app uses
// when it encodes song text (see stringToPETSCIIRaw), so the visualizer's own
// font already carries these glyphs.

#importonce

// Graphics-donor builds (-define GFX_DONOR) carry no code: the full-bank
// bins only donate the VIC assets to the relocating exporter.
#if !GFX_DONOR

#if !TIMER_FPS
.const TIMER_FPS = 50
#endif

//; For a 1x2 (double-height) font the bottom row of each glyph is the top char
//; plus this offset. The bar fonts put digit bottoms at code+$80.
#if !TIMER_BOTTOM_OFFSET
.const TIMER_BOTTOM_OFFSET = $80
#endif

TimerFrames:   .byte $00
TimerSeconds:  .byte $00
TimerMinutes:  .byte $00
timerChars:    .fill 5, $00        // MM:SS screen codes

#if TIMER_MOVABLE
//; The timer column is chosen at runtime: when it stands alone it sits at
//; TIMER_POS_ALONE (flush-right or centred, whatever the player wants), but when a
//; "/MM:SS" song length is shown to its right it shifts to TIMER_POS. The player sets
//; timerAlone (1 = no length -> TIMER_POS_ALONE, 0 = length present -> TIMER_POS)
//; before calling InitTimer. Both positions are fixed constants, so we just branch to
//; the right pair of stores - no self-modify.
timerAlone: .byte $01
#endif

// Zero the counter, set the (static) colour once, and paint 00:00.
InitTimer:
    lda #$00
    sta TimerFrames
    sta TimerSeconds
    sta TimerMinutes
    //; Colour RAM never changes, so write the 5 columns (both rows) just once.
#if TIMER_MOVABLE
    lda timerAlone
    beq !colourLeft+
    ldx #4
!colourR:
    lda #TIMER_COLOR
    sta $d800 + TIMER_POS_ALONE, x
    sta $d800 + TIMER_POS_ALONE + 40, x
    dex
    bpl !colourR-
    jmp DrawTimer
!colourLeft:
#endif
    ldx #4
!colour:
    lda #TIMER_COLOR
    sta $d800 + TIMER_POS, x
    sta $d800 + TIMER_POS + 40, x
    dex
    bpl !colour-
    jmp DrawTimer

#if SPECTROMETER_BAKED
// Re-sync the clock to the tune's loop point (the baked stream just wrapped).
// Where a tune loops back past an intro, the true play position never returns to
// 0:00, so we reset to the loop-point time the exporter baked in, not zero.
// Frame-exact: the exporter supplies the loop point as MM:SS plus an
// intra-second frame remainder (bakedLoopFrameRem), so a loop at e.g. 43.34s
// resets the internal frame counter to 43s + 17 frames - never a rounded
// second, so the clock cannot drift against the stream across replays.
// Baked-only: the loop-point fields exist just for the precomputed stream, and
// keeping this out of the live/shadow builds saves the bytes a tight WithLogo
// full build needs below the bitmap.
ResetTimerToLoop:
    //; Forced song loop: for a fade-out tune exported with the loop option the
    //; baked stream wraps back to keyframe 0, and MusicLoopFrames is non-zero -
    //; restart the tune here so the audio restarts on the exact frame the bars
    //; do. Naturally-looping tunes export MusicLoopFrames = 0 and skip this.
    lda MusicLoopFrames
    ora MusicLoopFrames + 1
    ora MusicLoopFrames + 2
    beq !noRestart+
    jsr RestartMusic
!noRestart:
    lda bakedLoopFrameRem
    sta TimerFrames
    lda bakedLoopMin
    sta TimerMinutes
    lda bakedLoopSec
    sta TimerSeconds
    jmp DrawTimer
#endif

// Advance one visual frame; redraw only when the second changes.
UpdateTimer:
#if TIMER_LOOP_WRAP
    //; Live (realtime/shadow) players have no stream-wrap signal, so the clock
    //; would run past the shown length (e.g. 04:00 / 03:20). CheckLoopWrap snaps
    //; it back to the loop point the moment it reaches the loop end and sets
    //; carry so we skip this frame's increment. Baked players don't define
    //; TIMER_LOOP_WRAP - they reset on the stream wrap (ResetTimerToLoop).
    jsr CheckLoopWrap
    bcs !done+
#endif
    inc TimerFrames
    lda TimerFrames
    cmp #TIMER_FPS
    bcc !done+

    lda #$00
    sta TimerFrames
    inc TimerSeconds
    lda TimerSeconds
    cmp #60
    bcc !draw+

    lda #$00
    sta TimerSeconds
    inc TimerMinutes
    lda TimerMinutes
    cmp #100
    bcc !draw+
    lda #99                        // clamp at 99:59
    sta TimerMinutes
    lda #59
    sta TimerSeconds
!draw:
    jsr DrawTimer
!done:
    rts

#if TIMER_LOOP_WRAP
//; Loop wrap for the live players. Carry set on return = wrapped (the caller
//; skips the per-frame increment). Compares the clock (MM:SS:frame) against the
//; loop-end time (bakedLoopEnd*, which equals the shown length) and, the moment
//; it reaches or passes it, snaps back to the loop point (bakedLoop*) and
//; redraws. Reached-or-passed (not exact ==) so a tune whose loop-end frame
//; lands outside the player's frame count still wraps on the next frame.
CheckLoopWrap:
    lda bakedHasLength
    beq !no+
    lda TimerMinutes
    cmp bakedLoopEndMin
    bcc !no+
    bne !wrap+
    lda TimerSeconds
    cmp bakedLoopEndSec
    bcc !no+
    bne !wrap+
    lda TimerFrames
    cmp bakedLoopEndFrameRem
    bcc !no+
!wrap:
    lda bakedLoopFrameRem
    sta TimerFrames
    lda bakedLoopSec
    sta TimerSeconds
    lda bakedLoopMin
    sta TimerMinutes
    jsr DrawTimer
    sec
    rts
!no:
    clc
    rts
#endif

// A (0..99) -> X = tens, A = ones
TimerDiv10:
    ldx #$ff
!loop:
    inx
    sec
    sbc #10
    bcs !loop-
    adc #10
    rts

DrawTimer:
    lda TimerMinutes
    jsr TimerDiv10
    pha
    txa
    clc
    adc #48
    sta timerChars + 0
    pla
    clc
    adc #48
    sta timerChars + 1
    lda #58                        // ':'
    sta timerChars + 2
    lda TimerSeconds
    jsr TimerDiv10
    pha
    txa
    clc
    adc #48
    sta timerChars + 3
    pla
    clc
    adc #48
    sta timerChars + 4

    //; Plot the 5 digits into both screen buffers. Colour is static (set in
    //; InitTimer). 1x2 font: top glyph = code, bottom glyph = code+$40. The
    //; bottom row is unconditional - KickAss #if runs before .const exists, so
    //; a .const height flag would never be seen; every timer user is 1x2.
#if TIMER_MOVABLE
    lda timerAlone
    beq !writeLeft+
    ldx #4
!writeR:
    lda timerChars, x
    sta TIMER_SCREEN0 + TIMER_POS_ALONE, x
    sta TIMER_SCREEN1 + TIMER_POS_ALONE, x
    ora #TIMER_BOTTOM_OFFSET
    sta TIMER_SCREEN0 + TIMER_POS_ALONE + 40, x
    sta TIMER_SCREEN1 + TIMER_POS_ALONE + 40, x
    dex
    bpl !writeR-
    rts
!writeLeft:
#endif
    ldx #4
!write:
    lda timerChars, x
    sta TIMER_SCREEN0 + TIMER_POS, x
    sta TIMER_SCREEN1 + TIMER_POS, x
    ora #TIMER_BOTTOM_OFFSET
    sta TIMER_SCREEN0 + TIMER_POS + 40, x
    sta TIMER_SCREEN1 + TIMER_POS + 40, x
    dex
    bpl !write-
    rts

#endif // !GFX_DONOR

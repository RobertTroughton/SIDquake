// =============================================================================
//                      MULTI-CALL IRQ SCHEDULER MODULE
//              Common interrupt framework for all visualizers
// =============================================================================
//
// Music timing ("double IRQ" scheme):
//   - Music call 0 (the "frame call") is raster-driven at a fixed sync line
//     once per frame (the player's frame handler).
//   - Music calls 1..N-1 (N = NumCallsPerFrame) are CIA1 Timer B driven,
//     evenly spaced at FRAME_CYCLES/N cycles. The timer is force-reloaded on
//     every frame call, so the schedule can never drift against the raster.
//     (Timer B rather than Timer A: CIA-timed SIDs that poke a timer almost
//     always target Timer A, and SetupStableRaster leaves Timer B running -
//     InitMultiCallIRQ reclaims it.)
//
// Display timing:
//   - Visualizer raster events (logo/effect splits) run as short "urgent"
//     IRQs that are allowed to interrupt a music call: the music section runs
//     with the CIA interrupt masked and the I flag cleared. Urgent handlers
//     only flip VIC registers, re-arm the next raster event and exit, so
//     nesting never disturbs SID playback.
//
// This is the "overlapping IRQ handlers" technique
// (https://trident64.github.io/overlapping-irq-handlers/): inside a long
// handler, arm the next interrupt, acknowledge the current one, cli, THEN do
// the long work - so later, more urgent interrupts execute on top of it.
// Mapping to the classic IRQ_MainControl/IRQ_AGSP shape: MusicFrameHandler +
// MusicFrameCall is the long "main control" IRQ (urgent VIC writes, arm next
// event, play music, run frame work - all interruptible after the early cli);
// the split handlers are the short high-priority IRQs that overlap it; the
// dispatcher provides the register/$01 save-restore that makes every level
// re-entrant; FrameActive / the CIA mask / MusicCallsLeft are the
// re-entrancy guards.
//
// Nesting rules enforced here:
//   - A split may interrupt a music call or frame work (depth 1).
//   - Music can never interrupt music: the CIA interrupt is masked for the
//     whole play call. A timer underflow that happens meanwhile stays latched
//     in the ICR and is delivered as soon as the mask is re-enabled.
//   - Once-per-frame work (bar updates, timers, sprites) runs after the frame
//     play call with the CIA re-enabled, so a mid-frame music call may nest
//     into it instead of being delayed - display work never affects the music.
//   - The blind spot (I flag set, splits must wait) is kept to the dispatcher
//     prologue plus a few instructions (~60 cycles, under one raster line).
//     Splits whose write position is beam-critical are armed one line early
//     and use WaitUntilRasterLine to land at a fixed cycle regardless of what
//     they interrupted.
//
// -----------------------------------------------------------------------------
// PLAYER CONTRACT
// -----------------------------------------------------------------------------
// The player imports this file after common.asm / keyboard.asm /
// musicplayback.asm and defines three routines:
//
//   MusicFrameHandler   Raster handler for the frame-sync event. Entered via
//                       the dispatcher (registers + $01 already saved, raster
//                       already acknowledged, $01 = $35). It must:
//                         1. do its urgent VIC writes (border-area setup),
//                         2. re-arm the next raster event with
//                            SetNextRasterEvent(line, handler),
//                         3. end with `jmp MusicFrameCall`.
//
//   MusicCall_Frame     The frame play call (call 0). Usually
//                       `jmp JustPlayMusic` or `jmp PlayMusicWithAnalysis`.
//                       Runs with CIA masked; splits may nest into it.
//
//   MusicCall_Other     Play calls 1..N-1. Usually `jmp JustPlayMusic`.
//
//   FrameCall           Once-per-frame display work (timers, bar updates,
//                       sprite animation, flags for the main loop). Runs with
//                       interrupts enabled - keep music-safe (RAM/VIC only).
//
// Split handlers are entered the same way as MusicFrameHandler and must end
// with `jmp ExitIRQ` (after their VIC writes + SetNextRasterEvent).
//
// Setup (interrupts still disabled, after SIDInit/NMIFix):
//   jsr InitMultiCallIRQ
//   StartRasterEvents(MUSIC_SYNC_LINE, MusicFrameHandler)
//   cli
//
// =============================================================================

#importonce

// Graphics-donor builds (-define GFX_DONOR) carry no code: the full-bank
// bins only donate the VIC assets to the relocating exporter.
#if !GFX_DONOR

// -----------------------------------------------------------------------------
// Timer period tables: 7 PAL entries (N=2..8) followed by 7 NTSC entries,
// indexed by (N - 2) + ClockType * 7. N=1 never programs the timer.
// CIA timers count latch+1 cycles per underflow, hence the -1.
// -----------------------------------------------------------------------------

.const PAL_FRAME_CYCLES  = 312 * 63     // 19656
.const NTSC_FRAME_CYCLES = 263 * 65     // 17095
.const MAX_CALLS_PER_FRAME = 8
.const NUM_PERIODS = MAX_CALLS_PER_FRAME - 1

TimerPeriodLo:  .fill NUM_PERIODS, <(floor(PAL_FRAME_CYCLES  / (i + 2)) - 1)
                .fill NUM_PERIODS, <(floor(NTSC_FRAME_CYCLES / (i + 2)) - 1)
TimerPeriodHi:  .fill NUM_PERIODS, >(floor(PAL_FRAME_CYCLES  / (i + 2)) - 1)
                .fill NUM_PERIODS, >(floor(NTSC_FRAME_CYCLES / (i + 2)) - 1)

// Number of CIA-driven calls still expected this frame. Underflows that fire
// after the count is exhausted (timer rounding near the frame boundary) are
// acknowledged and ignored.
MusicCallsLeft:     .byte $00

// Effective calls per frame, clamped to 1..MAX_CALLS_PER_FRAME at init.
EffectiveCalls:     .byte $01

// Non-zero while a frame call (play + frame work) is in progress. If the
// machine is so overloaded that the next frame's sync IRQ arrives before the
// previous frame call finished, the new one is skipped instead of recursing.
FrameActive:        .byte $00

// -----------------------------------------------------------------------------
// SetNextRasterEvent - arm the next raster event (line < 256 assumed; every
// player keeps $d011 bit 7 clear). Safe to use inside handlers.
// -----------------------------------------------------------------------------

.macro SetNextRasterEvent(line, handler) {
    lda #line
    sta $d012
    lda #<handler
    sta RasterEventVector + 1
    lda #>handler
    sta RasterEventVector + 2
}

// -----------------------------------------------------------------------------
// WaitUntilRasterLine - spin until the raster reaches `line` (clobbers A).
//
// For display splits whose write position matters ("racing the beam"): arm
// the event ONE LINE EARLY, then use this at the top of the handler. The
// handler may be entered with 0-8 cycles of normal interrupt jitter, or tens
// of cycles late when it had to interrupt another handler's blind spot - the
// spin absorbs all of it, so the writes that follow land at a fixed spot
// within `line` every frame (+/- the 9-cycle loop granularity). If entry was
// so late the line has already passed, the wait falls through immediately.
// -----------------------------------------------------------------------------

.macro WaitUntilRasterLine(line) {
!wait:
    lda $d012
    cmp #line
    bcc !wait-
}

// -----------------------------------------------------------------------------
// StartRasterEvents - point the hardware vector at the dispatcher, arm the
// first event and enable raster interrupts. Call with I flag set.
// -----------------------------------------------------------------------------

.macro StartRasterEvents(line, handler) {
    SetNextRasterEvent(line, handler)

    lda #<IRQDispatcher
    sta $fffe
    lda #>IRQDispatcher
    sta $ffff

    lda #$01
    sta $d01a
    sta $d019
}

// -----------------------------------------------------------------------------
// InitMultiCallIRQ - clamp NumCallsPerFrame, pick the CIA period for the
// machine's clock, stop the timer and clear any stale CIA interrupts.
// Call with the I flag set.
// -----------------------------------------------------------------------------

InitMultiCallIRQ:
    lda NumCallsPerFrame
    bne !notZero+
    lda #$01
!notZero:
    cmp #MAX_CALLS_PER_FRAME + 1
    bcc !inRange+
    lda #MAX_CALLS_PER_FRAME
!inRange:
    sta EffectiveCalls

    sec
    sbc #2                      // table index (N - 2); N=1 skips the timer
    bmi !noTimer+
    ldx ClockType
    beq !pal+
    clc
    adc #NUM_PERIODS
!pal:
    tax
    lda TimerPeriodLo, x
    sta $dc06
    lda TimerPeriodHi, x
    sta $dc07
!noTimer:

    lda #$00
    sta $dc0f                   // stop Timer B (SetupStableRaster leaves it running)
    sta MusicCallsLeft

    lda #$7f
    sta $dc0d                   // mask all CIA1 interrupts
    lda $dc0d                   // clear any latched flags

    jsr InitMusicLoop           // arm the forced-loop countdown (no-op when disabled)

    rts

// =============================================================================
// IRQ DISPATCHER
// Single hardware entry point for both interrupt sources. Saves A/X/Y and $01
// (a nested split must reach the real VIC even while the spectrometer analysis
// has I/O banked out), then routes by source. Every handler exits via ExitIRQ.
// =============================================================================

IRQDispatcher:
    pha
    txa
    pha
    tya
    pha

    lda $01
    pha
    lda #$35
    sta $01

    lda $d019
    bpl !notVIC+
    sta $d019                   // acknowledge whatever VIC flagged
RasterEventVector:
    jmp $abcd                   // self-modified: current raster event handler

!notVIC:
    lda $dc0d                   // reading acknowledges CIA1
    and #$02                    // Timer B -> music call
    bne MusicTimerCall

ExitIRQ:
    pla
    sta $01
    pla
    tay
    pla
    tax
    pla
    rti

// =============================================================================
// MusicFrameCall - tail of the player's frame handler (music call 0).
// Restarts the CIA schedule, plays with the CIA masked (splits may nest),
// then runs once-per-frame work with the CIA live again.
// =============================================================================

MusicFrameCall:
    // Severe overload guard: if the previous frame call is somehow still in
    // progress, drop this one (the display slips a frame) instead of nesting
    // frame calls into each other until the stack dies.
    lda FrameActive
    bne ExitIRQ

    // Open up as early as possible: with the CIA masked, music still can't
    // nest into music, but from the cli onward an urgent raster event can
    // interrupt everything below - including the play call itself. Keeping
    // this blind spot tiny is what lets splits land on time even when they
    // fire into the middle of a frame call.
    lda #$7f
    sta $dc0d
    cli

    // Restart the evenly-spaced schedule for this frame: force-reload the
    // period and start the timer in continuous mode. Expect N-1 CIA calls.
    // The interrupt stays masked until the frame play call is done.
    ldx EffectiveCalls
    dex
    stx MusicCallsLeft
    beq !singleCall+

    lda #%00010001              // start + force load, continuous
    sta $dc0f
    // The last underflow of the previous frame lands on (or races) this very
    // raster event when FRAME/N divides evenly - discard any stale latched
    // flag now, or it would fire as a bogus call when the schedule reopens.
    lda $dc0d
!singleCall:

#if INCLUDE_SPACE_FASTFORWARD
    // While fast-forwarding, the main loop owns SIDPlay and the frame work;
    // the IRQ keeps only the raster events alive. The CIA stays masked.
    lda FastForwardActive
    beq !normal+
    jmp ExitIRQ
!normal:
#endif

    inc FrameActive

#if !SPECTROMETER_BAKED
    // Forced song loop (live players): tick the countdown once per frame and,
    // when it expires, CheckMusicLoop silences the SID and re-inits the tune.
    // Carry set = restarted this frame - skip this frame's play call so the
    // fresh init state isn't immediately advanced mid-frame. Baked players
    // restart on the baked stream's wrap instead (INC/timer.asm).
    jsr CheckMusicLoop
    bcs !skipPlay+
#endif
    jsr MusicCall_Frame
!skipPlay:

    ldx EffectiveCalls
    dex
    beq !noTimer+
    lda #$82                    // open the timer schedule (a latched call fires now)
    sta $dc0d
!noTimer:

    jsr FrameCall               // display work; music calls may nest into it

    sei
    dec FrameActive
    jmp ExitIRQ

// =============================================================================
// MusicTimerCall - CIA Timer B driven music call (calls 1..N-1).
// =============================================================================

MusicTimerCall:
    lda MusicCallsLeft
    beq ExitIRQ                 // stray underflow at the frame boundary
    dec MusicCallsLeft

#if INCLUDE_SPACE_FASTFORWARD
    lda FastForwardActive
    bne ExitIRQ                 // main loop owns SIDPlay during fast-forward
#endif

    lda #$7f
    sta $dc0d                   // music may not interrupt music
    cli                         // ...but urgent raster splits may
    jsr MusicCall_Other

    sei                         // deliver a latched call after RTI, not nested
    lda MusicCallsLeft
    beq !done+
    lda #$82
    sta $dc0d
!done:
    jmp ExitIRQ

#endif // !GFX_DONOR

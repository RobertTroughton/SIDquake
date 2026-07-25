//; =============================================================================
//;                           BAR ANALYSIS MODULE
//;              Common SID Analysis and Bar Animation Functions
//; =============================================================================

#importonce

// Graphics-donor builds (-define GFX_DONOR) carry no code: the full-bank
// bins only donate the VIC assets to the relocating exporter.
.var attackMs = List().add(2, 8, 16, 24, 38, 56, 68, 80, 100, 250, 500, 800, 1000, 3000, 5000, 8000)

#if !GFX_DONOR

//; Required constants that must be defined before including this file:
//; - NUM_FREQUENCY_BARS
//; - TOP_SPECTRUM_HEIGHT  
//; - BAR_INCREASE_RATE
//; - BAR_DECREASE_RATE
//; - MAX_BAR_HEIGHT

//; =============================================================================
//; BAR STATE DATA
//; =============================================================================

//; Unaligned on purpose (see freqtable.asm): indexed absolute addressing works
//; at any alignment; padding cost the WithLogo players real bytes.
barHeightsLo:               .fill NUM_FREQUENCY_BARS, 0
#if !SPECTROMETER_BAKED
barVoiceMap:                .fill NUM_FREQUENCY_BARS, $03   //; only the live analysis maps voices to bars
#endif
smoothedHeights:            .fill NUM_FREQUENCY_BARS, 0
targetBarHeights:           .fill NUM_FREQUENCY_BARS, 0

//; Voice Waveform colour mode (live/shadow analysis only - baked players have
//; no register data): waveform family (pre-shifted <<3) of the voice that
//; last claimed each bar. 0=triangle, 1=saw, 2=pulse, 3=noise. Colour index
//; = family*8 + quantized bar height.
#if !SPECTROMETER_BAKED

//; A memory-tight player can define SPECTROMETER_EXTERNAL_BARWAVE and place
//; the 40-byte array itself (e.g. in spare screen RAM), zeroing it during init.
#if !SPECTROMETER_EXTERNAL_BARWAVE
barWaveMap:                 .fill NUM_FREQUENCY_BARS, 0
#endif

//; Waveform-register upper nibble -> family<<3. Combined waveforms take the
//; dominant timbre: noise > pulse > saw > triangle. Nibble 0 is unreachable
//; (silent voices are filtered out before the lookup). A memory-tight player
//; can define SPECTROMETER_EXTERNAL_WAVETABLE and place the 16 bytes itself
//; (e.g. in its data block's reserved space).
#if !SPECTROMETER_EXTERNAL_WAVETABLE
waveFamilyTable:            .byte $00, $00, $08, $08, $10, $10, $10, $10
                            .byte $18, $18, $18, $18, $18, $18, $18, $18
#endif

#endif // !SPECTROMETER_BAKED

//; Guard bytes: ApplySmoothing reads barHeights-2 .. barHeights+NUM+1.
.byte $00, $00
barHeights:                 .fill NUM_FREQUENCY_BARS, 0
.byte $00, $00


//; =============================================================================
//; VOICE STATE DATA (expanded for up to 4 SIDs = 12 voices)
//; Only the live SID-register analysis tracks per-voice release; baked players
//; drive release from the proportional cap alone, so this is dropped there.
//; =============================================================================

#if !SPECTROMETER_BAKED
voiceReleaseHi:             .fill 12, 0
                            .fill 4, BAR_DECREASE_RATE

voiceReleaseLo:             .fill 12, 0
                            .fill 4, 0
#endif

//; =============================================================================
//; CALCULATION TABLES
//; =============================================================================

//; Unaligned on purpose (see freqtable.asm): the padding costs more than the
//; occasional 1-cycle page-crossing penalty is worth.
neighbourSmoothVals: .fill MAX_BAR_HEIGHT + 1, floor(i * 32.0 / 100.0)
neighbourSmoothVals2: .fill MAX_BAR_HEIGHT + 1, floor(i * 12.0 / 100.0)

//; =============================================================================
//; ADSR ENVELOPE SIMULATION (optional: #define SPECTROMETER_ADSR before import)
//;
//; Instead of jumping straight to the sustain level, each voice's bar follows
//; a simulated SID envelope: attack ramps up at the programmed rate, decay
//; falls to the sustain level, and after gate-off the voice keeps claiming its
//; last bar while the release rings down - so slow string swells visibly
//; swell and plucked notes bloom and ring like they sound. Level is held in
//; bar units (8.8 fixed point), decay/release reuse the release-rate table
//; (the real SID uses the same rate curve for both). ~80 cycles per voice.
//; =============================================================================

#if SPECTROMETER_ADSR

.const ENV_RELEASE = 0
.const ENV_ATTACK  = 1
.const ENV_DECAY   = 2

//; The bars are log-spaced over 8 octaves, so one octave is a fixed offset of
//; NUM_FREQUENCY_BARS/8 bars. Each claimed bar also casts "harmonic ghosts"
//; one octave up at half level and two octaves up at quarter level, faking
//; the harmonic spread an FFT of the real audio shows.
.const HARMONIC_BAR_STEP = NUM_FREQUENCY_BARS / 8

//; Per-voice envelope state lives in low RAM (loader-independent scratch);
//; first frame after load self-corrects via the release path.
.const envLevelLo = $0240   //; 12 bytes
.const envLevelHi = $0250   //; 12 bytes
.const envPhase   = $0260   //; 12 bytes
.const envBar     = $0270   //; 12 bytes: last bar claimed while gated
.const envWave    = $0280   //; 12 bytes: waveform family (<<3) while gated

//; SID attack times (ms) -> level units per PAL frame (8.8, clamped 16-bit).
//; A memory-tight player can define SPECTROMETER_ADSR_EXTERNAL_TABLES and
//; place attackRateLo/Hi itself (e.g. in a spare gap between VIC assets).
//; (attackMs list is defined above the GFX_DONOR guard - the WithLogo
//; players' external ADSR table in the graphics area is computed from it.)
#if !SPECTROMETER_ADSR_EXTERNAL_TABLES
attackRateLo: .fill 16, <min(65535, (MAX_BAR_HEIGHT * 256 * 20) / attackMs.get(i))
attackRateHi: .fill 16, >min(65535, (MAX_BAR_HEIGHT * 256 * 20) / attackMs.get(i))
#endif

#endif

//; =============================================================================
//; SID REGISTER ANALYSIS (supports up to 4 SIDs = 12 voices)
//; Uses zero page pointers for compact single-routine implementation
//; =============================================================================

//; Zero page locations for voice analysis
.const zpRegPtr    = $FB    // 2-byte pointer to current SID's registers
.const zpVoiceIdx  = $FD    // Base voice index for current SID (0, 3, 6, or 9)
.const zpTempByte  = $FE    // Temporary storage

//; The live SID-register analysis (AnalyzeSIDRegisters .. AnalyzeSingleVoice)
//; and the FreqToBar tables it needs are excluded when the bar heights are
//; supplied by a precomputed baked FFT stream instead (see DecodeBakedFrame).
#if !SPECTROMETER_BAKED
AnalyzeSIDRegisters:
    // Save zero page values we're about to use
    lda zpRegPtr
    pha
    lda zpRegPtr + 1
    pha
    lda zpVoiceIdx
    pha
    lda zpTempByte
    pha

    // Analyze SID 1 (always)
    lda #<sidRegisterMirror
    sta zpRegPtr
    lda #>sidRegisterMirror
    sta zpRegPtr + 1
    lda #0
    sta zpVoiceIdx
    jsr AnalyzeSIDChip

    // Analyze SID 2 if present
    lda NumSIDChips
    cmp #2
    bcc !restoreZP+
    lda #<(sidRegisterMirror + 25)
    sta zpRegPtr
    lda #>(sidRegisterMirror + 25)
    sta zpRegPtr + 1
    lda #3
    sta zpVoiceIdx
    jsr AnalyzeSIDChip

    // Analyze SID 3 if present
    lda NumSIDChips
    cmp #3
    bcc !restoreZP+
    lda #<(sidRegisterMirror + 50)
    sta zpRegPtr
    lda #>(sidRegisterMirror + 50)
    sta zpRegPtr + 1
    lda #6
    sta zpVoiceIdx
    jsr AnalyzeSIDChip

    // Analyze SID 4 if present
    lda NumSIDChips
    cmp #4
    bcc !restoreZP+
    lda #<(sidRegisterMirror + 75)
    sta zpRegPtr
    lda #>(sidRegisterMirror + 75)
    sta zpRegPtr + 1
    lda #9
    sta zpVoiceIdx
    jsr AnalyzeSIDChip

!restoreZP:
    // Restore zero page values
    pla
    sta zpTempByte
    pla
    sta zpVoiceIdx
    pla
    sta zpRegPtr + 1
    pla
    sta zpRegPtr
    rts

//; =============================================================================
//; Analyze all 3 voices on one SID chip
//; Input: zpRegPtr points to SID's register mirror (25 bytes)
//;        zpVoiceIdx contains base voice index (0, 3, 6, or 9)
//; =============================================================================

AnalyzeSIDChip:
    // Analyze voice 0
    jsr AnalyzeSingleVoice

    // Move to voice 1
    clc
    lda zpRegPtr
    adc #7
    sta zpRegPtr
    bcc !nc1+
    inc zpRegPtr + 1
!nc1:
    inc zpVoiceIdx
    jsr AnalyzeSingleVoice

    // Move to voice 2
    clc
    lda zpRegPtr
    adc #7
    sta zpRegPtr
    bcc !nc2+
    inc zpRegPtr + 1
!nc2:
    inc zpVoiceIdx
    jmp AnalyzeSingleVoice  // Tail call - no need for JSR/RTS

//; =============================================================================
//; Single Voice Analysis Routine
//; Input: zpRegPtr points to current voice's 7 registers
//;        zpVoiceIdx contains voice index (0-11)
//; =============================================================================

#if SPECTROMETER_ADSR

AnalyzeSingleVoice:
    //; Voice is audibly active only when GATE is set, TEST is clear (TEST
    //; halts the oscillator; hard restart parks voices that way) and a
    //; waveform is selected - wave %0000 outputs silence even though the
    //; envelope keeps running, and rest/hard-restart frames use it.
    ldy #4
    lda (zpRegPtr), y
    and #$09
    cmp #$01
    bne !inactive+
    lda (zpRegPtr), y
    and #$f0
    bne !active+
!inactive:
    jmp EnvRelease

!active:
    //; A = waveform bits (reg 4 & $f0): remember the voice's timbre family
    //; for the Voice Waveform colour mode. Captured while gated so the
    //; release phase keeps the note's colour after reg 4 turns to garbage.
    lsr
    lsr
    lsr
    lsr
    tay
    lda waveFamilyTable, y
    ldx zpVoiceIdx
    sta envWave, x
    lda envPhase, x
    cmp #ENV_RELEASE
    bne !held+
    lda #ENV_ATTACK             //; gate just opened: restart the attack
    sta envPhase, x
    bne !attack+                //; (always: ENV_ATTACK != 0)
!held:
    cmp #ENV_DECAY
    beq !decay+
!attack:

    //; --- attack: level += rate[attack nibble], clamp at MAX -> decay ---
    ldy #5
    lda (zpRegPtr), y
    lsr
    lsr
    lsr
    lsr
    tay
    clc
    lda envLevelLo, x
    adc attackRateLo, y
    sta envLevelLo, x
    lda envLevelHi, x
    adc attackRateHi, y
    bcs !attackFull+
    cmp #MAX_BAR_HEIGHT
    bcc !storeAttack+
!attackFull:
    lda #ENV_DECAY
    sta envPhase, x
    lda #$00
    sta envLevelLo, x
    lda #MAX_BAR_HEIGHT
!storeAttack:
    sta envLevelHi, x
    jmp EnvFreqToBar

!decay:
    //; --- decay: fall toward the sustain level using the shared
    //; decay/release rate curve (never rises - real SID decay only counts
    //; down, even if sustain is raised mid-note) ---
    ldy #6
    lda (zpRegPtr), y
    lsr
    lsr
    lsr
    lsr
    tay
    lda sustainToHeight, y
    cmp envLevelHi, x
    bcs EnvFreqToBar            //; at (or above) sustain: hold
    sta zpTempByte              //; sustain floor (zpTempByte is free here)
    ldy #5
    lda (zpRegPtr), y
    and #$0f
    tay
    sec
    lda envLevelLo, x
    sbc releaseRateLo, y
    sta envLevelLo, x
    lda envLevelHi, x
    sbc releaseRateHi, y
    bcc !hitSustain+
    cmp zpTempByte
    bcs !storeDecay+
!hitSustain:
    lda #$00
    sta envLevelLo, x
    lda zpTempByte
!storeDecay:
    sta envLevelHi, x
    //; fall through: gate is on, map the live frequency to a bar

//; Same 3-range frequency lookup as the classic path; remembers the bar so
//; the release phase can keep claiming it after the gate closes.
EnvFreqToBar:
    ldy #1
    lda (zpRegPtr), y
    cmp #$ff
    bcc !freqOk+
    //; Freq $FFxx is hard-restart parking ($FFFE/$FFFF written a frame or
    //; two before the gate closes), not a playable note: keep claiming the
    //; last real bar instead of flashing the right edge of the spectrum
    //; and ringing the whole release out there.
    ldx zpVoiceIdx
    lda envBar, x
    tax
    jmp EnvClaimBar
!freqOk:
    sta zpTempByte
    tay
    cpy #$40
    bcs !useHighTable+
    cpy #$10
    bcs !useMidTable+
    tya
    asl
    asl
    asl
    asl
    sta !tempOra+ + 1
    ldy #0
    lda (zpRegPtr), y
    lsr
    lsr
    lsr
    lsr
!tempOra:
    ora #$00
    tax
    lda FreqToBarLo, x
    tax
    jmp !gotBar+
!useMidTable:
    lda zpTempByte
    sec
    sbc #$10
    asl
    asl
    sta !tempOra2+ + 1
    ldy #0
    lda (zpRegPtr), y
    lsr
    lsr
    lsr
    lsr
    lsr
    lsr
!tempOra2:
    ora #$00
    tax
    lda FreqToBarMid, x
    tax
    jmp !gotBar+
!useHighTable:
    ldy zpTempByte
    lda FreqToBarHi, y
    tax
!gotBar:
    txa
    ldy zpVoiceIdx
    sta envBar, y
    jmp EnvClaimBar

//; Gate off (or TEST on): ring the release down and keep claiming the bar
//; the note was last played on (the live frequency registers may hold
//; hard-restart garbage while the voice is parked).
EnvRelease:
    ldx zpVoiceIdx
    lda #ENV_RELEASE
    sta envPhase, x
    lda envLevelHi, x
    ora envLevelLo, x
    bne !ringing+
    rts
!ringing:
    ldy #6
    lda (zpRegPtr), y
    and #$0f
    tay
    sec
    lda envLevelLo, x
    sbc releaseRateLo, y
    sta envLevelLo, x
    lda envLevelHi, x
    sbc releaseRateHi, y
    bcs !storeRel+
    lda #$00
    sta envLevelLo, x
!storeRel:
    sta envLevelHi, x
    lda envBar, x
    tax                         //; X = bar

//; Claim bar X for this voice at its envelope level (claims on a shared bar
//; ADD together, saturating at MAX_BAR_HEIGHT - so simultaneous voices
//; reinforce a bar instead of the loudest silently hiding the rest), plus
//; octave ghosts at half and quarter level. No voiceRelease/barVoiceMap
//; bookkeeping here: ringing voices keep claiming their bar with live
//; falling targets, so UpdateBars' decay path only handles abandoned bars
//; via the proportional cap.
EnvClaimBar:
    ldy zpVoiceIdx
    lda envWave, y
    and #$18                    //; mask: low RAM is garbage on the first frames
    sta waveFamilyCur
    lda envLevelHi, y
    ldy #3                      //; the note's bar + 2 octave ghosts
!claimLoop:
    jsr ClaimBarAtLevel
    lsr                         //; each ghost at half the previous level
    .for (var i = 0; i < HARMONIC_BAR_STEP; i++) {
        inx
    }
    cpx #NUM_FREQUENCY_BARS
    bcs !ghostsDone+
    dey
    bne !claimLoop-
!ghostsDone:
    rts

waveFamilyCur: .byte 0

//; X = bar, A = level. Adds the claim into the per-frame accumulator,
//; saturating at MAX_BAR_HEIGHT (UpdateBars consumes and clears it each
//; frame), and tags the bar with the claiming voice's waveform family.
//; Preserves A and X so callers can chain ghosts.
ClaimBarAtLevel:
    sta zpTempByte
    clc
    adc targetBarHeights, x
    bcs !clamp+
    cmp #MAX_BAR_HEIGHT
    bcc !store+
!clamp:
    lda #MAX_BAR_HEIGHT
!store:
    sta targetBarHeights, x
    lda waveFamilyCur
    sta barWaveMap, x
    lda zpTempByte
    rts

#else

AnalyzeSingleVoice:
    //; Voice is audibly active only when GATE is set, TEST is clear (TEST
    //; halts the oscillator; hard-restart drivers park voices with TEST on
    //; and $FFFE/$FFFF in the frequency registers between notes - analyzing
    //; those lit a phantom top bar on every note that the audio never
    //; contained) and a waveform is selected (wave %0000 outputs silence
    //; even though the envelope keeps running).
    ldy #4
    lda (zpRegPtr), y
    and #$09
    cmp #$01
    beq !gateOn+
    rts
!gateOn:
    lda (zpRegPtr), y
    and #$f0
    bne !analyzeFreq+
    rts

!analyzeFreq:
    // Get frequency high byte (register offset 1)
    ldy #1
    lda (zpRegPtr), y
    cmp #$ff
    bcc !freqOk+
    rts                     //; $FFxx = hard-restart parking, not a note
!freqOk:
    sta zpTempByte          // Save freq high byte
    tay                     // Y = freq high byte for table lookups

    cpy #$40
    bcs !useHighTable+

    cpy #$10
    bcs !useMidTable+

    // Low frequencies (0x0000-0x0FFF)
    // index = (high_byte << 4) | (low_byte >> 4)
    tya
    asl
    asl
    asl
    asl
    sta !tempOra+ + 1       // Self-modify the ORA operand
    ldy #0
    lda (zpRegPtr), y       // Get freq low byte
    lsr
    lsr
    lsr
    lsr
!tempOra:
    ora #$00
    tax
    lda FreqToBarLo, x
    tax
    jmp !gotBar+

!useMidTable:
    // Mid frequencies (0x1000-0x3FFF)
    lda zpTempByte
    sec
    sbc #$10
    asl
    asl
    sta !tempOra2+ + 1
    ldy #0
    lda (zpRegPtr), y
    lsr
    lsr
    lsr
    lsr
    lsr
    lsr
!tempOra2:
    ora #$00
    tax
    lda FreqToBarMid, x
    tax
    jmp !gotBar+

!useHighTable:
    // High frequencies (>= 0x4000)
    ldy zpTempByte
    lda FreqToBarHi, y
    tax

!gotBar:
    // X now contains the bar index
    // Get ADSR register (offset 6) for release rate
    ldy #6
    lda (zpRegPtr), y
    and #$0f
    tay
    lda releaseRateHi, y
    ldy zpVoiceIdx
    sta voiceReleaseHi, y

    ldy #6
    lda (zpRegPtr), y
    and #$0f
    tay
    lda releaseRateLo, y
    ldy zpVoiceIdx
    sta voiceReleaseLo, y

    // Get sustain level (upper nibble of ADSR)
    ldy #6
    lda (zpRegPtr), y
    lsr
    lsr
    lsr
    lsr
    tay
    //; Claims on a shared bar ADD together (saturating at MAX_BAR_HEIGHT):
    //; simultaneous voices reinforce a bar instead of the loudest silently
    //; hiding the rest. UpdateBars consumes and clears the accumulator.
    lda sustainToHeight, y
    clc
    adc targetBarHeights, x
    bcs !clamp+
    cmp #MAX_BAR_HEIGHT
    bcc !store+
!clamp:
    lda #MAX_BAR_HEIGHT
!store:
    sta targetBarHeights, x

    //; Last claimant's release rate drives the bar's fall once abandoned
    lda zpVoiceIdx
    sta barVoiceMap, x

    //; Tag the bar with the voice's waveform family for the Voice Waveform
    //; colour mode (reg 4 is live here - the gate is on)
    ldy #4
    lda (zpRegPtr), y
    lsr
    lsr
    lsr
    lsr
    tay
    lda waveFamilyTable, y
    sta barWaveMap, x

    rts

#endif // SPECTROMETER_ADSR
#endif // !SPECTROMETER_BAKED (live SID-register analysis)

//; =============================================================================
//; BAR ANIMATION UPDATE
//;
//; targetBarHeights is a per-frame accumulator: the analysis pass ADDs every
//; live claim into it (saturating at MAX_BAR_HEIGHT) and UpdateBars consumes
//; and clears it here, so gated/ringing voices must re-claim every frame.
//;
//; Motion-shaped to match the site's HVSC-browser visualizer:
//;  * Rising bars ease out - each frame covers half the remaining gap (+1),
//;    instead of a fixed linear step.
//;  * A claim BELOW the current height eases down by ceil(gap/2) per frame,
//;    but never faster than the decay cap (height/8 + 1). Without the cap a
//;    quiet voice claiming a tall bar chopped the loud note's tail in a
//;    couple of frames, and a fast ADSR release ringing down collapsed a
//;    full bar almost instantly - both read as jarring flicker.
//;  * Abandoned bars (no claim this frame) fall at their voice's release
//;    rate, likewise capped at 1/8th of their height per frame (an
//;    exponential-looking tail).
//; =============================================================================

decayFallLo: .byte 0
decayFallHi: .byte 0

UpdateBars:
    ldx #NUM_FREQUENCY_BARS - 1
!loop:
    lda targetBarHeights, x
    beq !decay+

    cmp barHeights, x
    beq !consumed+
    bcs !rise+

    //; Claim below current height: ease down by ceil(gap/2) per frame,
    //; capped at the decay rate so a weaker claim can't yank a tall bar down.
    lda barHeights, x
    sec
    sbc targetBarHeights, x     //; A = gap (>= 1), carry set
    adc #$00                    //; A = gap + 1
    lsr                         //; ceil(gap/2)
    sta !fallAmt+ + 1
    lda barHeights, x
    lsr
    lsr
    lsr
    clc
    adc #$01                    //; decay cap = height/8 + 1 (always > 0)
    cmp !fallAmt+ + 1
    bcs !useGapStep+            //; cap >= gap step: keep the gap step
    sta !fallAmt+ + 1
!useGapStep:
    lda barHeights, x
    sec
!fallAmt:
    sbc #$00
    sta barHeights, x

!consumed:
    lda #$00
#if !SPECTROMETER_BAKED
    //; Live/shadow: targetBarHeights is a per-frame accumulator the analysis refills
    //; every frame, so consume (clear) it here. BAKED keyframes arrive at 25 Hz (every
    //; 2nd frame): clearing would leave the in-between "tween" frame with no target, so
    //; every bar took the decay path and dropped - a 25 Hz rise/fall sawtooth (the
    //; flicker). Keeping the target latched lets the tween frame keep easing toward the
    //; held keyframe; DecodeBakedFrame overwrites it when the next keyframe arrives.
    sta targetBarHeights, x
#endif
    beq !next+                  //; (always; A=0)

!rise:
    //; A = target (> current height). bar += (target - bar) / 2 + 1.
    sec
    sbc barHeights, x           //; diff >= 1
    lsr                         //; diff/2
    sec                         //; the +1 (carry into ADC)
    adc barHeights, x
    cmp targetBarHeights, x
    bcc !storeRise+
    //; Reached (or passed) the target: snap onto it.
    lda #$00
    sta barHeightsLo, x
    lda targetBarHeights, x
!storeRise:
    sta barHeights, x
    lda #$00
#if !SPECTROMETER_BAKED
    sta targetBarHeights, x     //; live/shadow only - keep baked target latched, see !consumed
#endif
    beq !next+                  //; (always; A=0)

!decay:
    lda barHeights, x
    ora barHeightsLo, x
    beq !next+

    //; Proportional cap: fall = height/8 in 8.8 fixed point (hi>>3, hi<<5),
    //; ORA #$40 guarantees a minimum fall so tails do reach zero.
    lda barHeights, x
    lsr
    lsr
    lsr
    sta decayFallHi
    lda barHeights, x
    asl
    asl
    asl
    asl
    asl
    ora #$40
    sta decayFallLo

#if !SPECTROMETER_ADSR && !SPECTROMETER_BAKED
    //; fall = min(voice release rate, proportional cap). (In ADSR mode the
    //; envelope drives release explicitly, so the cap alone handles the few
    //; genuinely abandoned bars.)
    ldy barVoiceMap, x
    lda voiceReleaseHi, y
    cmp decayFallHi
    bcc !useRelease+
    bne !doFall+
    lda voiceReleaseLo, y
    cmp decayFallLo
    bcs !doFall+
!useRelease:
    lda voiceReleaseLo, y
    sta decayFallLo
    lda voiceReleaseHi, y
    sta decayFallHi

!doFall:
#endif
    sec
    lda barHeightsLo, x
    sbc decayFallLo
    sta barHeightsLo, x
    lda barHeights, x
    sbc decayFallHi
    bcs !storeFall+
    lda #$00
    sta barHeightsLo, x
!storeFall:
    sta barHeights, x

!next:
    dex
    bmi !done+
    jmp !loop-
!done:
    rts

//; =============================================================================
//; SMOOTHING ALGORITHM
//; =============================================================================

ApplySmoothing:

    ldx #NUM_FREQUENCY_BARS - 1
!loop:
    clc
    lda barHeights + 0, x
    ldy barHeights - 1, x
    adc neighbourSmoothVals, y
    ldy barHeights + 1, x
    adc neighbourSmoothVals, y
    ldy barHeights - 2, x
    adc neighbourSmoothVals2, y
    ldy barHeights + 2, x
    adc neighbourSmoothVals2, y
    cmp #MAX_BAR_HEIGHT
    bcc !skip+
    lda #MAX_BAR_HEIGHT
!skip:
    sta smoothedHeights, x
    dex
    bpl !loop-
    rts

//; =============================================================================
//; INITIALIZATION HELPER
//; =============================================================================

InitializeBarArrays:
    ldy #$00
    lda #$00
!loop:
    sta barHeights - 2, y
    sta smoothedHeights - 2, y
    iny
    cpy #NUM_FREQUENCY_BARS + 4
    bne !loop-
    rts

#if SPECTROMETER_BAKED
//; =============================================================================
//; BAKED FFT SPECTROMETER PLAYBACK  (split / product vector quantization)
//;
//; Instead of deriving bars from SID registers, replay a precomputed FFT
//; bar-height stream baked into the PRG by the web app. The 40 bars are split into
//; bakedNumSegments segments of bakedSegWidth bars each; every segment carries its
//; OWN 256-entry codebook and its OWN per-keyframe index, so segments animate
//; independently - a slowly-drifting part of the spectrum keeps updating even while
//; another part holds, which stops the whole column freezing on one shared
//; prototype. Total codebook bytes are the same as a single 40-wide book
//; (256 * 40).
//;
//; The exporter chooses the segment count PER TUNE: 5 (x8 bars, best detail) when
//; the index fits RAM - which is almost always, since a looped tune stores just one
//; cycle - dropping to 4/2/1 for a long non-looping tune so it animates the whole
//; way through instead of stopping at a memory cap. So the decoder reads the count
//; and width from the data block rather than baking them in.
//;
//;   bakedCodebookPtr   ($50/$51)  page-aligned base of the codebook. It is stored
//;                                 TRANSPOSED - one 256-byte page per bar - so bar b's
//;                                 value for entry `index` is at base + b*256 + index,
//;                                 read as `lda base_b,X` (X=index): no multiply, and a
//;                                 consistent 4-cycle access thanks to the page align.
//;   bakedIndexStart    ($52/$53)  index streams, PLANAR: segment s owns the whole
//;                                 run of bakedNumKeyframes bytes starting at
//;                                 bakedIndexStart + s*bakedNumKeyframes, so its
//;                                 index for keyframe k is at +k within that run.
//;                                 (Planar rather than one interleaved record per
//;                                 keyframe: each segment's indices then sit next
//;                                 to each other, which is what the PRG cruncher
//;                                 can find matches in - worth ~9% of the index
//;                                 stream. The decoder keeps one pointer per
//;                                 segment instead of one striding pointer.)
//;   bakedNumKeyframes  ($54/$55)  number of 25 Hz keyframes
//;   bakedLoopStart     ($56/$57)  keyframe to wrap to at end of stream
//;   bakedNumSegments   ($58)      segment count (1,2,4,5)
//;   bakedSegWidth      ($59)      bars per segment (= 40 / bakedNumSegments)
//;
//; The bars of a segment all share that segment's index; the page just steps by one
//; per bar. UpdateBars' attack/decay does the 25->50 Hz interpolation and release.
//; No zero page used (self-modifying operands), so it is safe alongside the music.
//; =============================================================================

.var BAKED_MAX_SEGMENTS = 5              //; buffer size only; actual count is runtime

bakedKfCountLo:   .byte $00
bakedKfCountHi:   .byte $00
bakedLoopBaseLo:  .byte $00              //; bakedIndexStart + loopStart = segment 0's loop point
bakedLoopBaseHi:  .byte $00
bakedSegCtr:      .byte $00              //; current segment (0..segments-1) during decode
bakedBarsLeft:    .byte $00              //; bars remaining in the current segment
bakedFrameCtr:    .byte $00              //; frames until the next keyframe (see TickBakedFrame)
bakedJustLooped:  .byte $00              //; set to 1 when the stream wraps; player consumes it
segIdx:           .fill BAKED_MAX_SEGMENTS, $00
//; One read pointer per segment, each walking its own planar stream one byte per
//; keyframe. Rebuilt by SetIndexPointers at init and on every wrap.
bakedIdxPtrLo:    .fill BAKED_MAX_SEGMENTS, $00
bakedIdxPtrHi:    .fill BAKED_MAX_SEGMENTS, $00
bakedPtrBaseLo:   .byte $00              //; SetIndexPointers argument (segment 0's address)
bakedPtrBaseHi:   .byte $00

//; Call once per frame. Decodes the next keyframe every bakedFrameDivisor frames
//; (1/2/3 = 50/25/16.66 Hz) and holds between; UpdateBars interpolates the rest.
TickBakedFrame:
    lda bakedFrameCtr
    bne !hold+
    jsr DecodeBakedFrame
    lda bakedFrameDivisor
    sta bakedFrameCtr
!hold:
    dec bakedFrameCtr
    rts

//; Point every segment at keyframe 0 of its own stream, given segment 0's address
//; in bakedPtrBase: segment s starts one whole stream (bakedNumKeyframes bytes)
//; after segment s-1. Consumes bakedPtrBase (the caller reloads it each time).
SetIndexPointers:
    ldx #$00
!loop:
    lda bakedPtrBaseLo
    sta bakedIdxPtrLo, x
    lda bakedPtrBaseHi
    sta bakedIdxPtrHi, x
    clc
    lda bakedPtrBaseLo
    adc bakedNumKeyframes
    sta bakedPtrBaseLo
    lda bakedPtrBaseHi
    adc bakedNumKeyframes + 1
    sta bakedPtrBaseHi
    inx
    cpx bakedNumSegments
    bne !loop-
    rts

InitBaked:
    lda #$00
    sta bakedKfCountLo
    sta bakedKfCountHi
    sta bakedFrameCtr                    //; 0 -> decode on the very first frame

    //; Segment 0's loop point. Every other segment's is one stream length further
    //; on, which is exactly what SetIndexPointers walks - so the wrap costs one
    //; 16-bit add here and nothing per keyframe.
    clc
    lda bakedIndexStart
    adc bakedLoopStart
    sta bakedLoopBaseLo
    lda bakedIndexStart + 1
    adc bakedLoopStart + 1
    sta bakedLoopBaseHi

    lda bakedIndexStart
    sta bakedPtrBaseLo
    lda bakedIndexStart + 1
    sta bakedPtrBaseHi
    jmp SetIndexPointers                 //; tail call: its rts returns to our caller

DecodeBakedFrame:
    //; read this keyframe's index byte from each segment's own planar stream,
    //; then step that segment's pointer on by one keyframe
    ldx bakedNumSegments
    dex
!read:
    lda bakedIdxPtrLo, x
    sta !fetch+ + 1
    lda bakedIdxPtrHi, x
    sta !fetch+ + 2
!fetch:
    lda $ffff                       //; operand = &stream[segment x][keyframe]
    sta segIdx, x
    inc bakedIdxPtrLo, x
    bne !noCarry+
    inc bakedIdxPtrHi, x
!noCarry:
    dex
    bpl !read-

    //; codebook read pointer starts at the (page-aligned) codebook base; the high
    //; byte steps one page per bar, the low byte stays 0 so `lda base,X` is 4 cycles.
    lda bakedCodebookPtr
    sta bakedRead + 1
    lda bakedCodebookPtr + 1
    sta bakedRead + 2

    ldy #$00                        //; Y = global bar 0..numBars-1 (target offset)
    lda #$00
    sta bakedSegCtr
!segLoop:
    ldx bakedSegCtr
    lda segIdx, x
    tax                             //; X = this segment's codebook index (shared by its bars)
    lda bakedSegWidth
    sta bakedBarsLeft
!barLoop:
bakedRead:
    lda $ffff, x                    //; codebook[bar page + index]  (operand hi = current bar page)
    sta targetBarHeights, y
    inc bakedRead + 2               //; next bar -> next 256-byte page
    iny
    dec bakedBarsLeft
    bne !barLoop-
    inc bakedSegCtr
    lda bakedSegCtr
    cmp bakedNumSegments
    bne !segLoop-

    //; (the per-segment read pointers were stepped as they were read, above)

    //; advance keyframe counter; wrap back to the loop point at end of stream
    inc bakedKfCountLo
    bne !checkWrap+
    inc bakedKfCountHi
!checkWrap:
    lda bakedKfCountLo
    cmp bakedNumKeyframes
    bne !done+
    lda bakedKfCountHi
    cmp bakedNumKeyframes + 1
    bne !done+
    //; End of stream: loop back to the loop point (not the very start) so the
    //; visualization stays in sync with the tune's own audio loop.
    lda bakedLoopStart
    sta bakedKfCountLo
    lda bakedLoopStart + 1
    sta bakedKfCountHi
    lda #$01                        //; flag the wrap so the player can re-sync its timer
    sta bakedJustLooped
    lda bakedLoopBaseLo             //; re-point every segment at its loop keyframe
    sta bakedPtrBaseLo
    lda bakedLoopBaseHi
    sta bakedPtrBaseHi
    jmp SetIndexPointers            //; tail call: its rts returns to our caller
!done:
    rts
#endif // SPECTROMETER_BAKED


#endif // !GFX_DONOR

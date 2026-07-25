// =============================================================================
//                            RAISTLIN MIRROR BARS
//                   Advanced SID Music Spectrum Visualizer
// =============================================================================

//; Memory Map

//; On Load
//; VICBANK + $3800-$3FFF : CharSet

//; Real-time
//; VICBANK + $3000-$33FF : Screen 0
//; VICBANK + $3400-$37FF : Screen 1
//; VICBANK + $3800-$3FFF : CharSet

.var LOAD_ADDRESS                   = cmdLineVars.get("loadAddress").asNumber()
.var CODE_ADDRESS                   = cmdLineVars.get("sysAddress").asNumber()
.var DATA_ADDRESS                   = cmdLineVars.get("dataAddress").asNumber()

//; =============================================================================
//; CONFIGURATION CONSTANTS (needed before data block)
//; =============================================================================

.const NUM_FREQUENCY_BARS				= 40
.const TOP_SPECTRUM_HEIGHT				= 9
.const TOTAL_SPECTRUM_HEIGHT			= TOP_SPECTRUM_HEIGHT * 2

//; =============================================================================
//; DATA BLOCK
//; =============================================================================

* = DATA_ADDRESS "Data Block"
    .fill $0D, $00                      // Reserved bytes 0-12
borderColor:
    .byte $00                           // Byte 13 ($0D): Border color
backgroundColor:
    .byte $00                           // Byte 14 ($0E): Background color
    .fill $4C - $0F, $00                // Reserved bytes 15..$4B
bakedLoopEndMin:
    .byte $00                           // $4C: loop-end (= shown length) MM - live timer wraps here
bakedLoopEndSec:
    .byte $00                           // $4D: loop-end SS
bakedLoopEndFrameRem:
    .byte $00                           // $4E: loop-end intra-second frame
bakedLoopFrameRem:
    .byte $00                           // Byte 79 ($4F): loop-point intra-second frame (0..fps-1)
    //; Baked FFT spectrometer config (patched at export; zero = disabled/live):
bakedCodebookPtr:
    .word $0000                         // $50/$51: VQ codebook base address
bakedIndexStart:
    .word $0000                         // $52/$53: index-stream base address
bakedNumKeyframes:
    .word $0000                         // $54/$55: number of 25 Hz keyframes
bakedLoopStart:
    .word $0000                         // $56/$57: keyframe to loop back to at end
bakedNumSegments:
    .byte $00                           // $58: split-VQ segment count (1,2,4,5)
bakedSegWidth:
    .byte $00                           // $59: bars per segment (40 / segments)
bakedFrameDivisor:
    .byte $00                           // $5A: frames per keyframe (1/2/3=50/25/16.66Hz); patched at export
bakedLoopMin:
    .byte $00                           // $5B: loop-point time MM - timer resets here on wrap
bakedLoopSec:
    .byte $00                           // $5C: loop-point time SS
bakedLenMin:
    .byte $00                           // $5D: song length MM (only meaningful when known)
bakedLenSec:
    .byte $00                           // $5E: song length SS
bakedHasLength:
    .byte $00                           // $5F: 1 when a detected loop gives a real length
colorEffectMode:
    .byte $00                           // Byte 96 ($60): Color effect mode (0=Height, 1=LineGradient, 2=RainbowColumns, 3=Waveform)
lineGradientColors:
    .fill TOTAL_SPECTRUM_HEIGHT, $0b    // Bytes 97-114 ($61-$72): Line gradient colors for mirrored display
songNameColor:
    .byte $01                           // Byte 115 ($73): Song name text color (default: white)
artistNameColor:
    .byte $0f                           // Byte 116 ($74): Artist name text color (default: light grey)
    .fill DATA_ADDRESS + $80 - *, $00   // Pad to data-block offset $80
barGradientColors:                      // $80-$A7: per-bar colours (colorEffectMode 2, injected at export)
    .fill NUM_FREQUENCY_BARS, $00
    .fill DATA_ADDRESS + $100 - *, $00  // Fill rest of reserved space

* = CODE_ADDRESS "Main Code"

#if !GFX_DONOR
    jmp Initialize
#endif

//; Graphics VIC bank, decoupled from the code load address so a CODE_ONLY build
//; can assemble the code apart from the graphics (exporter places them
//; independently). Classic build derives it from the load address - output
//; unchanged; CODE_ONLY takes an optional :gfxBank= for the reloc tooling.
#if CODE_ONLY
.var GFX_BANK = cmdLineVars.containsKey("gfxBank") ? cmdLineVars.get("gfxBank").asNumber() : 1
#else
.var GFX_BANK = floor(LOAD_ADDRESS / $4000)
#endif
.var VIC_BANK						= GFX_BANK
.var VIC_BANK_ADDRESS               = VIC_BANK * $4000

//; =============================================================================
//; EXTERNAL RESOURCES
//; =============================================================================

.var file_charsetData = LoadBinary("CharSet.map")

//; =============================================================================
//; CONFIGURATION CONSTANTS (continued)
//; =============================================================================

.const BAR_INCREASE_RATE				= (TOP_SPECTRUM_HEIGHT * 0.6)
.const BAR_DECREASE_RATE				= (TOP_SPECTRUM_HEIGHT * 0.2)

.const SONG_TITLE_LINE					= 0
.const ARTIST_NAME_LINE					= 23
.const SPECTRUM_START_LINE				= 3

.eval setSeed(55378008)

.const SCREEN0_BANK						= 12
.const SCREEN1_BANK						= 13
.const CHARSET_BANK						= 7

.const SCREEN0_ADDRESS					= VIC_BANK_ADDRESS + (SCREEN0_BANK * $400)
.const SCREEN1_ADDRESS					= VIC_BANK_ADDRESS + (SCREEN1_BANK * $400)
.const CHARSET_ADDRESS					= VIC_BANK_ADDRESS + (CHARSET_BANK * $800)
.const COLOR_TABLE_ADDRESS				= VIC_BANK_ADDRESS + $2E00 //; $6E00-6E7F

.const D018_VALUE_0						= (SCREEN0_BANK * 16) + (CHARSET_BANK * 2)
.const D018_VALUE_1						= (SCREEN1_BANK * 16) + (CHARSET_BANK * 2)

.const MAX_BAR_HEIGHT					= TOP_SPECTRUM_HEIGHT * 8 - 1
.const MAIN_BAR_OFFSET					= MAX_BAR_HEIGHT - 7

//; Color table size - matches MAX_BAR_HEIGHT + padding for safety
.const COLOR_TABLE_SIZE					= MAX_BAR_HEIGHT + 9

//; Voice Waveform colour mode: bar height quantized to 8 brightness levels
//; (MAX_BAR_HEIGHT=71 >> 4 = 0..4) within each waveform family's ramp
.const WAVE_LEVEL_SHIFT					= 4

//; Elapsed-time timer: below the mirrored spectrum, above the artist line (line 21).
//; 1x2 font. When a song length is known we show "MM:SS/MM:SS" centred (timer col 14,
//; '/' 19, length 20); without one the timer sits centred alone at col 17. The movable
//; timer + "/length" is CODE_ONLY (the shipped export path); the classic full build
//; keeps the old centred timer, so it stays byte-for-byte unchanged.
.const TIMER_SCREEN0 = SCREEN0_ADDRESS
.const TIMER_SCREEN1 = SCREEN1_ADDRESS
.const TIMER_DOUBLE_HEIGHT = 1
#if CODE_ONLY
#define TIMER_MOVABLE
.const TIMER_POS = (21 * 40) + 14       //; with a length: left of "/MM:SS"
.const TIMER_POS_ALONE = (21 * 40) + 17 //; no length: centred alone
.const SLASH_POS = (21 * 40) + 19
.const LENGTH_POS = (21 * 40) + 20
.const TIMER_COLOR = $0c                //; timer digits: grey (12)
.const LENGTH_COLOR = $0b               //; length + '/': dark grey (11)
#else
.const TIMER_POS = (21 * 40) + 17       //; centred
.const TIMER_COLOR = $0b
#endif

//; =============================================================================
//; INCLUDES
//; =============================================================================

#define INCLUDE_SPACE_FASTFORWARD
//; Song-change keys desync the baked FFT stream (it's baked for one subtune), so
//; the baked build locks to the exported song. Live (realtime/shadow) modes keep
//; full song switching.
#if !SPECTROMETER_BAKED
#define INCLUDE_PLUS_MINUS_SONGCHANGE
#define INCLUDE_09ALPHA_SONGCHANGE
#endif
#define INCLUDE_F1_SHOWRASTERTIMINGBAR
#define INCLUDE_MUSIC_ANALYSIS
//; Bars follow a simulated SID envelope (attack/decay/sustain/release)
//; instead of snapping to the sustain level - see INC/spectrometer.asm.
//; In baked mode the bar heights come from a precomputed FFT stream, so the
//; ADSR simulation and the freqtable it uses are dropped (they also free the
//; room the baked decode tables need in this otherwise-full bank).
#if !SPECTROMETER_BAKED
#define SPECTROMETER_ADSR
#endif

//; Raster line for music call 0; the remaining calls are CIA-timer driven
//; (see INC/multicallirq.asm).
.const MUSIC_SYNC_LINE = 232

.import source "../INC/common.asm"
.import source "../INC/keyboard.asm"
.import source "../INC/musicplayback.asm"
.import source "../INC/multicallirq.asm"
.import source "../INC/stablerastersetup.asm"
.import source "../INC/spectrometer.asm"
#if !SPECTROMETER_BAKED
.import source "../INC/freqtable.asm"
#endif
.import source "../INC/barstyles.asm"
.import source "../INC/linkedwitheffect.asm"
//; Live players wrap the clock at the loop point (baked players reset on the
//; stream wrap instead) - see INC/timer.asm.
#if CODE_ONLY
#if !SPECTROMETER_BAKED
#define TIMER_LOOP_WRAP
#endif
#endif
.import source "../INC/timer.asm"

//; Graphics-donor build (-define GFX_DONOR): all runtime code is compiled
//; out - the full-bank bin only donates the data block + VIC assets to the
//; relocating exporter, so code size is never capped by the bank layout.
#if !GFX_DONOR


#if CODE_ONLY
//; Static "/MM:SS" song length drawn once at init, just right of the timer: a "/"
//; separator then the length. Only when a detected loop gave a real length
//; (bakedHasLength); otherwise the timer sits centred alone and nothing is drawn
//; here. Same 1x2 digit glyphs as the timer; '/' is screen code 47 (the font maps
//; ASCII 32..63 straight through, so it carries that glyph).
lengthChars: .fill 5, $00
DrawSongLength:
    lda bakedHasLength
    bne !show+
    rts
!show:
    //; '/' separator at SLASH_POS (dark grey, both rows of the 1x2 font)
    lda #47
    sta TIMER_SCREEN0 + SLASH_POS
    sta TIMER_SCREEN1 + SLASH_POS
    ora #TIMER_BOTTOM_OFFSET
    sta TIMER_SCREEN0 + SLASH_POS + 40
    sta TIMER_SCREEN1 + SLASH_POS + 40
    lda #LENGTH_COLOR
    sta $d800 + SLASH_POS
    sta $d800 + SLASH_POS + 40
    lda bakedLenMin
    jsr TimerDiv10
    pha
    txa
    clc
    adc #48
    sta lengthChars + 0
    pla
    clc
    adc #48
    sta lengthChars + 1
    lda #58                             //; ':'
    sta lengthChars + 2
    lda bakedLenSec
    jsr TimerDiv10
    pha
    txa
    clc
    adc #48
    sta lengthChars + 3
    pla
    clc
    adc #48
    sta lengthChars + 4
    ldx #4
!write:
    lda lengthChars, x
    sta TIMER_SCREEN0 + LENGTH_POS, x
    sta TIMER_SCREEN1 + LENGTH_POS, x
    ora #TIMER_BOTTOM_OFFSET
    sta TIMER_SCREEN0 + LENGTH_POS + 40, x
    sta TIMER_SCREEN1 + LENGTH_POS + 40, x
    lda #LENGTH_COLOR
    sta $d800 + LENGTH_POS, x
    sta $d800 + LENGTH_POS + 40, x
    dex
    bpl !write-
    rts
#endif

//; =============================================================================
//; DATA
//; =============================================================================

//; Unaligned on purpose (indexed absolute addressing needs no alignment)
previousHeightsScreen0:     .fill NUM_FREQUENCY_BARS, 255

previousHeightsScreen1:     .fill NUM_FREQUENCY_BARS, 255

previousColors:             .fill NUM_FREQUENCY_BARS, 255

//; =============================================================================
//; INITIALIZATION
//; =============================================================================

Initialize:
	sei

	lda #$35
	sta $01

    jsr RunLinkedWithEffect

    jsr InitKeyboard

	jsr SetupStableRaster

	lda #(63 - VIC_BANK)
	sta $dd00
	lda #VIC_BANK
	sta $dd02

	jsr NMIFix

	jsr InitializeVIC
	//; Bar style character data is injected at build time by the web app
	jsr ClearScreens
	jsr InitializeColors
	jsr DisplaySongInfo
#if TIMER_MOVABLE
	//; Timer centred alone, or shifted left to make room for "/MM:SS" when a length
	//; is known. bakedHasLength is $00 in non-baked builds -> centred alone.
	ldx #$01
	lda bakedHasLength
	beq !setAlone+
	ldx #$00
!setAlone:
	stx timerAlone
#endif
	jsr InitTimer
#if CODE_ONLY
	jsr DrawSongLength
#endif

	ldy #$00
	lda #$00
!loop:
	sta barHeights - 2, y
	sta smoothedHeights - 2, y
	iny
	cpy #NUM_FREQUENCY_BARS + 4
	bne !loop-

#if SPECTROMETER_BAKED
	jsr InitBaked
#endif

	jsr SetupMusic

	jsr InitMultiCallIRQ
	StartRasterEvents(MUSIC_SYNC_LINE, MusicFrameHandler)

	jsr VSync

	lda #$1b
	sta $d011

	cli

MainLoop:
    jsr CheckKeyboard

	lda FastForwardActive
	beq !noFF+

	//; Fast-forward mode: call SIDPlay multiple times from main loop.
	//; The IRQ framework skips its own play calls while this is active.
!ffFrameLoop:
	lda NumCallsPerFrame
	sta FFCallCounter

!ffCallLoop:
	jsr SIDPlay
	inc $d020
	dec FFCallCounter
	bne !ffCallLoop-

	//; Each pass above is one music frame's worth of play calls, so advance
	//; everything that tracks music frames at the same accelerated rate: the
	//; baked stream position (so bars + loop wrap stay in sync with the audio)
	//; and the on-screen clock. The IRQ's FrameCall is skipped during
	//; fast-forward, so this is the only place they'd advance.
#if SPECTROMETER_BAKED
	jsr TickBakedFrame
	lda bakedJustLooped
	beq !noWrap+
	lda #$00
	sta bakedJustLooped
	jsr ResetTimerToLoop
!noWrap:
#endif
#if !SPECTROMETER_BAKED
	jsr CheckMusicLoop          //; forced song loop tracks fast-forwarded frames too
#endif
	jsr UpdateTimer

	jsr CheckSpaceKey
	lda FastForwardActive
	bne !ffFrameLoop-

	lda #$00
	sta $d020
!noFF:

	lda visualizationUpdateFlag
	beq MainLoop

	lda #$00
	sta visualizationUpdateFlag

	jsr ApplySmoothing

	jsr RenderBars

	lda currentScreenBuffer
	eor #$01
	sta currentScreenBuffer

	jmp MainLoop

//; =============================================================================
//; VIC INITIALIZATION
//; =============================================================================

.const SKIP_REGISTER = $e1

InitializeVIC:
	ldx #VICConfigEnd - VICConfigStart - 1
!loop:
	lda VICConfigStart, x
	cmp #SKIP_REGISTER
	beq !skip+
	sta $d000, x
!skip:
	dex
	bpl !loop-

	//; Load border and background colors from data block
	lda borderColor
	sta $d020
	lda backgroundColor
	sta $d021

	rts

//; =============================================================================
//; INTERRUPT HANDLERS (see INC/multicallirq.asm for the shared scheduler)
//; =============================================================================

//; Music call 0, raster-driven once per frame: swap the double-buffered
//; screen (urgent VIC write), then hand over to the shared scheduler.
MusicFrameHandler:
	ldy currentScreenBuffer
	lda D018Values, y
	sta $d018

	SetNextRasterEvent(MUSIC_SYNC_LINE, MusicFrameHandler)
	jmp MusicFrameCall

//; The analysis play must stay inside the CIA-masked music section: it runs a
//; throwaway SIDPlay under Backup/RestoreSIDMemory, and a nested real call in
//; that window would have its state changes wiped by the restore.
MusicCall_Frame:
#if SPECTROMETER_BAKED
	//; Baked builds don't analyse the SID live: the frame music call is a plain
	//; play (audio only). Bar targets come from DecodeBakedFrame in FrameCall.
	jmp JustPlayMusic
#elif SPECTROMETER_SHADOW
	//; Shadow method: play once (stores land in the mirror), replay them to the
	//; SID in the baked order, then analyse the mirror (see musicplayback.asm).
	jmp PlayMusicShadow
#else
	jmp PlayMusicWithAnalysis
#endif

MusicCall_Other:
	jmp JustPlayMusic

FrameCall:
	//; Dynamic ("pulsing") colours first: colour RAM is shared between the
	//; two screen buffers, so it can't be double-buffered away. Starting the
	//; $d800 writes here - right after the frame music call, with the beam
	//; still in the bottom border - races the beam so the sweep finishes long
	//; before the raster re-enters the spectrum area. Music timing is safe:
	//; mid-frame music calls nest into this work instead of waiting for it.
	jsr UpdateBarColors

	inc visualizationUpdateFlag

	inc frameCounter
	bne !skip+
	inc frame256Counter
!skip:

#if SPECTROMETER_BAKED
	//; Bars are precomputed. Refresh the baked targets at 25 Hz (every 2nd
	//; frame); UpdateBars interpolates/decays the held targets over the odd
	//; frame so motion stays smooth at the 50 Hz visual rate.
	jsr TickBakedFrame
#endif

	jsr UpdateBars
#if SPECTROMETER_BAKED
	//; On a stream wrap, re-sync the clock to the loop-point time (not 0:00).
	lda bakedJustLooped
	beq !noReset+
	lda #$00
	sta bakedJustLooped
	jsr ResetTimerToLoop
!noReset:
#endif
	jmp UpdateTimer

UpdateBarColors:
	//; Only colorEffectMode 0 (Height) updates colour RAM dynamically
#if SPECTROMETER_BAKED
	//; Baked builds have no per-voice waveform data; only mode 0 is dynamic
	lda colorEffectMode
	beq !dynamic+
	rts
#else
	//; Modes 0 (Height) and 3 (Voice Waveform) drive colour RAM dynamically
	lda colorEffectMode
	beq !dynamic+
	cmp #3
	beq !dynamic+
	rts
#endif
!dynamic:

	ldy #NUM_FREQUENCY_BARS - 1
!colorLoop:
	ldx smoothedHeights, y
#if !SPECTROMETER_BAKED
	lda colorEffectMode
	beq !lookup+
	//; Waveform mode: colour = table[family*8 + quantized height]
	txa
	.for (var i = 0; i < WAVE_LEVEL_SHIFT; i++) {
		lsr
	}
	ora barWaveMap, y
	tax
!lookup:
#endif
	lda heightColorTable, x
	cmp previousColors, y
	beq !skip+

	sta previousColors, y
	.for (var line = 0; line < TOTAL_SPECTRUM_HEIGHT; line++) {
		sta $d800 + ((SPECTRUM_START_LINE + line) * 40) + ((40 - NUM_FREQUENCY_BARS) / 2), y
	}
!skip:

	dey
	bpl !colorLoop-
	rts


//; =============================================================================
//; RENDERING
//; =============================================================================

RenderBars:
	//; Colour RAM updates live in UpdateBarColors (called from FrameCall so
	//; they race the beam from the bottom border); here we only draw chars
	//; into the off-screen buffer.
	lda currentScreenBuffer
	beq !renderScreen1+

	jmp RenderToScreen0

!renderScreen1:
	jmp RenderToScreen1

RenderToScreen0:
	ldy #NUM_FREQUENCY_BARS
!loop:
	dey
	bpl !continue+
	rts
!continue:

	lda smoothedHeights, y
	cmp previousHeightsScreen0, y
	beq !loop-
	sta previousHeightsScreen0, y
	tax

	clc

	.for (var line = 0; line < TOP_SPECTRUM_HEIGHT; line++) {
		lda barCharacterMap - MAIN_BAR_OFFSET + (line * 8), x
		sta SCREEN0_ADDRESS + ((SPECTRUM_START_LINE + line) * 40) + ((40 - NUM_FREQUENCY_BARS) / 2), y
		adc #10
		sta SCREEN0_ADDRESS + ((SPECTRUM_START_LINE + (TOTAL_SPECTRUM_HEIGHT - 1) - line) * 40) + ((40 - NUM_FREQUENCY_BARS) / 2), y
	}
	jmp !loop-

RenderToScreen1:
	ldy #NUM_FREQUENCY_BARS
!loop:
	dey
	bpl !continue+
	rts
!continue:

	lda smoothedHeights, y
	cmp previousHeightsScreen1, y
	beq !loop-
	sta previousHeightsScreen1, y
	tax

	clc

	.for (var line = 0; line < TOP_SPECTRUM_HEIGHT; line++) {
		lda barCharacterMap - MAIN_BAR_OFFSET + (line * 8), x
		sta SCREEN1_ADDRESS + ((SPECTRUM_START_LINE + line) * 40) + ((40 - NUM_FREQUENCY_BARS) / 2), y
		adc #10
		sta SCREEN1_ADDRESS + ((SPECTRUM_START_LINE + (TOTAL_SPECTRUM_HEIGHT - 1) - line) * 40) + ((40 - NUM_FREQUENCY_BARS) / 2), y
	}
	jmp !loop-

//; =============================================================================
//; UTILITY FUNCTIONS
//; =============================================================================

ClearScreens:
	ldy #$00
	lda #$20
!loop:
	.for (var i = 0; i < 4; i++)
	{
		sta SCREEN0_ADDRESS + (i * 256), y
		sta SCREEN1_ADDRESS + (i * 256), y
		sta $d800 + (i * 256), y
	}
	iny
	bne !loop-
	rts

DisplaySongInfo:
	ldy #31

!loop:

	lda SongName, y
	sta SCREEN0_ADDRESS + (SONG_TITLE_LINE * 40) + 4, y
	sta SCREEN1_ADDRESS + (SONG_TITLE_LINE * 40) + 4, y
	ora #$80
	sta SCREEN0_ADDRESS + ((SONG_TITLE_LINE + 1) * 40) + 4, y
	sta SCREEN1_ADDRESS + ((SONG_TITLE_LINE + 1) * 40) + 4, y
	lda songNameColor
	sta $d800 + ((SONG_TITLE_LINE + 0) * 40) + 4, y
	sta $d800 + ((SONG_TITLE_LINE + 1) * 40) + 4, y

	//; The artist field is 32 bytes ($30-$4F) but its last 4 bytes ($4C-$4F)
	//; are reused by the baked loop-end time. Draw only the first 28 artist
	//; chars so those time bytes aren't rendered as trailing glyphs ("@90H").
	cpy #28
	bcs !skipArtist+
	lda ArtistName, y
	sta SCREEN0_ADDRESS + (ARTIST_NAME_LINE * 40) + 4, y
	sta SCREEN1_ADDRESS + (ARTIST_NAME_LINE * 40) + 4, y
	ora #$80
	sta SCREEN0_ADDRESS + ((ARTIST_NAME_LINE + 1) * 40) + 4, y
	sta SCREEN1_ADDRESS + ((ARTIST_NAME_LINE + 1) * 40) + 4, y
	lda artistNameColor
	sta $d800 + ((ARTIST_NAME_LINE + 0) * 40) + 4, y
	sta $d800 + ((ARTIST_NAME_LINE + 1) * 40) + 4, y
!skipArtist:

	dey
	bpl !loop-

	rts

//; InitializeColors - Set up color RAM for static color effect modes
InitializeColors:
	//; Modes 0 (Height) and 3 (Voice Waveform) = dynamic, nothing to init
	lda colorEffectMode
	beq !done+
	cmp #3
	beq !done+

	cmp #2
	bne !rowModes+
	jmp !columnMode+
!done:
	rts

!rowModes:
	//; Mode 1 (Fixed Gradient) - per-row colours
	ldx #NUM_FREQUENCY_BARS - 1
!barLoop:
	//; Set colors for each line of the spectrum (mirrored display)
	.for (var line = 0; line < TOTAL_SPECTRUM_HEIGHT; line++) {
		lda lineGradientColors + line
		sta $d800 + ((SPECTRUM_START_LINE + line) * 40) + ((40 - NUM_FREQUENCY_BARS) / 2), x
	}
	dex
	bpl !barLoop-
	rts

!columnMode:
	//; Mode 2 (Rainbow Columns): fixed colour per bar column (both mirror halves)
	ldx #NUM_FREQUENCY_BARS - 1
!colLoop:
	lda barGradientColors, x
	.for (var line = 0; line < TOTAL_SPECTRUM_HEIGHT; line++) {
		sta $d800 + ((SPECTRUM_START_LINE + line) * 40) + ((40 - NUM_FREQUENCY_BARS) / 2), x
	}
	dex
	bpl !colLoop-
	rts

SetupMusic:

	ldy #24
	lda #$00
!loop:
	sta $d400, y
	dey
	bpl !loop-

    lda SongNumber
	tax
	tay
	jmp SIDInit

//; =============================================================================
//; DATA SECTION - VIC Configuration
//; =============================================================================

VICConfigStart:
	.byte $00, $00						//; Sprite 0 X,Y
	.byte $00, $00						//; Sprite 1 X,Y
	.byte $00, $00						//; Sprite 2 X,Y
	.byte $00, $00						//; Sprite 3 X,Y
	.byte $00, $00						//; Sprite 4 X,Y
	.byte $00, $00						//; Sprite 5 X,Y
	.byte $00, $00						//; Sprite 6 X,Y
	.byte $00, $00						//; Sprite 7 X,Y
	.byte $00							//; Sprite X MSB
	.byte SKIP_REGISTER					//; D011
	.byte SKIP_REGISTER					//; D012
	.byte SKIP_REGISTER					//; D013
	.byte SKIP_REGISTER					//; D014
	.byte $00							//; Sprite enable
	.byte $08							//; D016
	.byte $00							//; Sprite Y expand
	.byte D018_VALUE_0					//; Memory setup
	.byte SKIP_REGISTER					//; D019
	.byte SKIP_REGISTER					//; D01A
	.byte $00							//; Sprite priority
	.byte $00							//; Sprite multicolor
	.byte $00							//; Sprite X expand
	.byte $00							//; Sprite-sprite collision
	.byte $00							//; Sprite-background collision
	.byte SKIP_REGISTER					//; Border color - loaded from data block
	.byte SKIP_REGISTER					//; Background color - loaded from data block
	.byte $00, $00						//; Extra colors
	.byte $00, $00, $00					//; Sprite extra colors
	.byte $00, $00, $00, $00			//; Sprite colors 0-3
	.byte $00, $00, $00, $00			//; Sprite colors 4-7
VICConfigEnd:

//; =============================================================================
//; DATA SECTION - Animation State
//; =============================================================================

visualizationUpdateFlag:	.byte $00
frameCounter:				.byte $00
frame256Counter:			.byte $00
currentScreenBuffer:		.byte $00

D018Values:					.byte D018_VALUE_0, D018_VALUE_1

//; =============================================================================
//; DATA SECTION - Display Mapping
//; =============================================================================

	.fill MAX_BAR_HEIGHT, 224
barCharacterMap:
	.fill 8, 225 + i
	.fill MAX_BAR_HEIGHT, 233

//; =============================================================================
#endif // !GFX_DONOR (code)

//; GRAPHICS (VIC) ASSETS - charset, bar chars, colour table (heightColorTable),
//; screens. A CODE_ONLY build omits these (the exporter places them in a VIC bank);
//; the code resolves heightColorTable via the address label (a gfx-ref, patched to
//; the chosen bank). Classic builds emit them here, byte-for-byte as before.
//; =============================================================================

.label heightColorTable = COLOR_TABLE_ADDRESS

#if !CODE_ONLY

* = CHARSET_ADDRESS "Font"
	.fill min($700, file_charsetData.getSize()), file_charsetData.get(i)

* = CHARSET_ADDRESS + (224 * 8) "Bar Chars"
//; Filled at build time by the web app based on BarStyle selection
	.fill BAR_STYLE_SIZE_MIRROR, $00

//; Color table (heightColorTable) - filled at build time by the web app.
* = COLOR_TABLE_ADDRESS "Color Table"
	.fill COLOR_TABLE_SIZE, $0b

* = SCREEN0_ADDRESS "Screen 0"
	.fill $400, $00

* = SCREEN1_ADDRESS "Screen 1"
	.fill $400, $00

#endif // !CODE_ONLY

//; =============================================================================
//; END OF FILE
//; =============================================================================
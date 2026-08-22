// =============================================================================
//                           RAISTLIN BARS WITH LOGO
//                   Advanced SID Music Spectrum Visualizer
// =============================================================================

//; Memory Map

//; On Load
//; VICBANK + $2000-$2C7F : Logo Bitmap (10 * $140)
//; VICBANK + $3000-$318F : Logo Screen Data
//; VICBANK + $3400-$358F : Logo Colour Data

//; Real-time
//; VICBANK + $2000-$2C7F : Logo Bitmap (10 * $140)
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
.const LOGO_HEIGHT						= 11
.const TOP_SPECTRUM_HEIGHT				= 8
.const BOTTOM_SPECTRUM_HEIGHT			= 3

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
    .fill TOP_SPECTRUM_HEIGHT + BOTTOM_SPECTRUM_HEIGHT, $0b  // Bytes 97-107 ($61-$6B): Line gradient colors
songNameColor:
    .byte $01                           // Song name text color (default: white)
spectrometerBgColor:
    .byte $00                           // Byte ($6D): Spectrometer background color (user-editable)
    .fill DATA_ADDRESS + $80 - *, $00   // Pad to data-block offset $80
barGradientColors:                      // $80-$A7: per-bar colours (colorEffectMode 2, injected at export)
    .fill NUM_FREQUENCY_BARS, $00
    .fill DATA_ADDRESS + $100 - *, $00  // Fill rest of reserved space

* = CODE_ADDRESS "Main Code"

#if !GFX_DONOR
    jmp Initialize
#endif

//; Graphics VIC bank. Decoupled from the code load address: a CODE_ONLY build
//; assembles the code apart from the graphics (so it escapes the "packed below the
//; bitmap" ceiling that leaves this player with no room for a timer), and the
//; exporter places the two blobs independently. The classic build derives the bank
//; from the load address, so its output is unchanged. CODE_ONLY takes an optional
//; :gfxBank= override so the reloc tooling can shift the graphics bank on its own.
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
.var file_waterSpritesData = LoadBinary("WaterSprites.map")

//; =============================================================================
//; CONFIGURATION CONSTANTS (continued)
//; =============================================================================

.const BAR_INCREASE_RATE				= ceil(TOP_SPECTRUM_HEIGHT * 1.3)
.const BAR_DECREASE_RATE				= ceil(TOP_SPECTRUM_HEIGHT * 0.2)

.const SONG_TITLE_LINE					= 23
.const SPECTRUM_START_LINE				= 12
.const REFLECTION_SPRITES_YVAL			= 50 + (SPECTRUM_START_LINE + TOP_SPECTRUM_HEIGHT) * 8 + 3

.eval setSeed(55378008)

//; Memory configuration
.const DD00Value                        = 3 - VIC_BANK
.const DD02Value                        = 60 + VIC_BANK

.const SCREEN0_BANK						= 12	//; $7000-$73FF
.const SCREEN1_BANK						= 13	//; $7400-$77FF
.const CHARSET_BANK						= 7		//; $7800-$7EFF and $7F00-7FFF
.const BITMAP_BANK						= 1		//; $6000-$6DBF
.const SPRITE_BASE_INDEX				= $B9	//; $6E40-$6FFF (7 sprites); 128-byte gap above is reused for the color table

//; Calculated addresses
.const BITMAP_ADDRESS					= VIC_BANK_ADDRESS + (BITMAP_BANK * $2000)
.const SCREEN0_ADDRESS					= VIC_BANK_ADDRESS + (SCREEN0_BANK * $400)
.const SCREEN1_ADDRESS					= VIC_BANK_ADDRESS + (SCREEN1_BANK * $400)
.const BITMAP_COL_DATA					= SCREEN1_ADDRESS //; on load, we have the COL data in the SCR1 data
.const CHARSET_ADDRESS					= VIC_BANK_ADDRESS + (CHARSET_BANK * $800)

.const SPRITES_ADDRESS					= VIC_BANK_ADDRESS + (SPRITE_BASE_INDEX * $40)
.const SPRITE_POINTERS_0				= SCREEN0_ADDRESS + $3F8
.const SPRITE_POINTERS_1				= SCREEN1_ADDRESS + $3F8

//; Logo-region $d011/$d016 lookup tables, indexed by the logo mode byte
//; (data block $70): 0=MC bitmap, 1=hires bitmap, 2=hires text,
//; 3=MC/mixed text, 4=ECM. They live in the screen-0 tail (bytes 1000-1015
//; are never displayed, sprite pointers start at +$3F8) because the Main
//; Code block is packed to the byte below the bitmap and has no room.
.const LogoD011Table					= SCREEN0_ADDRESS + $3E8
.const LogoD016Table					= SCREEN0_ADDRESS + $3E8 + 5

//; VIC register values
.const D018_VALUE_0						= (SCREEN0_BANK * 16) + (CHARSET_BANK * 2)
.const D018_VALUE_1						= (SCREEN1_BANK * 16) + (CHARSET_BANK * 2)
.const D018_VALUE_BITMAP				= (SCREEN0_BANK * 16) + (BITMAP_BANK * 8)

//; Calculated bar values
.const MAX_BAR_HEIGHT					= TOP_SPECTRUM_HEIGHT * 8 - 1
.const WATER_REFLECTION_HEIGHT			= BOTTOM_SPECTRUM_HEIGHT * 8
.const MAIN_BAR_OFFSET					= MAX_BAR_HEIGHT - 7
.const REFLECTION_OFFSET				= WATER_REFLECTION_HEIGHT - 7

//; Color table configuration - placed in gap between bitmap and sprites ($2DC0-$2E3F)
//; With SPRITE_BASE_INDEX at $B9, sprites start at $2E40, giving 128-byte gap for 72-byte color table
.const COLOR_TABLE_SIZE					= MAX_BAR_HEIGHT + 9

//; Voice Waveform colour mode: bar height quantized to 8 brightness levels
//; (MAX_BAR_HEIGHT=63 >> 3 = 0..7) within each waveform family's ramp
.const WAVE_LEVEL_SHIFT					= 3
.const COLOR_TABLE_ADDRESS				= VIC_BANK_ADDRESS + $2DC0 //; Within 16k VIC bank

//; Elapsed-time timer: to the right of the title line, 1x2 font, double-buffered
//; (matches RaistlinMirrorBarsWithLogo). Only in CODE_ONLY builds - the classic
//; single-blob build is packed to the byte below the bitmap and has no room; the
//; code-only build assembles the code apart from the graphics, so it fits normally.
#if CODE_ONLY
.const TIMER_SCREEN0 = SCREEN0_ADDRESS
.const TIMER_SCREEN1 = SCREEN1_ADDRESS
//; Bottom line: song name flush-left; on the right, the elapsed timer then (when a
//; length is known) a "/" and the song length flush-right - i.e. "MM:SS/MM:SS" in
//; cols 29..39. With a length: timer 29..33, '/' 34, length 35..39. Without one, the
//; timer alone sits flush-right at 35..39 (no gap). The player picks the timer column
//; at runtime via timerAlone; both positions are these fixed constants.
#define TIMER_MOVABLE
.const TIMER_POS = (SONG_TITLE_LINE * 40) + 29          //; with a length: left of "/MM:SS"
.const TIMER_POS_ALONE = (SONG_TITLE_LINE * 40) + 35    //; no length: flush-right
.const SLASH_POS = (SONG_TITLE_LINE * 40) + 34          //; '/' separator
.const LENGTH_POS = (SONG_TITLE_LINE * 40) + 35         //; "MM:SS" length, flush-right
.const TIMER_COLOR = $0c                                //; timer digits: grey (12)
.const LENGTH_COLOR = $0b                               //; length + '/': dark grey (11)
.const TIMER_DOUBLE_HEIGHT = 1
#endif

//; =============================================================================
//; INCLUDES
//; =============================================================================

//; Song-change keys desync the baked FFT stream (it's baked for one subtune), so
//; the baked build locks to the exported song. Live (realtime/shadow) modes keep
//; full song switching.
#if !SPECTROMETER_BAKED
#define INCLUDE_PLUS_MINUS_SONGCHANGE
#define INCLUDE_09ALPHA_SONGCHANGE
#endif
#define INCLUDE_F1_SHOWRASTERTIMINGBAR
#define INCLUDE_SPACE_FASTFORWARD
#define INCLUDE_MUSIC_ANALYSIS
#define SIDREGMIRROR_EXTERNAL
//; Bars follow a simulated SID envelope (attack/decay/sustain/release)
//; instead of snapping to the sustain level - see INC/spectrometer.asm.
//; Tables are placed after the color table (the code block is full).
//; In baked mode the bar heights come from a precomputed FFT stream, so the
//; ADSR simulation and the freqtable it uses are dropped (they also free the
//; room the baked decode tables need in this otherwise-full bank).
#if !SPECTROMETER_BAKED
#define SPECTROMETER_ADSR
#define SPECTROMETER_ADSR_EXTERNAL_TABLES
#endif

//; Raster line for music call 0 (below the visible area); the remaining calls
//; are CIA-timer driven and may be interrupted by the logo/spectrometer split
//; IRQ (see INC/multicallirq.asm).
.const MUSIC_SYNC_LINE = 251
.const SPLIT_RASTERLINE = 50 + (LOGO_HEIGHT * 8)

//; =============================================================================
//; SPRITE CURTAIN (dual-role sprites)
//; The logo/spectrometer split is hidden behind the 7 sprites: at the bottom
//; of each frame (after the water reflection has displayed) they become a
//; full-width border-coloured curtain whose 2 solid rows block the logo's
//; final two raster lines; the split handler then flips them back to water
//; duty. Colours and x-expansion are identical in both roles, so only X/Y,
//; $d010 and the pointers swap. The curtain sprite reuses the 7th water-frame
//; slot (the shimmer runs 6 frames instead of 7).
//; =============================================================================

//; Bias up one line (SPLIT_RASTERLINE - 2, not - 1): the curtain sprite renders
//; one line below its Y, and the split IRQ's VIC write lands ~1 line late from IRQ
//; latency, so both sat 1px low. CURTAIN_TOP_BLOCK_LINE drives the sprite Y AND
//; the split IRQ's $d012 (armed with CURTAIN_TOP_BLOCK_LINE below), so moving it
//; shifts the block and the switch together - the sprite keeps hiding the switch.
.const CURTAIN_TOP_BLOCK_LINE			= SPLIT_RASTERLINE - 2
.const CURTAIN_SPRITE_Y					= CURTAIN_TOP_BLOCK_LINE - 19	//; solid rows 19/20 land on the blocked lines
.const CURTAIN_SPRITE_INDEX				= SPRITE_BASE_INDEX + 6			//; the freed 7th water-frame slot

//; Where the sprites are handed back to curtain duty for the next frame. Two
//; lines after the water's last (its Y + 20), and well before MUSIC_SYNC_LINE.
//;
//; It is a raster event of its own because the arming has a DEADLINE the frame's
//; work cannot be trusted to meet: the VIC compares sprite Y once per line, so
//; the sprites must be back on curtain duty before CURTAIN_SPRITE_Y. Riding on
//; the tail of FrameCall they were not - behind the play call and
//; UpdateBarColors' colour-RAM sweep, and skipped entirely when the dispatcher's
//; overload guard drops a frame call - so at the switch the sprites were still
//; on water duty on 15% of frames (46 of 300, measured with
//; scripts/seam-latency.js --watch=curtain), leaving it written in the open: a
//; two-line smear across the seam, on any logo whose artwork reaches the bottom
//; of the band. An event of its own owes nothing to how long the frame's work
//; takes.
.const CURTAIN_ARM_LINE					= REFLECTION_SPRITES_YVAL + 23

.import source "../INC/common.asm"
.import source "../INC/keyboard.asm"
.import source "../INC/musicplayback.asm"
.import source "../INC/multicallirq.asm"

//; Sprite animation sine (half-resolution: the 0-127 phase advances as before
//; but two phases share an entry, lookup uses phase/2). Defined HERE - before
//; stablerastersetup's .align 128 - so these 64 data bytes fill alignment
//; padding instead of pushing the post-align code tail into the bitmap; the
//; packed full builds need that headroom for the fast-forward handling.
spriteSineTable:			.fill 64, 11.5 + 11.5*sin(toRadians(i*360/64))

.import source "../INC/stablerastersetup.asm"
.import source "../INC/spectrometer.asm"
#if !SPECTROMETER_BAKED
.import source "../INC/freqtable.asm"
#endif
.import source "../INC/barstyles.asm"
.import source "../INC/linkedwitheffect.asm"

//; Graphics-donor build (-define GFX_DONOR): all runtime code is compiled
//; out - the full-bank bin only donates the data block + VIC assets to the
//; relocating exporter, so code size is never capped by the bank layout.
#if !GFX_DONOR

#if CODE_ONLY
//; Live players wrap the clock at the loop point (baked players reset on the
//; stream wrap instead) - see INC/timer.asm.
#if CODE_ONLY
#if !SPECTROMETER_BAKED
#define TIMER_LOOP_WRAP
#endif
#endif
.import source "../INC/timer.asm"

//; Static "/MM:SS" song length, drawn once at init flush-right, with a "/" separator
//; just left of it (the timer sits left of the "/"). Only shown when the analysis
//; found a real length (bakedHasLength); otherwise the timer alone sits flush-right
//; and nothing is drawn here. Same 1x2 digit glyphs as the timer; the '/' is screen
//; code 47 (the font maps ASCII 32..63 straight through, so it carries the glyph).
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
//; Runtime-only state relocated into the top rows of Screen 1 (in-bank
//; $3400-$358F): those bytes hold the logo colour data at load time (copied
//; to $d800 once by DrawScreens) and are never displayed afterwards - the
//; logo area is bitmap mode and always fetches from Screen 0. Initialised in
//; Initialize after DrawScreens has consumed the colour data. This keeps the
//; Main Code block (which is packed to the byte below the bitmap) small
//; enough to hold the shared IRQ framework.
//; =============================================================================

//; The mirror is SIDMIRROR_SIZE bytes (100 analysing, 121 in the shadow build,
//; where the chips sit $20 apart - see INC/common.asm), so everything after it
//; is placed relative to that rather than at a fixed offset.
.label sidRegisterMirror        = SCREEN1_ADDRESS + 0
.label previousHeightsScreen0   = SCREEN1_ADDRESS + SIDMIRROR_SIZE          //; 40 bytes
.label previousHeightsScreen1   = SCREEN1_ADDRESS + SIDMIRROR_SIZE + 40     //; 40 bytes
.label previousColors           = SCREEN1_ADDRESS + SIDMIRROR_SIZE + 80     //; 40 bytes

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
	jsr DrawScreens
	jsr InitializeColors
#if CODE_ONLY
	//; Pick the timer column: flush-right on its own, or shifted left when a song
	//; length ("/MM:SS") will sit to its right. bakedHasLength is $00 in non-baked
	//; builds, so those keep the flush-right timer.
	ldx #$01
	lda bakedHasLength
	beq !setFlush+
	ldx #$00
!setFlush:
	stx timerAlone
	jsr InitTimer
	//; Draw "/MM:SS" when a length was found (bakedHasLength) - for realtime and
	//; shadow exports too, not just baked; DrawSongLength itself no-ops with no
	//; length, leaving the timer flush-right.
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

	//; The previous* arrays live where the logo colour data was loaded; mark
	//; every entry dirty now that DrawScreens has copied the colours out.
	ldy #(3 * NUM_FREQUENCY_BARS) - 1
	lda #$ff
!loop:
	sta previousHeightsScreen0, y
	dey
	bpl !loop-

#if SPECTROMETER_BAKED
	jsr InitBaked
#endif

	jsr SetupMusic

	lda BitmapScreenColour
	sta $d021

	jsr VSync

	lda BorderColour
	sta $d020

	jsr InitMultiCallIRQ
	StartRasterEvents(MUSIC_SYNC_LINE, MusicFrameHandler)

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

	//; One music frame advanced: keep the baked stream position (bars +
	//; loop wrap) moving at the same accelerated rate - and, in relocated
	//; builds (the only ones that carry the clock), the on-screen timer too.
#if SPECTROMETER_BAKED
	jsr TickBakedFrame
#endif
#if CODE_ONLY
#if SPECTROMETER_BAKED
	lda bakedJustLooped
	beq !noWrap+
	lda #$00
	sta bakedJustLooped
	jsr ResetTimerToLoop
!noWrap:
#endif
	jsr UpdateTimer
#endif
#if !SPECTROMETER_BAKED
	jsr CheckMusicLoop          //; forced song loop tracks fast-forwarded frames too
#endif

	jsr CheckSpaceKey
	lda FastForwardActive
	bne !ffFrameLoop-

	lda borderColor
	sta $d020
!noFF:

	lda visualizationUpdateFlag
	beq MainLoop

	jsr ApplySmoothing
	jsr RenderBars

	lda #$00
	sta visualizationUpdateFlag

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
	sta $d027							//; Also set sprite colors to match
	sta $d028
	sta $d029
	sta $d02a
	sta $d02b
	sta $d02c
	sta $d02d
	sta $d02e
	lda backgroundColor
	sta $d021

	rts

//; =============================================================================
//; INTERRUPT HANDLERS (see INC/multicallirq.asm for the shared scheduler)
//; Two raster events per frame: the frame call at MUSIC_SYNC_LINE (switches
//; the VIC to bitmap mode for the logo at the top of the next frame) and the
//; logo/spectrometer split. The split is an "urgent" event: it may interrupt
//; a mid-frame music call, flip the VIC registers and return without
//; affecting playback.
//; =============================================================================

MusicFrameHandler:
	//; Logo-region registers for the top of the next frame. The logo mode
	//; byte (data block $70, written by the exporter's logo conversion)
	//; indexes the $d011/$d016 tables: 0=MC bitmap, 1=hires bitmap,
	//; 2=hires text, 3=MC/mixed text, 4=ECM. $d018 is the same value for
	//; bitmap and charset logos: screen0 + (bitmap $6000 == charset $6000).
	lda #D018_VALUE_BITMAP
	sta $d018
	ldx BitmapMode
	lda LogoD016Table, x
	sta $d016
	lda LogoD011Table, x
	sta $d011
	lda BitmapScreenColour
	sta $d021
	//; Charset-logo globals $d022-$d024 (contiguous at data block $71-$73,
	//; from the conversion; zero for bitmap logos, which ignore them).
	ldx #$02
!logoRegs:
	lda LogoD022, x
	sta $d022, x
	dex
	bpl !logoRegs-

	ldy currentScreenBuffer
	lda D018Values, y
	sta SpectrometerD018 + 1

	//; Armed on the curtain's first blocked line (CURTAIN_TOP_BLOCK_LINE): the
	//; sprites hide both lines, so the handler just writes the registers. Uses the
	//; same const as the sprite Y so the switch and the curtain move together.
	SetNextRasterEvent(CURTAIN_TOP_BLOCK_LINE, SpectrometerDisplayIRQ)
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

#if SPECTROMETER_BAKED
	//; Refresh the baked targets at the chosen keyframe rate; UpdateBars
	//; interpolates the held targets between keyframes for smooth 50 Hz motion.
	jsr TickBakedFrame
#endif

	jsr UpdateBars
#if CODE_ONLY
#if SPECTROMETER_BAKED
	//; On a stream wrap, re-sync the clock to the loop-point time (not 0:00).
	lda bakedJustLooped
	beq !noReset+
	lda #$00
	sta bakedJustLooped
	jsr ResetTimerToLoop
!noReset:
#endif
	jsr UpdateTimer
#endif

	inc frameCounter
	bne !skip+
	inc frame256Counter
!skip:
	rts

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

	ldy #NUM_FREQUENCY_BARS
!colorLoop:
	dey
	bmi !done+

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
	lda heightToColor, x
	cmp previousColors, y
	beq !colorLoop-
	sta previousColors, y

	//; One constant colour for the whole column, water reflection included
	//; (the reflection is dimmed by its sparse dither, not by a darker hue).
	.for (var line = 0; line < TOP_SPECTRUM_HEIGHT + BOTTOM_SPECTRUM_HEIGHT; line++) {
		sta $d800 + ((SPECTRUM_START_LINE + line) * 40) + ((40 - NUM_FREQUENCY_BARS) / 2), y
	}
	jmp !colorLoop-

!done:
	rts

//; Urgent split: back to char mode for the spectrometer area. Fires on the
//; curtain's first blocked line; the two blocked lines hide the register
//; burst (any entry jitter included), then the sprites flip to water duty.
SpectrometerDisplayIRQ:
	lda #$1b
	ldx spectrometerBgColor
SpectrometerD018:
	ldy #$00
	sta $d011
	stx $d021
	sty $d018
	lda #$08
	sta $d016

	jsr ApplyWaterSprites

	SetNextRasterEvent(CURTAIN_ARM_LINE, CurtainArmIRQ)
	jmp ExitIRQ

//; The water has displayed: hand the sprites back to curtain duty for the top of
//; the next frame (see CURTAIN_ARM_LINE).
CurtainArmIRQ:
	//; Music event first, so a slow frame can never cost the frame's play call.
	SetNextRasterEvent(MUSIC_SYNC_LINE, MusicFrameHandler)
	//; Sprite registers are music-safe, so let a mid-frame CIA call nest into
	//; the writes rather than sit behind them.
	cli
	jsr UpdateSprites
	jmp ExitIRQ

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

	.for (var line = 0; line < TOP_SPECTRUM_HEIGHT; line++) {
		lda barCharacterMap - MAIN_BAR_OFFSET + (line * 8), x
		sta SCREEN0_ADDRESS + ((SPECTRUM_START_LINE + line) * 40) + ((40 - NUM_FREQUENCY_BARS) / 2), y
	}

	txa
	lsr
	tax
	.for (var line = 0; line < BOTTOM_SPECTRUM_HEIGHT; line++) {
		lda barCharacterMap - REFLECTION_OFFSET + (line * 8), x
		clc
		adc #10
		sta SCREEN0_ADDRESS + ((SPECTRUM_START_LINE + TOP_SPECTRUM_HEIGHT + BOTTOM_SPECTRUM_HEIGHT - 1 - line) * 40) + ((40 - NUM_FREQUENCY_BARS) / 2), y
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

	.for (var line = 0; line < TOP_SPECTRUM_HEIGHT; line++) {
		lda barCharacterMap - MAIN_BAR_OFFSET + (line * 8), x
		sta SCREEN1_ADDRESS + ((SPECTRUM_START_LINE + line) * 40) + ((40 - NUM_FREQUENCY_BARS) / 2), y
	}

	txa
	lsr
	tax
	.for (var line = 0; line < BOTTOM_SPECTRUM_HEIGHT; line++) {
		lda barCharacterMap - REFLECTION_OFFSET + (line * 8), x
		clc
		adc #20
		sta SCREEN1_ADDRESS + ((SPECTRUM_START_LINE + TOP_SPECTRUM_HEIGHT + BOTTOM_SPECTRUM_HEIGHT - 1 - line) * 40) + ((40 - NUM_FREQUENCY_BARS) / 2), y
	}
	jmp !loop-

//; =============================================================================
//; SPRITE ANIMATION
//; =============================================================================

//; Configure the sprites as the curtain for the top of the next frame, and
//; advance the wobble phase. Called from CurtainArmIRQ, on its own raster event
//; once the water has displayed; the split handler (ApplyWaterSprites) flips
//; them back to water duty.
UpdateSprites:
	ldx #$06
	ldy #$0c							//; sprite 6 first: $d00c/$d00d, down to $d000/$d001
!loop:
	lda CurtainXTable, x
	sta $d000, y
	lda #CURTAIN_SPRITE_Y
	sta $d001, y
	lda #CURTAIN_SPRITE_INDEX
	sta SPRITE_POINTERS_0, x
	sta SPRITE_POINTERS_1, x
	dey
	dey
	dex
	bpl !loop-
	lda #$60							//; curtain sprites 5 (264) and 6 (312) cross the 256-line
	sta $d010

	clc
	lda spriteAnimationIndex
	adc #$01
	and #$7f
	sta spriteAnimationIndex

	rts

CurtainXTable: .byte 24, 72, 120, 168, 216, 264 - 256, 312 - 256

//; After the split: back to water duty. Gated to the first line past the
//; curtain - the curtain rows are still displaying while the split handler
//; runs, and rewriting X/Y/pointers under them would tear the block.
//; Y is written last as an extra guard.
ApplyWaterSprites:
	WaitUntilRasterLine(SPLIT_RASTERLINE + 1)

	lda spriteAnimationIndex
	lsr									//; two phases per sine entry (see spriteSineTable)
	tax
	lda spriteSineTable, x
	.for (var i = 0; i < 7; i++) {
		sta $d000 + (i * 2)
		.if (i != 6) {
			clc
			adc #$30
		}
	}
	ldy #$40							//; Sprite 6 always has X MSB set
	lda $d000 + (5 * 2)
	bmi !skip+
	ldy #$60							//; Sprites 5 and 6 have X MSB set
!skip:
	sty $d010

	lda frameCounter
	lsr
	lsr
	and #$07
	cmp #$06							//; 6 frames now (slot 7 is the curtain)
	bcc !noClamp+
	sbc #$06							//; 6,7 -> 0,1 (carry set by cmp)
!noClamp:
	//; ADD, not ORA. The base is $B9 here (the curtain took the slot above the six
	//; water frames) and its low bit is already set, so ORA folded frames 0/1, 2/3
	//; and 4/5 onto one pointer each: three of the six ever showed, each for twice
	//; as long, and the shimmer jumped two rows at a time instead of drifting one -
	//; the reflection blinked rather than moved. Carry is clear on the bcc path and
	//; set after the sbc, so it has to be cleared here.
	clc
	adc #SPRITE_BASE_INDEX
	.for (var i = 0; i < 7; i++) {
		sta SPRITE_POINTERS_0 + i
		sta SPRITE_POINTERS_1 + i
	}

	ldx #$0c
	lda #REFLECTION_SPRITES_YVAL
!yloop:
	sta $d001, x
	dex
	dex
	bpl !yloop-

	rts

//; =============================================================================
//; UTILITY FUNCTIONS
//; =============================================================================

DrawScreens:

	ldy #00
!loop:
	.for (var i = 0; i < 4; i++)
	{
		lda BITMAP_COL_DATA + (i * 256), y
		sta $d800 + (i * 256), y
	}
	iny
	bne !loop-

#if CODE_ONLY
	//; Song name LEFT-aligned into cols 0..27 (the right of the line holds the timer
	//; and optional "/length"). The exporter centres the 32-byte name, so skip the
	//; leading spaces and copy from the first real character; past the 32-byte name we
	//; write spaces. Longer names are truncated at 28 columns.
	ldx #$ff
!lead:
	inx
	cpx #28
	bcs !copy+                  //; window is all spaces -> render blank
	lda SongName, x
	cmp #$20                    //; space (screen code 32)
	beq !lead-
!copy:
	ldy #$00
!cp:
	lda #$20                    //; default: past the name -> space
	cpx #32
	bcs !put+
	lda SongName, x
!put:
	sta SCREEN0_ADDRESS + (SONG_TITLE_LINE * 40) + 0, y
	sta SCREEN1_ADDRESS + (SONG_TITLE_LINE * 40) + 0, y
	ora #$80
	sta SCREEN0_ADDRESS + ((SONG_TITLE_LINE + 1) * 40) + 0, y
	sta SCREEN1_ADDRESS + ((SONG_TITLE_LINE + 1) * 40) + 0, y
	lda songNameColor
	sta $d800 + ((SONG_TITLE_LINE + 0) * 40) + 0, y
	sta $d800 + ((SONG_TITLE_LINE + 1) * 40) + 0, y
	inx
	iny
	cpy #28
	bne !cp-
#else
	//; Classic single-blob build (no timer): compact centred-name copy, cols 0..27.
	ldy #27
!loop:
	lda SongName, y
	sta SCREEN0_ADDRESS + (SONG_TITLE_LINE * 40) + 0, y
	sta SCREEN1_ADDRESS + (SONG_TITLE_LINE * 40) + 0, y
	ora #$80
	sta SCREEN0_ADDRESS + ((SONG_TITLE_LINE + 1) * 40) + 0, y
	sta SCREEN1_ADDRESS + ((SONG_TITLE_LINE + 1) * 40) + 0, y
	lda songNameColor
	sta $d800 + ((SONG_TITLE_LINE + 0) * 40) + 0, y
	sta $d800 + ((SONG_TITLE_LINE + 1) * 40) + 0, y
	dey
	bpl !loop-
#endif

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
	//; Set colors for each line of the spectrum
	.for (var line = 0; line < TOP_SPECTRUM_HEIGHT; line++) {
		lda lineGradientColors + line
		sta $d800 + ((SPECTRUM_START_LINE + line) * 40) + ((40 - NUM_FREQUENCY_BARS) / 2), x
	}
	//; Reflection lines: same colour as the water-line row (injected constant),
	//; no darkening - the sparse dither is what makes the reflection read faint.
	.for (var line = 0; line < BOTTOM_SPECTRUM_HEIGHT; line++) {
		lda lineGradientColors + TOP_SPECTRUM_HEIGHT + line
		sta $d800 + ((SPECTRUM_START_LINE + TOP_SPECTRUM_HEIGHT + line) * 40) + ((40 - NUM_FREQUENCY_BARS) / 2), x
	}
	dex
	bpl !barLoop-
	rts

!columnMode:
	//; Mode 2 (Rainbow Columns): one fixed colour per bar column, water
	//; reflection included (no darker hue - the dither dims it).
	ldx #NUM_FREQUENCY_BARS - 1
!colLoop:
	lda barGradientColors, x
	.for (var line = 0; line < TOP_SPECTRUM_HEIGHT + BOTTOM_SPECTRUM_HEIGHT; line++) {
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
	.byte $00, REFLECTION_SPRITES_YVAL	//; Sprite 0 X,Y
	.byte $00, REFLECTION_SPRITES_YVAL	//; Sprite 1 X,Y
	.byte $00, REFLECTION_SPRITES_YVAL	//; Sprite 2 X,Y
	.byte $00, REFLECTION_SPRITES_YVAL	//; Sprite 3 X,Y
	.byte $00, REFLECTION_SPRITES_YVAL	//; Sprite 4 X,Y
	.byte $00, REFLECTION_SPRITES_YVAL	//; Sprite 5 X,Y
	.byte $00, REFLECTION_SPRITES_YVAL	//; Sprite 6 X,Y
	.byte $00, REFLECTION_SPRITES_YVAL	//; Sprite 7 X,Y
	.byte $00							//; Sprite X MSB
	.byte SKIP_REGISTER					//; D011
	.byte SKIP_REGISTER					//; D012
	.byte SKIP_REGISTER					//; D013
	.byte SKIP_REGISTER					//; D014
	.byte $7f							//; Sprite enable (7 sprites: 0-6)
	.byte $18							//; D016
	.byte $00							//; Sprite Y expand
	.byte D018_VALUE_BITMAP				//; Memory setup
	.byte SKIP_REGISTER					//; D019
	.byte SKIP_REGISTER					//; D01A
	.byte $00							//; Sprite priority
	.byte $00							//; Sprite multicolor
	.byte $7f							//; Sprite X expand (7 sprites: 0-6)
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
spriteAnimationIndex:		.byte $00

D018Values:					.byte D018_VALUE_0, D018_VALUE_1

//; =============================================================================
//; DATA SECTION - Display Mapping
//; =============================================================================

//; Clamp padding sized to the actual index range: main bars index
//; [-MAIN_BAR_OFFSET .. MAX_BAR_HEIGHT] relative to barCharacterMap.
	.fill MAIN_BAR_OFFSET, 224
barCharacterMap:
	.fill 8, 225 + i
	.fill MAX_BAR_HEIGHT - 7, 233

//; =============================================================================
#endif // !GFX_DONOR (code)

//; GRAPHICS (VIC) ASSETS + CPU-read tables (colour table, ADSR rates,
//; sprites, charset, bar chars, screens, logo bitmap).
//;
//; A CODE_ONLY build omits the emitted bytes - the exporter synthesises/places
//; them from the PNGs, palettes and static maps into a VIC bank - while the code
//; keeps resolving heightToColor / attackRate* via these address labels
//; (gfx-refs, patched to the chosen bank). The classic build emits them here,
//; byte-for-byte as before.
//; =============================================================================

.label heightToColor  = COLOR_TABLE_ADDRESS
#if !SPECTROMETER_BAKED
.label attackRateLo   = COLOR_TABLE_ADDRESS + COLOR_TABLE_SIZE
.label attackRateHi   = COLOR_TABLE_ADDRESS + COLOR_TABLE_SIZE + 16
#endif

#if !CODE_ONLY

//; Color table (heightToColor) - filled at build time by the web app.
* = COLOR_TABLE_ADDRESS "Color Table"
	.fill COLOR_TABLE_SIZE, $0b

//; ADSR attack-rate tables. Baked builds have no ADSR simulation, so these (and
//; the attackMs source data they derive from) don't exist.
#if !SPECTROMETER_BAKED
* = COLOR_TABLE_ADDRESS + COLOR_TABLE_SIZE "ADSR Attack Rates"
	.fill 16, <min(65535, (MAX_BAR_HEIGHT * 256 * 20) / attackMs.get(i))
	.fill 16, >min(65535, (MAX_BAR_HEIGHT * 256 * 20) / attackMs.get(i))
#endif

//; Sprite data (6 animation frames; the 7th slot holds the curtain sprite)
* = SPRITES_ADDRESS "Water Sprites"
	.fill min(6 * 64, file_waterSpritesData.getSize()), file_waterSpritesData.get(i)

* = SPRITES_ADDRESS + (6 * 64) "Curtain Sprite"
	.fill 57, $00						//; rows 0-18 transparent
	.fill 6, $ff						//; rows 19-20 solid - the 2-line block
	.byte $00

//; Charset
* = CHARSET_ADDRESS "Font"
	.fill min($700, file_charsetData.getSize()), file_charsetData.get(i)

* = CHARSET_ADDRESS + (224 * 8) "Bar Chars"
//; Filled at build time by the web app based on BarStyle selection
	.fill BAR_STYLE_SIZE_WATER, $00

* = SCREEN0_ADDRESS "Screen 0"
	.fill LOGO_HEIGHT * 40, $00
	.fill 1000 - (LOGO_HEIGHT * 40), $20
	//; Screen tail (chars 1000+ are never displayed): the logo mode tables
	//; (LogoD011Table / LogoD016Table), then pad up to the sprite pointers.
	.byte $3b, $3b, $1b, $1b, $5b
	.byte $18, $08, $08, $18, $08
	.fill $400 - 1000 - 10, $20

* = SCREEN1_ADDRESS "Screen 1"
	.fill LOGO_HEIGHT * 40, $00
	.fill $400 - (LOGO_HEIGHT * 40), $20

* = BITMAP_ADDRESS "Bitmap"
	.fill LOGO_HEIGHT * 40 * 8, $00

#endif // !CODE_ONLY

//; =============================================================================
//; END OF FILE
//; =============================================================================
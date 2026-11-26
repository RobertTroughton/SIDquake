// =============================================================================
//                                   PIANO
//          A logo, the song name, and a piano keyboard that plays itself
// =============================================================================
//
// Screen layout (char rows):
//    0-10  logo (10 art rows + 1 clear row that hides the raster split)
//   12-13  song name, 1x2 font, centred
//   15-16  elapsed time, and "/" + song length when the analysis found one
//      17  drum bar: low, mid and high thirds light on drum hits
//   18-23  keyboard: 40 white keys, C to G across 5 octaves and a fifth;
//          the black keys are the top 4 of its 6 rows
//      24  filter bar: the filter cutoff as a length
//
// Which keys are down comes from the SID registers, read the same two ways
// the bar players read them: the realtime build peeks a second play call with
// RAM banked in over $D400 (INC/musicplayback.asm AnalyseMusic), the shadow
// build (-define SPECTROMETER_SHADOW) reads the mirror the tune's own
// repointed stores fill. Each voice's frequency becomes a note by binary
// search of a PAL semitone-boundary table; gate, sustain, decay and release
// decide how long the key stays lit and how bright it is. Not every pitch is
// a key press: noise is a drum and goes to the drum bar, a pitch that steps
// under a held gate is a chord (kept lit together) when it jumps three
// semitones or more and a slide (not shown) when it moves less.
//
// Lit white keys are recoloured in colour RAM (the black keys are background
// pixels cut out of the white-key characters, so a white key's cells carry
// only that key). Lit black keys are sprites: one 6px-wide, Y-expanded sprite
// per lit black key, up to eight. A white key takes the colour of its note's
// waveform (triangle blue, sawtooth red, pulse green, mixed purple) and fades
// back to white as its envelope falls; a black key lights grey.
//
// The logo/piano split is hidden behind the same sprite curtain as
// RaistlinBarsWithLogo (7 x-expanded sprites whose last two rows block the
// logo's final two lines). Below the split the sprites become the black-key
// highlights; MusicFrameHandler hands them back to curtain duty in the bottom
// border.
//
// Memory map (VIC bank relative):
//   $2000-$2DBF  logo bitmap (11 rows), or the logo charset in text modes
//   $2E00-$2E3F  curtain sprite
//   $2E40-$2E7F  black-key sprite
//   $3000-$33FF  screen (logo rows injected at export) + sprite pointers
//   $3400-$35B7  logo colour data on load (copied to $D800 at init)
//   $3800-$3EFF  1x2 font (injected at export)
//   $3F00-$3F3F  piano characters (224-231)
// =============================================================================

.var LOAD_ADDRESS                   = cmdLineVars.get("loadAddress").asNumber()
.var CODE_ADDRESS                   = cmdLineVars.get("sysAddress").asNumber()
.var DATA_ADDRESS                   = cmdLineVars.get("dataAddress").asNumber()

//; =============================================================================
//; DATA BLOCK
//; =============================================================================

* = DATA_ADDRESS "Data Block"
    .fill $0D, $00                      // Reserved bytes 0-12
borderColor:
    .byte $00                           // $0D: border colour
backgroundColor:
    .byte $00                           // $0E: logo background colour (from the logo conversion)
    .fill $4C - $0F, $00
    //; Song length and loop point, patched at export (same offsets as the bar
    //; players; see INC/timer.asm).
bakedLoopEndMin:
    .byte $00                           // $4C: loop-end (= shown length) MM - the clock wraps here
bakedLoopEndSec:
    .byte $00                           // $4D: loop-end SS
bakedLoopEndFrameRem:
    .byte $00                           // $4E: loop-end frame within that second
bakedLoopFrameRem:
    .byte $00                           // $4F: loop-point frame within that second
    .fill $5B - $50, $00
bakedLoopMin:
    .byte $00                           // $5B: loop-point MM - the clock resets here
bakedLoopSec:
    .byte $00                           // $5C: loop-point SS
bakedLenMin:
    .byte $00                           // $5D: song length MM
bakedLenSec:
    .byte $00                           // $5E: song length SS
bakedHasLength:
    .byte $00                           // $5F: 1 when the analysis found a real length
    .fill $6C - $60, $00
songNameColor:
    .byte $01                           // $6C: song name colour
pianoBgColor:
    .byte $00                           // $6D: background below the logo
    .fill $74 - $6E, $00                // $70-$73: logo mode + $d022-$d024 (common.asm)
pianoLowNote:
    .byte $00                           // $74: leftmost C's note number + 1 (C0 = note 0), picked at export; 0 = C1
pianoDrumSplit:
    .byte $00, $00                      // $75/$76: noise frequency high bytes splitting low/mid/high drums, measured at export; 0 = $40/$A0
    .fill DATA_ADDRESS + $100 - *, $00

* = CODE_ADDRESS "Main Code"

#if !GFX_DONOR
    jmp Initialize
#endif

#if CODE_ONLY
.var GFX_BANK = cmdLineVars.containsKey("gfxBank") ? cmdLineVars.get("gfxBank").asNumber() : 1
#else
.var GFX_BANK = floor(LOAD_ADDRESS / $4000)
#endif
.var VIC_BANK						= GFX_BANK
.var VIC_BANK_ADDRESS               = VIC_BANK * $4000

//; =============================================================================
//; CONFIGURATION
//; =============================================================================

.const LOGO_HEIGHT						= 11
.const SONG_TITLE_LINE					= 12
.const TIMER_LINE						= 15
.const DRUM_ROW							= 17
.const KEYS_TOP_ROW						= 18
.const BLACK_KEY_ROWS					= 4		//; 2/3 of the keyboard's height
.const KEYS_BOTTOM_ROW					= 23
.const FILTER_ROW						= 24

.const NUM_WHITE_KEYS					= 40
.const NUM_KEYS							= 68	//; C..G over 5 octaves + 7 semitones
.const DEFAULT_LOW_NOTE					= 12	//; C1
.const MAX_VOICES						= 12	//; 4 SID chips
.const NUM_KEY_SPRITES					= 8
.const FLASH_FRAMES						= 2		//; a struck key shows its flash colour this long
.const LIFT_FALL						= 26	//; a key its voice has left fades over 10 frames
.const LEGATO_FRAMES					= 3		//; a small pitch step held this long is a new note, not a slide
.const ATTACK_FRAMES					= 3		//; longest a note's start is watched before deciding
.const ST_IDLE							= 0		//; voice states (voiceState)
.const ST_ATTACK						= 1		//; a note or drum has started: watching it
.const ST_NOTE							= 2		//; a note: its key is lit
.const ST_DRUM							= 3		//; a drum: its pitch is ignored until the next start
.const DRUM_ZONES						= 3
.const DRUM_FALL						= 22	//; a drum zone fades over 12 frames
.const DEFAULT_DRUM_SPLIT_1				= $40
.const DEFAULT_DRUM_SPLIT_2				= $a0

.const SCREEN_BANK						= 12	//; +$3000
.const CHARSET_BANK						= 7		//; +$3800
.const BITMAP_BANK						= 1		//; +$2000
.const SPRITE_BASE_INDEX				= $B8	//; +$2E00

.const SCREEN_ADDRESS					= VIC_BANK_ADDRESS + (SCREEN_BANK * $400)
.const LOGO_COL_DATA					= VIC_BANK_ADDRESS + $3400
.const CHARSET_ADDRESS					= VIC_BANK_ADDRESS + (CHARSET_BANK * $800)
.const BITMAP_ADDRESS					= VIC_BANK_ADDRESS + (BITMAP_BANK * $2000)
.const SPRITES_ADDRESS					= VIC_BANK_ADDRESS + (SPRITE_BASE_INDEX * $40)
.const SPRITE_POINTERS					= SCREEN_ADDRESS + $3F8
.const CURTAIN_SPRITE_INDEX				= SPRITE_BASE_INDEX
.const KEY_SPRITE_INDEX					= SPRITE_BASE_INDEX + 1

.const D018_LOGO						= (SCREEN_BANK * 16) + (BITMAP_BANK * 8)
.const D018_PIANO						= (SCREEN_BANK * 16) + (CHARSET_BANK * 2)

.const PIANO_CHARS						= 224
.const CHAR_BLACK_ROW					= PIANO_CHARS + 0	//; +variant (0..3)
.const CHAR_WHITE						= PIANO_CHARS + 4
.const CHAR_WHITE_BOTTOM				= PIANO_CHARS + 5
.const CHAR_DRUM_BAR					= PIANO_CHARS + 6
.const CHAR_FILTER_BAR					= PIANO_CHARS + 7

.const WHITE_UNLIT						= $01
.const BLACK_KEY_FLASH					= $0f	//; lit black keys are grey (blackKeyShades)

//; Sprite Y lines up with a char row at 50 + row * 8 (first text row at 51).
.const KEY_SPRITE_Y						= 50 + (KEYS_TOP_ROW * 8)

#define INCLUDE_PLUS_MINUS_SONGCHANGE
#define INCLUDE_09ALPHA_SONGCHANGE
#define INCLUDE_F1_SHOWRASTERTIMINGBAR
#define INCLUDE_SPACE_FASTFORWARD
#define INCLUDE_MUSIC_ANALYSIS

//; Clock under the song name, centred: "MM:SS/MM:SS" in cols 14-24 when the
//; length is known, "MM:SS" alone in cols 17-21 when it is not. One screen,
//; so both timer screens are the same.
#define TIMER_MOVABLE
#define TIMER_LOOP_WRAP
.const TIMER_SCREEN0 = VIC_BANK_ADDRESS + $3000
.const TIMER_SCREEN1 = TIMER_SCREEN0
.const TIMER_POS = (TIMER_LINE * 40) + 14
.const TIMER_POS_ALONE = (TIMER_LINE * 40) + 17
.const SLASH_POS = (TIMER_LINE * 40) + 19
.const LENGTH_POS = (TIMER_LINE * 40) + 20
.const TIMER_COLOR = $0c
.const LENGTH_COLOR = $0b
.const TIMER_DOUBLE_HEIGHT = 1

.const MUSIC_SYNC_LINE					= 251
.const SPLIT_RASTERLINE					= 50 + (LOGO_HEIGHT * 8)

//; Curtain geometry as in RaistlinBarsWithLogo: the split IRQ is armed on the
//; first of the two blocked lines, and the sprite Y follows the same constant.
.const CURTAIN_TOP_BLOCK_LINE			= SPLIT_RASTERLINE - 2
.const CURTAIN_SPRITE_Y					= CURTAIN_TOP_BLOCK_LINE - 19

.import source "../INC/common.asm"
.import source "../INC/keyboard.asm"
.import source "../INC/musicplayback.asm"
.import source "../INC/multicallirq.asm"
.import source "../INC/stablerastersetup.asm"
.import source "../INC/linkedwitheffect.asm"
.import source "../INC/timer.asm"

//; =============================================================================
//; KEYBOARD GEOMETRY (assembly-time tables)
//; =============================================================================

//; White-key index (0..6) of each semitone, and for a black key the index of
//; the white key to its right (the black key straddles that key's left edge).
.var semitoneWhite = List().add(0, 1, 1, 2, 2, 3, 4, 4, 5, 5, 6, 6)
.var semitoneBlack = List().add(0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0)

.function keyColumn(k) {
	.return floor(k / 12) * 7 + semitoneWhite.get(mod(k, 12))
}

//; Black-row character variant for white-key column c: bit 0 = a black key
//; cuts into its left edge, bit 1 = into its right edge. The outermost keys
//; have no cut on the screen edge.
.function whiteVariant(c) {
	.var w = mod(c, 7)
	.var left = (c > 0 && (w == 1 || w == 2 || w == 4 || w == 5 || w == 6)) ? 1 : 0
	.var right = (c < NUM_WHITE_KEYS - 1 && (w == 0 || w == 1 || w == 3 || w == 4 || w == 5)) ? 2 : 0
	.return left + right
}

//; SID frequency register value at which note n begins (half a semitone
//; below it), PAL clock, C0 = note 0. Entries past B7 never match.
.function noteThreshold(n) {
	.if (n == 0) .return 0
	.if (n >= 96) .return $ffff
	.var hz = 16.3516 * pow(2, (n - 0.5) / 12)
	.return min($ffff, round(hz * 16777216 / 985248))
}

//; =============================================================================
//; CODE
//; =============================================================================

#if !GFX_DONOR

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
	jsr DrawScreens
	jsr InitPiano

	//; The clock sits centred on its own, or shifted left of a "/MM:SS" length.
	ldx #$01
	lda bakedHasLength
	beq !alone+
	ldx #$00
!alone:
	stx timerAlone
	jsr InitTimer
	jsr DrawSongLength

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
	beq MainLoop

	//; Fast-forward: the main loop owns SIDPlay; the keyboard holds its last
	//; picture until it ends.
!ffFrameLoop:
	lda NumCallsPerFrame
	sta FFCallCounter
!ffCallLoop:
	jsr SIDPlay
	inc $d020
	dec FFCallCounter
	bne !ffCallLoop-

	jsr CheckMusicLoop
	jsr UpdateTimer
	jsr CheckSpaceKey
	lda FastForwardActive
	bne !ffFrameLoop-

	lda borderColor
	sta $d020
	jmp MainLoop

InitializeVIC:
	lda #$00
	sta $d015
	sta $d010
	sta $d017
	sta $d01b
	sta $d01c
	lda #$08
	sta $d016
	lda #D018_LOGO
	sta $d018
	lda borderColor
	sta $d020
	lda backgroundColor
	sta $d021
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
//; SCREEN SETUP
//; =============================================================================

DrawScreens:
	//; Logo colours (rows 0-10) from the staging area the exporter fills.
	ldy #$00
!loop:
	lda LOGO_COL_DATA, y
	sta $d800, y
	iny
	bne !loop-
!loop:
	lda LOGO_COL_DATA + $100, y
	sta $d800 + $100, y
	iny
	cpy #(LOGO_HEIGHT * 40) - $100
	bne !loop-

	//; Rows 11-18: blank, then the song name (already centred in 32 chars by
	//; the exporter) at cols 4-35, top half on row 13, bottom half on row 14.
	ldy #(4 * 40) - 1
!clear:
	lda #$20
	sta SCREEN_ADDRESS + (LOGO_HEIGHT * 40), y
	sta SCREEN_ADDRESS + ((LOGO_HEIGHT + 4) * 40), y
	lda songNameColor
	sta $d800 + (LOGO_HEIGHT * 40), y
	sta $d800 + ((LOGO_HEIGHT + 4) * 40), y
	dey
	cpy #$ff
	bne !clear-

	ldy #31
!name:
	lda SongName, y
	sta SCREEN_ADDRESS + (SONG_TITLE_LINE * 40) + 4, y
	ora #$80
	sta SCREEN_ADDRESS + ((SONG_TITLE_LINE + 1) * 40) + 4, y
	dey
	bpl !name-

	//; Keyboard.
	ldy #NUM_WHITE_KEYS - 1
!keys:
	lda whiteVariantTable, y
	ora #CHAR_BLACK_ROW
	.for (var row = KEYS_TOP_ROW; row < KEYS_TOP_ROW + BLACK_KEY_ROWS; row++) {
		sta SCREEN_ADDRESS + (row * 40), y
	}
	lda #CHAR_WHITE
	.for (var row = KEYS_TOP_ROW + BLACK_KEY_ROWS; row < KEYS_BOTTOM_ROW; row++) {
		sta SCREEN_ADDRESS + (row * 40), y
	}
	lda #CHAR_WHITE_BOTTOM
	sta SCREEN_ADDRESS + (KEYS_BOTTOM_ROW * 40), y

	lda #WHITE_UNLIT
	.for (var row = KEYS_TOP_ROW; row <= KEYS_BOTTOM_ROW; row++) {
		sta $d800 + (row * 40), y
	}

	//; The two bars start unlit: their colour is the background.
	lda #CHAR_FILTER_BAR
	sta SCREEN_ADDRESS + (FILTER_ROW * 40), y
	lda #CHAR_DRUM_BAR
	sta SCREEN_ADDRESS + (DRUM_ROW * 40), y
	lda pianoBgColor
	sta $d800 + (DRUM_ROW * 40), y
	sta $d800 + (FILTER_ROW * 40), y
	dey
	bpl !keys-
	rts

//; =============================================================================
//; INTERRUPTS (see INC/multicallirq.asm)
//; =============================================================================

//; Bottom border: logo registers for the top of the next frame, and the
//; sprites back on curtain duty before the curtain's Y comes round.
MusicFrameHandler:
	lda #D018_LOGO
	sta $d018
	ldx BitmapMode
	lda LogoD016Table, x
	sta $d016
	lda LogoD011Table, x
	sta $d011
	lda BitmapScreenColour
	sta $d021
	ldx #$02
!logoRegs:
	lda LogoD022, x
	sta $d022, x
	dex
	bpl !logoRegs-

	ldx #$06
	ldy #$0c
!curtain:
	lda CurtainXTable, x
	sta $d000, y
	lda #CURTAIN_SPRITE_Y
	sta $d001, y
	lda #CURTAIN_SPRITE_INDEX
	sta SPRITE_POINTERS, x
	lda borderColor
	sta $d027, x
	dey
	dey
	dex
	bpl !curtain-
	lda #$60							//; curtain sprites 5 and 6 sit past X 255
	sta $d010
	lda #$7f
	sta $d01d
	sta $d015
	lda #$00
	sta $d017

	SetNextRasterEvent(CURTAIN_TOP_BLOCK_LINE, PianoSplitIRQ)
	jmp MusicFrameCall

//; The curtain's two blocked lines hide the switch to the piano's char mode.
//; Once they have passed, the sprites become the black-key highlights.
PianoSplitIRQ:
	lda #$1b
	ldx pianoBgColor
	ldy #D018_PIANO
	sta $d011
	stx $d021
	sty $d018
	lda #$08
	sta $d016

	WaitUntilRasterLine(SPLIT_RASTERLINE + 1)

	lda #$00
	sta $d01d
	lda #$ff
	sta $d017
	ldx #NUM_KEY_SPRITES - 1
	ldy #(NUM_KEY_SPRITES - 1) * 2
!loop:
	lda keySpriteX, x
	sta $d000, y
	lda #KEY_SPRITE_Y
	sta $d001, y
	lda keySpriteColour, x
	sta $d027, x
	lda #KEY_SPRITE_INDEX
	sta SPRITE_POINTERS, x
	dey
	dey
	dex
	bpl !loop-
	lda keySpriteMSB
	sta $d010
	lda keySpriteEnable
	sta $d015

	SetNextRasterEvent(MUSIC_SYNC_LINE, MusicFrameHandler)
	jmp ExitIRQ

MusicCall_Frame:
#if SPECTROMETER_SHADOW
	jmp PlayMusicShadow
#else
	jmp PlayMusicWithAnalysis
#endif

MusicCall_Other:
	jmp JustPlayMusic

FrameCall:
	jsr UpdatePiano
	jmp UpdateTimer

//; "/MM:SS" song length right of the clock, drawn once; nothing when no length
//; was found. Same 1x2 digits as the clock; '/' is screen code 47.
DrawSongLength:
	lda bakedHasLength
	bne !show+
	rts
!show:
	lda #47
	sta SCREEN_ADDRESS + SLASH_POS
	ora #TIMER_BOTTOM_OFFSET
	sta SCREEN_ADDRESS + SLASH_POS + 40
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
	lda #58								//; ':'
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
	sta SCREEN_ADDRESS + LENGTH_POS, x
	ora #TIMER_BOTTOM_OFFSET
	sta SCREEN_ADDRESS + LENGTH_POS + 40, x
	lda #LENGTH_COLOR
	sta $d800 + LENGTH_POS, x
	sta $d800 + LENGTH_POS + 40, x
	dex
	bpl !write-
	rts

lengthChars:			.fill 5, $00

//; =============================================================================
//; SID ANALYSIS
//; Called at the end of the frame's analysis play (AnalyseMusic or
//; PlayMusicShadow) with sidRegisterMirror holding every chip's registers.
//; Per voice: the key it is on (0..NUM_KEYS-1, $ff = silent), its gate, and
//; its AD/SR bytes. Noise-only voices are drums, not notes, and are skipped,
//; as are voices with the test bit set or no waveform.
//; =============================================================================

AnalyzeSIDRegisters:
	ldx NumSIDChips
	lda voicesForChips, x
	sta numVoices
	ldx #$00
!voice:
	lda #$00
	sta voiceNoise, x
	ldy voiceRegOffset, x
	lda sidRegisterMirror + 4, y
	sta ctrlByte
	//; Colour family from the tonal waveform bits (triangle, sawtooth, pulse).
	lsr
	lsr
	lsr
	lsr
	and #$07
	sty saveY
	tay
	lda waveFamilyTable, y
	sta voiceWaveFamily, x
	ldy saveY
	lda ctrlByte
	and #$01
	sta voiceGate, x
	lda sidRegisterMirror + 5, y
	sta voiceAD, x
	lda sidRegisterMirror + 6, y
	sta voiceSR, x
	lda sidRegisterMirror + 0, y
	sta freqLo
	lda sidRegisterMirror + 1, y
	sta freqHi
	lda ctrlByte
	and #$08
	bne !silent+
	lda ctrlByte
	and #$f0
	beq !silent+
	bpl !tonal+

	//; Noise: a drum. Its pitch picks the low, mid or high drum zone against
	//; the two thresholds the exporter measured for this tune.
	lda #$01
	sta voiceNoise, x
	ldy #$00
	lda freqHi
	cmp drumThreshold1
	bcc !zone+
	iny
	cmp drumThreshold2
	bcc !zone+
	iny
!zone:
	tya
	sta voiceZone, x
	jmp !silent+

!tonal:
	lda freqHi
	ora freqLo
	beq !silent+
	jsr FreqToKey
	sta voiceKey, x
	jmp !next+

!silent:
	lda #$ff
	sta voiceKey, x
!next:
	inx
	cpx numVoices
	beq !voicesRead+
	jmp !voice-
!voicesRead:

	//; Filter bar: cutoff (high byte) as a length, when any voice of SID 1 is
	//; routed through the filter; coloured by the lowest such voice's waveform.
	lda #$00
	sta filterLength
	lda sidRegisterMirror + $17
	and #$07
	beq !noFilter+
	ldx #$00
	lsr
	bcs !routed+
	inx
	lsr
	bcs !routed+
	inx
!routed:
	stx filterVoice
	lda sidRegisterMirror + $16
	lsr
	lsr
	lsr
	tax
	lda filterLengthTable, x
	sta filterLength
!noFilter:
	rts

//; freqHi/freqLo -> A = key index 0..NUM_KEYS-1, folded by octaves into the
//; keyboard's range. Preserves X and Y.
FreqToKey:
	sty saveY
	lda #$00
	sta noteIndex
	lda #$40
	sta searchStep
!search:
	lda noteIndex
	ora searchStep
	tay
	lda freqLo
	cmp noteThresholdLo, y
	lda freqHi
	sbc noteThresholdHi, y
	bcc !below+
	sty noteIndex
!below:
	lsr searchStep
	bne !search-

	lda noteIndex
	cmp #96
	bcc !inTable+
	lda #95
!inTable:
	sec
	sbc lowNote
!up:
	bpl !down+
	clc
	adc #12
	jmp !up-
!down:
	cmp #NUM_KEYS
	bcc !done+
	sbc #12
	jmp !down-
!done:
	ldy saveY
	rts

//; =============================================================================
//; PIANO STATE + DRAWING (once per frame)
//; Each voice is idle, watching the start of a note (ST_ATTACK), playing a
//; note (ST_NOTE) or playing a drum (ST_DRUM). A start is a gate rising,
//; sounding again after a silent sample (a hard restart), noise starting, or,
//; during a note, a different pitch with the gate off: a multispeed tune can
//; open and close a gate between two frames' samples, and then the new pitch
//; is all the analysis sees.
//;
//; A start is watched before anything lights, because its first samples are
//; often not its note: instruments open with a frame of noise or an octave
//; jump, and kicks are a pitch falling fast with or without noise. Noise for
//; a second sample (or noise, then silence) is a snare or hi-hat; a pitch
//; falling two semitones or more twice running is a kick or tom (low zone);
//; either lights the drum bar. A pitch that holds for a sample is a note, and
//; so is anything still undecided after ATTACK_FRAMES with no noise. A plain
//; note therefore lights one frame after it starts - which in the realtime
//; build, whose analysis runs a play call ahead of the sound, lands it in step.
//;
//; Each key has a level (0 = up, 255 = just struck), a per-frame fall and the
//; voice that last played it. While the gate is held the level is kept at
//; least at a floor set by the voice's sustain, falling at the decay rate;
//; after the gate drops it falls at the release rate. A white key's level
//; picks one of four shades from its note's waveform colour; black keys are
//; lit in grey.
//; =============================================================================

UpdatePiano:
	ldx #NUM_KEYS - 1
!fall:
	lda keyFlash, x
	beq !noFlash+
	dec keyFlash, x
!noFlash:
	lda keyLevel, x
	beq !nextFall+
	sec
	sbc keyFall, x
	bcs !store+
	lda #$00
!store:
	sta keyLevel, x
!nextFall:
	dex
	bpl !fall-

	ldx #DRUM_ZONES - 1
!drumFall:
	lda drumFlash, x
	beq !noDrumFlash+
	dec drumFlash, x
!noDrumFlash:
	lda drumLevel, x
	sec
	sbc #DRUM_FALL
	bcs !drumStore+
	lda #$00
!drumStore:
	sta drumLevel, x
	dex
	bpl !drumFall-

	ldx #$00
!voice:
	lda voiceNoise, x
	bne !sounding+
	lda voiceKey, x
	bpl !sounding+

	//; Silent. A noise blip that ends in silence was a drum (a click or a
	//; hi-hat).
	lda voiceState, x
	cmp #ST_ATTACK
	bne !toIdle+
	lda attackNoise, x
	beq !toIdle+
	jsr DrumHit
!toIdle:
	lda #ST_IDLE
	sta voiceState, x
	jmp !record+

	//; Does a new note (or drum) start here? A gate rising; sounding again
	//; after a silent sample (a hard restart); noise starting without a new
	//; gate; or, in a note, a different pitch with the gate off - a multispeed
	//; tune can open and close a gate between two frames' samples, and then
	//; the new pitch (or the hard restart before it) is all the analysis sees.
!sounding:
	lda voiceGate, x
	beq !noRise+
	lda prevGate, x
	beq !start+
!noRise:
	lda prevKey, x
	bpl !wasSounding+
	lda prevNoise, x
	beq !start+
!wasSounding:
	lda voiceNoise, x
	beq !notNoiseStart+
	lda prevNoise, x
	bne !notNoiseStart+
	lda voiceState, x
	cmp #ST_ATTACK
	bne !start+
!notNoiseStart:
	lda voiceState, x
	cmp #ST_NOTE
	bne !dispatch+
	lda voiceGate, x
	bne !dispatch+
	lda voiceNoise, x
	bne !dispatch+
	lda voiceKey, x
	cmp prevKey, x
	bne !start+
!dispatch:
	lda voiceState, x
	cmp #ST_ATTACK
	beq !attack+
	cmp #ST_NOTE
	bne !toRecord+
	jmp !held+
!toRecord:
	jmp !record+

	//; The start of a note or a drum: watch it for a frame or two before
	//; showing anything (see the PIANO STATE notes above).
!start:
	lda #ST_ATTACK
	sta voiceState, x
	lda #$00
	sta attackAge, x
	sta attackFalls, x
	sta attackNoise, x
	lda voiceKey, x
	sta attackKey, x
	lda voiceNoise, x
	beq !toRecord-
	inc attackNoise, x
	lda voiceZone, x
	sta attackZone, x
	jmp !record+

!attack:
	inc attackAge, x
	lda voiceNoise, x
	beq !attackTonal+
	//; Noise held for a second sample: a snare or hi-hat.
	inc attackNoise, x
	lda attackNoise, x
	cmp #2
	bcc !attackTime+
	jsr DrumHit
	jmp !record+

!attackTonal:
	ldy voiceKey, x
	lda attackKey, x
	bmi !attackNext+
	tya
	cmp attackKey, x
	bne !moved+
	jmp !note+
	//; Two falls of two semitones or more in a row: a kick or a tom, in the
	//; drum bar's low zone.
!moved:
	clc
	adc #2
	cmp attackKey, x
	beq !fell+
	bcs !attackNext+
!fell:
	inc attackFalls, x
	lda attackFalls, x
	cmp #2
	bcc !attackNext+
	lda #$00
	sta attackZone, x
	jsr DrumHit
	jmp !record+
!attackNext:
	tya
	sta attackKey, x
!attackTime:
	lda attackAge, x
	cmp #ATTACK_FRAMES
	bcc !toRecord2+
	lda attackNoise, x
	beq !timeNote+
	jsr DrumHit
	jmp !record+
!timeNote:
	ldy voiceKey, x
	bmi !toRecord2+
	jmp !note+
!toRecord2:
	jmp !record+

	//; A note, held: the pitch moving under a held gate (moves with the gate
	//; off start new notes, above). Three semitones or more is another note
	//; of a chord (an arpeggio): light it beside the others. Less is a slide
	//; or vibrato: keep showing the note it started on, unless the pitch then
	//; stays put (a legato note; see !steady).
!held:
	ldy voiceKey, x
	tya
	cmp prevKey, x
	beq !steady+
	sec
	sbc prevKey, x
	bcs !distance+
	eor #$ff
	adc #$01
!distance:
	cmp #3
	bcc !glide+
	lda #$ff
	sta pendingKey, x
	txa
	cmp keyVoice, y
	bne !chordStrike+
	lda keyLevel, y
	bne !envelope+
!chordStrike:
	jsr StrikeKey
	jmp !envelope+

!glide:
	tya
	sta pendingKey, x
	lda #$00
	sta pendingAge, x
	ldy shownKey, x
	jmp !envelope+

!steady:
	cmp pendingKey, x
	bne !envelope+
	inc pendingAge, x
	lda pendingAge, x
	cmp #LEGATO_FRAMES - 1
	bcs !note+
	ldy shownKey, x
	jmp !envelope+

	//; A note: the voice's other keys let go, this one (Y) is struck.
!note:
	lda #ST_NOTE
	sta voiceState, x
	lda #$ff
	sta pendingKey, x
	jsr LiftVoice
	jsr StrikeKey
	tya
	sta shownKey, x

	//; Envelope for the key Y if the voice owns it, else for the key it is
	//; showing (a vibrato's neighbour is not the note): held, a sustain floor
	//; and the decay rate; released, the release rate.
!envelope:
	tya
	bmi !envDone+
	txa
	cmp keyVoice, y
	bne !useShown+
	lda keyLevel, y
	bne !ownKey+
!useShown:
	ldy shownKey, x
	bmi !envDone+
	txa
	cmp keyVoice, y
	bne !envDone+
	lda keyLevel, y
	beq !envDone+
!ownKey:
	lda voiceGate, x
	beq !released+
	lda voiceSR, x
	lsr
	lsr
	lsr
	lsr
	sty saveY
	tay
	lda sustainFloor, y
	ldy saveY
	cmp keyLevel, y
	bcc !noFloor+
	sta keyLevel, y
!noFloor:
	lda voiceAD, x
	jmp !setFall+
!released:
	lda voiceSR, x
!setFall:
	and #$0f
	sty saveY
	tay
	lda envelopeFall, y
	ldy saveY
	sta keyFall, y
!envDone:
!record:
	lda voiceKey, x
	sta prevKey, x
	lda voiceGate, x
	sta prevGate, x
	lda voiceNoise, x
	sta prevNoise, x
!nextVoice:
	inx
	cpx numVoices
	beq !voicesDone+
	jmp !voice-
!voicesDone:

	//; Draw: white keys into colour RAM when their shade changes, lit black
	//; keys into the sprite list the split IRQ applies.
	lda #$00
	sta keySpriteEnable
	sta keySpriteMSB
	sta spriteSlot

	ldx #NUM_KEYS - 1
!key:
	lda keyLevel, x
	beq !unlit+
	lsr
	lsr
	lsr
	lsr
	lsr
	lsr
	ora keyFamily, x
	tay
	lda keyFlash, x
	beq !steady+
	lda keyIsBlack, x
	bne !blackFlash+
	lda whiteFlash, y
	jmp !white+
!blackFlash:
	lda #BLACK_KEY_FLASH
	jmp !blackColour+
!steady:
	lda keyIsBlack, x
	bne !blackLit+
	lda whiteShades, y
	jmp !white+

!unlit:
	lda keyIsBlack, x
	bne !nextKey+
	lda #WHITE_UNLIT
!white:
	cmp prevShade, x
	beq !nextKey+
	sta prevShade, x
	ldy keyColumnTable, x
	.for (var row = KEYS_TOP_ROW; row <= KEYS_BOTTOM_ROW; row++) {
		sta $d800 + (row * 40), y
	}
	jmp !nextKey+

!blackLit:
	lda keyLevel, x
	lsr
	lsr
	lsr
	lsr
	lsr
	lsr
	tay
	lda blackKeyShades, y
!blackColour:
	ldy spriteSlot
	cpy #NUM_KEY_SPRITES
	bcs !nextKey+
	sta keySpriteColour, y
	lda keySpriteXLo, x
	sta keySpriteX, y
	lda keySpriteXHi, x
	beq !noMSB+
	lda bitTable, y
	ora keySpriteMSB
	sta keySpriteMSB
!noMSB:
	lda bitTable, y
	ora keySpriteEnable
	sta keySpriteEnable
	inc spriteSlot

!nextKey:
	dex
	bmi !keysDone+
	jmp !key-
!keysDone:

	//; Drum bar: each zone in its own colour, flash then fade.
	ldx #DRUM_ZONES - 1
!drum:
	lda drumLevel, x
	beq !drumOff+
	lsr
	lsr
	lsr
	lsr
	lsr
	lsr
	ora drumZoneFamily, x
	tay
	lda drumFlash, x
	beq !drumSteady+
	lda blackFlash, y
	jmp !drumColour+
!drumSteady:
	lda blackShades, y
	jmp !drumColour+
!drumOff:
	lda pianoBgColor
!drumColour:
	cmp prevDrumColour, x
	beq !nextDrum+
	sta prevDrumColour, x
	ldy drumZoneFirst, x
	sty zoneFirst
	ldy drumZoneLast, x
!col:
	sta $d800 + (DRUM_ROW * 40), y
	dey
	bmi !nextDrum+
	cpy zoneFirst
	bcs !col-
!nextDrum:
	dex
	bpl !drum-

	//; Filter bar: lit from the left for the cutoff's length.
	lda #$00
	ldy filterLength
	beq !filterColour+
	ldy filterVoice
	lda voiceWaveFamily, y
	ora #$03
	tay
	lda blackShades, y
!filterColour:
	cmp prevFilterColour
	bne !drawFilter+
	lda filterLength
	cmp prevFilterLength
	beq !filterDone+
	lda prevFilterColour
!drawFilter:
	sta prevFilterColour
	lda filterLength
	sta prevFilterLength
	ldy #NUM_WHITE_KEYS - 1
!fcol:
	lda pianoBgColor
	cpy filterLength
	bcs !fput+
	lda prevFilterColour
!fput:
	sta $d800 + (FILTER_ROW * 40), y
	dey
	bpl !fcol-
!filterDone:
	rts

//; Voice X's note turned out to be a drum: light its drum zone (attackZone),
//; let go of its keys, and ignore its pitch until the next note starts.
//; Preserves X.
DrumHit:
	ldy attackZone, x
	lda #$ff
	sta drumLevel, y
	lda #FLASH_FRAMES
	sta drumFlash, y
	lda #ST_DRUM
	sta voiceState, x
	ldy #$ff
	jmp LiftVoice

//; Strike key Y for voice X: full level, flash, owned by the voice, in the
//; colour of the voice's waveform now.
//; Preserves X and Y.
StrikeKey:
	lda #$ff
	sta keyLevel, y
	lda #FLASH_FRAMES
	sta keyFlash, y
	txa
	sta keyVoice, y
	lda voiceWaveFamily, x
	sta keyFamily, y
	rts

//; Voice X moves to key Y: every other key it still holds lets go, fading
//; over LIFT_FALL. Preserves X and Y.
LiftVoice:
	stx liftVoice
	sty liftKeep
	ldy #NUM_KEYS - 1
!loop:
	lda keyLevel, y
	beq !next+
	lda keyVoice, y
	cmp liftVoice
	bne !next+
	cpy liftKeep
	beq !next+
	lda keyFall, y
	cmp #LIFT_FALL
	bcs !next+
	lda #LIFT_FALL
	sta keyFall, y
!next:
	dey
	bpl !loop-
	ldy liftKeep
	rts

InitPiano:
	ldx pianoLowNote
	bne !set+
	ldx #DEFAULT_LOW_NOTE + 1
!set:
	dex
	stx lowNote

	ldx #NUM_KEYS - 1
!loop:
	lda #$00
	sta keyLevel, x
	sta keyFall, x
	sta keyVoice, x
	sta keyFlash, x
	lda #WHITE_UNLIT
	sta prevShade, x
	dex
	bpl !loop-

	ldx #MAX_VOICES - 1
!loop:
	lda #$ff
	sta voiceKey, x
	sta prevKey, x
	sta pendingKey, x
	sta shownKey, x
	lda #$00
	sta prevGate, x
	sta prevNoise, x
	sta voiceState, x
	dex
	bpl !loop-

	ldx #DRUM_ZONES - 1
!loop:
	lda #$00
	sta drumLevel, x
	sta drumFlash, x
	lda pianoBgColor
	sta prevDrumColour, x
	dex
	bpl !loop-
	lda #$00
	sta filterLength
	sta prevFilterLength
	sta prevFilterColour

	lda pianoDrumSplit
	bne !split1+
	lda #DEFAULT_DRUM_SPLIT_1
!split1:
	sta drumThreshold1
	lda pianoDrumSplit + 1
	bne !split2+
	lda #DEFAULT_DRUM_SPLIT_2
!split2:
	sta drumThreshold2

	lda #$00
	sta keySpriteEnable
	sta keySpriteMSB
	lda #$03
	sta numVoices
	rts

//; =============================================================================
//; TABLES
//; =============================================================================

LogoD011Table:			.byte $3b, $3b, $1b, $1b, $5b
LogoD016Table:			.byte $18, $08, $08, $18, $08
CurtainXTable:			.byte 24, 72, 120, 168, 216, 264 - 256, 312 - 256
bitTable:				.byte $01, $02, $04, $08, $10, $20, $40, $80
//; Drum bar zones (columns), a blank column between each.
drumZoneFirst:			.byte 0, 14, 27
drumZoneLast:			.byte 12, 25, 39
//; Filter cutoff high byte / 8 -> lit columns (1..40).
filterLengthTable:		.fill 32, round((i + 1) * 40 / 32)

voicesForChips:			.byte 3, 3, 6, 9, 12
voiceRegOffset:			.fill MAX_VOICES, floor(i / 3) * SIDMIRROR_CHIP_STRIDE + mod(i, 3) * 7

//; Per-frame level fall for a decay/release nibble: the SID's envelope time
//; (6 ms .. 24 s) in frames, held to 8..40 frames so a short note still shows
//; and a long release doesn't leave a key lit for seconds.
.var envelopeMs = List().add(6, 24, 48, 72, 114, 168, 204, 240, 300, 750, 1500, 2400, 3000, 9000, 15000, 24000)
envelopeFall:			.fill 16, ceil(255 / max(8, min(40, round(envelopeMs.get(i) / 20))))
//; Level a held key keeps for a sustain nibble (0 = none, so it decays out).
sustainFloor:			.fill 16, i == 0 ? 0 : 112 + i * 9

//; Colour families (x4 into the shade tables): red, green, blue, orange,
//; purple, cyan. Shades run dimmest lit (level 1..63) to brightest (192..255);
//; white keys fade back towards white, the bars on the dark background
//; towards dark. A struck key shows its family's flash colour for
//; FLASH_FRAMES first: the strong colour on a white key, which then settles
//; to the lighter shade; the light colour on a bar.
//;
//; A key's family is its note's waveform - the closest the SID has to an
//; instrument - so the same sound has the same colour on any voice. Indexed
//; by the control register's triangle/sawtooth/pulse bits: triangle blue,
//; sawtooth red, pulse green, any two or three together purple.
waveFamilyTable:		.byte 2 * 4, 2 * 4, 0 * 4, 4 * 4, 1 * 4, 4 * 4, 4 * 4, 4 * 4
//; The drum bar's zones have their own: low (kicks) red, mid orange, high
//; (hi-hats) cyan.
drumZoneFamily:			.byte 0 * 4, 3 * 4, 5 * 4
whiteShades:			.byte $0f, $0a, $0a, $0a
						.byte $0f, $0d, $0d, $0d
						.byte $0f, $0e, $0e, $0e
						.byte $0f, $08, $08, $08
						.byte $0f, $04, $04, $04
						.byte $0f, $03, $03, $03
whiteFlash:				.fill 4, $02
						.fill 4, $05
						.fill 4, $06
						.fill 4, $09
						.fill 4, $06
						.fill 4, $0e
blackFlash:				.fill 4, $0a
						.fill 4, $0d
						.fill 4, $03
						.fill 4, $07
						.fill 4, $0a
						.fill 4, $0d
//; Lit black keys are grey whichever voice plays them: flash light grey
//; (BLACK_KEY_FLASH), then mid grey, dark grey as they fade.
blackKeyShades:			.byte $0b, $0c, $0c, $0c
//; The drum and filter bars, on the dark background.
blackShades:			.byte $09, $02, $02, $02
						.byte $0b, $05, $05, $05
						.byte $06, $0e, $0e, $0e
						.byte $09, $08, $08, $08
						.byte $06, $04, $04, $04
						.byte $0b, $03, $03, $03

noteThresholdLo:		.fill 128, <noteThreshold(i)
noteThresholdHi:		.fill 128, >noteThreshold(i)

keyColumnTable:			.fill NUM_KEYS, keyColumn(i)
keyIsBlack:				.fill NUM_KEYS, semitoneBlack.get(mod(i, 12))
keySpriteXLo:			.fill NUM_KEYS, <(keyColumn(i) * 8 + 21)
keySpriteXHi:			.fill NUM_KEYS, >(keyColumn(i) * 8 + 21)
whiteVariantTable:		.fill NUM_WHITE_KEYS, whiteVariant(i)

//; =============================================================================
//; STATE
//; =============================================================================

lowNote:				.byte DEFAULT_LOW_NOTE
numVoices:				.byte 3
ctrlByte:				.byte 0
freqLo:					.byte 0
freqHi:					.byte 0
noteIndex:				.byte 0
searchStep:				.byte 0
saveY:					.byte 0
spriteSlot:				.byte 0

voiceKey:				.fill MAX_VOICES, $ff
voiceGate:				.fill MAX_VOICES, 0
voiceAD:				.fill MAX_VOICES, 0
voiceSR:				.fill MAX_VOICES, 0
prevKey:				.fill MAX_VOICES, $ff
prevGate:				.fill MAX_VOICES, 0
voiceNoise:				.fill MAX_VOICES, 0
voiceWaveFamily:		.fill MAX_VOICES, 0		//; colour family (x4) of its waveform now
voiceZone:				.fill MAX_VOICES, 0
prevNoise:				.fill MAX_VOICES, 0
voiceState:				.fill MAX_VOICES, ST_IDLE
attackAge:				.fill MAX_VOICES, 0		//; samples since the note started
attackNoise:			.fill MAX_VOICES, 0		//; noise samples in it so far
attackFalls:			.fill MAX_VOICES, 0		//; falls of two semitones or more in a row
attackKey:				.fill MAX_VOICES, $ff	//; last tonal key in it ($ff none yet)
attackZone:				.fill MAX_VOICES, 0		//; drum zone if it turns out a drum
shownKey:				.fill MAX_VOICES, $ff	//; the key showing the voice's current note
pendingKey:				.fill MAX_VOICES, $ff	//; a small pitch step waiting to prove itself a note
pendingAge:				.fill MAX_VOICES, 0
liftVoice:				.byte 0
liftKeep:				.byte 0

drumLevel:				.fill DRUM_ZONES, 0
drumFlash:				.fill DRUM_ZONES, 0
prevDrumColour:			.fill DRUM_ZONES, 0
drumThreshold1:			.byte DEFAULT_DRUM_SPLIT_1
drumThreshold2:			.byte DEFAULT_DRUM_SPLIT_2
zoneFirst:				.byte 0
filterLength:			.byte 0
filterVoice:			.byte 0
prevFilterLength:		.byte 0
prevFilterColour:		.byte 0

keyLevel:				.fill NUM_KEYS, 0
keyFall:				.fill NUM_KEYS, 0
keyVoice:				.fill NUM_KEYS, 0
prevShade:				.fill NUM_KEYS, WHITE_UNLIT
keyFlash:				.fill NUM_KEYS, 0	//; frames of strike flash left
keyFamily:				.fill NUM_KEYS, 0	//; colour family (x4) of the note that lit it

keySpriteX:				.fill NUM_KEY_SPRITES, 0
keySpriteColour:		.fill NUM_KEY_SPRITES, 0
keySpriteMSB:			.byte 0
keySpriteEnable:		.byte 0

#endif // !GFX_DONOR

//; =============================================================================
//; GRAPHICS (VIC) ASSETS
//; A CODE_ONLY build omits these; the exporter places them from the graphics
//; manifest and injects the logo and font.
//; =============================================================================

#if !CODE_ONLY

* = SPRITES_ADDRESS "Curtain Sprite"
	.fill 57, $00						//; rows 0-18 transparent
	.fill 6, $ff						//; rows 19-20 solid - the 2-line block
	.byte $00

* = SPRITES_ADDRESS + $40 "Key Sprite"
	//; 6px wide, 16 rows; Y-expanded to the black keys' 32 lines.
	.for (var row = 0; row < 21; row++) {
		.byte row < BLACK_KEY_ROWS * 4 ? %11111100 : $00, $00, $00
	}
	.byte $00

* = SCREEN_ADDRESS "Screen"
	.fill LOGO_HEIGHT * 40, $00
	.fill $400 - (LOGO_HEIGHT * 40), $20

* = LOGO_COL_DATA "Logo Colour"
	.fill LOGO_HEIGHT * 40, $00

* = CHARSET_ADDRESS + (PIANO_CHARS * 8) "Piano Chars"
	//; Black-key rows: white key (pixels 0-6, pixel 7 the gap between keys)
	//; with a 3px cut on the left and/or right where a black key sits.
	.var cut = List().add(%11111110, %00011110, %11111000, %00011000)
	.for (var v = 0; v < 4; v++) {
		.fill 8, cut.get(v)
	}
	.fill 8, %11111110					//; CHAR_WHITE
	.fill 6, %11111110					//; CHAR_WHITE_BOTTOM: rounded front edge
	.byte %01111100, %00000000
	.fill 4, $00						//; CHAR_DRUM_BAR: 3px, 1px above the keys
	.fill 3, $ff
	.byte $00
	.byte $00							//; CHAR_FILTER_BAR: 3px, 1px below the keys
	.fill 3, $ff
	.fill 4, $00

* = BITMAP_ADDRESS "Bitmap"
	.fill LOGO_HEIGHT * 40 * 8, $00

#endif // !CODE_ONLY

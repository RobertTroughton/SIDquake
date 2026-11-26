// =============================================================================
//                                   PIANO
//          A logo, the song name, and a piano keyboard that plays itself
// =============================================================================
//
// Screen layout (char rows):
//    0-10  logo (10 art rows + 1 clear row that hides the raster split)
//   13-14  song name, 1x2 font, centred
//   16-17  elapsed time, and "/" + song length when the analysis found one
//   19-24  keyboard: 40 white keys, C to G across 5 octaves and a fifth;
//          the black keys are the top 4 of its 6 rows
//
// Which keys are down comes from the SID registers, read the same two ways
// the bar players read them: the realtime build peeks a second play call with
// RAM banked in over $D400 (INC/musicplayback.asm AnalyseMusic), the shadow
// build (-define SPECTROMETER_SHADOW) reads the mirror the tune's own
// repointed stores fill. Each voice's frequency becomes a note by binary
// search of a PAL semitone-boundary table; gate, sustain, decay and release
// decide how long the key stays lit and how bright it is.
//
// Lit white keys are recoloured in colour RAM (the black keys are background
// pixels cut out of the white-key characters, so a white key's cells carry
// only that key). Lit black keys are sprites: one 6px-wide, Y-expanded sprite
// per lit black key, up to eight. Each voice has its own colour family, and a
// key fades from the full colour back to unlit as its envelope falls.
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
//   $3F00-$3F2F  piano characters (224-229)
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
.const SONG_TITLE_LINE					= 13
.const TIMER_LINE						= 16
.const KEYS_TOP_ROW						= 19
.const BLACK_KEY_ROWS					= 4		//; 2/3 of the keyboard's height
.const KEYS_BOTTOM_ROW					= 24

.const NUM_WHITE_KEYS					= 40
.const NUM_KEYS							= 68	//; C..G over 5 octaves + 7 semitones
.const DEFAULT_LOW_NOTE					= 12	//; C1
.const MAX_VOICES						= 12	//; 4 SID chips
.const NUM_KEY_SPRITES					= 8
.const LIFT_FALL						= 128	//; a lifted key is unlit two frames after the voice moves on

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

.const WHITE_UNLIT						= $01

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
	ldy voiceRegOffset, x
	lda sidRegisterMirror + 4, y
	sta ctrlByte
	and #$08
	bne !silent+
	lda ctrlByte
	and #$f0
	beq !silent+
	cmp #$80
	beq !silent+
	lda sidRegisterMirror + 0, y
	sta freqLo
	lda sidRegisterMirror + 1, y
	sta freqHi
	ora freqLo
	beq !silent+

	lda sidRegisterMirror + 5, y
	sta voiceAD, x
	lda sidRegisterMirror + 6, y
	sta voiceSR, x
	lda ctrlByte
	and #$01
	sta voiceGate, x
	jsr FreqToKey
	sta voiceKey, x
	jmp !next+

!silent:
	lda #$ff
	sta voiceKey, x
!next:
	inx
	cpx numVoices
	bne !voice-
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
//; Each key has a level (0 = up, 255 = just struck), a per-frame fall and the
//; voice that last played it. A gate rising strikes the key, and so does a
//; voice landing on a different key than last frame (or sounding again after
//; a silent frame) with or without its gate: a multispeed tune can open and
//; close a gate between two frames' samples, and then the new note, or the
//; hard restart before it, is all the analysis sees. While the gate is held the level is kept at
//; least at a floor set by the voice's sustain, falling at the decay rate;
//; after the gate drops it falls at the release rate. The level picks one of
//; four shades from the voice's colour family.
//; =============================================================================

UpdatePiano:
	ldx #NUM_KEYS - 1
!fall:
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

	ldx #$00
!voice:
	ldy voiceKey, x
	bpl !playing+
	lda #$00
	sta prevGate, x
	lda #$ff
	sta prevKey, x
	jmp !nextVoice+

!playing:
	//; One voice is one finger: landing on a new key lifts the one it was
	//; on, unless another voice has taken that key since.
	tya
	cmp lastKey, x
	beq !sameKey+
	lda lastKey, x
	bmi !noLift+
	sty saveY
	tay
	txa
	cmp keyVoice, y
	bne !notMine+
	lda keyFall, y
	cmp #LIFT_FALL
	bcs !notMine+
	lda #LIFT_FALL
	sta keyFall, y
!notMine:
	ldy saveY
!noLift:
	tya
	sta lastKey, x
!sameKey:
	txa
	sta keyVoice, y
	tya
	cmp prevKey, x
	bne !strike+
	lda voiceGate, x
	beq !released+
	lda prevGate, x
	bne !held+
!strike:
	lda #$ff
	sta keyLevel, y
	lda voiceGate, x
	beq !released+
!held:
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

	lda voiceGate, x
	sta prevGate, x
	tya
	sta prevKey, x
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
	ldy keyVoice, x
	ora voiceFamily, y
	tay
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
	lda blackShades, y
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
	bpl !key-
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
	lda #WHITE_UNLIT
	sta prevShade, x
	dex
	bpl !loop-

	ldx #MAX_VOICES - 1
!loop:
	lda #$ff
	sta voiceKey, x
	sta prevKey, x
	sta lastKey, x
	lda #$00
	sta prevGate, x
	dex
	bpl !loop-

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

voicesForChips:			.byte 3, 3, 6, 9, 12
voiceRegOffset:			.fill MAX_VOICES, floor(i / 3) * SIDMIRROR_CHIP_STRIDE + mod(i, 3) * 7

//; Per-frame level fall for a decay/release nibble: the SID's envelope time
//; (6 ms .. 24 s) in frames, held to 4..40 frames so a short note still shows
//; and a long release doesn't leave a key lit for seconds.
.var envelopeMs = List().add(6, 24, 48, 72, 114, 168, 204, 240, 300, 750, 1500, 2400, 3000, 9000, 15000, 24000)
envelopeFall:			.fill 16, ceil(255 / max(4, min(40, round(envelopeMs.get(i) / 20))))
//; Level a held key keeps for a sustain nibble (0 = none, so it decays out).
sustainFloor:			.fill 16, i == 0 ? 0 : 112 + i * 9

//; Shades per voice family, dimmest lit (level 1..63) to brightest (192..255).
//; White keys fade back towards white; black keys towards dark. Families:
//; red, green, blue, orange, purple, cyan; voices 7-12 reuse them.
voiceFamily:			.fill MAX_VOICES, mod(i, 6) * 4
whiteShades:			.byte $0f, $0a, $02, $02
						.byte $0f, $0d, $05, $05
						.byte $0f, $0e, $06, $06
						.byte $0f, $07, $08, $08
						.byte $0f, $0a, $04, $04
						.byte $0f, $03, $0e, $0e
blackShades:			.byte $09, $02, $0a, $0a
						.byte $0b, $05, $0d, $0d
						.byte $0b, $06, $0e, $0e
						.byte $09, $08, $07, $07
						.byte $06, $04, $04, $0a
						.byte $0b, $0e, $03, $03

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
lastKey:				.fill MAX_VOICES, $ff	//; the key each voice last played, kept through silence

keyLevel:				.fill NUM_KEYS, 0
keyFall:				.fill NUM_KEYS, 0
keyVoice:				.fill NUM_KEYS, 0
prevShade:				.fill NUM_KEYS, WHITE_UNLIT

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

* = BITMAP_ADDRESS "Bitmap"
	.fill LOGO_HEIGHT * 40 * 8, $00

#endif // !CODE_ONLY

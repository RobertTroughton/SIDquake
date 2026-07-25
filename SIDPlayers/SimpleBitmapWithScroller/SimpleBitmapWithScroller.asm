// =============================================================================
//                      SIMPLE BITMAP WITH SCROLLER PLAYER
//                   Bitmap Graphics SID Music Player for C64
// =============================================================================

.var LOAD_ADDRESS                   = cmdLineVars.get("loadAddress").asNumber()
.var CODE_ADDRESS                   = cmdLineVars.get("sysAddress").asNumber()
.var DATA_ADDRESS                   = cmdLineVars.get("dataAddress").asNumber()

* = DATA_ADDRESS "Data Block"
    .fill $71, $00
fontMode:
    .byte $00                           // 0 = scroller reads C64 ROM, 1 = scroller reads injected RAM charset
    .fill $100 - $72, $00

* = CODE_ADDRESS "Main Code"

    jmp Initialize

.var VIC_BANK						= floor(LOAD_ADDRESS / $4000)
.var VIC_BANK_ADDRESS               = VIC_BANK * $4000
.var BITMAP_BANK                    = 1
.var SCREEN_BANK                    = 2
.var COLOUR_BANK                    = 3
.var SPRITES_INDEX                  = $00

.var ScrollColour					= DATA_ADDRESS + $80

// Optional injected charset. Sits in the gap between sprite data ($x000-$x1FF)
// and bitmap screen ($x800), on a $400 boundary so the scroller's
// `ora #high` indexing addresses three contiguous 256-byte pages
// (codes 0-31, 32-63, 64-95) without carry collisions.
.const RAM_CHARSET_ADDRESS          = LOAD_ADDRESS + $400
.const RAM_CHARSET_BASE_HI          = >RAM_CHARSET_ADDRESS

.const DD00Value                        = 3 - VIC_BANK
.const DD02Value                        = 60 + VIC_BANK
.const D018Value                        = (SCREEN_BANK * 16) + (BITMAP_BANK * 8)

.const BITMAP_MAP_DATA                  = VIC_BANK_ADDRESS + (BITMAP_BANK * $2000)
.const BITMAP_SCREEN_DATA               = VIC_BANK_ADDRESS + (SCREEN_BANK * $0400)
.const BITMAP_COLOUR_DATA               = VIC_BANK_ADDRESS + (COLOUR_BANK * $0400)
.const SPRITES_DATA                     = VIC_BANK_ADDRESS + (SPRITES_INDEX * 64)

.const SCROLLTEXT_ADDR                  = VIC_BANK_ADDRESS - $1800

// =============================================================================
// INCLUDES
// =============================================================================

#define INCLUDE_SPACE_FASTFORWARD
#define INCLUDE_PLUS_MINUS_SONGCHANGE
#define INCLUDE_09ALPHA_SONGCHANGE
#define INCLUDE_F1_SHOWRASTERTIMINGBAR

// Raster line for music call 0; the remaining calls are CIA-timer driven
// (see INC/multicallirq.asm).
.const MUSIC_SYNC_LINE = 250

.import source "../INC/common.asm"
.import source "../INC/keyboard.asm"
.import source "../INC/musicplayback.asm"
.import source "../INC/multicallirq.asm"
.import source "../INC/linkedwitheffect.asm"

// =============================================================================
// INITIALIZATION ENTRY POINT
// =============================================================================

Initialize:
    sei

    lda #$35
    sta $01

    jsr SetupCharset

    jsr RunLinkedWithEffect

    jsr VSync

    lda #$00
    sta $d011
    sta $d020

    jsr InitializeVIC

    // The scroller is optional. With an empty scroll text (null first byte) leave
    // the sprites off and skip the per-frame scroll, so this is just the bitmap.
    lda #1
    sta scrollEnabled
    lda SCROLLTEXT_ADDR
    bne !hasScroll+
    lda #0
    sta scrollEnabled
    sta $d015                   // sprites off
!hasScroll:

    // Set $D016 based on bitmap mode (MC=$18, HI=$08)
    lda #$08
    ldx BitmapMode
    bne !hiresBitmap+
    lda #$18               // Multicolor mode
!hiresBitmap:
    sta $d016

    lda BitmapScreenColour
    sta $d021

    jsr InitKeyboard

    lda SongNumber
    sta CurrentSong
    
    lda NumSongs
    bne !skip+
    lda #1
    sta NumSongs
!skip:

    lda #0
    sta ShowRasterBars

    lda CurrentSong
    tax
    tay
    jsr SIDInit

    jsr NMIFix

    ldy #$00
!loop:
    .for (var i = 0; i < 4; i++)
    {
        lda BITMAP_COLOUR_DATA + (i * 256), y
        sta $d800 + (i * 256), y
    }
    iny
    bne !loop-

    ldy #$07
!loop:
    lda ScrollColour
    sta $d027, y
    dex
    dey
    bpl !loop-

    jsr InitMultiCallIRQ
    StartRasterEvents(MUSIC_SYNC_LINE, MusicFrameHandler)

    lda #DD00Value
    sta $dd00
    lda #DD02Value
    sta $dd02

    lda #D018Value
    sta $d018

    jsr VSync

    lda BorderColour
    sta $d020

    lda #$3b
    sta $d011

    cli

MainLoop:
    jsr CheckKeyboard

    lda FastForwardActive
    beq MainLoop

    // Fast-forward mode: call SIDPlay multiple times from main loop.
    // The IRQ framework skips its own play calls while this is active.
!ffFrameLoop:
    lda NumCallsPerFrame
    sta FFCallCounter

!ffCallLoop:
    jsr SIDPlay
    inc $d020
    dec FFCallCounter
    lda FFCallCounter
    bne !ffCallLoop-

    jsr CheckMusicLoop          // forced song loop tracks fast-forwarded frames too
    jsr CheckSpaceKey
    lda FastForwardActive
    bne !ffFrameLoop-

    lda BorderColour
    sta $d020

    jmp MainLoop

// =============================================================================
// INTERRUPT HANDLERS (see INC/multicallirq.asm for the shared scheduler)
// =============================================================================

MusicFrameHandler:
    SetNextRasterEvent(MUSIC_SYNC_LINE, MusicFrameHandler)
    jmp MusicFrameCall

MusicCall_Frame:
MusicCall_Other:
    jmp JustPlayMusic

// The scroller now advances once per frame regardless of how many music
// calls the tune needs, so the scroll speed no longer depends on the tune.
// Skipped entirely when no scroll text was supplied (just a static bitmap).
FrameCall:
    lda scrollEnabled
    bne SpriteScroller
    rts

scrollEnabled:  .byte $00

SpriteScroller:

    ldx #$0e
    dex
    dex
    bpl !skip+

    jsr ScrollSprites

    ldx #$0f
!skip:
    stx SpriteScroller + 1

    txa
    clc
    sta $d000       //; $00-0F
    adc #$30
    sta $d002       //; $30-3F
    adc #$30
    sta $d004       //; $60-6F
    adc #$30
    sta $d006       //; $90-9F
    adc #$30
    sta $d008       //; $C0-CF
    adc #$30
    sta $d00a       //; $F0-FF
    adc #$30
    sta $d00c       //; $20-2F
    eor #$70
    sta $d00e       //; $50-5F

    rts
  

ScrollSprites:

    ldy #$00
!loop:
    lda SPRITES_DATA + (0 * 64) + 1, y
    sta SPRITES_DATA + (0 * 64) + 0, y
    lda SPRITES_DATA + (0 * 64) + 2, y
    sta SPRITES_DATA + (0 * 64) + 1, y

    lda SPRITES_DATA + (1 * 64) + 0, y
    sta SPRITES_DATA + (0 * 64) + 2, y
    lda SPRITES_DATA + (1 * 64) + 1, y
    sta SPRITES_DATA + (1 * 64) + 0, y
    lda SPRITES_DATA + (1 * 64) + 2, y
    sta SPRITES_DATA + (1 * 64) + 1, y
    
    lda SPRITES_DATA + (2 * 64) + 0, y
    sta SPRITES_DATA + (1 * 64) + 2, y
    lda SPRITES_DATA + (2 * 64) + 1, y
    sta SPRITES_DATA + (2 * 64) + 0, y
    lda SPRITES_DATA + (2 * 64) + 2, y
    sta SPRITES_DATA + (2 * 64) + 1, y

    lda SPRITES_DATA + (3 * 64) + 0, y
    sta SPRITES_DATA + (2 * 64) + 2, y
    lda SPRITES_DATA + (3 * 64) + 1, y
    sta SPRITES_DATA + (3 * 64) + 0, y
    lda SPRITES_DATA + (3 * 64) + 2, y
    sta SPRITES_DATA + (3 * 64) + 1, y

    lda SPRITES_DATA + (4 * 64) + 0, y
    sta SPRITES_DATA + (3 * 64) + 2, y
    lda SPRITES_DATA + (4 * 64) + 1, y
    sta SPRITES_DATA + (4 * 64) + 0, y
    lda SPRITES_DATA + (4 * 64) + 2, y
    sta SPRITES_DATA + (4 * 64) + 1, y

    lda SPRITES_DATA + (5 * 64) + 0, y
    sta SPRITES_DATA + (4 * 64) + 2, y
    lda SPRITES_DATA + (5 * 64) + 1, y
    sta SPRITES_DATA + (5 * 64) + 0, y
    lda SPRITES_DATA + (5 * 64) + 2, y
    sta SPRITES_DATA + (5 * 64) + 1, y

    lda SPRITES_DATA + (6 * 64) + 0, y
    sta SPRITES_DATA + (5 * 64) + 2, y
    lda SPRITES_DATA + (6 * 64) + 1, y
    sta SPRITES_DATA + (6 * 64) + 0, y
    lda SPRITES_DATA + (6 * 64) + 2, y
    sta SPRITES_DATA + (6 * 64) + 1, y

    lda SPRITES_DATA + (7 * 64) + 0, y
    sta SPRITES_DATA + (6 * 64) + 2, y
    lda SPRITES_DATA + (7 * 64) + 1, y
    sta SPRITES_DATA + (7 * 64) + 0, y
    lda SPRITES_DATA + (7 * 64) + 2, y
    sta SPRITES_DATA + (7 * 64) + 1, y

    iny
    iny
    iny
    cpy #(8 * 3)
    beq !finished+
    jmp !loop-

!finished:

ReadScroller:
    lda SCROLLTEXT_ADDR
    bne !notEnd+
    lda #<SCROLLTEXT_ADDR
    sta ReadScroller + 1
    lda #>SCROLLTEXT_ADDR
    sta ReadScroller + 2
    bne ReadScroller
!notEnd:

    tax
    lsr
    lsr
    lsr
    lsr
    lsr
ScrollerCharsetOra:
    ora #RAM_CHARSET_BASE_HI     //; injected RAM charset (3 pages: codes 0-95)
    sta InCharPtr + 2
    txa
    asl
    asl
    asl
    sta InCharPtr + 1

    //; The charset and the sprite data are both plain RAM, so no $01 banking:
    //; touching $01 to page the ROM in would hang the machine if an IRQ arrived
    //; with I/O banked out.
    ldx #7
    ldy #(7 * 3)
InCharPtr:
    lda $abcd, x
    sta SPRITES_DATA + (7 * 64) + 2, y
    dey
    dey
    dey
    dex
    bpl InCharPtr

    inc ReadScroller + 1
    bne !skip+
    inc ReadScroller + 2
!skip:

    rts
   

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

	rts

//; =============================================================================
//; DATA SECTION - VIC Configuration
//; =============================================================================

VICConfigStart:
	.byte $00, $ea						//; Sprite 0 X,Y
	.byte $00, $ea						//; Sprite 1 X,Y
	.byte $00, $ea						//; Sprite 2 X,Y
	.byte $00, $ea						//; Sprite 3 X,Y
	.byte $00, $ea						//; Sprite 4 X,Y
	.byte $00, $ea						//; Sprite 5 X,Y
	.byte $00, $ea						//; Sprite 6 X,Y
	.byte $00, $ea						//; Sprite 7 X,Y
	.byte $c0							//; Sprite X MSB
	.byte SKIP_REGISTER					//; D011
	.byte SKIP_REGISTER					//; D012
	.byte SKIP_REGISTER					//; D013
	.byte SKIP_REGISTER					//; D014
	.byte $ff							//; Sprite enable
	.byte $18							//; D016
	.byte $ff							//; Sprite Y expand
	.byte D018Value     				//; D018
	.byte SKIP_REGISTER					//; D019
	.byte SKIP_REGISTER					//; D01A
	.byte $00							//; Sprite priority
	.byte $00							//; Sprite multicolor
	.byte $ff							//; Sprite X expand
	.byte $00							//; Sprite-sprite collision
	.byte $00							//; Sprite-background collision
	.byte SKIP_REGISTER					//; Border color
	.byte SKIP_REGISTER     			//; Background color
	.byte $00, $00						//; Extra colors
	.byte $00, $00, $00					//; Sprite extra colors
	.byte $01, $01, $01, $01			//; Sprite colors 0-3
	.byte $01, $01, $01, $01			//; Sprite colors 4-7
VICConfigEnd:

// =============================================================================
// CHARSET SETUP
//
// The scroller always reads the injected RAM charset (RAM_CHARSET_ADDRESS); the
// C64 ROM font is no longer used (it can return later as a normal 1x1 font).
// Nothing to patch at runtime, so this is a no-op kept only so the init call
// site is stable.
// =============================================================================

SetupCharset:
    rts

// =============================================================================
// EMBEDDED CHARSET DATA (768 bytes; populated by prg-builder when not ROM mode)
// =============================================================================

* = RAM_CHARSET_ADDRESS "Embedded Charset"
EmbeddedCharset:
    .fill $300, $00

// =============================================================================
// DATA SECTION - Placeholder screen and bitmap data
// =============================================================================

* = SCROLLTEXT_ADDR "ScrollText"

    .byte $00                           // empty by default (no scroller); the exporter
                                        // injects the scroll text here when one is set

* = BITMAP_MAP_DATA "Bitmap MAP Data"
    .fill $2000, $00

* = BITMAP_SCREEN_DATA "Bitmap SCR Data"
    .fill $3f8, $00
    .fill 8, SPRITES_INDEX + i

* = BITMAP_COLOUR_DATA "Bitmap COL Data"
    .fill $400, $00

* = SPRITES_DATA
    .fill $200, $00

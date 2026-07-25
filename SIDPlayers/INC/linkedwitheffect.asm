#importonce

// Graphics-donor builds (-define GFX_DONOR) carry no code: the full-bank
// bins only donate the VIC assets to the relocating exporter.
#if !GFX_DONOR

// =============================================================================
//                             SIDQUAKE INTRO
//                   Left-to-right colour sweep watermark
// =============================================================================
// Shows "SIDquake2" tucked into the bottom-right corner, with a quick
// colour roll that starts at the 'S' (left) and sweeps right, then fades out.
// =============================================================================

.const EFFECT_TEXT_Y            = 24    // bottom row
.const EFFECT_TEXT_X            = 30    // right-aligned: "SIDquake2" = 9 chars -> cols 30..38
.const EFFECT_WIDTH             = 9
.const EFFECT_OFFSET            = (EFFECT_TEXT_Y * 40) + EFFECT_TEXT_X

// When BANK_AWARE_EFFECT is defined the host player has already selected its
// VIC bank and copied a charset into CHARSET_RAM, so the intro draws into that
// player's in-bank screen. Otherwise it falls back to the classic bank-0 $0400
// screen with the lowercase ROM charset (used by all the other players).
#if BANK_AWARE_EFFECT
.var ScreenAddress = SCREEN_RAM
#else
.var ScreenAddress = $0400
#endif
.var VIC_COLOURMEMORY = $d800

// =============================================================================
// DATA
// =============================================================================

// "SIDquake2": S I D (uppercase, $41-based) + q u a k e (lowercase, $01-based)
//             + 2 ($32).
EffectText:             .byte $53, $49, $44, $11, $15, $01, $0b, $05, $32
// Colour ramp swept across the 8 chars: black lead, quick fade up to white,
// a short hold, fade back down, then black. One column advances per frame, so
// this is a ~0.7s roll at 50 fps. Terminated by $ff (a negative byte).
ColourFadeValues:       .fill EFFECT_WIDTH, $00
                        .byte $0b, $0c, $0f
                        .fill 20, $01
                        .byte $0f, $0c, $0b
                        .fill 10, $00
                        .byte $ff

// =============================================================================
// EFFECT ENTRY POINT
// =============================================================================

RunLinkedWithEffect:

#if BANK_AWARE_EFFECT
    // Screen addresses are fixed in-bank; no relocation needed.
#else
    // Relocate the intro screen onto the safe bank-0 page chosen by the
    // exporter (avoids a SID that loads low). Patch the clear-loop base and the
    // text-line store high byte; the colour writes use fixed $D800. The text
    // sits at offset EFFECT_OFFSET (bottom row), which is 3 pages into the
    // screen, so its store high byte is the screen base + 3.
    ldx IntroScreenHi
    stx ClrSt + 2
    txa
    clc
    adc #>EFFECT_OFFSET
    sta TxtL + 2
#endif

    jsr VSync

    lda #$00
    sta $d020
    sta $d021

    jsr VSync

    // Clear 4 pages (1000 bytes) of the screen via a single self-modifying
    // store whose high byte walks through the pages.
    ldx #0
    ldy #4
    lda #$20
!clr:
ClrSt:
    sta ScreenAddress,x
    inx
    bne !clr-
    inc ClrSt + 2
    dey
    bne !clr-

    // Draw the text and init its colours to black (invisible)
    ldx #EFFECT_WIDTH-1
!txt:
    lda EffectText,x
TxtL:
    sta ScreenAddress + EFFECT_OFFSET,x
    lda #0              // Start with black (invisible)
    sta VIC_COLOURMEMORY + EFFECT_OFFSET,x
    dex
    bpl !txt-

    jsr VSync

#if BANK_AWARE_EFFECT
    lda #D018_VALUE             // in-bank screen + charset; VIC bank already set
    sta $d018
#else
    // screen = IntroScreenHi page, charset = lowercase ROM ($1800), VIC bank 0
    lda IntroD018
    sta $d018
    lda #$97
    sta $dd00
#endif
    lda #$08
    sta $d016
    lda #$00
    sta $d015
    lda #$1b
    sta $d011

    ldy #$00

OuterLoop:
    ldy #$00

    jsr VSync

    // Fill the columns right-to-left (x = EFFECT_WIDTH-1..0) while reading the
    // ramp forwards, so the leading edge of the sweep reaches column 0 (the 'S')
    // first and rolls rightwards.
    ldx #EFFECT_WIDTH-1
!loop:
    lda ColourFadeValues, y
    sta VIC_COLOURMEMORY + EFFECT_OFFSET, x
    iny
    dex
    bpl !loop-

    inc OuterLoop + 1

    lda ColourFadeValues, y
    bpl OuterLoop

    jsr VSync
    lda #$00
    sta $d011
    jmp VSync

!continue:
    jmp !loop-



#endif // !GFX_DONOR
